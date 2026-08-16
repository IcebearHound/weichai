"""排队付款引擎:并发执行一批付款意图,含幂等、租约与重试。

每个意图先通过 ReceiptLedger 获取幂等租约(同键同时只允许一个执行者),
租约到期前重试获取;拿到租约后按 RetryPolicy 尝试调用网关,成功则
根据"键+引用+金额"生成确定性收据 ID 并提交;失败按可重试性选择
继续重试(指数退避 + 确定性抖动)、拒绝或推迟。
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime, timedelta
from types import MappingProxyType
from uuid import uuid4

from .ledger import ReceiptLedger
from .model import DeliveryReceipt, GatewayReply, PayoutIntent, PayoutResult, RetryPolicy


# 网关调用签名:接收意图、幂等键与尝试次数,返回应答
Gateway = Callable[[PayoutIntent, str, int], Awaitable[GatewayReply]]
# 幂等键工厂:由意图与序号生成唯一键
IdentityFactory = Callable[[PayoutIntent, int], str]


class QueuedPayoutEngine:
    """并发排队付款引擎。

    execute_group 以信号量限流并发执行一组意图;
    内部 _execute_one 完成单意图的租约获取、网关重试与收据提交。
    """

    def __init__(
        self,
        ledger: ReceiptLedger,
        retry_policy: RetryPolicy,
        concurrency: int = 8,
        lease_seconds: float = 30,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if concurrency < 1:
            raise ValueError("concurrency must be positive")
        if lease_seconds <= 0:
            raise ValueError("lease_seconds must be positive")
        if retry_policy.maximum_attempts < 1:
            raise ValueError("maximum_attempts must be positive")
        if retry_policy.base_delay_seconds < 0 or retry_policy.maximum_delay_seconds < 0:
            raise ValueError("retry delays must be non-negative")
        if not 0 <= retry_policy.jitter_fraction <= 1:
            raise ValueError("jitter_fraction must be within [0, 1]")
        self._ledger = ledger
        self._retry_policy = retry_policy
        self._concurrency = concurrency
        self._lease_seconds = lease_seconds
        self._clock = clock or (lambda: datetime.now(UTC))

    async def execute_group(
        self,
        items: Sequence[PayoutIntent],
        identity: IdentityFactory,
        gateway: Gateway,
    ) -> list[PayoutResult]:
        """并发执行一组意图,返回结果列表(与输入顺序一一对应)。

        用 Semaphore 限制并发;单个任务失败(未捕获异常)时返回
        state="deferred" 的结果,不中断其它任务。
        """
        semaphore = asyncio.Semaphore(self._concurrency)
        tasks: list[asyncio.Task[PayoutResult]] = []
        for ordinal, item in enumerate(items):
            key = identity(item, ordinal).strip()
            tasks.append(
                asyncio.create_task(
                    self._execute_one(item, ordinal, key, gateway, semaphore),
                    name=f"payout:{ordinal}:{item.identity}",
                )
            )
        if not tasks:
            return []
        gathered = await asyncio.gather(*tasks, return_exceptions=True)
        output: list[PayoutResult] = []
        for ordinal, value in enumerate(gathered):
            item = items[ordinal]
            if isinstance(value, BaseException):
                output.append(
                    PayoutResult(
                        identity=item.identity,
                        ordinal=ordinal,
                        state="deferred",
                        attempts=0,
                        reason=f"engine failure: {type(value).__name__}: {value}",
                    )
                )
            else:
                output.append(value)
        return output

    async def _execute_one(
        self,
        item: PayoutIntent,
        ordinal: int,
        key: str,
        gateway: Gateway,
        semaphore: asyncio.Semaphore,
    ) -> PayoutResult:
        if not item.identity.strip():
            return PayoutResult(item.identity, ordinal, "rejected", 0, reason="identity is required")
        if not item.account.strip() or not item.beneficiary.strip():
            return PayoutResult(item.identity, ordinal, "rejected", 0, reason="account and beneficiary are required")
        if item.money.amount <= 0:
            return PayoutResult(item.identity, ordinal, "rejected", 0, reason="amount must be positive")
        if len(item.money.currency.strip()) != 3:
            return PayoutResult(item.identity, ordinal, "rejected", 0, reason="currency must be a three-letter code")
        if not key:
            return PayoutResult(item.identity, ordinal, "rejected", 0, reason="idempotency key is required")
        # 租约获取有期限:2 倍租约时长内抢不到即放弃(避免无限等待)
        owner = f"{uuid4().hex}:{ordinal}"
        acquisition_deadline = asyncio.get_running_loop().time() + self._lease_seconds * 2
        reservation = None
        while reservation is None:
            now = self._clock()
            existing, observed, owned = await self._ledger.reserve(key, owner, now, self._lease_seconds)
            if existing is not None:
                # 已存在收据:幂等命中,直接返回已结算
                return PayoutResult(
                    identity=item.identity,
                    ordinal=ordinal,
                    state="settled",
                    attempts=0,
                    receipt=existing,
                )
            if owned and observed is not None:
                reservation = observed
                break
            # 租约被他人持有:等到其过期或获取期限耗尽
            remaining = acquisition_deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                retry_after = observed.expires_at if observed is not None else now + timedelta(seconds=1)
                return PayoutResult(
                    identity=item.identity,
                    ordinal=ordinal,
                    state="deferred",
                    attempts=0,
                    reason="idempotency reservation remained busy",
                    retry_after=retry_after,
                )
            wait_seconds = min(0.02, remaining)
            if observed is not None:
                until_expiry = max(0.001, (observed.expires_at - now).total_seconds())
                wait_seconds = min(wait_seconds, until_expiry)
            await asyncio.sleep(wait_seconds)
        last_reply: GatewayReply | None = None
        last_reason = "gateway was not attempted"
        attempts = 0
        try:
            async with semaphore:
                for attempt in range(1, self._retry_policy.maximum_attempts + 1):
                    attempts = attempt
                    try:
                        reply = await gateway(item, key, attempt)
                    except asyncio.CancelledError:
                        raise
                    except Exception as error:
                        # 网关调用抛异常:转成拒绝应答,统一走重试判定
                        reply = GatewayReply(
                            accepted=False,
                            reference="",
                            code="exception",
                            message=f"{type(error).__name__}: {error}",
                            completed_at=self._clock(),
                            details=MappingProxyType({"exception": type(error).__name__}),
                        )
                    last_reply = reply
                    if reply.accepted:
                        # 收据 ID 由幂等键+引用+金额确定性生成:同键重放产生同一收据
                        seed = f"{key}|{reply.reference}|{item.money.currency}|{item.money.amount}"
                        receipt_id = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]
                        receipt = DeliveryReceipt(
                            idempotency_key=key,
                            receipt_id=receipt_id,
                            account=item.account,
                            beneficiary=item.beneficiary,
                            money=item.money,
                            value_date=item.value_date,
                            settled_at=reply.completed_at,
                            gateway_reference=reply.reference,
                            attempts=attempt,
                            metadata=MappingProxyType(
                                {
                                    "gateway_code": reply.code,
                                    "rail": item.rail,
                                    "source_identity": item.identity,
                                    **dict(reply.details),
                                }
                            ),
                        )
                        committed = await self._ledger.commit(reservation, receipt)
                        return PayoutResult(
                            identity=item.identity,
                            ordinal=ordinal,
                            state="settled",
                            attempts=attempt,
                            receipt=committed,
                        )
                    last_reason = f"{reply.code}: {reply.message}"
                    retryable = reply.code in self._retry_policy.retryable_codes or reply.code == "exception"
                    if not retryable:
                        # 永久失败:立即拒绝
                        return PayoutResult(item.identity, ordinal, "rejected", attempt, reason=last_reason)
                    if attempt >= self._retry_policy.maximum_attempts:
                        break
                    # 指数退避:base × 2^(attempt-1),封顶 maximum_delay
                    exponential = min(
                        self._retry_policy.maximum_delay_seconds,
                        self._retry_policy.base_delay_seconds * (2 ** (attempt - 1)),
                    )
                    # 确定性抖动:由键+尝试次数导出 [0,1),再映射到 ±jitter_fraction
                    digest = hashlib.blake2s(f"{key}:{attempt}".encode("utf-8"), digest_size=4).digest()
                    unit = int.from_bytes(digest, "big") / 0xFFFFFFFF
                    jitter = exponential * self._retry_policy.jitter_fraction * (unit * 2 - 1)
                    await asyncio.sleep(max(0, exponential + jitter))
            retry_at = (last_reply.completed_at if last_reply is not None else self._clock()) + timedelta(
                seconds=self._retry_policy.maximum_delay_seconds
            )
            return PayoutResult(
                identity=item.identity,
                ordinal=ordinal,
                state="deferred",
                attempts=attempts,
                reason=last_reason,
                retry_after=retry_at,
            )
        finally:
            # 无论成败都释放租约,避免键被永久占用
            await self._ledger.release(reservation)
