use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::domain::{LaneReport, WorkItem, WorkOutcome};

/// 工作项处理器:对单条记录执行业务逻辑。
pub trait RecordHandler: Send + Sync {
    fn handle(&self, record: &WorkItem) -> Result<(), String>;
}

/// 确认器:处理器成功后向外(如消息队列)确认消费。
pub trait RecordAcknowledger: Send + Sync {
    fn acknowledge(&self, record: &WorkItem) -> Result<(), String>;
}

/// 按账户分键的有序执行器。
///
/// 不变量:
/// - 同一账户内按 sequence 严格有序处理,失败会阻断该账户后续记录;
/// - 不同账户并行处理(受 `maximum_parallel_accounts` 限制,分批 wave);
/// - 相同 identity 只执行一次处理器,重复投递被识别并仅确认。
pub struct KeyedRecordExecutor {
    /// 账户 -> 通道互斥锁(并发波次之间串行化同账户处理)。
    account_locks: Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
    /// 账户 -> 已提交的最大序列号(用于识别过期序列)。
    committed_sequences: Mutex<BTreeMap<String, i64>>,
    /// 已见 identity 集合 + FIFO 淘汰队列(有限记忆去重)。
    seen_identities: Mutex<(BTreeSet<String>, VecDeque<String>)>,
    maximum_parallel_accounts: usize,
    remembered_identities: usize,
}

impl KeyedRecordExecutor {
    /// 驱动一批工作项执行,返回与输入同序的逐条报告。
    ///
    /// 流程:按账户分组并组内按序列排序 → 每组在独立线程内串行处理 →
    /// 结果按输入序号归位。畸形记录直接产生失败报告,不进入通道。
    pub fn drive(
        &self,
        records: &[WorkItem],
        handler: &dyn RecordHandler,
        acknowledger: &dyn RecordAcknowledger,
    ) -> Vec<LaneReport> {
        if records.is_empty() {
            return Vec::new();
        }
        // 按账户分组,组内保持输入序号以便结果归位。
        let mut lanes: BTreeMap<String, Vec<(usize, WorkItem)>> = BTreeMap::new();
        let mut malformed = BTreeMap::new();
        for (input_ordinal, record) in records.iter().cloned().enumerate() {
            // 字段级预检:空账户/空键/负序列/非有限数值。
            if record.account.trim().is_empty() {
                malformed.insert(
                    input_ordinal,
                    LaneReport {
                        input_ordinal,
                        identity: record.key.clone(),
                        account: record.account.clone(),
                        sequence: record.sequence,
                        outcome: WorkOutcome::HandlerFailed,
                        detail: Some("record account is empty".to_owned()),
                        processing_time: std::time::Duration::ZERO,
                        acknowledged: false,
                    },
                );
                continue;
            }
            if record.key.trim().is_empty() {
                malformed.insert(
                    input_ordinal,
                    LaneReport {
                        input_ordinal,
                        identity: record.key.clone(),
                        account: record.account.clone(),
                        sequence: record.sequence,
                        outcome: WorkOutcome::HandlerFailed,
                        detail: Some("record key is empty".to_owned()),
                        processing_time: std::time::Duration::ZERO,
                        acknowledged: false,
                    },
                );
                continue;
            }
            if record.sequence < 0 {
                malformed.insert(
                    input_ordinal,
                    LaneReport {
                        input_ordinal,
                        identity: record.key.clone(),
                        account: record.account.clone(),
                        sequence: record.sequence,
                        outcome: WorkOutcome::StaleSequence,
                        detail: Some("record sequence is negative".to_owned()),
                        processing_time: std::time::Duration::ZERO,
                        acknowledged: false,
                    },
                );
                continue;
            }
            if !record.value.is_finite() || !record.weight.is_finite() {
                malformed.insert(
                    input_ordinal,
                    LaneReport {
                        input_ordinal,
                        identity: record.key.clone(),
                        account: record.account.clone(),
                        sequence: record.sequence,
                        outcome: WorkOutcome::HandlerFailed,
                        detail: Some("record value or weight is not finite".to_owned()),
                        processing_time: std::time::Duration::ZERO,
                        acknowledged: false,
                    },
                );
                continue;
            }
            lanes
                .entry(record.account.clone())
                .or_default()
                .push((input_ordinal, record));
        }
        // 通道内按序列升序(序列相同按输入顺序)排列,保证有序处理。
        for lane in lanes.values_mut() {
            lane.sort_by(|left, right| {
                left.1
                    .sequence
                    .cmp(&right.1.sequence)
                    .then_with(|| left.0.cmp(&right.0))
            });
        }
        // 为每个账户准备(或复用)通道锁;锁表超限时清理不活跃账户的锁。
        let mut lane_locks = BTreeMap::new();
        {
            let mut locks = match self.account_locks.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            for account in lanes.keys() {
                let lock = locks
                    .entry(account.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(())))
                    .clone();
                lane_locks.insert(account.clone(), lock);
            }
            if locks.len() > 16_384 {
                let active_accounts = lanes.keys().cloned().collect::<BTreeSet<_>>();
                locks.retain(|account, lock| {
                    active_accounts.contains(account) || Arc::strong_count(lock) > 1
                });
            }
        }
        // 结果槽:与输入等长,初始全空,完成后按序号填回。
        let output = Mutex::new(vec![None; records.len()]);
        {
            let mut guard = match output.lock() {
                Ok(value) => value,
                Err(poisoned) => poisoned.into_inner(),
            };
            for (ordinal, report) in malformed {
                guard[ordinal] = Some(report);
            }
        }
        // 通道按最早观察时刻排序,使批内整体处理接近公平。
        let mut lane_entries = lanes.into_iter().collect::<Vec<_>>();
        lane_entries.sort_by(|left, right| {
            let left_first = left
                .1
                .first()
                .map(|entry| entry.1.observed_at)
                .unwrap_or(i64::MAX);
            let right_first = right
                .1
                .first()
                .map(|entry| entry.1.observed_at)
                .unwrap_or(i64::MAX);
            left_first
                .cmp(&right_first)
                .then_with(|| left.0.cmp(&right.0))
        });
        // 分批 wave 并发:每波至多 `maximum_parallel_accounts` 个账户并行。
        let parallelism = self.maximum_parallel_accounts.max(1);
        for wave in lane_entries.chunks(parallelism) {
            std::thread::scope(|scope| {
                for (account, lane) in wave {
                    let account = account.clone();
                    let lane = lane.clone();
                    let lane_lock = lane_locks
                        .get(&account)
                        .expect("lane lock created for every validated account")
                        .clone();
                    let output = &output;
                    scope.spawn(move || {
                        // 串行化同一账户:即使跨 wave 也不允许同账户并发。
                        let _lane_guard = match lane_lock.lock() {
                            Ok(guard) => guard,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        // 前序失败后,后续记录标记 Pending 不再尝试。
                        let mut blocked_by = None;
                        let mut identities_in_lane = BTreeSet::new();
                        for (input_ordinal, record) in lane {
                            let started = Instant::now();
                            let identity = format!("{}:{}:{}", record.account, record.sequence, record.key);
                            if let Some(blocker) = &blocked_by {
                                let report = LaneReport {
                                    input_ordinal,
                                    identity,
                                    account: record.account.clone(),
                                    sequence: record.sequence,
                                    outcome: WorkOutcome::Pending,
                                    detail: Some(format!(
                                        "not attempted because earlier account record {blocker} failed"
                                    )),
                                    processing_time: started.elapsed(),
                                    acknowledged: false,
                                };
                                match output.lock() {
                                    Ok(mut values) => values[input_ordinal] = Some(report),
                                    Err(poisoned) => poisoned.into_inner()[input_ordinal] = Some(report),
                                }
                                continue;
                            }
                            // 批内重复 identity:不执行,仅确认(确认失败则阻断后续)。
                            if !identities_in_lane.insert(identity.clone()) {
                                let acknowledgement = acknowledger.acknowledge(&record);
                                let (outcome, detail, acknowledged) = match acknowledgement {
                                    Ok(()) => (
                                        WorkOutcome::Duplicate,
                                        Some("duplicate delivery inside this input batch".to_owned()),
                                        true,
                                    ),
                                    Err(error) => {
                                        blocked_by = Some(identity.clone());
                                        (
                                            WorkOutcome::AcknowledgementFailed,
                                            Some(format!("duplicate acknowledgement failed: {error}")),
                                            false,
                                        )
                                    }
                                };
                                let report = LaneReport {
                                    input_ordinal,
                                    identity,
                                    account: record.account.clone(),
                                    sequence: record.sequence,
                                    outcome,
                                    detail,
                                    processing_time: started.elapsed(),
                                    acknowledged,
                                };
                                match output.lock() {
                                    Ok(mut values) => values[input_ordinal] = Some(report),
                                    Err(poisoned) => poisoned.into_inner()[input_ordinal] = Some(report),
                                }
                                continue;
                            }
                            // 历史已见 identity(此前已持久处理):仅确认。
                            let already_seen = match self.seen_identities.lock() {
                                Ok(values) => values.0.contains(&identity),
                                Err(poisoned) => poisoned.into_inner().0.contains(&identity),
                            };
                            if already_seen {
                                let acknowledgement = acknowledger.acknowledge(&record);
                                let (outcome, detail, acknowledged) = match acknowledgement {
                                    Ok(()) => (
                                        WorkOutcome::Duplicate,
                                        Some("record was durably handled by an earlier delivery".to_owned()),
                                        true,
                                    ),
                                    Err(error) => {
                                        blocked_by = Some(identity.clone());
                                        (
                                            WorkOutcome::AcknowledgementFailed,
                                            Some(format!("repeat acknowledgement failed: {error}")),
                                            false,
                                        )
                                    }
                                };
                                let report = LaneReport {
                                    input_ordinal,
                                    identity,
                                    account: record.account.clone(),
                                    sequence: record.sequence,
                                    outcome,
                                    detail,
                                    processing_time: started.elapsed(),
                                    acknowledged,
                                };
                                match output.lock() {
                                    Ok(mut values) => values[input_ordinal] = Some(report),
                                    Err(poisoned) => poisoned.into_inner()[input_ordinal] = Some(report),
                                }
                                continue;
                            }
                            // 过期序列:不高于该账户已提交的最大序列,直接标记 Stale。
                            let committed_sequence = match self.committed_sequences.lock() {
                                Ok(values) => values.get(&record.account).copied(),
                                Err(poisoned) => poisoned.into_inner().get(&record.account).copied(),
                            };
                            if committed_sequence.is_some_and(|committed| record.sequence <= committed) {
                                let committed = committed_sequence.unwrap_or(record.sequence);
                                let report = LaneReport {
                                    input_ordinal,
                                    identity,
                                    account: record.account.clone(),
                                    sequence: record.sequence,
                                    outcome: WorkOutcome::StaleSequence,
                                    detail: Some(format!(
                                        "sequence {} is not newer than committed account sequence {committed}",
                                        record.sequence
                                    )),
                                    processing_time: started.elapsed(),
                                    acknowledged: false,
                                };
                                match output.lock() {
                                    Ok(mut values) => values[input_ordinal] = Some(report),
                                    Err(poisoned) => poisoned.into_inner()[input_ordinal] = Some(report),
                                }
                                continue;
                            }
                            // 正常路径:处理器 → 确认;任一失败都阻断该账户后续记录。
                            match handler.handle(&record) {
                                Err(error) => {
                                    blocked_by = Some(identity.clone());
                                    let report = LaneReport {
                                        input_ordinal,
                                        identity,
                                        account: record.account.clone(),
                                        sequence: record.sequence,
                                        outcome: WorkOutcome::HandlerFailed,
                                        detail: Some(error),
                                        processing_time: started.elapsed(),
                                        acknowledged: false,
                                    };
                                    match output.lock() {
                                        Ok(mut values) => values[input_ordinal] = Some(report),
                                        Err(poisoned) => poisoned.into_inner()[input_ordinal] = Some(report),
                                    }
                                }
                                Ok(()) => match acknowledger.acknowledge(&record) {
                                    Err(error) => {
                                        blocked_by = Some(identity.clone());
                                        let report = LaneReport {
                                            input_ordinal,
                                            identity,
                                            account: record.account.clone(),
                                            sequence: record.sequence,
                                            outcome: WorkOutcome::AcknowledgementFailed,
                                            detail: Some(error),
                                            processing_time: started.elapsed(),
                                            acknowledged: false,
                                        };
                                        match output.lock() {
                                            Ok(mut values) => values[input_ordinal] = Some(report),
                                            Err(poisoned) => poisoned.into_inner()[input_ordinal] = Some(report),
                                        }
                                    }
                                    Ok(()) => {
                                        {
                                            // 提交成功:推进账户已提交序列。
                                            let mut sequences = match self.committed_sequences.lock() {
                                                Ok(values) => values,
                                                Err(poisoned) => poisoned.into_inner(),
                                            };
                                            sequences
                                                .entry(record.account.clone())
                                                .and_modify(|sequence| *sequence = (*sequence).max(record.sequence))
                                                .or_insert(record.sequence);
                                        }
                                        {
                                            // 记忆 identity,超出窗口时淘汰最旧。
                                            let mut seen = match self.seen_identities.lock() {
                                                Ok(values) => values,
                                                Err(poisoned) => poisoned.into_inner(),
                                            };
                                            if seen.0.insert(identity.clone()) {
                                                seen.1.push_back(identity.clone());
                                            }
                                            while seen.1.len() > self.remembered_identities {
                                                if let Some(expired) = seen.1.pop_front() {
                                                    seen.0.remove(&expired);
                                                }
                                            }
                                        }
                                        let report = LaneReport {
                                            input_ordinal,
                                            identity,
                                            account: record.account.clone(),
                                            sequence: record.sequence,
                                            outcome: WorkOutcome::Handled,
                                            detail: None,
                                            processing_time: started.elapsed(),
                                            acknowledged: true,
                                        };
                                        match output.lock() {
                                            Ok(mut values) => values[input_ordinal] = Some(report),
                                            Err(poisoned) => poisoned.into_inner()[input_ordinal] = Some(report),
                                        }
                                    }
                                },
                            }
                        }
                    });
                }
            });
        }
        let values = match output.into_inner() {
            Ok(values) => values,
            Err(poisoned) => poisoned.into_inner(),
        };
        // 结果归位:未填的槽(理论上不可能)兜底为 Pending。
        values
            .into_iter()
            .enumerate()
            .map(|(input_ordinal, report)| {
                report.unwrap_or_else(|| {
                    let record = &records[input_ordinal];
                    LaneReport {
                        input_ordinal,
                        identity: record.key.clone(),
                        account: record.account.clone(),
                        sequence: record.sequence,
                        outcome: WorkOutcome::Pending,
                        detail: Some("record was not assigned to an execution lane".to_owned()),
                        processing_time: std::time::Duration::ZERO,
                        acknowledged: false,
                    }
                })
            })
            .collect()
    }
}

impl Default for KeyedRecordExecutor {
    fn default() -> Self {
        Self {
            account_locks: Mutex::new(BTreeMap::new()),
            committed_sequences: Mutex::new(BTreeMap::new()),
            seen_identities: Mutex::new((BTreeSet::new(), VecDeque::new())),
            // 默认并行度取机器核数,限制在 [2, 32]。
            maximum_parallel_accounts: std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(4)
                .clamp(2, 32),
            remembered_identities: 65_536,
        }
    }
}
