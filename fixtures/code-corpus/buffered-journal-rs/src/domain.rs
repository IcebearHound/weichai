use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

/// 记录的业务类别(由负载前缀推断)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordKind {
    /// 审计类记录。
    Audit,
    TradeAccepted,
    TradeRejected,
    QuoteObserved,
    SettlementStarted,
    SettlementCompleted,
    SettlementFailed,
    AccountCheckpoint,
    ProviderHealth,
    Administrative,
    /// 墓碑记录:标记旧数据已过期,是压缩回收的候选。
    Tombstone,
    Unknown(String),
}

/// 持久化强度:决定写入时调用哪些 fsync。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Durability {
    /// 仅刷用户态缓冲,不 fsync(最快,掉电可能丢)。
    Buffered,
    /// 同步数据(不保证元数据)。
    DataSync,
    /// 完整 fsync(最安全,最慢)。
    FullSync,
}

/// 触发一次刷盘的原因(诊断用途)。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlushReason {
    BelowThreshold,
    ThresholdReached,
    TimerElapsed,
    Explicit,
    Shutdown,
    Recovery,
}

/// 服务提供方熔断状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderStatus {
    /// 熔断已打开:暂时不派发请求。
    Closed,
    /// 正常运行。
    Open,
    /// 半开:放行试探请求验证恢复。
    HalfOpen,
    /// 被配置禁用。
    Disabled,
}

/// 一次工作项处理的最终结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkOutcome {
    Pending,
    Handled,
    Duplicate,
    StaleSequence,
    HandlerFailed,
    AcknowledgementFailed,
    RejectedDuringShutdown,
}

/// 重试类别:决定退避基数与是否允许重试。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum RetryClass {
    Immediate,
    Transient,
    Congestion,
    ProviderUnavailable,
    StorageBusy,
    /// 永久失败:不允许重试。
    Permanent,
}

/// 段生命周期状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SegmentState {
    /// 正在接收写入。
    Active,
    /// 已封存:不再接收写入,等待压缩/保留。
    Sealed,
    Compacting,
    /// 已被更新一代的段取代(压缩产物)。
    Superseded,
    /// 数据可疑,隔离待人工处理。
    Quarantined,
    Missing,
}

/// 单帧(批量内的记录)完整性检查结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameStatus {
    Complete,
    TruncatedHeader,
    TruncatedPayload,
    InvalidMagic,
    UnsupportedVersion,
    ChecksumMismatch,
    Oversized,
    SequenceRegression,
}

/// 压缩动作。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompactionAction {
    Keep,
    Merge,
    Rewrite,
    DropExpired,
    Quarantine,
}

/// 保留决策:决定段是否可被删除。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetentionDecision {
    Preserve,
    Delete,
    /// 有活跃读者租约,暂缓。
    DelayForReader,
    /// 副本尚未确认,暂缓。
    DelayForReplica,
    /// 处于法律保留期,暂缓。
    DelayForLegalHold,
    Quarantine,
}

/// 一条待处理的工作项(与 JournalRecord 相对,面向执行器)。
#[derive(Clone, Debug, PartialEq)]
pub struct WorkItem {
    /// 全局唯一键(account:sequence:key 的原始部分)。
    pub key: String,
    pub account: String,
    pub sequence: i64,
    pub observed_at: i64,
    pub value: f64,
    pub weight: f64,
    pub status: String,
    pub tags: Vec<String>,
}

/// 一条日志记录:带全局唯一身份与账户归属。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalRecord {
    /// 全局唯一身份,用于幂等去重。
    pub identity: String,
    pub account: String,
    /// 事件发生时刻(毫秒时间戳)。
    pub occurred_at: i64,
    /// 记录内容(通常以类别前缀开头,如 `trade.accepted|...`)。
    pub payload: String,
}

/// 一次追加操作的回执。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppendReceipt {
    pub segment_id: u64,
    pub first_sequence: u64,
    pub last_sequence: u64,
    /// 批次在段文件中的起始字节偏移。
    pub byte_offset: u64,
    pub byte_length: u64,
    pub record_count: usize,
    pub durability: Durability,
    pub committed_at: SystemTime,
    pub checksum: u64,
}

/// 一个段文件的可观测描述(扫描/规划/报告用)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SegmentDescriptor {
    pub segment_id: u64,
    pub path: PathBuf,
    pub state: SegmentState,
    /// 代际:同 id 每经一次重写 +1,用于区分新旧版本。
    pub generation: u32,
    pub first_sequence: u64,
    pub last_sequence: u64,
    pub first_timestamp_ms: i64,
    pub last_timestamp_ms: i64,
    /// 记录内容净字节数(不含帧头/校验等开销)。
    pub logical_bytes: u64,
    pub physical_bytes: u64,
    pub live_records: usize,
    /// 墓碑记录数(压缩回收候选)。
    pub tombstone_records: usize,
    pub duplicate_records: usize,
    pub checksum_failures: usize,
    /// 当前持有读租约的读者数。
    pub reader_leases: usize,
    pub replica_acks: BTreeSet<String>,
    /// 账户 -> (该账户在此段中的序列范围)。
    pub account_ranges: BTreeMap<String, (u64, u64)>,
    pub created_at: SystemTime,
    pub sealed_at: Option<SystemTime>,
    pub legal_hold: bool,
}

/// 服务提供方端点配置。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderEndpoint {
    pub name: String,
    pub address: String,
    /// 优先级:越小越优先。
    pub priority: u16,
    /// 同优先级内的加权轮询权重。
    pub weight: u16,
    pub enabled: bool,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    /// 打开熔断所需的连续失败数。
    pub failure_limit: usize,
    /// 半开探测成功后关闭熔断所需的连续成功数。
    pub success_limit: usize,
    pub cooldown: Duration,
    /// 该端点的最大并发在途请求数。
    pub max_in_flight: usize,
    pub capabilities: BTreeSet<String>,
}

/// 单个端点的熔断器可观测视图。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CircuitView {
    pub endpoint: String,
    pub status: ProviderStatus,
    pub consecutive_failures: usize,
    pub consecutive_successes: usize,
    pub total_attempts: u64,
    pub total_failures: u64,
    pub in_flight: usize,
    /// 熔断已打开的持续时长。
    pub opened_for: Option<Duration>,
    pub last_latency: Option<Duration>,
    pub last_error: Option<String>,
}

/// 执行器对单条工作项的处理报告。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaneReport {
    /// 输入批次中的原始序号。
    pub input_ordinal: usize,
    pub identity: String,
    pub account: String,
    pub sequence: i64,
    pub outcome: WorkOutcome,
    pub detail: Option<String>,
    pub processing_time: Duration,
    pub acknowledged: bool,
}

/// 一次压缩规划。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompactionPlan {
    pub plan_id: String,
    /// 参与压缩的输入段 id 列表。
    pub inputs: Vec<u64>,
    pub action: CompactionAction,
    pub destination_generation: u32,
    pub estimated_read_bytes: u64,
    pub estimated_write_bytes: u64,
    pub estimated_reclaimed_bytes: u64,
    pub earliest_sequence: u64,
    pub latest_sequence: u64,
    pub accounts: BTreeSet<String>,
    pub reasons: Vec<String>,
    /// 阻止执行的阻塞因素(有则 action 必为 Keep)。
    pub blocked_by: Vec<String>,
    /// 0-99,越高越紧急。
    pub urgency: u8,
}

/// 运行时全貌快照(遥测)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeSnapshot {
    pub captured_at: SystemTime,
    pub accepted_records: u64,
    pub rejected_records: u64,
    pub duplicate_records: u64,
    pub durable_records: u64,
    pub buffered_records: usize,
    pub active_writers: usize,
    pub writer_failures: u64,
    pub bytes_encoded: u64,
    pub bytes_written: u64,
    pub bytes_reclaimed: u64,
    pub retry_depth: usize,
    pub open_circuits: usize,
    pub active_accounts: usize,
    pub oldest_buffer_age: Option<Duration>,
    pub flush_latency_p50: Option<Duration>,
    pub flush_latency_p95: Option<Duration>,
    pub flush_latency_p99: Option<Duration>,
    /// 提供方 -> (尝试数, 失败数)。
    pub provider_failure_rates: BTreeMap<String, (u64, u64)>,
    /// 段状态标签 -> 段数。
    pub segment_state_counts: BTreeMap<String, usize>,
    pub warnings: Vec<String>,
}

/// 一次维护循环的报告。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MaintenanceReport {
    pub started_at: SystemTime,
    pub finished_at: SystemTime,
    pub scanned_segments: usize,
    pub repaired_segments: usize,
    pub quarantined_segments: usize,
    pub compacted_segments: usize,
    pub deleted_segments: usize,
    pub retained_segments: usize,
    pub records_recovered: usize,
    pub records_discarded: usize,
    pub bytes_read: u64,
    pub bytes_written: u64,
    pub bytes_reclaimed: u64,
    pub checkpoint_advanced_to: Option<u64>,
    pub actions: Vec<String>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}
