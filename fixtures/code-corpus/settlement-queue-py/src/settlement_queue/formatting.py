"""面向展示/审计的格式化工具。

提供报价队列标签、结算队列名、供应商路由文案、交易收据格式化
与批次审计标题等纯函数,统一输出字符串的规范格式,
供日志、审计与监控展示复用。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal

from .model import DeliveryReceipt, PayoutResult


def quote_queue_label(base: str, counter: str, priority: int, region: str = "global") -> str:
    """生成报价队列标签,如 "quotes.eu.usd-jpy.p3"。

    币种大写、region 归一化为小写连字符,priority 夹到 [0,9]。
    """
    normalized_base = base.strip().upper()
    normalized_counter = counter.strip().upper()
    normalized_region = "-".join(region.strip().lower().split()) or "global"
    bounded_priority = max(0, min(9, int(priority)))
    pair = f"{normalized_base}-{normalized_counter}"
    return f"quotes.{normalized_region}.{pair}.p{bounded_priority}"


def settlement_queue_name(region: str, currency: str, rail: str, expedited: bool = False) -> str:
    """生成结算队列名,如 "settlement.eu.usd.bank.standard"。

    缺省值分别回退为 unknown/xxx/default;expedited 追加 ".express" 后缀。
    """
    safe_region = "-".join(region.strip().lower().split()) or "unknown"
    safe_currency = currency.strip().lower() or "xxx"
    safe_rail = "-".join(rail.strip().lower().split()) or "default"
    suffix = ".express" if expedited else ".standard"
    return f"settlement.{safe_region}.{safe_currency}.{safe_rail}{suffix}"


def provider_route_caption(path: Sequence[str], latency_ms: float | None = None) -> str:
    """生成供应商路由文案,如 "A → B (42.5 ms, fast)"。

    latency 按阈值分档:fast(<50ms) / normal(<250ms) / slow。
    """
    normalized = [provider.strip() for provider in path if provider.strip()]
    route = " → ".join(normalized) if normalized else "no provider"
    if latency_ms is None:
        return route
    latency = max(0, latency_ms)
    band = "fast" if latency < 50 else "normal" if latency < 250 else "slow"
    return f"{route} ({latency:,.1f} ms, {band})"


def trade_receipt_formatter(receipt: DeliveryReceipt, ordinal: int = 0) -> str:
    """格式化交易收据,如 "#1 Alice received 1,000.00 USD [REF123]"。

    beneficiary 缺省回退为 "unknown beneficiary",引用号优先用网关引用。
    """
    money = f"{receipt.money.amount:,.2f} {receipt.money.currency.upper()}"
    beneficiary = receipt.beneficiary.strip() or "unknown beneficiary"
    reference = receipt.gateway_reference.strip() or receipt.receipt_id
    return f"#{ordinal + 1} {beneficiary} received {money} [{reference}]"


def audit_batch_heading(
    results: Sequence[PayoutResult],
    tags: Mapping[str, str] | None = None,
) -> str:
    """生成批次审计标题:统计 settled/rejected/deferred 数量与总尝试次数。

    tags 的键值对按字典序拼成上下文后缀,保证相同上下文输出一致。
    """
    settled = sum(result.state == "settled" for result in results)
    rejected = sum(result.state == "rejected" for result in results)
    deferred = sum(result.state == "deferred" for result in results)
    attempts = sum(result.attempts for result in results)
    context = " ".join(f"{key}={value}" for key, value in sorted((tags or {}).items()))
    summary = f"batch: {settled} settled, {rejected} rejected, {deferred} deferred, {attempts} attempts"
    return f"{summary} ({context})" if context else summary
