"""面向展示/审计的格式化工具。

提供主题解析、供应商标签、交易摘要、审计轨迹与报价徽标等纯函数,
集中控制输出字符串的规范格式,供日志、审计与监控展示复用。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from .model import ProcessOutcome, TradeEvent


def settlement_topic_parser(topic: str) -> tuple[str, str, str]:
    """解析形如 region.domain.channel 的结算主题,返回末三段 (区域, 域, 通道)。

    主题按 "." 分段并取末三段,允许前面携带更多层级前缀(如集群名);
    少于三段时视为非法并抛 ValueError。
    """
    parts = [part.strip().lower() for part in topic.split(".") if part.strip()]
    if len(parts) < 3:
        raise ValueError("topic must contain a region, domain, and channel")
    return parts[-3], parts[-2], parts[-1]


def provider_labeler(provider: str, region: str, healthy: bool = True) -> str:
    """生成供应商展示标签,如 "Acme Corp (US, available)"。

    provider 归一化为标题大小写,region 归一化为大写,缺省分别回退为
    "Unknown Provider" 与 "GLOBAL";healthy 决定状态文案。
    """
    normalized_provider = " ".join(provider.strip().split()).title() or "Unknown Provider"
    normalized_region = region.strip().upper() or "GLOBAL"
    state = "available" if healthy else "unavailable"
    return f"{normalized_provider} ({normalized_region}, {state})"


def trade_event_caption(event: TradeEvent, include_tags: bool = False) -> str:
    """生成一笔交易的摘要文案,如 "A-1001 #42 BUY 1,000.5 AAPL"。

    数量保留 4 位小数并去掉尾零;include_tags=True 时按字母序追加标签。
    """
    direction = "BUY" if event.side == "buy" else "SELL"
    quantity = f"{event.quantity:,.4f}".rstrip("0").rstrip(".")
    caption = f"{event.account} #{event.sequence} {direction} {quantity} {event.instrument}"
    if include_tags and event.tags:
        caption += " [" + ", ".join(sorted(event.tags)) + "]"
    return caption


def audit_trail_caption(actor: str, action: str, sequence: int, context: Mapping[str, str] | None = None) -> str:
    """生成审计轨迹行:序列号固定 8 位补零,后接 actor 与 action。

    actor/action 缺省分别回退为 "system"/"no action";context 的键值对按字典序
    拼成后缀,保证相同上下文输出完全一致(便于审计比对)。
    """
    normalized_actor = actor.strip() or "system"
    normalized_action = " ".join(action.strip().split()) or "no action"
    suffix = " ".join(f"{key}={value}" for key, value in sorted((context or {}).items()))
    base = f"{max(0, sequence):08d} · {normalized_actor} · {normalized_action}"
    return f"{base} ({suffix})" if suffix else base


def quote_sequence_badge(outcomes: Sequence[ProcessOutcome], pair: str = "UNKNOWN") -> str:
    """把一批处理结果汇总成徽标文案,展示检查点与各状态计数。

    pair 归一化为大写并把 "-" 替换为 "/";检查点取所有结果中的最大值,
    无结果时为 -1。
    """
    handled = sum(outcome.state == "handled" for outcome in outcomes)
    duplicate = sum(outcome.state == "duplicate" for outcome in outcomes)
    deferred = sum(outcome.state == "deferred" for outcome in outcomes)
    checkpoint = max((outcome.checkpoint for outcome in outcomes), default=-1)
    normalized_pair = pair.strip().upper().replace("-", "/") or "UNKNOWN"
    return f"{normalized_pair} checkpoint={checkpoint} handled={handled} duplicate={duplicate} deferred={deferred}"
