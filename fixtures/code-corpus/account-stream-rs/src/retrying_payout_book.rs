use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Payout {
    pub id: String,
    pub account: String,
    pub beneficiary: String,
    pub amount_minor: i64,
    pub currency: String,
    pub reference: String,
}

impl Payout {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("payout identity is required".to_owned());
        }
        if self.account.trim().is_empty() || self.beneficiary.trim().is_empty() {
            return Err("payout accounts are required".to_owned());
        }
        if self.account == self.beneficiary {
            return Err("payout source and beneficiary must differ".to_owned());
        }
        if self.amount_minor <= 0 {
            return Err("payout amount must be positive".to_owned());
        }
        if self.currency.len() != 3
            || !self
                .currency
                .chars()
                .all(|value| value.is_ascii_uppercase())
        {
            return Err("payout currency must be an uppercase ISO-style code".to_owned());
        }
        if self.reference.len() > 140 {
            return Err("payout reference is too long".to_owned());
        }
        Ok(())
    }

    pub fn fingerprint(&self) -> String {
        let fields = [
            self.id.as_str(),
            self.account.as_str(),
            self.beneficiary.as_str(),
            self.currency.as_str(),
            self.reference.as_str(),
        ];
        let mut state = 0xcbf29ce484222325_u64;
        for field in fields {
            for byte in field.as_bytes() {
                state ^= u64::from(*byte);
                state = state.wrapping_mul(0x100000001b3);
            }
            state ^= 0xff;
            state = state.wrapping_mul(0x100000001b3);
        }
        for byte in self.amount_minor.to_be_bytes() {
            state ^= u64::from(byte);
            state = state.wrapping_mul(0x100000001b3);
        }
        format!("{state:016x}")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutReceipt {
    pub identity: String,
    pub payout_id: String,
    pub provider_token: String,
    pub route: String,
    pub attempt: u32,
    pub completed_millis: u128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PayoutResult {
    Settled(PayoutReceipt),
    Failed { attempts: u32, reason: String },
}

#[derive(Debug)]
struct BatchFlightState {
    finished: bool,
    fingerprint: String,
    result: Vec<PayoutResult>,
    error: Option<String>,
}

#[derive(Debug)]
struct BatchFlight {
    state: Mutex<BatchFlightState>,
    changed: Condvar,
}

#[derive(Clone, Debug)]
struct CompletedBatch {
    fingerprint: String,
    result: Vec<PayoutResult>,
    completed_at: Instant,
}

#[derive(Debug, Default)]
struct BookState {
    completed: HashMap<String, CompletedBatch>,
    receipts: HashMap<String, PayoutReceipt>,
    running: HashMap<String, Arc<BatchFlight>>,
    attempts_by_payout: BTreeMap<String, u32>,
    joined_batches: u64,
    replayed_batches: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutBookSnapshot {
    pub completed_batches: usize,
    pub running_batches: usize,
    pub receipt_count: usize,
    pub joined_batches: u64,
    pub replayed_batches: u64,
    pub attempts_by_payout: BTreeMap<String, u32>,
}

#[derive(Debug)]
pub struct RetryingPayoutBook {
    attempts: u32,
    state: Mutex<BookState>,
}

impl RetryingPayoutBook {
    pub fn new(attempts: u32) -> Result<Self, String> {
        if attempts == 0 || attempts > 12 {
            return Err("attempt limit must be between one and twelve".to_owned());
        }
        Ok(Self {
            attempts,
            state: Mutex::new(BookState::default()),
        })
    }

    pub fn apply_batch<F>(
        &self,
        key: &str,
        items: &[Payout],
        mut operation: F,
    ) -> Result<Vec<PayoutResult>, String>
    where
        F: FnMut(&Payout, u32) -> Result<(String, String), String>,
    {
        let key = key.trim();
        if key.len() < 8 || key.len() > 128 {
            return Err("batch key length must be between eight and 128".to_owned());
        }
        if items.is_empty() || items.len() > 2_000 {
            return Err("batch payout count is outside supported range".to_owned());
        }
        let mut identities = std::collections::HashSet::with_capacity(items.len());
        for item in items {
            item.validate()?;
            if !identities.insert(item.id.as_str()) {
                return Err(format!("duplicate payout identity {}", item.id));
            }
        }
        let fingerprint = batch_fingerprint(items);
        let (flight, leader) = {
            let mut state = self.state.lock().map_err(|_| "payout book lock poisoned")?;
            if let Some(completed) = state.completed.get(key).cloned() {
                if completed.fingerprint != fingerprint {
                    return Err("batch key already names a different payout set".to_owned());
                }
                state.replayed_batches = state.replayed_batches.saturating_add(1);
                return Ok(completed.result);
            }
            if let Some(running) = state.running.get(key).cloned() {
                let running_state = running
                    .state
                    .lock()
                    .map_err(|_| "payout flight lock poisoned")?;
                if running_state.fingerprint != fingerprint {
                    return Err("batch key is running with a different payout set".to_owned());
                }
                drop(running_state);
                state.joined_batches = state.joined_batches.saturating_add(1);
                (running, false)
            } else {
                let created = Arc::new(BatchFlight {
                    state: Mutex::new(BatchFlightState {
                        finished: false,
                        fingerprint: fingerprint.clone(),
                        result: Vec::new(),
                        error: None,
                    }),
                    changed: Condvar::new(),
                });
                state.running.insert(key.to_owned(), created.clone());
                (created, true)
            }
        };
        if !leader {
            let mut state = flight
                .state
                .lock()
                .map_err(|_| "payout flight lock poisoned")?;
            while !state.finished {
                state = flight
                    .changed
                    .wait(state)
                    .map_err(|_| "payout flight wait poisoned")?;
            }
            return match &state.error {
                Some(reason) => Err(reason.clone()),
                None => Ok(state.result.clone()),
            };
        }

        let execution = self.execute_items(key, items, &mut operation);
        let (result, execution_error) = match execution {
            Ok(result) => (result, None),
            Err(reason) => (Vec::new(), Some(reason)),
        };
        {
            let mut state = self.state.lock().map_err(|_| "payout book lock poisoned")?;
            state.running.remove(key);
            if execution_error.is_none() {
                state.completed.insert(
                    key.to_owned(),
                    CompletedBatch {
                        fingerprint,
                        result: result.clone(),
                        completed_at: Instant::now(),
                    },
                );
            }
        }
        {
            let mut flight_state = flight
                .state
                .lock()
                .map_err(|_| "payout flight lock poisoned")?;
            flight_state.result = result.clone();
            flight_state.error = execution_error.clone();
            flight_state.finished = true;
            flight.changed.notify_all();
        }
        match execution_error {
            Some(reason) => Err(reason),
            None => Ok(result),
        }
    }

    pub fn snapshot(&self) -> Result<PayoutBookSnapshot, String> {
        let state = self.state.lock().map_err(|_| "payout book lock poisoned")?;
        Ok(PayoutBookSnapshot {
            completed_batches: state.completed.len(),
            running_batches: state.running.len(),
            receipt_count: state.receipts.len(),
            joined_batches: state.joined_batches,
            replayed_batches: state.replayed_batches,
            attempts_by_payout: state.attempts_by_payout.clone(),
        })
    }

    pub fn forget_batches_older_than(&self, age: Duration) -> Result<usize, String> {
        let threshold = Instant::now().checked_sub(age).unwrap_or_else(Instant::now);
        let mut state = self.state.lock().map_err(|_| "payout book lock poisoned")?;
        let before = state.completed.len();
        state
            .completed
            .retain(|_, completed| completed.completed_at >= threshold);
        Ok(before - state.completed.len())
    }

    fn execute_items<F>(
        &self,
        key: &str,
        items: &[Payout],
        operation: &mut F,
    ) -> Result<Vec<PayoutResult>, String>
    where
        F: FnMut(&Payout, u32) -> Result<(String, String), String>,
    {
        let started = Instant::now();
        let mut outcomes = Vec::with_capacity(items.len());
        for item in items {
            let prior = {
                let state = self.state.lock().map_err(|_| "payout book lock poisoned")?;
                state.receipts.get(&item.id).cloned()
            };
            if let Some(receipt) = prior {
                outcomes.push(PayoutResult::Settled(receipt));
                continue;
            }
            let mut last_reason = "payout was not attempted".to_owned();
            let mut settled = None;
            for attempt in 1..=self.attempts {
                {
                    let mut state = self.state.lock().map_err(|_| "payout book lock poisoned")?;
                    *state.attempts_by_payout.entry(item.id.clone()).or_insert(0) += 1;
                }
                match operation(item, attempt) {
                    Ok((provider_token, route)) => {
                        let candidate = PayoutReceipt {
                            identity: receipt_identity(key, item, &provider_token),
                            payout_id: item.id.clone(),
                            provider_token,
                            route,
                            attempt,
                            completed_millis: started.elapsed().as_millis(),
                        };
                        let canonical = {
                            let mut state =
                                self.state.lock().map_err(|_| "payout book lock poisoned")?;
                            state
                                .receipts
                                .entry(item.id.clone())
                                .or_insert(candidate)
                                .clone()
                        };
                        settled = Some(canonical);
                        break;
                    }
                    Err(reason) => last_reason = reason,
                }
            }
            match settled {
                Some(receipt) => outcomes.push(PayoutResult::Settled(receipt)),
                None => outcomes.push(PayoutResult::Failed {
                    attempts: self.attempts,
                    reason: last_reason,
                }),
            }
        }
        Ok(outcomes)
    }
}

fn batch_fingerprint(items: &[Payout]) -> String {
    let mut state = 0x84222325cbf29ce4_u64;
    for item in items {
        for byte in item.fingerprint().as_bytes() {
            state ^= u64::from(*byte);
            state = state.rotate_left(7).wrapping_mul(0x9e3779b185ebca87);
        }
    }
    format!("{state:016x}")
}

fn receipt_identity(key: &str, item: &Payout, provider_token: &str) -> String {
    let mut state = 0x6eed0e9da4d94a4f_u64;
    for byte in key
        .as_bytes()
        .iter()
        .chain(item.id.as_bytes())
        .chain(provider_token.as_bytes())
    {
        state ^= u64::from(*byte);
        state = state.rotate_left(9).wrapping_mul(0xa24baed4963ee407);
    }
    format!("payout-{state:016x}")
}
