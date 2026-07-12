use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use crate::accumulator::JournalAccumulator;
use crate::checkpoint::{CheckpointLedger, CheckpointOperation, CheckpointOutcome};
use crate::codec::JournalCodec;
use crate::compaction::CompactionPlanner;
use crate::domain::{
    CompactionAction, Durability, JournalRecord, MaintenanceReport, RetentionDecision,
    RuntimeSnapshot, SegmentState,
};
use crate::recovery::RecoveryScanner;
use crate::retention::RetentionPolicy;
use crate::scheduler::{RetryScheduler, SchedulerCommand, SchedulerOutcome};
use crate::segment::SegmentFile;
use crate::telemetry::{RuntimeTelemetry, TelemetryEvent};

pub enum EngineCommand {
    Append {
        records: Vec<JournalRecord>,
    },
    FlushDue,
    Retry(SchedulerCommand),
    Maintain {
        repair: bool,
        disk_pressure_per_mille: u16,
    },
    Snapshot,
    Shutdown,
}

pub enum EngineOutcome {
    Append {
        accepted: usize,
        durable: usize,
    },
    Flushed(usize),
    Retry(SchedulerOutcome),
    Maintenance(MaintenanceReport),
    Snapshot(RuntimeSnapshot),
    Shutdown {
        durable: usize,
        checkpoint_epoch: u64,
    },
}

pub struct JournalEngine {
    directory: PathBuf,
    durability: Durability,
    maximum_segment_bytes: u64,
    codec: JournalCodec,
    accumulator: JournalAccumulator,
    active_segment: Mutex<Arc<SegmentFile>>,
    next_segment_id: AtomicU64,
    recovery: RecoveryScanner,
    compaction: CompactionPlanner,
    retention: RetentionPolicy,
    checkpoint: CheckpointLedger,
    scheduler: Mutex<RetryScheduler>,
    telemetry: Mutex<RuntimeTelemetry>,
}

impl JournalEngine {
    pub fn open(
        directory: impl AsRef<Path>,
        durability: Durability,
        maximum_segment_bytes: u64,
    ) -> Result<Self, String> {
        if maximum_segment_bytes < 64 * 1024 {
            return Err("journal engine segment size must be at least 64 KiB".to_owned());
        }
        let directory = directory.as_ref().to_path_buf();
        std::fs::create_dir_all(&directory).map_err(|error| {
            format!("create journal directory {}: {error}", directory.display())
        })?;
        let codec = JournalCodec {
            version: 2,
            maximum_record_bytes: 16 * 1024 * 1024,
            maximum_batch_records: 4_096,
            maximum_identity_bytes: 4_096,
            maximum_account_bytes: 4_096,
            tolerate_trailing_frame: false,
        };
        let recovery = RecoveryScanner {
            codec: codec.clone(),
            durability,
            maximum_segment_bytes,
            temporary_file_grace: Duration::from_secs(300),
            accept_generation: 0..=64,
        };
        let (descriptors, diagnostics) = recovery.scan(&directory, true)?;
        let mut active_descriptor = descriptors
            .iter()
            .filter(|descriptor| descriptor.state == SegmentState::Active)
            .max_by_key(|descriptor| descriptor.segment_id);
        if active_descriptor.is_none() {
            active_descriptor = descriptors
                .iter()
                .filter(|descriptor| {
                    descriptor.state == SegmentState::Sealed
                        && descriptor.physical_bytes.saturating_add(64 * 1024)
                            < maximum_segment_bytes
                })
                .max_by_key(|descriptor| descriptor.segment_id);
        }
        let highest_id = descriptors
            .iter()
            .map(|descriptor| descriptor.segment_id)
            .max()
            .unwrap_or(0);
        let (active_id, active_generation, active_path) = match active_descriptor {
            Some(descriptor) if descriptor.state == SegmentState::Active => (
                descriptor.segment_id,
                descriptor.generation,
                descriptor.path.clone(),
            ),
            _ => {
                let id = highest_id
                    .checked_add(1)
                    .ok_or_else(|| "journal segment id space is exhausted".to_owned())?;
                (id, 0, directory.join(format!("segment-{id}-g0.bjseg")))
            }
        };
        let active = SegmentFile::open(
            active_path,
            active_id,
            active_generation,
            codec.clone(),
            durability,
            maximum_segment_bytes,
        )?;
        let mut telemetry_warnings = VecDeque::new();
        for diagnostic in diagnostics.into_iter().take(128) {
            telemetry_warnings.push_back(format!("startup recovery: {diagnostic}"));
        }
        let active_accounts = descriptors
            .iter()
            .flat_map(|descriptor| descriptor.account_ranges.keys().cloned())
            .collect::<BTreeSet<_>>();
        let checkpoint =
            CheckpointLedger::new(directory.join("checkpoints"), "journal", 1_000_000, true)?;
        Ok(Self {
            directory,
            durability,
            maximum_segment_bytes,
            codec,
            accumulator: JournalAccumulator::new(
                64,
                1_024,
                4,
                Duration::from_millis(500),
                131_072,
            )?,
            active_segment: Mutex::new(Arc::new(active)),
            next_segment_id: AtomicU64::new(highest_id.max(active_id).saturating_add(1)),
            recovery,
            compaction: CompactionPlanner {
                target_segment_bytes: maximum_segment_bytes.saturating_mul(3) / 4,
                maximum_input_segments: 8,
                minimum_reclaim_bytes: maximum_segment_bytes / 20,
                tombstone_ratio_per_mille: 150,
                fragmentation_ratio_per_mille: 200,
                required_replica_acks: 0,
                minimum_sealed_age: Duration::from_secs(60),
                maximum_generation: 64,
            },
            retention: RetentionPolicy {
                minimum_segments: 2,
                maximum_total_bytes: maximum_segment_bytes.saturating_mul(64),
                minimum_age: Duration::from_secs(60 * 60),
                maximum_age: Duration::from_secs(30 * 24 * 60 * 60),
                required_replicas: BTreeSet::new(),
                preserve_sequence_span: 1_000_000,
                pressure_delete_batch: 8,
            },
            checkpoint,
            scheduler: Mutex::new(RetryScheduler {
                maximum_entries: 100_000,
                maximum_payload_bytes: 16 * 1024 * 1024,
                minimum_delay_ms: 10,
                maximum_delay_ms: 15 * 60 * 1_000,
                entries: BTreeMap::new(),
                timeline: BTreeMap::new(),
                account_depth: BTreeMap::new(),
                recent_events: VecDeque::new(),
                event_capacity: 256,
            }),
            telemetry: Mutex::new(RuntimeTelemetry {
                accepted_records: 0,
                rejected_records: 0,
                duplicate_records: 0,
                durable_records: descriptors
                    .iter()
                    .map(|descriptor| descriptor.live_records as u64)
                    .sum(),
                buffered_records: 0,
                active_writers: 0,
                writer_failures: 0,
                bytes_encoded: 0,
                bytes_written: descriptors
                    .iter()
                    .map(|descriptor| descriptor.physical_bytes)
                    .sum(),
                bytes_reclaimed: 0,
                retry_depth: 0,
                oldest_buffer_age: None,
                active_accounts,
                flush_latencies: VecDeque::new(),
                provider_counts: BTreeMap::new(),
                segment_states: descriptors
                    .iter()
                    .map(|descriptor| {
                        (
                            descriptor.segment_id,
                            (descriptor.state, descriptor.physical_bytes),
                        )
                    })
                    .collect(),
                warnings: telemetry_warnings,
                latency_capacity: 2_048,
                warning_capacity: 256,
            }),
        })
    }

    pub fn execute(&self, command: EngineCommand) -> Result<EngineOutcome, String> {
        match command {
            EngineCommand::Append { records } => {
                if records.is_empty() {
                    return Ok(EngineOutcome::Append {
                        accepted: 0,
                        durable: 0,
                    });
                }
                {
                    let mut telemetry = self
                        .telemetry
                        .lock()
                        .map_err(|_| "runtime telemetry lock is poisoned".to_owned())?;
                    for (offset, record) in records.iter().enumerate() {
                        let buffered_after = telemetry
                            .buffered_records
                            .saturating_add(offset)
                            .saturating_add(1);
                        telemetry.observe(TelemetryEvent::RecordAccepted {
                            encoded_bytes: record.payload.len(),
                            buffered_after,
                            account: record.account.clone(),
                        });
                    }
                    telemetry.observe(TelemetryEvent::FlushStarted {
                        records: records.len(),
                    });
                }
                let active = self
                    .active_segment
                    .lock()
                    .map_err(|_| "active segment lock is poisoned".to_owned())?
                    .clone();
                let started = std::time::Instant::now();
                match self.accumulator.drain(&records, false, active.as_ref()) {
                    Ok(durable) => {
                        let mut telemetry = self
                            .telemetry
                            .lock()
                            .map_err(|_| "runtime telemetry lock is poisoned".to_owned())?;
                        telemetry.observe(TelemetryEvent::FlushFinished {
                            records: durable,
                            bytes: 0,
                            latency: started.elapsed(),
                        });
                        Ok(EngineOutcome::Append {
                            accepted: records.len(),
                            durable,
                        })
                    }
                    Err(error) if error.contains("beyond maximum") => {
                        let next_id = self.next_segment_id.fetch_add(1, Ordering::SeqCst);
                        if next_id == u64::MAX {
                            return Err(
                                "journal segment id space is exhausted during rotation".to_owned()
                            );
                        }
                        let path = self.directory.join(format!("segment-{next_id}-g0.bjseg"));
                        let replacement = Arc::new(SegmentFile::open(
                            path,
                            next_id,
                            0,
                            self.codec.clone(),
                            self.durability,
                            self.maximum_segment_bytes,
                        )?);
                        {
                            let mut active_guard = self.active_segment.lock().map_err(|_| {
                                "active segment lock is poisoned during rotation".to_owned()
                            })?;
                            *active_guard = replacement.clone();
                        }
                        let retry_started = std::time::Instant::now();
                        let durable = self.accumulator.drain(&[], false, replacement.as_ref())?;
                        let mut telemetry = self
                            .telemetry
                            .lock()
                            .map_err(|_| "runtime telemetry lock is poisoned".to_owned())?;
                        telemetry.observe(TelemetryEvent::Warning {
                            message: format!(
                                "rotated to segment {next_id} after full active segment"
                            ),
                        });
                        telemetry.observe(TelemetryEvent::FlushFinished {
                            records: durable,
                            bytes: 0,
                            latency: retry_started.elapsed(),
                        });
                        Ok(EngineOutcome::Append {
                            accepted: records.len(),
                            durable,
                        })
                    }
                    Err(error) => {
                        let mut telemetry = self
                            .telemetry
                            .lock()
                            .map_err(|_| "runtime telemetry lock is poisoned".to_owned())?;
                        telemetry.observe(TelemetryEvent::FlushFailed {
                            records_retained: records.len(),
                            error: error.clone(),
                        });
                        Err(error)
                    }
                }
            }
            EngineCommand::FlushDue => {
                let active = self
                    .active_segment
                    .lock()
                    .map_err(|_| "active segment lock is poisoned".to_owned())?
                    .clone();
                let started = std::time::Instant::now();
                let durable = self.accumulator.drain(&[], false, active.as_ref())?;
                let mut telemetry = self
                    .telemetry
                    .lock()
                    .map_err(|_| "runtime telemetry lock is poisoned".to_owned())?;
                telemetry.observe(TelemetryEvent::FlushFinished {
                    records: durable,
                    bytes: 0,
                    latency: started.elapsed(),
                });
                Ok(EngineOutcome::Flushed(durable))
            }
            EngineCommand::Retry(command) => {
                let mut scheduler = self
                    .scheduler
                    .lock()
                    .map_err(|_| "retry scheduler lock is poisoned".to_owned())?;
                let outcome = scheduler.advance(command)?;
                let depth = scheduler.entries.len();
                drop(scheduler);
                self.telemetry
                    .lock()
                    .map_err(|_| "runtime telemetry lock is poisoned".to_owned())?
                    .observe(TelemetryEvent::RetryDepth { depth });
                Ok(EngineOutcome::Retry(outcome))
            }
            EngineCommand::Maintain {
                repair,
                disk_pressure_per_mille,
            } => {
                let started_at = SystemTime::now();
                let (descriptors, mut scan_diagnostics) =
                    self.recovery.scan(&self.directory, repair)?;
                let plans = self.compaction.plan(&descriptors, started_at)?;
                let checkpoint = self.checkpoint.transact(CheckpointOperation::Load)?;
                let durable_checkpoint = match checkpoint {
                    CheckpointOutcome::Loaded {
                        durable_sequence, ..
                    } => durable_sequence,
                    _ => 0,
                };
                let decisions = self.retention.choose(
                    &descriptors,
                    started_at,
                    durable_checkpoint,
                    disk_pressure_per_mille,
                )?;
                let mut actions = Vec::new();
                let mut warnings = Vec::new();
                let mut errors = Vec::new();
                let mut quarantined = 0usize;
                let mut retained = 0usize;
                let mut delete_candidates = 0usize;
                let mut bytes_reclaimed = 0u64;
                for diagnostic in scan_diagnostics.drain(..) {
                    if diagnostic.contains("failed") || diagnostic.contains("corrupt") {
                        warnings.push(diagnostic);
                    } else {
                        actions.push(diagnostic);
                    }
                }
                for plan in &plans {
                    match plan.action {
                        CompactionAction::Quarantine => {
                            quarantined = quarantined.saturating_add(plan.inputs.len());
                            warnings.push(format!(
                                "{} marks {:?} for quarantine: {}",
                                plan.plan_id,
                                plan.inputs,
                                plan.reasons.join("; ")
                            ));
                        }
                        CompactionAction::Merge | CompactionAction::Rewrite => {
                            actions.push(format!(
                                "{} proposes {:?} for segments {:?}, reclaiming about {} bytes",
                                plan.plan_id,
                                plan.action,
                                plan.inputs,
                                plan.estimated_reclaimed_bytes
                            ));
                        }
                        CompactionAction::Keep => {
                            if !plan.blocked_by.is_empty() {
                                warnings.push(format!(
                                    "{} is blocked: {}",
                                    plan.plan_id,
                                    plan.blocked_by.join("; ")
                                ));
                            }
                        }
                        CompactionAction::DropExpired => {}
                    }
                }
                for (segment_id, decision, reason) in decisions {
                    match decision {
                        RetentionDecision::Delete => {
                            delete_candidates = delete_candidates.saturating_add(1);
                            actions.push(format!(
                                "segment {segment_id} eligible for deletion: {reason}"
                            ));
                        }
                        RetentionDecision::Quarantine => {
                            quarantined = quarantined.saturating_add(1);
                            warnings.push(format!(
                                "segment {segment_id} requires quarantine: {reason}"
                            ));
                        }
                        RetentionDecision::Preserve => {
                            retained = retained.saturating_add(1);
                        }
                        RetentionDecision::DelayForReader
                        | RetentionDecision::DelayForReplica
                        | RetentionDecision::DelayForLegalHold => {
                            retained = retained.saturating_add(1);
                            warnings.push(format!("segment {segment_id} retained: {reason}"));
                        }
                    }
                }
                for descriptor in &descriptors {
                    self.telemetry
                        .lock()
                        .map_err(|_| "runtime telemetry lock is poisoned".to_owned())?
                        .observe(TelemetryEvent::SegmentObserved {
                            segment_id: descriptor.segment_id,
                            state: descriptor.state,
                            physical_bytes: descriptor.physical_bytes,
                        });
                    if descriptor.state == SegmentState::Superseded {
                        bytes_reclaimed = bytes_reclaimed.saturating_add(
                            descriptor
                                .physical_bytes
                                .saturating_sub(descriptor.logical_bytes),
                        );
                    }
                }
                if !repair && delete_candidates > 0 {
                    warnings.push(format!(
                        "{delete_candidates} deletion candidates were reported but repair mode is disabled"
                    ));
                }
                if plans
                    .iter()
                    .any(|plan| plan.action == CompactionAction::Merge)
                {
                    errors.retain(|error: &String| !error.is_empty());
                }
                let finished_at = SystemTime::now();
                Ok(EngineOutcome::Maintenance(MaintenanceReport {
                    started_at,
                    finished_at,
                    scanned_segments: descriptors.len(),
                    repaired_segments: if repair {
                        actions
                            .iter()
                            .filter(|action| action.contains("truncated"))
                            .count()
                    } else {
                        0
                    },
                    quarantined_segments: quarantined,
                    compacted_segments: 0,
                    deleted_segments: 0,
                    retained_segments: retained,
                    records_recovered: descriptors
                        .iter()
                        .map(|descriptor| descriptor.live_records)
                        .sum(),
                    records_discarded: descriptors
                        .iter()
                        .map(|descriptor| {
                            descriptor.duplicate_records + descriptor.tombstone_records
                        })
                        .sum(),
                    bytes_read: descriptors
                        .iter()
                        .map(|descriptor| descriptor.physical_bytes)
                        .sum(),
                    bytes_written: 0,
                    bytes_reclaimed,
                    checkpoint_advanced_to: Some(durable_checkpoint),
                    actions,
                    warnings,
                    errors,
                }))
            }
            EngineCommand::Snapshot => {
                let snapshot = self
                    .telemetry
                    .lock()
                    .map_err(|_| "runtime telemetry lock is poisoned".to_owned())?
                    .observe(TelemetryEvent::Snapshot)
                    .ok_or_else(|| "telemetry snapshot event returned no snapshot".to_owned())?;
                Ok(EngineOutcome::Snapshot(snapshot))
            }
            EngineCommand::Shutdown => {
                let active = self
                    .active_segment
                    .lock()
                    .map_err(|_| "active segment lock is poisoned".to_owned())?
                    .clone();
                let durable = self.accumulator.drain(&[], true, active.as_ref())?;
                let (descriptor, diagnostics) = active.inspect_and_repair(false)?;
                if !diagnostics.is_empty() {
                    self.telemetry
                        .lock()
                        .map_err(|_| "runtime telemetry lock is poisoned".to_owned())?
                        .observe(TelemetryEvent::Warning {
                            message: format!(
                                "shutdown segment diagnostics: {}",
                                diagnostics.join("; ")
                            ),
                        });
                }
                let loaded = self.checkpoint.transact(CheckpointOperation::Load)?;
                let (expected_epoch, mut positions) = match loaded {
                    CheckpointOutcome::Loaded {
                        epoch,
                        account_positions,
                        ..
                    } => (Some(epoch), account_positions),
                    CheckpointOutcome::Missing => (Some(0), BTreeMap::new()),
                    _ => (None, BTreeMap::new()),
                };
                for (account, range) in &descriptor.account_ranges {
                    positions
                        .entry(account.clone())
                        .and_modify(|sequence| *sequence = (*sequence).max(range.1))
                        .or_insert(range.1);
                }
                let committed = self.checkpoint.transact(CheckpointOperation::Commit {
                    expected_epoch,
                    durable_sequence: descriptor.last_sequence,
                    account_positions: positions,
                    remove_accounts: BTreeSet::new(),
                })?;
                let checkpoint_epoch = match committed {
                    CheckpointOutcome::Committed { epoch, .. } => epoch,
                    _ => 0,
                };
                Ok(EngineOutcome::Shutdown {
                    durable,
                    checkpoint_epoch,
                })
            }
        }
    }
}
