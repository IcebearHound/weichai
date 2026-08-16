"""分区化事件泵:按账户泳道串行消费,保证"每账户内严格有序、跨账户并行"。

每个账户一条 asyncio 泳道:新事件在尾部挂一个 future 作为闸门,只有前序事件
完成(或失败)后才放行,天然实现同一账户的顺序性;不同账户互不阻塞。
同时承担去重(基于近期已确认消息)、背压(泳道数与排队上限)、超时控制
与检查点提交。
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from .checkpoint import CheckpointStore
from .model import EventHeaders, LaneSnapshot, ProcessOutcome, QueuePolicy, TradeEvent


# 处理回调:消费一条事件(无返回值);确认回调:处理成功后向代理确认投递
Processor = Callable[[TradeEvent], Awaitable[None]]
Acknowledger = Callable[[TradeEvent, EventHeaders], Awaitable[None]]


class PartitionedEventPump:
    """消费泵主体。

    consume 提交一条事件处理;snapshot 返回各泳道观测快照;
    close 置关闭标志并等待所有泳道排空。内部用一把 asyncio.Lock
    保护泳道表与去重表。
    """

    def __init__(
        self,
        checkpoints: CheckpointStore,
        policy: QueuePolicy,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if policy.maximum_lanes < 1 or policy.maximum_queued_per_lane < 1:
            raise ValueError("lane limits must be positive")
        if policy.processing_timeout_seconds <= 0 or policy.acknowledgement_timeout_seconds <= 0:
            raise ValueError("timeouts must be positive")
        if policy.dedup_retention_seconds < 0 or policy.lane_idle_seconds < 0:
            raise ValueError("retention intervals must be non-negative")
        self._checkpoints = checkpoints
        self._policy = policy
        self._clock = clock or (lambda: datetime.now(UTC))
        self._guard = asyncio.Lock()
        self._lanes: dict[str, dict[str, object]] = {}
        self._acknowledged: dict[str, datetime] = {}
        self._closing = False

    async def consume(
        self,
        event: TradeEvent,
        headers: EventHeaders,
        process: Processor,
        acknowledge: Acknowledger,
    ) -> ProcessOutcome:
        """消费一条事件,返回处理结果 ProcessOutcome。

        流程:
        1) 清理过期的去重记录(超过 dedup_retention_seconds);
        2) 命中去重表 → 直接返回 duplicate;
        3) 在账户泳道尾部排入闸门,排队超过 maximum_queued_per_lane 抛错;
        4) 等待前序闸门放行,与检查点比对(落后/等于检查点判为重复或抛错);
        5) 依次执行 process(超时 processing_timeout_seconds)与 acknowledge
           (超时 acknowledgement_timeout_seconds),成功后提交检查点;
        6) finally 中释放闸门、恢复泳道计数,泳道清空即销毁。

        任何异常都会使泳道 failures 计数 +1 并原样向上抛,由上层转入死信。
        """
        if not event.message_id.strip() or not event.account.strip():
            raise ValueError("message_id and account are required")
        if event.sequence < 0 or not isinstance(event.sequence, int):
            raise ValueError("sequence must be a non-negative integer")
        if event.quantity <= 0:
            raise ValueError("quantity must be positive")
        if headers.partition < 0 or headers.offset < 0:
            raise ValueError("partition and offset must be non-negative")
        admitted_at = self._clock()
        if admitted_at.tzinfo is None:
            admitted_at = admitted_at.replace(tzinfo=UTC)
        loop = asyncio.get_running_loop()
        async with self._guard:
            if self._closing:
                raise RuntimeError("event pump is closing")
            cutoff_seconds = admitted_at.timestamp() - self._policy.dedup_retention_seconds
            for message_id, acknowledged_at in tuple(self._acknowledged.items()):
                # 滑动窗口清理:只保留窗口内的消息 ID,避免去重表无限膨胀
                if acknowledged_at.timestamp() < cutoff_seconds:
                    self._acknowledged.pop(message_id, None)
            if event.message_id in self._acknowledged:
                checkpoint = await self._checkpoints.load(event.account)
                return ProcessOutcome(
                    event.message_id,
                    event.account,
                    event.sequence,
                    "duplicate",
                    admitted_at,
                    admitted_at,
                    checkpoint.sequence if checkpoint is not None else -1,
                )
            lane = self._lanes.get(event.account)
            if lane is None:
                if len(self._lanes) >= self._policy.maximum_lanes:
                    raise RuntimeError("maximum active lane count reached")
                # 空泳道的首个闸门直接放行
                predecessor = loop.create_future()
                predecessor.set_result(None)
                lane = {
                    "tail": predecessor,
                    "queued": 0,
                    "in_flight": False,
                    "failures": 0,
                    "oldest": admitted_at,
                    "last_message_id": None,
                }
                self._lanes[event.account] = lane
            queued = int(lane["queued"])
            if queued >= self._policy.maximum_queued_per_lane:
                raise RuntimeError(f"lane backlog limit reached for {event.account}")
            predecessor = lane["tail"]
            # 新闸门挂在队尾,构成链式串行:只有前序任务完成后才会放行
            gate = loop.create_future()
            lane["tail"] = gate
            lane["queued"] = queued + 1
            if queued == 0:
                # 泳道从空变非空,记录最老入队时间供监控
                lane["oldest"] = admitted_at
        try:
            try:
                # shield 防止前序任务被取消时本任务连带取消;
                # 前序失败不阻塞后继处理,因此异常被有意吞掉
                await asyncio.shield(predecessor)
            except Exception:
                pass
            started_at = self._clock()
            if started_at.tzinfo is None:
                started_at = started_at.replace(tzinfo=UTC)
            async with self._guard:
                if event.message_id in self._acknowledged:
                    checkpoint = await self._checkpoints.load(event.account)
                    completed_at = self._clock()
                    return ProcessOutcome(
                        event.message_id,
                        event.account,
                        event.sequence,
                        "duplicate",
                        started_at,
                        completed_at,
                        checkpoint.sequence if checkpoint is not None else -1,
                    )
                lane["in_flight"] = True
            checkpoint = await self._checkpoints.load(event.account)
            if checkpoint is not None and event.sequence <= checkpoint.sequence:
                if checkpoint.message_id == event.message_id:
                    # 序列号不晚于检查点且消息一致:已确认过,幂等返回 duplicate
                    async with self._guard:
                        self._acknowledged[event.message_id] = started_at
                    return ProcessOutcome(
                        event.message_id,
                        event.account,
                        event.sequence,
                        "duplicate",
                        started_at,
                        self._clock(),
                        checkpoint.sequence,
                    )
                raise ValueError(
                    f"sequence {event.sequence} is not after checkpoint {checkpoint.sequence} for {event.account}"
                )
            try:
                await asyncio.wait_for(process(event), timeout=self._policy.processing_timeout_seconds)
            except Exception:
                async with self._guard:
                    lane["failures"] = int(lane["failures"]) + 1
                raise
            try:
                await asyncio.wait_for(
                    acknowledge(event, headers),
                    timeout=self._policy.acknowledgement_timeout_seconds,
                )
            except Exception:
                async with self._guard:
                    lane["failures"] = int(lane["failures"]) + 1
                raise
            committed = await self._checkpoints.commit(
                event.account,
                event.sequence,
                event.message_id,
                headers.partition,
                headers.offset,
                self._clock(),
            )
            completed_at = self._clock()
            if completed_at.tzinfo is None:
                completed_at = completed_at.replace(tzinfo=UTC)
            async with self._guard:
                self._acknowledged[event.message_id] = completed_at
                # 记录最近成功消息,供快照观测
                lane["last_message_id"] = event.message_id
            return ProcessOutcome(
                event.message_id,
                event.account,
                event.sequence,
                "handled",
                started_at,
                completed_at,
                committed.sequence,
            )
        finally:
            async with self._guard:
                lane["in_flight"] = False
                lane["queued"] = max(0, int(lane["queued"]) - 1)
                # 即使本事件失败也放行后继,保证泳道不断流
                if not gate.done():
                    gate.set_result(None)
                if int(lane["queued"]) == 0:
                    lane["oldest"] = None
                    if self._lanes.get(event.account) is lane:
                        # 泳道排空即销毁,释放资源
                        self._lanes.pop(event.account, None)

    async def snapshot(self) -> tuple[LaneSnapshot, ...]:
        """返回所有活跃泳道的观测快照,按排队数降序、账户升序排列。

        在锁外逐个加载检查点,避免在持锁期间做磁盘 I/O。
        """
        async with self._guard:
            lane_rows = tuple((account, dict(values)) for account, values in self._lanes.items())
        snapshots: list[LaneSnapshot] = []
        for account, values in lane_rows:
            checkpoint = await self._checkpoints.load(account)
            snapshots.append(
                LaneSnapshot(
                    account=account,
                    queued=int(values["queued"]),
                    in_flight=bool(values["in_flight"]),
                    checkpoint=checkpoint.sequence if checkpoint is not None else -1,
                    last_message_id=str(values["last_message_id"]) if values["last_message_id"] is not None else None,
                    failures=int(values["failures"]),
                    oldest_enqueued_at=values["oldest"] if isinstance(values["oldest"], datetime) else None,
                )
            )
        return tuple(sorted(snapshots, key=lambda row: (-row.queued, row.account)))

    async def close(self) -> tuple[LaneSnapshot, ...]:
        """关闭泵:拒绝新事件,等待所有泳道排空后返回最终快照。

        仅等待各泳道队尾闸门(意味着其后所有排队的任务均已结束),
        而不等待可能仍在处理中的任务本体,保证调用方不会死锁。
        """
        async with self._guard:
            self._closing = True
            tails = tuple(values["tail"] for values in self._lanes.values())
        if tails:
            await asyncio.gather(*(asyncio.shield(tail) for tail in tails), return_exceptions=True)
        return await self.snapshot()
