//! 账户流处理库:按账户分片的消息投递、序列账本、回执编解码与重试调度。
//!
//! 本库围绕“账户流(account stream)”这一核心抽象组织:每个账户拥有独立的、
//! 严格递增的消息序列,所有模块共同保证同一账户的消息按序、恰好一次地处理,
//! 同时不同账户之间可以并行推进。

pub mod account_partitioner;
pub mod partitioned_inbox;
pub mod quote_token_parser;
pub mod receipt_codec;
pub mod retry_schedule;
pub mod retrying_payout_book;
pub mod sequence_ledger;
pub mod shutdown_ledger;

pub use account_partitioner::{AccountPartitioner, PartitionBalance};
pub use partitioned_inbox::{
    DeliveryOutcome, InboxError, InboxSnapshot, LaneSnapshot, PartitionedInbox, StreamMessage,
};
pub use quote_token_parser::{ParsedCommand, QuoteTokenParser};
pub use receipt_codec::{ReceiptCodec, ReceiptEnvelope};
pub use retry_schedule::RetrySchedule;
pub use retrying_payout_book::{
    Payout, PayoutBookSnapshot, PayoutReceipt, PayoutResult, RetryingPayoutBook,
};
pub use sequence_ledger::{SequenceLedger, SequenceObservation, SequenceSnapshot};
pub use shutdown_ledger::{PendingRecord, ShutdownLedger, ShutdownSnapshot};
