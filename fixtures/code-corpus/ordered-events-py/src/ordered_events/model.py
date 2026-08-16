"""领域模型定义:有序事件管道中流转的全部不可变数据对象。

本模块是 ordered_events 包的"词汇表"——其它模块都通过这里定义的 dataclass
交换数据。统一采用 frozen + slots 的 dataclass 有两个原因:
1) 不可变性保证共享对象在并发消费场景下不会被意外修改;
2) 紧凑的内存布局适合高频创建的事件流场景。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from types import MappingProxyType
from typing import Any, Literal, Mapping


# 消费结果状态:handled=成功处理, duplicate=重复消息, replayed=重放命中, deferred=延迟处理
ConsumeState = Literal["handled", "duplicate", "replayed", "deferred"]
# 死信原因分类:处理失败 / 确认失败 / 序列异常 / 反序列化失败 / 已过期
DeadLetterReason = Literal["processing", "acknowledgement", "sequence", "deserialization", "expired"]


@dataclass(frozen=True, slots=True)
class TradeEvent:
    """一笔已从代理记录解码出来的交易事件。

    message_id 是全局唯一标识;account + sequence 构成同一账户内的顺序坐标,
    消费端依靠这对坐标保证"每账户内严格有序"。payload 是剔除保留字段后的
    原始负载(只读映射),tags 用于携带轻量级筛选标签。
    """
    message_id: str
    account: str
    sequence: int
    occurred_at: datetime
    instrument: str
    side: Literal["buy", "sell"]
    quantity: float
    payload: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))
    tags: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class EventHeaders:
    """事件在代理中的投递元数据。

    记录事件来自哪个 topic/分区/偏移量,以及接收时间、关联 ID 与重试次数。
    attempt 从 1 开始,每次重新投递 +1,供去重与死信重试策略使用。
    """
    topic: str
    partition: int
    offset: int
    received_at: datetime
    correlation_id: str
    attempt: int = 1


@dataclass(frozen=True, slots=True)
class ProcessOutcome:
    """一次 consume 调用的处理结果。

    state 标记最终状态;checkpoint 是本次处理后该账户提交的检查点序号
    (重复消息场景下则为已存在的检查点);reason 仅在失败时携带补充说明。
    """
    message_id: str
    account: str
    sequence: int
    state: ConsumeState
    started_at: datetime
    completed_at: datetime
    checkpoint: int
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class Checkpoint:
    """某账户已确认消费到的位置标记。

    sequence 表示该账户已处理到的最大连续序号,message_id 是落盘时的消息标识;
    generation 单调递增,用于在恢复/合并场景下比较检查点的新旧。
    """
    account: str
    sequence: int
    message_id: str
    partition: int
    offset: int
    committed_at: datetime
    generation: int


@dataclass(frozen=True, slots=True)
class ReplaySlice:
    """为一个账户规划出的重放区间。

    from_sequence/through_sequence 是目标区间边界;events 是区间内实际可用于
    重放的事件;missing_sequences 是区间内的空洞;duplicate_ids 是区间内重复
    的消息 ID;complete=False 表示存在空洞、重放不完整。
    """
    account: str
    from_sequence: int
    through_sequence: int
    events: tuple[TradeEvent, ...]
    missing_sequences: tuple[int, ...]
    duplicate_ids: tuple[str, ...]
    complete: bool


@dataclass(frozen=True, slots=True)
class DeadLetter:
    """一条死信记录。

    保存失败事件的完整上下文(事件、头、原因、详情、失败时间、尝试次数);
    next_retry_at 为空表示该条已"终态"(不再重试,可能是达到最大次数或
    原因不可恢复)。
    """
    event: TradeEvent
    headers: EventHeaders
    reason: DeadLetterReason
    detail: str
    failed_at: datetime
    attempts: int
    next_retry_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class PartitionLease:
    """消费者对某个分区的租约。

    owner 持有时长 lease_seconds,expires_at 过期后其它消费者可抢占;
    generation 记录租约的续租代数;accounts 列出该分区负责的账户集合。
    """
    partition: int
    owner: str
    acquired_at: datetime
    expires_at: datetime
    generation: int
    accounts: frozenset[str] = frozenset()


@dataclass(frozen=True, slots=True)
class LaneSnapshot:
    """某个账户处理泳道在某一时刻的观测快照。

    用于监控与运维:queued 表示排队中消息数,in_flight 表示是否正在处理,
    failures 是累计失败次数,oldest_enqueued_at 是队列中最老消息的入队时间。
    """
    account: str
    queued: int
    in_flight: bool
    checkpoint: int
    last_message_id: str | None
    failures: int
    oldest_enqueued_at: datetime | None


@dataclass(frozen=True, slots=True)
class QueuePolicy:
    """控制泵消费行为的策略参数。

    maximum_lanes 限制同时活跃的账户泳道数;maximum_queued_per_lane 限制单泳道
    积压;processing_timeout/acknowledgement_timeout 分别约束处理与确认的耗时上限;
    dedup_retention_seconds 决定去重表保留多久;lane_idle_seconds 用于判定泳道空闲。
    """
    maximum_lanes: int
    maximum_queued_per_lane: int
    processing_timeout_seconds: float
    acknowledgement_timeout_seconds: float
    dedup_retention_seconds: float
    lane_idle_seconds: float


@dataclass(frozen=True, slots=True)
class TelemetryPoint:
    """一个时间点的遥测观测值。

    metric 是指标名,value/unit 为数值与单位,labels 携带维度标签(只读映射),
    供 EventTelemetry 聚合出统计摘要。
    """
    observed_at: datetime
    account: str
    metric: str
    value: float
    unit: str
    labels: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))


@dataclass(frozen=True, slots=True)
class JournalEntry:
    """追加式日志中的一条记录。

    previous_digest 指向前一条的 SHA-256 摘要、digest 为自身摘要,
    两者构成哈希链,可检测日志被篡改或截断;ordinal 是单调序号。
    """
    ordinal: int
    written_at: datetime
    category: str
    subject: str
    fields: Mapping[str, Any]
    previous_digest: str
    digest: str


@dataclass(frozen=True, slots=True)
class BrokerRecord:
    """从消息代理读取/写入的原始记录(字节级)。

    key/value 是消息键值,topic/partition/offset 定位其在代理中的位置,
    headers 是键值头(值统一以 bytes 承载)。
    """
    key: bytes
    value: bytes
    topic: str
    partition: int
    offset: int
    timestamp: datetime
    headers: tuple[tuple[str, bytes], ...] = ()
