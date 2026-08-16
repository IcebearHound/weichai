"""领域模型定义:结算管道中流转的全部不可变数据对象。

本模块是 settlement_queue 包的"词汇表":金额(Money)、付款意图(PayoutIntent)、
投递收据(DeliveryReceipt)、处理结果(PayoutResult)、重试策略(RetryPolicy)、
网关应答(GatewayReply)、幂等租约(Reservation)、批次计划(BatchPlan)、
净额头寸(NetPosition)、对账发现(ReconcileFinding)、资金边(FundingEdge)
与日志记录(JournalRecord)。统一采用 frozen + slots 的 dataclass,
保证并发共享安全与紧凑的内存布局。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from types import MappingProxyType
from typing import Any, Literal, Mapping


# 付款结果状态:settled=已结算, rejected=被拒绝(终态), deferred=推迟(待重试)
PayoutState = Literal["settled", "rejected", "deferred"]
# 价值日调整规则:向后顺延 / 向前提前 / 修正后延(不跨月时向后,跨月向前)
AdjustmentRule = Literal["following", "preceding", "modified-following"]
# 失败类型分类:瞬时(可重试)/ 永久(不可重试)/ 未知
FailureKind = Literal["transient", "permanent", "unknown"]


@dataclass(frozen=True, slots=True)
class Money:
    """金额:币种 + Decimal 数值(避免浮点误差)。"""
    currency: str
    amount: Decimal


@dataclass(frozen=True, slots=True)
class PayoutIntent:
    """一笔付款意图:由谁付、付给谁、金额、价值日与优先级。

    identity 是意图的业务唯一标识;attributes 携带附加属性(只读映射);
    rail 表示结算通道(如 bank/ach),priority 越小越优先。
    """
    identity: str
    account: str
    beneficiary: str
    money: Money
    value_date: date
    priority: int
    created_at: datetime
    rail: str = "bank"
    attributes: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))


@dataclass(frozen=True, slots=True)
class DeliveryReceipt:
    """一笔已结算付款的投递收据。

    idempotency_key 关联原始意图(幂等键),receipt_id 为收据摘要标识;
    metadata 记录网关返回详情与来源身份,供对账追溯。
    """
    idempotency_key: str
    receipt_id: str
    account: str
    beneficiary: str
    money: Money
    value_date: date
    settled_at: datetime
    gateway_reference: str
    attempts: int
    metadata: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))


@dataclass(frozen=True, slots=True)
class PayoutResult:
    """一次付款尝试的最终结果。

    state 标记最终状态;attempts 为实际尝试次数;receipt 仅在结算成功时
    非空;reason 携带失败/拒绝原因;retry_after 在 deferred 时给出建议重试时间。
    """
    identity: str
    ordinal: int
    state: PayoutState
    attempts: int
    receipt: DeliveryReceipt | None = None
    reason: str | None = None
    retry_after: datetime | None = None


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """重试策略:尝试次数上限、退避延迟区间与抖动比例。

    重试延迟 = base_delay × 2^(attempt-1)(封顶 maximum_delay),
    再叠加 ±jitter_fraction × 延迟 的抖动;retryable_codes 列出可重试的网关码。
    """
    maximum_attempts: int
    base_delay_seconds: float
    maximum_delay_seconds: float
    jitter_fraction: float
    retryable_codes: frozenset[str]


@dataclass(frozen=True, slots=True)
class GatewayReply:
    """网关对一次付款请求的应答。

    accepted 表示是否受理;reference 是网关侧引用号;code/message 为
    结果码与说明;details 携带允许的附加字段(只读映射)。
    """
    accepted: bool
    reference: str
    code: str
    message: str
    completed_at: datetime
    details: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))


@dataclass(frozen=True, slots=True)
class Reservation:
    """幂等租约:同一幂等键在同一时刻只允许一个执行者。

    owner 是执行者标识,version 单调递增用于检测所有权变更;
    committed 标记租约是否已随收据提交而释放。
    """
    key: str
    owner: str
    acquired_at: datetime
    expires_at: datetime
    version: int
    committed: bool = False


@dataclass(frozen=True, slots=True)
class BatchPlan:
    """一批付款的调度计划。

    waves 为按冲突分色后得到的并行波次;rejected 是被拒绝意图及其原因;
    account_totals/currency_totals 为账户/币种汇总;
    scheduled_value_dates 为每个意图调整后的价值日;warnings 为规划期告警。
    """
    waves: tuple[tuple[PayoutIntent, ...], ...]
    rejected: Mapping[str, str]
    account_totals: Mapping[str, Money]
    currency_totals: Mapping[str, Decimal]
    scheduled_value_dates: Mapping[str, date]
    warnings: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class NetPosition:
    """某账户在某个币种上的净额头寸。

    incoming/outgoing 为入/出方向汇总,net 为其差值(正=应收,负=应付);
    gross_count 为笔数,largest_leg 为最大单笔,concentration 衡量单笔集中度。
    """
    account: str
    currency: str
    incoming: Decimal
    outgoing: Decimal
    net: Decimal
    gross_count: int
    largest_leg: Decimal
    concentration: Decimal


@dataclass(frozen=True, slots=True)
class ReconcileFinding:
    """一条对账发现。

    severity 为严重度(info/warning/error);category 为问题类别;
    expected/observed 描述期望值与实际值;repairable 表示是否可自动修复;
    context 携带附加上下文。
    """
    identity: str
    severity: Literal["info", "warning", "error"]
    category: str
    expected: str
    observed: str
    repairable: bool
    context: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))


@dataclass(frozen=True, slots=True)
class FundingEdge:
    """资金转移的一条可用边(渠道)。

    source → target 方向,currency 为币种;capacity 为剩余容量,cost 为单位成本;
    仅在 [available_from, available_until] 窗口内可用;labels 携带特性标签。
    """
    source: str
    target: str
    currency: str
    capacity: Decimal
    cost: Decimal
    available_from: datetime
    available_until: datetime
    labels: frozenset[str] = frozenset()


@dataclass(frozen=True, slots=True)
class JournalRecord:
    """追加式审计日志的一条记录。

    sequence 为单调序号;previous_digest 指向前一条摘要、digest 为自身
    SHA-256 摘要,构成哈希链,可检测篡改与截断。
    """
    sequence: int
    occurred_at: datetime
    category: str
    subject: str
    payload: Mapping[str, Any]
    previous_digest: str
    digest: str
