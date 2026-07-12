use std::collections::{BTreeMap, HashMap};
use std::fmt::{Display, Formatter};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamMessage {
    pub id: String,
    pub account: String,
    pub sequence: u64,
    pub occurred_at_millis: i64,
    pub kind: String,
    pub body: Vec<u8>,
    pub headers: BTreeMap<String, String>,
}

impl StreamMessage {
    pub fn validate(&self) -> Result<(), InboxError> {
        if self.id.trim().is_empty() {
            return Err(InboxError::InvalidMessage(
                "message identity is required".to_owned(),
            ));
        }
        if self.account.trim().is_empty() {
            return Err(InboxError::InvalidMessage(
                "account identity is required".to_owned(),
            ));
        }
        if self.sequence == 0 {
            return Err(InboxError::InvalidMessage(
                "sequence must be positive".to_owned(),
            ));
        }
        if self.kind.trim().is_empty() || self.kind.len() > 80 {
            return Err(InboxError::InvalidMessage(
                "message kind length is invalid".to_owned(),
            ));
        }
        if self.body.len() > 1024 * 1024 {
            return Err(InboxError::InvalidMessage(
                "message body exceeds one mebibyte".to_owned(),
            ));
        }
        if self.headers.len() > 32 {
            return Err(InboxError::InvalidMessage(
                "message has too many headers".to_owned(),
            ));
        }
        for (name, value) in &self.headers {
            if name.trim().is_empty() || name.len() > 64 || value.len() > 512 {
                return Err(InboxError::InvalidMessage(
                    "message header is invalid".to_owned(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeliveryOutcome {
    Processed { next_sequence: u64 },
    Duplicate { completed_at: Instant },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InboxError {
    InvalidMessage(String),
    SequenceBehind { expected: u64, received: u64 },
    SequenceWaitExpired { expected: u64, received: u64 },
    HandlerFailed(String),
    AcknowledgeFailed(String),
    StatePoisoned(&'static str),
    Closed,
}

impl Display for InboxError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidMessage(reason) => write!(formatter, "invalid message: {reason}"),
            Self::SequenceBehind { expected, received } => {
                write!(
                    formatter,
                    "sequence {received} is behind expected {expected}"
                )
            }
            Self::SequenceWaitExpired { expected, received } => {
                write!(
                    formatter,
                    "timed out waiting for sequence {received}; expected {expected}"
                )
            }
            Self::HandlerFailed(reason) => write!(formatter, "message handler failed: {reason}"),
            Self::AcknowledgeFailed(reason) => {
                write!(formatter, "message acknowledgement failed: {reason}")
            }
            Self::StatePoisoned(name) => write!(formatter, "inbox state lock poisoned: {name}"),
            Self::Closed => write!(formatter, "inbox is closed"),
        }
    }
}

impl std::error::Error for InboxError {}

#[derive(Clone, Debug)]
struct CompletedDelivery {
    account: String,
    sequence: u64,
    completed_at: Instant,
}

#[derive(Debug)]
struct LaneState {
    expected_sequence: u64,
    active_message: Option<String>,
    waiting: BTreeMap<u64, usize>,
    processed: u64,
    failed: u64,
    last_completed_at: Option<Instant>,
}

#[derive(Debug)]
struct AccountLane {
    state: Mutex<LaneState>,
    changed: Condvar,
}

impl AccountLane {
    fn new(expected_sequence: u64) -> Self {
        Self {
            state: Mutex::new(LaneState {
                expected_sequence: expected_sequence.max(1),
                active_message: None,
                waiting: BTreeMap::new(),
                processed: 0,
                failed: 0,
                last_completed_at: None,
            }),
            changed: Condvar::new(),
        }
    }
}

#[derive(Debug)]
struct RegistryState {
    lanes: HashMap<String, Arc<AccountLane>>,
    completed: HashMap<String, CompletedDelivery>,
    closed: bool,
    accepted: u64,
    duplicates: u64,
    rejected: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaneSnapshot {
    pub account: String,
    pub expected_sequence: u64,
    pub active_message: Option<String>,
    pub waiting_sequences: Vec<u64>,
    pub waiting_callers: usize,
    pub processed: u64,
    pub failed: u64,
    pub last_completed_millis_ago: Option<u128>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InboxSnapshot {
    pub closed: bool,
    pub accepted: u64,
    pub duplicates: u64,
    pub rejected: u64,
    pub completed_count: usize,
    pub lane_count: usize,
    pub lanes: Vec<LaneSnapshot>,
}

#[derive(Debug)]
pub struct PartitionedInbox {
    registry: Mutex<RegistryState>,
    sequence_wait: Duration,
    completed_limit: usize,
}

impl PartitionedInbox {
    pub fn new(sequence_wait: Duration, completed_limit: usize) -> Result<Self, InboxError> {
        if sequence_wait.is_zero() || sequence_wait > Duration::from_secs(30) {
            return Err(InboxError::InvalidMessage(
                "sequence wait must be positive and at most thirty seconds".to_owned(),
            ));
        }
        if completed_limit == 0 || completed_limit > 1_000_000 {
            return Err(InboxError::InvalidMessage(
                "completed identity limit must be between one and one million".to_owned(),
            ));
        }
        Ok(Self {
            registry: Mutex::new(RegistryState {
                lanes: HashMap::new(),
                completed: HashMap::new(),
                closed: false,
                accepted: 0,
                duplicates: 0,
                rejected: 0,
            }),
            sequence_wait,
            completed_limit,
        })
    }

    pub fn with_starting_sequences(
        sequence_wait: Duration,
        completed_limit: usize,
        starts: &BTreeMap<String, u64>,
    ) -> Result<Self, InboxError> {
        let inbox = Self::new(sequence_wait, completed_limit)?;
        {
            let mut registry = inbox.lock_registry()?;
            for (account, sequence) in starts {
                if account.trim().is_empty() || *sequence == 0 {
                    return Err(InboxError::InvalidMessage(
                        "starting account and sequence must be valid".to_owned(),
                    ));
                }
                registry
                    .lanes
                    .insert(account.clone(), Arc::new(AccountLane::new(*sequence)));
            }
        }
        Ok(inbox)
    }

    pub fn handle<H, A>(
        &self,
        message: StreamMessage,
        handler: H,
        acknowledge: A,
    ) -> Result<DeliveryOutcome, InboxError>
    where
        H: FnOnce(&StreamMessage) -> Result<(), String>,
        A: FnOnce(&str) -> Result<(), String>,
    {
        message.validate()?;
        let lane = {
            let mut registry = self.lock_registry()?;
            if registry.closed {
                registry.rejected = registry.rejected.saturating_add(1);
                return Err(InboxError::Closed);
            }
            if let Some(completed) = registry.completed.get(&message.id).cloned() {
                if completed.account != message.account || completed.sequence != message.sequence {
                    registry.rejected = registry.rejected.saturating_add(1);
                    return Err(InboxError::InvalidMessage(
                        "completed identity was reused for another stream position".to_owned(),
                    ));
                }
                registry.duplicates = registry.duplicates.saturating_add(1);
                return Ok(DeliveryOutcome::Duplicate {
                    completed_at: completed.completed_at,
                });
            }
            registry.accepted = registry.accepted.saturating_add(1);
            registry
                .lanes
                .entry(message.account.clone())
                .or_insert_with(|| Arc::new(AccountLane::new(1)))
                .clone()
        };

        let deadline = Instant::now() + self.sequence_wait;
        let mut state = lane
            .state
            .lock()
            .map_err(|_| InboxError::StatePoisoned("account lane"))?;
        *state.waiting.entry(message.sequence).or_insert(0) += 1;
        loop {
            if message.sequence < state.expected_sequence {
                remove_waiter(&mut state, message.sequence);
                if let Some(completed_at) = self.completed_time(&message)? {
                    lane.changed.notify_all();
                    return Ok(DeliveryOutcome::Duplicate { completed_at });
                }
                state.failed = state.failed.saturating_add(1);
                lane.changed.notify_all();
                self.increment_rejected()?;
                return Err(InboxError::SequenceBehind {
                    expected: state.expected_sequence,
                    received: message.sequence,
                });
            }
            if message.sequence == state.expected_sequence && state.active_message.is_none() {
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                remove_waiter(&mut state, message.sequence);
                state.failed = state.failed.saturating_add(1);
                lane.changed.notify_all();
                self.increment_rejected()?;
                return Err(InboxError::SequenceWaitExpired {
                    expected: state.expected_sequence,
                    received: message.sequence,
                });
            }
            let remaining = deadline.saturating_duration_since(now);
            let (next, timed) = lane
                .changed
                .wait_timeout(state, remaining)
                .map_err(|_| InboxError::StatePoisoned("account lane wait"))?;
            state = next;
            if timed.timed_out()
                && (message.sequence != state.expected_sequence || state.active_message.is_some())
            {
                remove_waiter(&mut state, message.sequence);
                state.failed = state.failed.saturating_add(1);
                lane.changed.notify_all();
                self.increment_rejected()?;
                return Err(InboxError::SequenceWaitExpired {
                    expected: state.expected_sequence,
                    received: message.sequence,
                });
            }
        }
        remove_waiter(&mut state, message.sequence);

        if let Some(completed_at) = self.completed_time(&message)? {
            lane.changed.notify_all();
            return Ok(DeliveryOutcome::Duplicate { completed_at });
        }
        state.active_message = Some(message.id.clone());
        drop(state);

        if let Err(reason) = handler(&message) {
            self.release_failure(&lane)?;
            return Err(InboxError::HandlerFailed(reason));
        }
        if let Err(reason) = acknowledge(&message.id) {
            self.release_failure(&lane)?;
            return Err(InboxError::AcknowledgeFailed(reason));
        }

        let completed_at = Instant::now();
        {
            let mut registry = self.lock_registry()?;
            registry.completed.insert(
                message.id.clone(),
                CompletedDelivery {
                    account: message.account.clone(),
                    sequence: message.sequence,
                    completed_at,
                },
            );
            trim_completed(&mut registry.completed, self.completed_limit);
        }
        let mut state = lane
            .state
            .lock()
            .map_err(|_| InboxError::StatePoisoned("account lane completion"))?;
        state.expected_sequence = state.expected_sequence.saturating_add(1);
        state.active_message = None;
        state.processed = state.processed.saturating_add(1);
        state.last_completed_at = Some(completed_at);
        let next_sequence = state.expected_sequence;
        lane.changed.notify_all();
        Ok(DeliveryOutcome::Processed { next_sequence })
    }

    pub fn snapshot(&self) -> Result<InboxSnapshot, InboxError> {
        let (closed, accepted, duplicates, rejected, completed_count, lanes) = {
            let registry = self.lock_registry()?;
            (
                registry.closed,
                registry.accepted,
                registry.duplicates,
                registry.rejected,
                registry.completed.len(),
                registry
                    .lanes
                    .iter()
                    .map(|(account, lane)| (account.clone(), lane.clone()))
                    .collect::<Vec<_>>(),
            )
        };
        let now = Instant::now();
        let mut lane_snapshots = Vec::with_capacity(lanes.len());
        for (account, lane) in lanes {
            let state = lane
                .state
                .lock()
                .map_err(|_| InboxError::StatePoisoned("account lane snapshot"))?;
            lane_snapshots.push(LaneSnapshot {
                account,
                expected_sequence: state.expected_sequence,
                active_message: state.active_message.clone(),
                waiting_sequences: state.waiting.keys().copied().collect(),
                waiting_callers: state.waiting.values().sum(),
                processed: state.processed,
                failed: state.failed,
                last_completed_millis_ago: state
                    .last_completed_at
                    .map(|completed| now.saturating_duration_since(completed).as_millis()),
            });
        }
        lane_snapshots.sort_by(|left, right| left.account.cmp(&right.account));
        Ok(InboxSnapshot {
            closed,
            accepted,
            duplicates,
            rejected,
            completed_count,
            lane_count: lane_snapshots.len(),
            lanes: lane_snapshots,
        })
    }

    pub fn close(&self) -> Result<(), InboxError> {
        let mut registry = self.lock_registry()?;
        registry.closed = true;
        for lane in registry.lanes.values() {
            lane.changed.notify_all();
        }
        Ok(())
    }

    pub fn forget_completed_before(&self, age: Duration) -> Result<usize, InboxError> {
        let threshold = Instant::now().checked_sub(age).unwrap_or_else(Instant::now);
        let mut registry = self.lock_registry()?;
        let before = registry.completed.len();
        registry
            .completed
            .retain(|_, delivery| delivery.completed_at >= threshold);
        Ok(before - registry.completed.len())
    }

    fn completed_time(&self, message: &StreamMessage) -> Result<Option<Instant>, InboxError> {
        let mut registry = self.lock_registry()?;
        let completed = registry.completed.get(&message.id).cloned();
        match completed {
            Some(delivery)
                if delivery.account == message.account && delivery.sequence == message.sequence =>
            {
                registry.duplicates = registry.duplicates.saturating_add(1);
                Ok(Some(delivery.completed_at))
            }
            Some(_) => Err(InboxError::InvalidMessage(
                "completed identity was reused for another stream position".to_owned(),
            )),
            None => Ok(None),
        }
    }

    fn release_failure(&self, lane: &AccountLane) -> Result<(), InboxError> {
        let mut state = lane
            .state
            .lock()
            .map_err(|_| InboxError::StatePoisoned("account lane failure"))?;
        state.active_message = None;
        state.failed = state.failed.saturating_add(1);
        lane.changed.notify_all();
        self.increment_rejected()
    }

    fn increment_rejected(&self) -> Result<(), InboxError> {
        let mut registry = self.lock_registry()?;
        registry.rejected = registry.rejected.saturating_add(1);
        Ok(())
    }

    fn lock_registry(&self) -> Result<MutexGuard<'_, RegistryState>, InboxError> {
        self.registry
            .lock()
            .map_err(|_| InboxError::StatePoisoned("registry"))
    }
}

fn remove_waiter(state: &mut LaneState, sequence: u64) {
    if let Some(count) = state.waiting.get_mut(&sequence) {
        *count -= 1;
        if *count == 0 {
            state.waiting.remove(&sequence);
        }
    }
}

fn trim_completed(completed: &mut HashMap<String, CompletedDelivery>, limit: usize) {
    while completed.len() > limit {
        let oldest = completed
            .iter()
            .min_by_key(|(_, delivery)| delivery.completed_at)
            .map(|(identity, _)| identity.clone());
        if let Some(identity) = oldest {
            completed.remove(&identity);
        } else {
            break;
        }
    }
}
