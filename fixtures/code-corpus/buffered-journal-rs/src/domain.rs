use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordKind {
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
    Tombstone,
    Unknown(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Durability {
    Buffered,
    DataSync,
    FullSync,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlushReason {
    BelowThreshold,
    ThresholdReached,
    TimerElapsed,
    Explicit,
    Shutdown,
    Recovery,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderStatus {
    Closed,
    Open,
    HalfOpen,
    Disabled,
}

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum RetryClass {
    Immediate,
    Transient,
    Congestion,
    ProviderUnavailable,
    StorageBusy,
    Permanent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SegmentState {
    Active,
    Sealed,
    Compacting,
    Superseded,
    Quarantined,
    Missing,
}

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompactionAction {
    Keep,
    Merge,
    Rewrite,
    DropExpired,
    Quarantine,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetentionDecision {
    Preserve,
    Delete,
    DelayForReader,
    DelayForReplica,
    DelayForLegalHold,
    Quarantine,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorkItem {
    pub key: String,
    pub account: String,
    pub sequence: i64,
    pub observed_at: i64,
    pub value: f64,
    pub weight: f64,
    pub status: String,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalRecord {
    pub identity: String,
    pub account: String,
    pub occurred_at: i64,
    pub payload: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppendReceipt {
    pub segment_id: u64,
    pub first_sequence: u64,
    pub last_sequence: u64,
    pub byte_offset: u64,
    pub byte_length: u64,
    pub record_count: usize,
    pub durability: Durability,
    pub committed_at: SystemTime,
    pub checksum: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SegmentDescriptor {
    pub segment_id: u64,
    pub path: PathBuf,
    pub state: SegmentState,
    pub generation: u32,
    pub first_sequence: u64,
    pub last_sequence: u64,
    pub first_timestamp_ms: i64,
    pub last_timestamp_ms: i64,
    pub logical_bytes: u64,
    pub physical_bytes: u64,
    pub live_records: usize,
    pub tombstone_records: usize,
    pub duplicate_records: usize,
    pub checksum_failures: usize,
    pub reader_leases: usize,
    pub replica_acks: BTreeSet<String>,
    pub account_ranges: BTreeMap<String, (u64, u64)>,
    pub created_at: SystemTime,
    pub sealed_at: Option<SystemTime>,
    pub legal_hold: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderEndpoint {
    pub name: String,
    pub address: String,
    pub priority: u16,
    pub weight: u16,
    pub enabled: bool,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    pub failure_limit: usize,
    pub success_limit: usize,
    pub cooldown: Duration,
    pub max_in_flight: usize,
    pub capabilities: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CircuitView {
    pub endpoint: String,
    pub status: ProviderStatus,
    pub consecutive_failures: usize,
    pub consecutive_successes: usize,
    pub total_attempts: u64,
    pub total_failures: u64,
    pub in_flight: usize,
    pub opened_for: Option<Duration>,
    pub last_latency: Option<Duration>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaneReport {
    pub input_ordinal: usize,
    pub identity: String,
    pub account: String,
    pub sequence: i64,
    pub outcome: WorkOutcome,
    pub detail: Option<String>,
    pub processing_time: Duration,
    pub acknowledged: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompactionPlan {
    pub plan_id: String,
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
    pub blocked_by: Vec<String>,
    pub urgency: u8,
}

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
    pub provider_failure_rates: BTreeMap<String, (u64, u64)>,
    pub segment_state_counts: BTreeMap<String, usize>,
    pub warnings: Vec<String>,
}

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
