use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::time::{Duration, SystemTime};

use crate::domain::{ProviderStatus, RuntimeSnapshot, SegmentState};

pub enum TelemetryEvent {
    RecordAccepted {
        encoded_bytes: usize,
        buffered_after: usize,
        account: String,
    },
    RecordRejected {
        duplicate: bool,
        reason: String,
    },
    FlushStarted {
        records: usize,
    },
    FlushFinished {
        records: usize,
        bytes: u64,
        latency: Duration,
    },
    FlushFailed {
        records_retained: usize,
        error: String,
    },
    RetryDepth {
        depth: usize,
    },
    ProviderAttempt {
        provider: String,
        success: bool,
        status: ProviderStatus,
        latency: Duration,
    },
    SegmentObserved {
        segment_id: u64,
        state: SegmentState,
        physical_bytes: u64,
    },
    SegmentRemoved {
        segment_id: u64,
        reclaimed_bytes: u64,
    },
    BufferAge {
        age: Option<Duration>,
    },
    Warning {
        message: String,
    },
    Snapshot,
    ResetWindow,
}

pub struct RuntimeTelemetry {
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
    pub oldest_buffer_age: Option<Duration>,
    pub active_accounts: BTreeSet<String>,
    pub flush_latencies: VecDeque<Duration>,
    pub provider_counts: BTreeMap<String, (u64, u64, ProviderStatus, Duration)>,
    pub segment_states: BTreeMap<u64, (SegmentState, u64)>,
    pub warnings: VecDeque<String>,
    pub latency_capacity: usize,
    pub warning_capacity: usize,
}

impl RuntimeTelemetry {
    pub fn observe(&mut self, event: TelemetryEvent) -> Option<RuntimeSnapshot> {
        match event {
            TelemetryEvent::RecordAccepted {
                encoded_bytes,
                buffered_after,
                account,
            } => {
                self.accepted_records = self.accepted_records.saturating_add(1);
                self.bytes_encoded = self.bytes_encoded.saturating_add(encoded_bytes as u64);
                self.buffered_records = buffered_after;
                if !account.is_empty() {
                    self.active_accounts.insert(account);
                }
                None
            }
            TelemetryEvent::RecordRejected { duplicate, reason } => {
                self.rejected_records = self.rejected_records.saturating_add(1);
                if duplicate {
                    self.duplicate_records = self.duplicate_records.saturating_add(1);
                }
                if !reason.is_empty() {
                    self.warnings
                        .push_back(format!("record rejected: {reason}"));
                }
                while self.warnings.len() > self.warning_capacity {
                    self.warnings.pop_front();
                }
                None
            }
            TelemetryEvent::FlushStarted { records } => {
                self.active_writers = self.active_writers.saturating_add(1);
                if records == 0 {
                    self.warnings
                        .push_back("writer started an empty flush".to_owned());
                }
                while self.warnings.len() > self.warning_capacity {
                    self.warnings.pop_front();
                }
                None
            }
            TelemetryEvent::FlushFinished {
                records,
                bytes,
                latency,
            } => {
                self.active_writers = self.active_writers.saturating_sub(1);
                self.durable_records = self.durable_records.saturating_add(records as u64);
                self.buffered_records = self.buffered_records.saturating_sub(records);
                self.bytes_written = self.bytes_written.saturating_add(bytes);
                self.flush_latencies.push_back(latency);
                while self.flush_latencies.len() > self.latency_capacity {
                    self.flush_latencies.pop_front();
                }
                if latency > Duration::from_secs(5) {
                    self.warnings.push_back(format!(
                        "flush of {records} records took {} milliseconds",
                        latency.as_millis()
                    ));
                }
                while self.warnings.len() > self.warning_capacity {
                    self.warnings.pop_front();
                }
                None
            }
            TelemetryEvent::FlushFailed {
                records_retained,
                error,
            } => {
                self.active_writers = self.active_writers.saturating_sub(1);
                self.writer_failures = self.writer_failures.saturating_add(1);
                self.buffered_records = self.buffered_records.max(records_retained);
                self.warnings.push_back(format!(
                    "flush failed while retaining {records_retained} records: {error}"
                ));
                while self.warnings.len() > self.warning_capacity {
                    self.warnings.pop_front();
                }
                None
            }
            TelemetryEvent::RetryDepth { depth } => {
                self.retry_depth = depth;
                if depth > 100_000 {
                    self.warnings
                        .push_back(format!("retry queue depth is {depth}"));
                }
                while self.warnings.len() > self.warning_capacity {
                    self.warnings.pop_front();
                }
                None
            }
            TelemetryEvent::ProviderAttempt {
                provider,
                success,
                status,
                latency,
            } => {
                let entry = self.provider_counts.entry(provider.clone()).or_insert((
                    0,
                    0,
                    status,
                    Duration::ZERO,
                ));
                entry.0 = entry.0.saturating_add(1);
                if !success {
                    entry.1 = entry.1.saturating_add(1);
                }
                entry.2 = status;
                entry.3 = if entry.3.is_zero() {
                    latency
                } else {
                    let old_micros = entry.3.as_micros();
                    let new_micros = latency.as_micros();
                    let average = old_micros.saturating_mul(7).saturating_add(new_micros) / 8;
                    Duration::from_micros(average.min(u64::MAX as u128) as u64)
                };
                if status == ProviderStatus::Open {
                    self.warnings
                        .push_back(format!("provider {provider} circuit is open"));
                }
                while self.warnings.len() > self.warning_capacity {
                    self.warnings.pop_front();
                }
                None
            }
            TelemetryEvent::SegmentObserved {
                segment_id,
                state,
                physical_bytes,
            } => {
                self.segment_states
                    .insert(segment_id, (state, physical_bytes));
                if state == SegmentState::Quarantined {
                    self.warnings
                        .push_back(format!("segment {segment_id} is quarantined"));
                }
                while self.warnings.len() > self.warning_capacity {
                    self.warnings.pop_front();
                }
                None
            }
            TelemetryEvent::SegmentRemoved {
                segment_id,
                reclaimed_bytes,
            } => {
                self.segment_states.remove(&segment_id);
                self.bytes_reclaimed = self.bytes_reclaimed.saturating_add(reclaimed_bytes);
                None
            }
            TelemetryEvent::BufferAge { age } => {
                self.oldest_buffer_age = age;
                if age.is_some_and(|duration| duration > Duration::from_secs(30)) {
                    self.warnings.push_back(format!(
                        "oldest buffered record is {} milliseconds old",
                        age.unwrap_or_default().as_millis()
                    ));
                }
                while self.warnings.len() > self.warning_capacity {
                    self.warnings.pop_front();
                }
                None
            }
            TelemetryEvent::Warning { message } => {
                if !message.is_empty() {
                    self.warnings.push_back(message);
                }
                while self.warnings.len() > self.warning_capacity {
                    self.warnings.pop_front();
                }
                None
            }
            TelemetryEvent::ResetWindow => {
                self.flush_latencies.clear();
                self.provider_counts.clear();
                self.active_accounts.clear();
                self.warnings.clear();
                self.writer_failures = 0;
                self.rejected_records = 0;
                self.duplicate_records = 0;
                None
            }
            TelemetryEvent::Snapshot => {
                let mut latencies = self.flush_latencies.iter().copied().collect::<Vec<_>>();
                latencies.sort_unstable();
                let percentile = |numerator: usize, denominator: usize| {
                    if latencies.is_empty() {
                        None
                    } else {
                        let scaled = latencies.len().saturating_sub(1).saturating_mul(numerator);
                        let index = (scaled + denominator / 2) / denominator;
                        latencies.get(index.min(latencies.len() - 1)).copied()
                    }
                };
                let provider_failure_rates = self
                    .provider_counts
                    .iter()
                    .map(|(provider, counters)| (provider.clone(), (counters.0, counters.1)))
                    .collect();
                let open_circuits = self
                    .provider_counts
                    .values()
                    .filter(|entry| entry.2 == ProviderStatus::Open)
                    .count();
                let mut segment_state_counts = BTreeMap::new();
                for (state, _) in self.segment_states.values() {
                    let label = match state {
                        SegmentState::Active => "active",
                        SegmentState::Sealed => "sealed",
                        SegmentState::Compacting => "compacting",
                        SegmentState::Superseded => "superseded",
                        SegmentState::Quarantined => "quarantined",
                        SegmentState::Missing => "missing",
                    };
                    *segment_state_counts.entry(label.to_owned()).or_insert(0) += 1;
                }
                Some(RuntimeSnapshot {
                    captured_at: SystemTime::now(),
                    accepted_records: self.accepted_records,
                    rejected_records: self.rejected_records,
                    duplicate_records: self.duplicate_records,
                    durable_records: self.durable_records,
                    buffered_records: self.buffered_records,
                    active_writers: self.active_writers,
                    writer_failures: self.writer_failures,
                    bytes_encoded: self.bytes_encoded,
                    bytes_written: self.bytes_written,
                    bytes_reclaimed: self.bytes_reclaimed,
                    retry_depth: self.retry_depth,
                    open_circuits,
                    active_accounts: self.active_accounts.len(),
                    oldest_buffer_age: self.oldest_buffer_age,
                    flush_latency_p50: percentile(50, 100),
                    flush_latency_p95: percentile(95, 100),
                    flush_latency_p99: percentile(99, 100),
                    provider_failure_rates,
                    segment_state_counts,
                    warnings: self.warnings.iter().cloned().collect(),
                })
            }
        }
    }
}
