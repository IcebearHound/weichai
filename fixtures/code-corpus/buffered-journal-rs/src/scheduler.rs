use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::domain::RetryClass;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RetryTicket {
    Waiting {
        identity: String,
        account: String,
        class: RetryClass,
        attempt: u32,
        submitted_at_ms: u64,
        ready_at_ms: u64,
        deadline_ms: Option<u64>,
        payload: Vec<u8>,
        last_error: String,
    },
    Leased {
        identity: String,
        account: String,
        class: RetryClass,
        attempt: u32,
        leased_at_ms: u64,
        lease_until_ms: u64,
        deadline_ms: Option<u64>,
        payload: Vec<u8>,
        last_error: String,
    },
}

pub enum SchedulerCommand {
    Schedule {
        now_ms: u64,
        identity: String,
        account: String,
        class: RetryClass,
        attempt: u32,
        requested_delay_ms: u64,
        deadline_ms: Option<u64>,
        payload: Vec<u8>,
        last_error: String,
    },
    Poll {
        now_ms: u64,
        capacity: usize,
        maximum_per_account: usize,
        lease_ms: u64,
    },
    Complete {
        identity: String,
    },
    Release {
        now_ms: u64,
        identity: String,
        class: RetryClass,
        error: String,
    },
    Cancel {
        identity: String,
    },
    ReclaimExpired {
        now_ms: u64,
    },
    Inspect,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SchedulerOutcome {
    Scheduled {
        identity: String,
        ready_at_ms: u64,
        replaced: bool,
    },
    Dispatch(Vec<RetryTicket>),
    Completed(bool),
    Released {
        identity: String,
        ready_at_ms: u64,
    },
    Cancelled(bool),
    Reclaimed(usize),
    Snapshot {
        waiting: usize,
        leased: usize,
        by_account: BTreeMap<String, usize>,
        by_class: BTreeMap<RetryClass, usize>,
        next_ready_at_ms: Option<u64>,
        recent_events: Vec<String>,
    },
}

pub struct RetryScheduler {
    pub maximum_entries: usize,
    pub maximum_payload_bytes: usize,
    pub minimum_delay_ms: u64,
    pub maximum_delay_ms: u64,
    pub entries: BTreeMap<String, RetryTicket>,
    pub timeline: BTreeMap<u64, BTreeSet<String>>,
    pub account_depth: BTreeMap<String, usize>,
    pub recent_events: VecDeque<String>,
    pub event_capacity: usize,
}

impl RetryScheduler {
    pub fn advance(&mut self, command: SchedulerCommand) -> Result<SchedulerOutcome, String> {
        if self.maximum_entries == 0 {
            return Err("retry scheduler maximum entries must be greater than zero".to_owned());
        }
        if self.maximum_payload_bytes == 0 {
            return Err(
                "retry scheduler maximum payload bytes must be greater than zero".to_owned(),
            );
        }
        if self.minimum_delay_ms > self.maximum_delay_ms {
            return Err(format!(
                "retry delay range is inverted: {}..{}",
                self.minimum_delay_ms, self.maximum_delay_ms
            ));
        }
        match command {
            SchedulerCommand::Schedule {
                now_ms,
                identity,
                account,
                class,
                attempt,
                requested_delay_ms,
                deadline_ms,
                payload,
                last_error,
            } => {
                if identity.trim().is_empty() {
                    return Err("retry identity must not be empty".to_owned());
                }
                if account.trim().is_empty() {
                    return Err(format!("retry {identity} has an empty account"));
                }
                if payload.len() > self.maximum_payload_bytes {
                    return Err(format!(
                        "retry {identity} payload is {} bytes, above maximum {}",
                        payload.len(),
                        self.maximum_payload_bytes
                    ));
                }
                if class == RetryClass::Permanent {
                    return Err(format!("retry {identity} is classified as permanent"));
                }
                if deadline_ms.is_some_and(|deadline| deadline <= now_ms) {
                    return Err(format!("retry {identity} deadline has already passed"));
                }
                if !self.entries.contains_key(&identity)
                    && self.entries.len() >= self.maximum_entries
                {
                    return Err(format!(
                        "retry scheduler is full at {} entries",
                        self.entries.len()
                    ));
                }
                let exponent = attempt.min(20);
                let base = match class {
                    RetryClass::Immediate => 0,
                    RetryClass::Transient => 25,
                    RetryClass::Congestion => 100,
                    RetryClass::ProviderUnavailable => 250,
                    RetryClass::StorageBusy => 500,
                    RetryClass::Permanent => self.maximum_delay_ms,
                };
                let exponential = base
                    .saturating_mul(1u64.checked_shl(exponent).unwrap_or(u64::MAX))
                    .min(self.maximum_delay_ms);
                let requested = requested_delay_ms
                    .max(self.minimum_delay_ms)
                    .min(self.maximum_delay_ms);
                let nominal = exponential.max(requested).min(self.maximum_delay_ms);
                let mut hash = 0xcbf29ce484222325u64;
                for byte in identity.as_bytes().iter().chain(account.as_bytes()) {
                    hash ^= *byte as u64;
                    hash = hash.wrapping_mul(0x100000001b3);
                }
                hash ^= attempt as u64;
                let jitter_span = nominal / 5;
                let jitter = if jitter_span == 0 {
                    0
                } else {
                    let width = jitter_span.saturating_mul(2).saturating_add(1);
                    (hash % width) as i128 - jitter_span as i128
                };
                let adjusted = if jitter < 0 {
                    nominal.saturating_sub((-jitter) as u64)
                } else {
                    nominal
                        .saturating_add(jitter as u64)
                        .min(self.maximum_delay_ms)
                };
                let ready_at_ms = now_ms
                    .checked_add(adjusted)
                    .ok_or_else(|| format!("retry {identity} ready time overflowed"))?;
                if deadline_ms.is_some_and(|deadline| ready_at_ms >= deadline) {
                    return Err(format!(
                        "retry {identity} would become ready at {ready_at_ms}, not before deadline {}",
                        deadline_ms.unwrap_or(ready_at_ms)
                    ));
                }
                let replacement = self.entries.remove(&identity);
                if let Some(previous) = &replacement {
                    let (previous_account, previous_ready) = match previous {
                        RetryTicket::Waiting {
                            account,
                            ready_at_ms,
                            ..
                        } => (account, Some(*ready_at_ms)),
                        RetryTicket::Leased { account, .. } => (account, None),
                    };
                    if let Some(ready) = previous_ready {
                        if let Some(identities) = self.timeline.get_mut(&ready) {
                            identities.remove(&identity);
                            if identities.is_empty() {
                                self.timeline.remove(&ready);
                            }
                        }
                    }
                    if let Some(depth) = self.account_depth.get_mut(previous_account) {
                        *depth = depth.saturating_sub(1);
                        if *depth == 0 {
                            self.account_depth.remove(previous_account);
                        }
                    }
                }
                let ticket = RetryTicket::Waiting {
                    identity: identity.clone(),
                    account: account.clone(),
                    class,
                    attempt,
                    submitted_at_ms: now_ms,
                    ready_at_ms,
                    deadline_ms,
                    payload,
                    last_error,
                };
                self.entries.insert(identity.clone(), ticket);
                self.timeline
                    .entry(ready_at_ms)
                    .or_default()
                    .insert(identity.clone());
                *self.account_depth.entry(account.clone()).or_insert(0) += 1;
                self.recent_events.push_back(format!(
                    "scheduled {identity} for account {account} at {ready_at_ms} after attempt {attempt}"
                ));
                while self.recent_events.len() > self.event_capacity {
                    self.recent_events.pop_front();
                }
                Ok(SchedulerOutcome::Scheduled {
                    identity,
                    ready_at_ms,
                    replaced: replacement.is_some(),
                })
            }
            SchedulerCommand::Poll {
                now_ms,
                capacity,
                maximum_per_account,
                lease_ms,
            } => {
                if capacity == 0 {
                    return Ok(SchedulerOutcome::Dispatch(Vec::new()));
                }
                if maximum_per_account == 0 {
                    return Err("poll maximum per account must be greater than zero".to_owned());
                }
                if lease_ms == 0 {
                    return Err("retry lease duration must be greater than zero".to_owned());
                }
                let due_times = self
                    .timeline
                    .range(..=now_ms)
                    .map(|(time, _)| *time)
                    .collect::<Vec<_>>();
                let mut due_identities = VecDeque::new();
                for time in due_times {
                    if let Some(identities) = self.timeline.remove(&time) {
                        for identity in identities {
                            due_identities.push_back(identity);
                        }
                    }
                }
                let mut selected = Vec::new();
                let mut per_account = BTreeMap::new();
                let mut deferred = Vec::new();
                while let Some(identity) = due_identities.pop_front() {
                    let ticket = match self.entries.remove(&identity) {
                        Some(ticket @ RetryTicket::Waiting { .. }) => ticket,
                        Some(ticket @ RetryTicket::Leased { .. }) => {
                            self.entries.insert(identity, ticket);
                            continue;
                        }
                        None => continue,
                    };
                    let (
                        ticket_identity,
                        account,
                        class,
                        attempt,
                        deadline_ms,
                        payload,
                        last_error,
                        ready_at_ms,
                    ) = match ticket {
                        RetryTicket::Waiting {
                            identity,
                            account,
                            class,
                            attempt,
                            deadline_ms,
                            payload,
                            last_error,
                            ready_at_ms,
                            ..
                        } => (
                            identity,
                            account,
                            class,
                            attempt,
                            deadline_ms,
                            payload,
                            last_error,
                            ready_at_ms,
                        ),
                        RetryTicket::Leased { .. } => {
                            unreachable!("leased tickets were returned above")
                        }
                    };
                    if deadline_ms.is_some_and(|deadline| deadline <= now_ms) {
                        if let Some(depth) = self.account_depth.get_mut(&account) {
                            *depth = depth.saturating_sub(1);
                            if *depth == 0 {
                                self.account_depth.remove(&account);
                            }
                        }
                        self.recent_events
                            .push_back(format!("expired {ticket_identity} for account {account}"));
                        continue;
                    }
                    let account_selected = *per_account.get(&account).unwrap_or(&0usize);
                    if selected.len() >= capacity || account_selected >= maximum_per_account {
                        deferred.push((
                            ready_at_ms,
                            RetryTicket::Waiting {
                                identity: ticket_identity,
                                account,
                                class,
                                attempt,
                                submitted_at_ms: now_ms,
                                ready_at_ms,
                                deadline_ms,
                                payload,
                                last_error,
                            },
                        ));
                        continue;
                    }
                    let lease_until_ms = now_ms
                        .checked_add(lease_ms)
                        .ok_or_else(|| "retry lease time overflowed".to_owned())?;
                    let leased = RetryTicket::Leased {
                        identity: ticket_identity.clone(),
                        account: account.clone(),
                        class,
                        attempt,
                        leased_at_ms: now_ms,
                        lease_until_ms,
                        deadline_ms,
                        payload,
                        last_error,
                    };
                    self.entries.insert(ticket_identity.clone(), leased.clone());
                    *per_account.entry(account.clone()).or_insert(0) += 1;
                    self.recent_events.push_back(format!(
                        "leased {ticket_identity} for account {account} until {lease_until_ms}"
                    ));
                    selected.push(leased);
                }
                for (ready, ticket) in deferred {
                    let identity = match &ticket {
                        RetryTicket::Waiting { identity, .. } => identity.clone(),
                        RetryTicket::Leased { identity, .. } => identity.clone(),
                    };
                    self.entries.insert(identity.clone(), ticket);
                    self.timeline.entry(ready).or_default().insert(identity);
                }
                while self.recent_events.len() > self.event_capacity {
                    self.recent_events.pop_front();
                }
                Ok(SchedulerOutcome::Dispatch(selected))
            }
            SchedulerCommand::Complete { identity } => {
                let removed = self.entries.remove(&identity);
                if let Some(ticket) = &removed {
                    let account = match ticket {
                        RetryTicket::Waiting {
                            account,
                            ready_at_ms,
                            ..
                        } => {
                            if let Some(identities) = self.timeline.get_mut(ready_at_ms) {
                                identities.remove(&identity);
                                if identities.is_empty() {
                                    self.timeline.remove(ready_at_ms);
                                }
                            }
                            account
                        }
                        RetryTicket::Leased { account, .. } => account,
                    };
                    if let Some(depth) = self.account_depth.get_mut(account) {
                        *depth = depth.saturating_sub(1);
                        if *depth == 0 {
                            self.account_depth.remove(account);
                        }
                    }
                    self.recent_events
                        .push_back(format!("completed retry {identity}"));
                }
                Ok(SchedulerOutcome::Completed(removed.is_some()))
            }
            SchedulerCommand::Release {
                now_ms,
                identity,
                class,
                error,
            } => {
                let ticket = self
                    .entries
                    .remove(&identity)
                    .ok_or_else(|| format!("cannot release unknown retry {identity}"))?;
                let (account, attempt, deadline_ms, payload) = match ticket {
                    RetryTicket::Leased {
                        account,
                        attempt,
                        deadline_ms,
                        payload,
                        ..
                    } => (account, attempt.saturating_add(1), deadline_ms, payload),
                    waiting @ RetryTicket::Waiting { .. } => {
                        let ready_at_ms = match &waiting {
                            RetryTicket::Waiting { ready_at_ms, .. } => *ready_at_ms,
                            RetryTicket::Leased { .. } => unreachable!("matched waiting retry"),
                        };
                        self.entries.insert(identity.clone(), waiting);
                        self.timeline
                            .entry(ready_at_ms)
                            .or_default()
                            .insert(identity.clone());
                        return Err(format!("retry {identity} is waiting, not leased"));
                    }
                };
                let base = match class {
                    RetryClass::Immediate => self.minimum_delay_ms,
                    RetryClass::Transient => 50,
                    RetryClass::Congestion => 200,
                    RetryClass::ProviderUnavailable => 500,
                    RetryClass::StorageBusy => 1_000,
                    RetryClass::Permanent => {
                        if let Some(depth) = self.account_depth.get_mut(&account) {
                            *depth = depth.saturating_sub(1);
                        }
                        return Err(format!(
                            "retry {identity} became permanently failed: {error}"
                        ));
                    }
                };
                let delay = base
                    .saturating_mul(1u64.checked_shl(attempt.min(20)).unwrap_or(u64::MAX))
                    .max(self.minimum_delay_ms)
                    .min(self.maximum_delay_ms);
                let ready_at_ms = now_ms.saturating_add(delay);
                if deadline_ms.is_some_and(|deadline| ready_at_ms >= deadline) {
                    if let Some(depth) = self.account_depth.get_mut(&account) {
                        *depth = depth.saturating_sub(1);
                    }
                    return Err(format!(
                        "retry {identity} cannot be released before its deadline"
                    ));
                }
                let waiting = RetryTicket::Waiting {
                    identity: identity.clone(),
                    account: account.clone(),
                    class,
                    attempt,
                    submitted_at_ms: now_ms,
                    ready_at_ms,
                    deadline_ms,
                    payload,
                    last_error: error,
                };
                self.entries.insert(identity.clone(), waiting);
                self.timeline
                    .entry(ready_at_ms)
                    .or_default()
                    .insert(identity.clone());
                self.recent_events.push_back(format!(
                    "released {identity} for account {account}; next attempt at {ready_at_ms}"
                ));
                Ok(SchedulerOutcome::Released {
                    identity,
                    ready_at_ms,
                })
            }
            SchedulerCommand::Cancel { identity } => {
                let removed = self.entries.remove(&identity);
                if let Some(ticket) = &removed {
                    let account = match ticket {
                        RetryTicket::Waiting {
                            account,
                            ready_at_ms,
                            ..
                        } => {
                            if let Some(identities) = self.timeline.get_mut(ready_at_ms) {
                                identities.remove(&identity);
                                if identities.is_empty() {
                                    self.timeline.remove(ready_at_ms);
                                }
                            }
                            account
                        }
                        RetryTicket::Leased { account, .. } => account,
                    };
                    if let Some(depth) = self.account_depth.get_mut(account) {
                        *depth = depth.saturating_sub(1);
                        if *depth == 0 {
                            self.account_depth.remove(account);
                        }
                    }
                    self.recent_events
                        .push_back(format!("cancelled retry {identity}"));
                }
                Ok(SchedulerOutcome::Cancelled(removed.is_some()))
            }
            SchedulerCommand::ReclaimExpired { now_ms } => {
                let expired = self
                    .entries
                    .iter()
                    .filter_map(|(identity, ticket)| match ticket {
                        RetryTicket::Leased { lease_until_ms, .. } if *lease_until_ms <= now_ms => {
                            Some(identity.clone())
                        }
                        RetryTicket::Waiting {
                            deadline_ms: Some(deadline),
                            ..
                        } if *deadline <= now_ms => Some(identity.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                let mut reclaimed = 0usize;
                for identity in expired {
                    let Some(ticket) = self.entries.remove(&identity) else {
                        continue;
                    };
                    match ticket {
                        RetryTicket::Leased {
                            account,
                            class,
                            attempt,
                            deadline_ms,
                            payload,
                            last_error,
                            ..
                        } => {
                            if deadline_ms.is_some_and(|deadline| deadline <= now_ms) {
                                if let Some(depth) = self.account_depth.get_mut(&account) {
                                    *depth = depth.saturating_sub(1);
                                }
                                self.recent_events
                                    .push_back(format!("expired leased retry {identity}"));
                            } else {
                                let ready_at_ms = now_ms.saturating_add(self.minimum_delay_ms);
                                self.entries.insert(
                                    identity.clone(),
                                    RetryTicket::Waiting {
                                        identity: identity.clone(),
                                        account,
                                        class,
                                        attempt: attempt.saturating_add(1),
                                        submitted_at_ms: now_ms,
                                        ready_at_ms,
                                        deadline_ms,
                                        payload,
                                        last_error,
                                    },
                                );
                                self.timeline
                                    .entry(ready_at_ms)
                                    .or_default()
                                    .insert(identity.clone());
                                self.recent_events
                                    .push_back(format!("reclaimed expired lease {identity}"));
                            }
                        }
                        RetryTicket::Waiting {
                            account,
                            ready_at_ms,
                            ..
                        } => {
                            if let Some(identities) = self.timeline.get_mut(&ready_at_ms) {
                                identities.remove(&identity);
                                if identities.is_empty() {
                                    self.timeline.remove(&ready_at_ms);
                                }
                            }
                            if let Some(depth) = self.account_depth.get_mut(&account) {
                                *depth = depth.saturating_sub(1);
                            }
                            self.recent_events
                                .push_back(format!("expired waiting retry {identity}"));
                        }
                    }
                    reclaimed = reclaimed.saturating_add(1);
                }
                self.account_depth.retain(|_, depth| *depth > 0);
                while self.recent_events.len() > self.event_capacity {
                    self.recent_events.pop_front();
                }
                Ok(SchedulerOutcome::Reclaimed(reclaimed))
            }
            SchedulerCommand::Inspect => {
                let mut waiting = 0usize;
                let mut leased = 0usize;
                let mut by_class = BTreeMap::new();
                for ticket in self.entries.values() {
                    let class = match ticket {
                        RetryTicket::Waiting { class, .. } => {
                            waiting = waiting.saturating_add(1);
                            *class
                        }
                        RetryTicket::Leased { class, .. } => {
                            leased = leased.saturating_add(1);
                            *class
                        }
                    };
                    *by_class.entry(class).or_insert(0) += 1;
                }
                Ok(SchedulerOutcome::Snapshot {
                    waiting,
                    leased,
                    by_account: self.account_depth.clone(),
                    by_class,
                    next_ready_at_ms: self.timeline.keys().next().copied(),
                    recent_events: self.recent_events.iter().cloned().collect(),
                })
            }
        }
    }
}
