use std::collections::{BTreeSet, VecDeque};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::domain::JournalRecord;

pub trait BatchWriter: Send + Sync {
    fn persist(&self, records: &[JournalRecord]) -> Result<(), String>;
}

struct AccumulatorState {
    pending: VecDeque<JournalRecord>,
    pending_identities: BTreeSet<String>,
    active_identities: BTreeSet<String>,
    durable_identities: BTreeSet<String>,
    durable_order: VecDeque<String>,
    oldest_pending_at: Option<Instant>,
    last_durable_at: Instant,
    closing: bool,
    in_flight_writers: usize,
    accepted_records: u64,
    rejected_records: u64,
    durable_records: u64,
    failed_batches: u64,
    generation: u64,
    last_failure: Option<String>,
}

pub struct JournalAccumulator {
    state: Mutex<AccumulatorState>,
    changed: Condvar,
    threshold: usize,
    maximum_batch: usize,
    maximum_in_flight_writers: usize,
    interval: Duration,
    remembered_identities: usize,
}

impl JournalAccumulator {
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
                if state.closing && !incoming.is_empty() {
                    state.rejected_records =
                        state.rejected_records.saturating_add(incoming.len() as u64);
                    return Err(
                        "journal accumulator is shutting down and rejects new records".to_owned(),
                    );
                }
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
            if !threshold_due && !timer_due && !shutdown_due {
                return Ok(durable_during_call);
            }
            if !writer_slot_available {
                if !shutdown {
                    return Ok(durable_during_call);
                }
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
            state.generation = state
                .generation
                .saturating_add(1)
                .max(batch_generation.saturating_add(1));
            match persisted {
                Ok(()) => {
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
    fn default() -> Self {
        Self::new(64, 512, 4, Duration::from_secs(1), 16_384)
            .expect("default journal accumulator configuration is valid")
    }
}
