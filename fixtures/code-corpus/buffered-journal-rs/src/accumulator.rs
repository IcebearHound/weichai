use std::collections::{BTreeSet, VecDeque};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::domain::JournalRecord;

/// 批量持久化器:接收一批记录并保证写入成功(或返回错误由调用方决定重试)。
pub trait BatchWriter: Send + Sync {
    fn persist(&self, records: &[JournalRecord]) -> Result<(), String>;
}

/// 累积器的内部状态。
struct AccumulatorState {
    /// 待写入队列(FIFO)。
    pending: VecDeque<JournalRecord>,
    /// 队列中记录的 identity 索引,用于去重。
    pending_identities: BTreeSet<String>,
    /// 正在被写入线程持有所属权、尚未落盘的 identity。
    active_identities: BTreeSet<String>,
    /// 最近已落盘的 identity(有限窗口,用于识别重复投递)。
    durable_identities: BTreeSet<String>,
    /// durable_identities 的插入顺序,用于淘汰最旧的记录。
    durable_order: VecDeque<String>,
    /// 队列中最旧记录被接收的时刻,用于定时刷盘判定。
    oldest_pending_at: Option<Instant>,
    last_durable_at: Instant,
    /// 是否已进入关闭模式(拒绝新记录)。
    closing: bool,
    /// 正在执行写入回调的线程数。
    in_flight_writers: usize,
    accepted_records: u64,
    rejected_records: u64,
    durable_records: u64,
    failed_batches: u64,
    /// 状态版本号:每次状态变化递增,用于等待循环检测是否错过唤醒。
    generation: u64,
    last_failure: Option<String>,
}

/// 批量累积器:把高频小批量写入合并为低频率的大批量持久化。
///
/// 刷盘触发条件(任一满足):待写数量达到 `threshold`、最旧记录等待超过 `interval`、
/// 或显式关闭(shutdown)。同一 identity 在一次刷盘周期内只会被写一次。
/// 并发调用 `drain` 时最多有 `maximum_in_flight_writers` 个写入线程同时落盘。
pub struct JournalAccumulator {
    state: Mutex<AccumulatorState>,
    changed: Condvar,
    /// 触发刷盘的待写记录数阈值。
    threshold: usize,
    /// 单批最大记录数。
    maximum_batch: usize,
    /// 并发写入线程数上限。
    maximum_in_flight_writers: usize,
    /// 定时刷盘的最大等待间隔。
    interval: Duration,
    /// 已落盘 identity 的保留窗口大小。
    remembered_identities: usize,
}

impl JournalAccumulator {
    /// 创建累积器;各参数互相约束(如 `maximum_batch >= threshold`,
    /// 身份窗口必须能覆盖至少一个最大批次)。
    pub fn new(
        threshold: usize,
        maximum_batch: usize,
        maximum_in_flight_writers: usize,
        interval: Duration,
        remembered_identities: usize,
    ) -> Result<Self, String> {
        if threshold == 0 {
            return Err("journal flush threshold must be greater than zero".to_owned());
        }
        if maximum_batch == 0 {
            return Err("journal maximum batch must be greater than zero".to_owned());
        }
        if maximum_batch < threshold {
            return Err(format!(
                "maximum batch {maximum_batch} cannot be smaller than threshold {threshold}"
            ));
        }
        if maximum_in_flight_writers == 0 {
            return Err("at least one journal writer slot is required".to_owned());
        }
        if interval.is_zero() {
            return Err("journal flush interval must be non-zero".to_owned());
        }
        if remembered_identities < maximum_batch {
            return Err(format!(
                "identity memory {remembered_identities} must cover one maximum batch {maximum_batch}"
            ));
        }
        let now = Instant::now();
        Ok(Self {
            state: Mutex::new(AccumulatorState {
                pending: VecDeque::new(),
                pending_identities: BTreeSet::new(),
                active_identities: BTreeSet::new(),
                durable_identities: BTreeSet::new(),
                durable_order: VecDeque::new(),
                oldest_pending_at: None,
                last_durable_at: now,
                closing: false,
                in_flight_writers: 0,
                accepted_records: 0,
                rejected_records: 0,
                durable_records: 0,
                failed_batches: 0,
                generation: 0,
                last_failure: None,
            }),
            changed: Condvar::new(),
            threshold,
            maximum_batch,
            maximum_in_flight_writers,
            interval,
            remembered_identities,
        })
    }

    /// 缓冲新记录(或关闭时排空队列)。返回本次调用中变为 durable 的记录数。
    ///
    /// 一次调用可能多轮刷盘:只要仍有待写记录、条件满足且有可用写入槽,
    /// 就继续取批写入;shutdown 模式下会一直循环直到清空或超时。
    pub fn drain(
        &self,
        incoming: &[JournalRecord],
        shutdown: bool,
        writer: &dyn BatchWriter,
    ) -> Result<usize, String> {
        let call_started = Instant::now();
        let mut durable_during_call = 0usize;
        let mut incoming_was_admitted = false;
        loop {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "journal accumulator lock is poisoned".to_owned())?;
            if !incoming_was_admitted {
                // 关闭后拒绝新记录(关闭前的存量仍继续刷)。
                if state.closing && !incoming.is_empty() {
                    state.rejected_records =
                        state.rejected_records.saturating_add(incoming.len() as u64);
                    return Err(
                        "journal accumulator is shutting down and rejects new records".to_owned(),
                    );
                }
                // 准入阶段:逐条校验字段/大小,并用三套 identity 集合去重。
                let mut local_identities = BTreeSet::new();
                let mut admitted = VecDeque::new();
                let mut rejected = 0usize;
                for (ordinal, record) in incoming.iter().enumerate() {
                    if record.identity.trim().is_empty() {
                        rejected = rejected.saturating_add(1);
                        state.last_failure =
                            Some(format!("incoming record {ordinal} has an empty identity"));
                        continue;
                    }
                    if record.account.trim().is_empty() {
                        rejected = rejected.saturating_add(1);
                        state.last_failure =
                            Some(format!("incoming record {ordinal} has an empty account"));
                        continue;
                    }
                    // 16 MiB 单条上限:防止异常大记录撑爆内存与帧格式。
                    if record.payload.len() > 16 * 1024 * 1024 {
                        rejected = rejected.saturating_add(1);
                        state.last_failure = Some(format!(
                            "incoming record {} is {} bytes, above the 16 MiB safety limit",
                            record.identity,
                            record.payload.len()
                        ));
                        continue;
                    }
                    if !local_identities.insert(record.identity.clone()) {
                        rejected = rejected.saturating_add(1);
                        continue;
                    }
                    // 与队列中、写入中或已落盘的 identity 重复 → 拒绝(幂等)。
                    if state.pending_identities.contains(&record.identity)
                        || state.active_identities.contains(&record.identity)
                        || state.durable_identities.contains(&record.identity)
                    {
                        rejected = rejected.saturating_add(1);
                        continue;
                    }
                    admitted.push_back(record.clone());
                }
                if !admitted.is_empty() {
                    if state.pending.is_empty() {
                        state.oldest_pending_at = Some(Instant::now());
                    }
                    for record in admitted {
                        state.pending_identities.insert(record.identity.clone());
                        state.pending.push_back(record);
                        state.accepted_records = state.accepted_records.saturating_add(1);
                    }
                    state.generation = state.generation.saturating_add(1);
                }
                state.rejected_records = state.rejected_records.saturating_add(rejected as u64);
                incoming_was_admitted = true;
                if shutdown {
                    state.closing = true;
                    state.generation = state.generation.saturating_add(1);
                    self.changed.notify_all();
                }
            } else if shutdown && !state.closing {
                state.closing = true;
                state.generation = state.generation.saturating_add(1);
                self.changed.notify_all();
            }
            if shutdown && !state.closing {
                return Err("shutdown state transition was lost".to_owned());
            }
            let pending_count = state.pending.len();
            let threshold_due = pending_count >= self.threshold;
            let timer_due = state
                .oldest_pending_at
                .is_some_and(|oldest| oldest.elapsed() >= self.interval);
            let shutdown_due = shutdown && state.closing && pending_count > 0;
            let writer_slot_available = state.in_flight_writers < self.maximum_in_flight_writers;
            if pending_count == 0 {
                state.oldest_pending_at = None;
                if shutdown {
                    // 关闭且无待写:等待所有在途写入者结束(250ms 轮询,30s 超时保护)。
                    if state.in_flight_writers == 0 {
                        state.last_failure = None;
                        self.changed.notify_all();
                        return Ok(durable_during_call);
                    }
                    let observed_generation = state.generation;
                    let (guard, wait) = self
                        .changed
                        .wait_timeout(state, Duration::from_millis(250))
                        .map_err(|_| {
                            "journal accumulator lock poisoned while awaiting writers".to_owned()
                        })?;
                    state = guard;
                    // generation 未变化说明没有新事件,可据此判定超时而非继续空转。
                    if wait.timed_out()
                        && state.generation == observed_generation
                        && call_started.elapsed() > Duration::from_secs(30)
                    {
                        let active = state.in_flight_writers;
                        return Err(format!(
                            "shutdown waited over 30 seconds for {active} in-flight journal writers"
                        ));
                    }
                    drop(state);
                    continue;
                }
                return Ok(durable_during_call);
            }
            // 三种触发条件都不满足时,本批暂不落盘,直接返回。
            if !threshold_due && !timer_due && !shutdown_due {
                return Ok(durable_during_call);
            }
            if !writer_slot_available {
                if !shutdown {
                    return Ok(durable_during_call);
                }
                // 关闭模式下等待写入槽释放。
                let observed_generation = state.generation;
                let (guard, wait) = self
                    .changed
                    .wait_timeout(state, Duration::from_millis(250))
                    .map_err(|_| {
                        "journal accumulator lock poisoned while awaiting a writer slot".to_owned()
                    })?;
                state = guard;
                if wait.timed_out()
                    && state.generation == observed_generation
                    && call_started.elapsed() > Duration::from_secs(30)
                {
                    let active = state.in_flight_writers;
                    let pending = state.pending.len();
                    return Err(format!(
                        "shutdown could not obtain a writer slot; {active} active, {pending} pending"
                    ));
                }
                drop(state);
                continue;
            }
            // 取批:把身份从 pending 移到 active(所属权转移到写入线程)。
            let take = pending_count.min(self.maximum_batch);
            let mut batch = Vec::with_capacity(take);
            for _ in 0..take {
                if let Some(record) = state.pending.pop_front() {
                    state.pending_identities.remove(&record.identity);
                    state.active_identities.insert(record.identity.clone());
                    batch.push(record);
                }
            }
            if batch.is_empty() {
                state.oldest_pending_at = None;
                drop(state);
                continue;
            }
            if state.pending.is_empty() {
                state.oldest_pending_at = None;
            } else {
                state.oldest_pending_at = Some(Instant::now());
            }
            state.in_flight_writers = state.in_flight_writers.saturating_add(1);
            state.generation = state.generation.saturating_add(1);
            let batch_generation = state.generation;
            drop(state);
            let write_started = Instant::now();
            let persisted = writer.persist(&batch);
            let write_elapsed = write_started.elapsed();
            let mut state = self
                .state
                .lock()
                .map_err(|_| "journal accumulator lock is poisoned after persistence".to_owned())?;
            state.in_flight_writers = state.in_flight_writers.saturating_sub(1);
            // 保证 generation 严格单调,让等待者总能观察到“事件发生了”。
            state.generation = state
                .generation
                .saturating_add(1)
                .max(batch_generation.saturating_add(1));
            match persisted {
                Ok(()) => {
                    // 落盘成功:移入 durable 窗口并淘汰最旧记录。
                    for record in &batch {
                        state.active_identities.remove(&record.identity);
                        if state.durable_identities.insert(record.identity.clone()) {
                            state.durable_order.push_back(record.identity.clone());
                        }
                    }
                    while state.durable_order.len() > self.remembered_identities {
                        if let Some(expired) = state.durable_order.pop_front() {
                            state.durable_identities.remove(&expired);
                        }
                    }
                    state.durable_records =
                        state.durable_records.saturating_add(batch.len() as u64);
                    state.last_durable_at = Instant::now();
                    state.last_failure = None;
                    durable_during_call = durable_during_call.saturating_add(batch.len());
                    // 写入过慢(超过 4 倍间隔)虽成功也记录告警。
                    if write_elapsed > self.interval.saturating_mul(4) {
                        state.last_failure = Some(format!(
                            "journal writer succeeded slowly after {} milliseconds",
                            write_elapsed.as_millis()
                        ));
                    }
                    self.changed.notify_all();
                    let pending_after_write = state.pending.len();
                    let active_after_write = state.in_flight_writers;
                    if shutdown {
                        if pending_after_write == 0 && active_after_write == 0 {
                            return Ok(durable_during_call);
                        }
                        drop(state);
                        continue;
                    }
                    // 非关闭模式:若仍达到阈值且有槽位,且本次调用写入量未超限,继续刷。
                    if pending_after_write >= self.threshold
                        && active_after_write < self.maximum_in_flight_writers
                        && durable_during_call < self.maximum_batch.saturating_mul(4)
                    {
                        drop(state);
                        continue;
                    }
                    return Ok(durable_during_call);
                }
                Err(error) => {
                    // 写入失败:整批按原序放回队首重试,identity 仍保持去重语义。
                    state.failed_batches = state.failed_batches.saturating_add(1);
                    state.last_failure = Some(error.clone());
                    let pending_was_empty = state.pending.is_empty();
                    for record in batch.into_iter().rev() {
                        state.active_identities.remove(&record.identity);
                        if !state.pending_identities.contains(&record.identity)
                            && !state.durable_identities.contains(&record.identity)
                        {
                            state.pending_identities.insert(record.identity.clone());
                            state.pending.push_front(record);
                        }
                    }
                    if pending_was_empty && !state.pending.is_empty() {
                        state.oldest_pending_at = Some(Instant::now());
                    }
                    self.changed.notify_all();
                    let retained = state.pending.len();
                    let active = state.in_flight_writers;
                    drop(state);
                    return Err(format!(
                        "journal writer failed after retaining {retained} records ({active} other writers active): {error}"
                    ));
                }
            }
        }
    }
}

impl Default for JournalAccumulator {
    /// 生产环境友好的默认配置(阈值 64、单批 512、4 并发、1 秒间隔)。
    fn default() -> Self {
        Self::new(64, 512, 4, Duration::from_secs(1), 16_384)
            .expect("default journal accumulator configuration is valid")
    }
}
