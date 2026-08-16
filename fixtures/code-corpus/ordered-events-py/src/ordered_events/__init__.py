"""ordered_events:有序事件消费管道的公共入口。

本包提供从代理原始记录解码、按账户泳道有序消费、检查点持久化、
去重、死信重试、重放规划、分区租约协调与遥测聚合的完整能力。
通过 __init__ 将各模块的核心类型与函数统一导出,外部只需
`from ordered_events import ...` 即可使用,无需关心内部模块结构。
"""

from .adapters import BrokerEventAdapter
from .backpressure import BackpressureWindow
from .checkpoint import CheckpointStore
from .deadletter import DeadLetterQueue
from .journal import EventJournal
from .model import (
    BrokerRecord,
    Checkpoint,
    DeadLetter,
    EventHeaders,
    JournalEntry,
    LaneSnapshot,
    PartitionLease,
    ProcessOutcome,
    QueuePolicy,
    ReplaySlice,
    TelemetryPoint,
    TradeEvent,
)
from .ordering import SequenceAnalyzer
from .partition import PartitionCoordinator
from .pump import PartitionedEventPump
from .replay import ReplayPlanner
from .supervisor import ConsumptionSupervisor
from .telemetry import EventTelemetry
from .formatting import (
    audit_trail_caption,
    provider_labeler,
    quote_sequence_badge,
    settlement_topic_parser,
    trade_event_caption,
)

__all__ = [
    "BackpressureWindow",
    "BrokerEventAdapter",
    "BrokerRecord",
    "Checkpoint",
    "CheckpointStore",
    "ConsumptionSupervisor",
    "DeadLetter",
    "DeadLetterQueue",
    "EventHeaders",
    "EventJournal",
    "EventTelemetry",
    "JournalEntry",
    "LaneSnapshot",
    "PartitionCoordinator",
    "PartitionLease",
    "PartitionedEventPump",
    "ProcessOutcome",
    "QueuePolicy",
    "ReplayPlanner",
    "ReplaySlice",
    "SequenceAnalyzer",
    "TelemetryPoint",
    "TradeEvent",
    "audit_trail_caption",
    "provider_labeler",
    "quote_sequence_badge",
    "settlement_topic_parser",
    "trade_event_caption",
]
