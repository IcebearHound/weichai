use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingRecord {
    pub identity: String,
    pub partition: String,
    pub sequence: u64,
    pub payload: Vec<u8>,
    pub accepted_at: Instant,
}

#[derive(Debug)]
struct ShutdownState {
    pending: VecDeque<PendingRecord>,
    closing: bool,
    writer_active: bool,
    accepted: u64,
    persisted: u64,
    failed_writes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShutdownSnapshot {
    pub pending: usize,
    pub closing: bool,
    pub writer_active: bool,
    pub accepted: u64,
    pub persisted: u64,
    pub failed_writes: u64,
}

#[derive(Debug)]
pub struct ShutdownLedger {
    state: Mutex<ShutdownState>,
    changed: Condvar,
    maximum_pending: usize,
}

impl ShutdownLedger {
    pub fn new(maximum_pending: usize) -> Result<Self, String> {
        if maximum_pending == 0 || maximum_pending > 1_000_000 {
            return Err("maximum pending count is outside supported range".to_owned());
        }
        Ok(Self {
            state: Mutex::new(ShutdownState {
                pending: VecDeque::new(),
                closing: false,
                writer_active: false,
                accepted: 0,
                persisted: 0,
                failed_writes: 0,
            }),
            changed: Condvar::new(),
            maximum_pending,
        })
    }

    pub fn append(&self, record: PendingRecord) -> Result<usize, String> {
        if record.identity.trim().is_empty() || record.partition.trim().is_empty() {
            return Err("record identity and partition are required".to_owned());
        }
        if record.sequence == 0 || record.payload.is_empty() {
            return Err("record sequence and payload are required".to_owned());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "shutdown ledger lock poisoned")?;
        if state.closing {
            return Err("shutdown ledger is closing".to_owned());
        }
        if state.pending.len() >= self.maximum_pending {
            return Err("shutdown ledger capacity exceeded".to_owned());
        }
        if state
            .pending
            .iter()
            .any(|existing| existing.identity == record.identity)
        {
            return Ok(state.pending.len());
        }
        state.pending.push_back(record);
        state.accepted = state.accepted.saturating_add(1);
        self.changed.notify_all();
        Ok(state.pending.len())
    }

    pub fn drain<F>(&self, maximum: usize, mut writer: F) -> Result<usize, String>
    where
        F: FnMut(&[PendingRecord]) -> Result<(), String>,
    {
        if maximum == 0 {
            return Err("drain maximum must be positive".to_owned());
        }
        let batch = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "shutdown ledger lock poisoned")?;
            while state.writer_active {
                state = self
                    .changed
                    .wait(state)
                    .map_err(|_| "shutdown wait poisoned")?;
            }
            if state.pending.is_empty() {
                return Ok(0);
            }
            state.writer_active = true;
            let count = maximum.min(state.pending.len());
            state.pending.drain(..count).collect::<Vec<_>>()
        };
        let write_result = writer(&batch);
        let mut state = self
            .state
            .lock()
            .map_err(|_| "shutdown ledger lock poisoned")?;
        state.writer_active = false;
        match write_result {
            Ok(()) => {
                state.persisted = state.persisted.saturating_add(batch.len() as u64);
                self.changed.notify_all();
                Ok(batch.len())
            }
            Err(reason) => {
                for record in batch.into_iter().rev() {
                    state.pending.push_front(record);
                }
                state.failed_writes = state.failed_writes.saturating_add(1);
                self.changed.notify_all();
                Err(reason)
            }
        }
    }

    pub fn finish<F>(&self, timeout: Duration, mut writer: F) -> Result<usize, String>
    where
        F: FnMut(&[PendingRecord]) -> Result<(), String>,
    {
        if timeout.is_zero() {
            return Err("shutdown timeout must be positive".to_owned());
        }
        let deadline = Instant::now() + timeout;
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "shutdown ledger lock poisoned")?;
            state.closing = true;
            while state.writer_active {
                let now = Instant::now();
                if now >= deadline {
                    return Err("timed out waiting for active writer".to_owned());
                }
                let (next, wait) = self
                    .changed
                    .wait_timeout(state, deadline.saturating_duration_since(now))
                    .map_err(|_| "shutdown wait poisoned")?;
                state = next;
                if wait.timed_out() && state.writer_active {
                    return Err("timed out waiting for active writer".to_owned());
                }
            }
        }
        let mut total = 0;
        loop {
            if Instant::now() >= deadline {
                return Err("shutdown drain timed out".to_owned());
            }
            let pending = self.snapshot()?.pending;
            if pending == 0 {
                return Ok(total);
            }
            total += self.drain(pending, |records| writer(records))?;
        }
    }

    pub fn snapshot(&self) -> Result<ShutdownSnapshot, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "shutdown ledger lock poisoned")?;
        Ok(ShutdownSnapshot {
            pending: state.pending.len(),
            closing: state.closing,
            writer_active: state.writer_active,
            accepted: state.accepted,
            persisted: state.persisted,
            failed_writes: state.failed_writes,
        })
    }

    pub fn pending_records(&self) -> Result<Vec<PendingRecord>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "shutdown ledger lock poisoned")?;
        Ok(state.pending.iter().cloned().collect())
    }
}
