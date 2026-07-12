#![forbid(unsafe_code)]

pub mod accumulator;
pub mod checkpoint;
pub mod codec;
pub mod compaction;
pub mod domain;
pub mod engine;
pub mod executor;
pub mod formatting;
pub mod index;
pub mod recovery;
pub mod replica;
pub mod retention;
pub mod scheduler;
pub mod segment;
pub mod telemetry;

pub use accumulator::{BatchWriter, JournalAccumulator};
pub use checkpoint::{CheckpointLedger, CheckpointOperation, CheckpointOutcome};
pub use codec::JournalCodec;
pub use compaction::CompactionPlanner;
pub use domain::{
    AppendReceipt, CircuitView, CompactionAction, CompactionPlan, Durability, FlushReason,
    JournalRecord, LaneReport, MaintenanceReport, ProviderEndpoint, ProviderStatus, RecordKind,
    RetentionDecision, RetryClass, RuntimeSnapshot, SegmentDescriptor, WorkItem, WorkOutcome,
};
pub use engine::{EngineCommand, EngineOutcome, JournalEngine};
pub use executor::{KeyedRecordExecutor, RecordAcknowledger, RecordHandler};
pub use formatting::{
    audit_flush_label, provider_route_slug, quote_frame_caption, settlement_banner,
    trade_event_title,
};
pub use index::SparseIndex;
pub use recovery::RecoveryScanner;
pub use replica::{ProviderInvoker, ReplicaSelector};
pub use retention::RetentionPolicy;
pub use scheduler::{RetryScheduler, RetryTicket, SchedulerCommand, SchedulerOutcome};
pub use segment::SegmentFile;
pub use telemetry::{RuntimeTelemetry, TelemetryEvent};
