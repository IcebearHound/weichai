#![allow(dead_code)]
//! 测试支撑库:构造隔离的临时工作区与合成领域对象,供各测试文件复用。

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use buffered_journal_rs::{
    JournalCodec, JournalRecord, ProviderEndpoint, RetryScheduler, SegmentDescriptor, WorkItem,
};

/// 全局递增序号,保证每次创建的临时目录路径唯一。
static DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// 隔离的临时测试工作区:创建时建目录,析构时递归删除。
pub struct TempWorkspace {
    path: PathBuf,
}

impl TempWorkspace {
    pub fn new(label: &str) -> Self {
        let nonce = DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "buffered-journal-{label}-{}-{timestamp}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("create isolated test directory");
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// 合成一条日志记录。
pub fn record(identity: &str, account: &str, occurred_at: i64, payload: &str) -> JournalRecord {
    JournalRecord {
        identity: identity.to_owned(),
        account: account.to_owned(),
        occurred_at,
        payload: payload.to_owned(),
    }
}

/// 合成一条工作项。
pub fn work(key: &str, account: &str, sequence: i64) -> WorkItem {
    WorkItem {
        key: key.to_owned(),
        account: account.to_owned(),
        sequence,
        observed_at: sequence.saturating_mul(10),
        value: sequence as f64 + 0.25,
        weight: 1.0,
        status: "ready".to_owned(),
        tags: vec!["synthetic".to_owned()],
    }
}

/// 测试用编解码器配置(宽容尾部截断)。
pub fn codec() -> JournalCodec {
    JournalCodec {
        version: 2,
        maximum_record_bytes: 1024 * 1024,
        maximum_batch_records: 4096,
        maximum_identity_bytes: 1024,
        maximum_account_bytes: 1024,
        tolerate_trailing_frame: true,
    }
}

/// 合成一个提供方端点。
pub fn endpoint(name: &str, priority: u16) -> ProviderEndpoint {
    ProviderEndpoint {
        name: name.to_owned(),
        address: format!("memory://{name}"),
        priority,
        weight: 1,
        enabled: true,
        connect_timeout: Duration::from_millis(10),
        request_timeout: Duration::from_secs(1),
        failure_limit: 1,
        success_limit: 1,
        cooldown: Duration::from_secs(60),
        max_in_flight: 4,
        capabilities: BTreeSet::from(["quotes".to_owned()]),
    }
}

/// 合成一个调度器(小容量,便于测试)。
pub fn scheduler() -> RetryScheduler {
    RetryScheduler {
        maximum_entries: 128,
        maximum_payload_bytes: 4096,
        minimum_delay_ms: 1,
        maximum_delay_ms: 60_000,
        entries: BTreeMap::new(),
        timeline: BTreeMap::new(),
        account_depth: BTreeMap::new(),
        recent_events: VecDeque::new(),
        event_capacity: 32,
    }
}

/// 合成一个已封存的段描述(账户按 id 取模归属,便于构造多段场景)。
pub fn descriptor(
    root: &Path,
    segment_id: u64,
    first_sequence: u64,
    last_sequence: u64,
    physical_bytes: u64,
) -> SegmentDescriptor {
    let now = SystemTime::now();
    SegmentDescriptor {
        segment_id,
        path: root.join(format!("segment-{segment_id}-g0.bjseg")),
        state: buffered_journal_rs::domain::SegmentState::Sealed,
        generation: 0,
        first_sequence,
        last_sequence,
        first_timestamp_ms: first_sequence as i64,
        last_timestamp_ms: last_sequence as i64,
        logical_bytes: physical_bytes.saturating_mul(8) / 10,
        physical_bytes,
        live_records: last_sequence.saturating_sub(first_sequence) as usize + 1,
        tombstone_records: 0,
        duplicate_records: 0,
        checksum_failures: 0,
        reader_leases: 0,
        replica_acks: BTreeSet::new(),
        account_ranges: BTreeMap::from([(
            format!("account-{}", segment_id % 3),
            (first_sequence, last_sequence),
        )]),
        created_at: now.checked_sub(Duration::from_secs(86_400)).unwrap_or(now),
        sealed_at: Some(now.checked_sub(Duration::from_secs(3_600)).unwrap_or(now)),
        legal_hold: false,
    }
}
