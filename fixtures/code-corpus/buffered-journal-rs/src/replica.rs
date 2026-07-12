use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::domain::{ProviderEndpoint, ProviderStatus};

pub trait ProviderInvoker: Send + Sync {
    fn invoke(
        &self,
        endpoint: &ProviderEndpoint,
        operation: &str,
        deadline: Instant,
    ) -> Result<Vec<u8>, String>;
}

struct CircuitState {
    status: ProviderStatus,
    consecutive_failures: usize,
    consecutive_successes: usize,
    total_attempts: u64,
    total_failures: u64,
    in_flight: usize,
    opened_at: Option<Instant>,
    probe_in_flight: bool,
    last_attempt: Option<Instant>,
    last_success: Option<Instant>,
    last_latency: Option<Duration>,
    last_error: Option<String>,
    latency_ewma_micros: u64,
}

pub struct ReplicaSelector {
    states: Mutex<BTreeMap<String, CircuitState>>,
    rotation: AtomicU64,
}

impl ReplicaSelector {
    pub fn route(
        &self,
        endpoints: &[ProviderEndpoint],
        operation: &str,
        invoker: &dyn ProviderInvoker,
    ) -> Result<Option<Vec<u8>>, String> {
        if operation.trim().is_empty() {
            return Err("provider operation must not be empty".to_owned());
        }
        if endpoints.is_empty() {
            return Ok(None);
        }
        let mut names = BTreeSet::new();
        for endpoint in endpoints {
            if endpoint.name.trim().is_empty() {
                return Err("provider endpoint has an empty name".to_owned());
            }
            if endpoint.address.trim().is_empty() {
                return Err(format!("provider {} has an empty address", endpoint.name));
            }
            if !names.insert(endpoint.name.as_str()) {
                return Err(format!(
                    "provider name {} occurs more than once",
                    endpoint.name
                ));
            }
            if endpoint.failure_limit == 0 {
                return Err(format!(
                    "provider {} has a zero failure limit",
                    endpoint.name
                ));
            }
            if endpoint.success_limit == 0 {
                return Err(format!(
                    "provider {} has a zero recovery success limit",
                    endpoint.name
                ));
            }
            if endpoint.max_in_flight == 0 {
                return Err(format!(
                    "provider {} allows no in-flight requests",
                    endpoint.name
                ));
            }
            if endpoint.request_timeout.is_zero() {
                return Err(format!(
                    "provider {} has a zero request timeout",
                    endpoint.name
                ));
            }
        }
        let mut ordered: Vec<&ProviderEndpoint> = endpoints
            .iter()
            .filter(|endpoint| endpoint.enabled)
            .collect();
        if ordered.is_empty() {
            let mut states = self
                .states
                .lock()
                .map_err(|_| "provider circuit map is poisoned".to_owned())?;
            for endpoint in endpoints {
                let state = states.entry(endpoint.name.clone()).or_insert(CircuitState {
                    status: ProviderStatus::Disabled,
                    consecutive_failures: 0,
                    consecutive_successes: 0,
                    total_attempts: 0,
                    total_failures: 0,
                    in_flight: 0,
                    opened_at: None,
                    probe_in_flight: false,
                    last_attempt: None,
                    last_success: None,
                    last_latency: None,
                    last_error: None,
                    latency_ewma_micros: 0,
                });
                state.status = ProviderStatus::Disabled;
            }
            return Ok(None);
        }
        ordered.sort_by_key(|endpoint| (endpoint.priority, endpoint.name.as_str()));
        let rotation = self.rotation.fetch_add(1, Ordering::Relaxed);
        let mut ranked = Vec::with_capacity(ordered.len());
        let mut group_start = 0usize;
        while group_start < ordered.len() {
            let priority = ordered[group_start].priority;
            let mut group_end = group_start + 1;
            while group_end < ordered.len() && ordered[group_end].priority == priority {
                group_end += 1;
            }
            let group = &ordered[group_start..group_end];
            let total_weight = group
                .iter()
                .map(|endpoint| endpoint.weight.max(1) as u64)
                .sum::<u64>()
                .max(1);
            let pivot = rotation.wrapping_add(priority as u64 * 131) % total_weight;
            let mut cumulative = 0u64;
            let mut chosen = 0usize;
            for (index, endpoint) in group.iter().enumerate() {
                cumulative = cumulative.saturating_add(endpoint.weight.max(1) as u64);
                if pivot < cumulative {
                    chosen = index;
                    break;
                }
            }
            for offset in 0..group.len() {
                ranked.push(group[(chosen + offset) % group.len()]);
            }
            group_start = group_end;
        }
        let configured_names = endpoints
            .iter()
            .map(|endpoint| endpoint.name.as_str())
            .collect::<BTreeSet<_>>();
        {
            let mut states = self
                .states
                .lock()
                .map_err(|_| "provider circuit map is poisoned".to_owned())?;
            states.retain(|name, state| {
                configured_names.contains(name.as_str()) || state.in_flight != 0
            });
            for endpoint in endpoints {
                let state = states.entry(endpoint.name.clone()).or_insert(CircuitState {
                    status: if endpoint.enabled {
                        ProviderStatus::Closed
                    } else {
                        ProviderStatus::Disabled
                    },
                    consecutive_failures: 0,
                    consecutive_successes: 0,
                    total_attempts: 0,
                    total_failures: 0,
                    in_flight: 0,
                    opened_at: None,
                    probe_in_flight: false,
                    last_attempt: None,
                    last_success: None,
                    last_latency: None,
                    last_error: None,
                    latency_ewma_micros: 0,
                });
                if !endpoint.enabled {
                    state.status = ProviderStatus::Disabled;
                    state.probe_in_flight = false;
                } else if state.status == ProviderStatus::Disabled {
                    state.status = ProviderStatus::Closed;
                    state.consecutive_failures = 0;
                    state.consecutive_successes = 0;
                    state.opened_at = None;
                }
            }
        }
        let mut attempted = Vec::new();
        let mut skipped_open = Vec::new();
        let mut skipped_busy = Vec::new();
        let mut last_error = None;
        for endpoint in ranked {
            let now = Instant::now();
            let reservation = {
                let mut states = self
                    .states
                    .lock()
                    .map_err(|_| "provider circuit map is poisoned".to_owned())?;
                let state = states.get_mut(&endpoint.name).ok_or_else(|| {
                    format!("missing circuit state for provider {}", endpoint.name)
                })?;
                if state.status == ProviderStatus::Open {
                    let cooled = state.opened_at.is_some_and(|opened| {
                        now.saturating_duration_since(opened) >= endpoint.cooldown
                    });
                    if cooled {
                        state.status = ProviderStatus::HalfOpen;
                        state.consecutive_successes = 0;
                        state.probe_in_flight = false;
                    }
                }
                match state.status {
                    ProviderStatus::Disabled => false,
                    ProviderStatus::Open => {
                        skipped_open.push(endpoint.name.clone());
                        false
                    }
                    ProviderStatus::HalfOpen if state.probe_in_flight => {
                        skipped_busy.push(endpoint.name.clone());
                        false
                    }
                    ProviderStatus::Closed if state.in_flight >= endpoint.max_in_flight => {
                        skipped_busy.push(endpoint.name.clone());
                        false
                    }
                    ProviderStatus::HalfOpen | ProviderStatus::Closed => {
                        state.in_flight = state.in_flight.saturating_add(1);
                        state.total_attempts = state.total_attempts.saturating_add(1);
                        state.last_attempt = Some(now);
                        if state.status == ProviderStatus::HalfOpen {
                            state.probe_in_flight = true;
                        }
                        true
                    }
                }
            };
            if !reservation {
                continue;
            }
            attempted.push(endpoint.name.clone());
            let started = Instant::now();
            let deadline = started
                .checked_add(endpoint.request_timeout)
                .unwrap_or(started);
            let response = invoker.invoke(endpoint, operation, deadline);
            let elapsed = started.elapsed();
            let timed_out = elapsed > endpoint.request_timeout;
            let normalized_response = if timed_out {
                Err(format!(
                    "provider {} exceeded its {:?} request timeout after {:?}",
                    endpoint.name, endpoint.request_timeout, elapsed
                ))
            } else {
                response
            };
            let mut states = self
                .states
                .lock()
                .map_err(|_| "provider circuit map is poisoned after invocation".to_owned())?;
            let state = states
                .get_mut(&endpoint.name)
                .ok_or_else(|| format!("circuit state vanished for provider {}", endpoint.name))?;
            state.in_flight = state.in_flight.saturating_sub(1);
            state.probe_in_flight = false;
            state.last_latency = Some(elapsed);
            let latency_micros = elapsed.as_micros().min(u64::MAX as u128) as u64;
            state.latency_ewma_micros = if state.latency_ewma_micros == 0 {
                latency_micros
            } else {
                state
                    .latency_ewma_micros
                    .saturating_mul(7)
                    .saturating_add(latency_micros)
                    / 8
            };
            match normalized_response {
                Ok(bytes) => {
                    state.consecutive_failures = 0;
                    state.consecutive_successes = state.consecutive_successes.saturating_add(1);
                    state.last_success = Some(Instant::now());
                    state.last_error = None;
                    if state.status == ProviderStatus::HalfOpen
                        && state.consecutive_successes >= endpoint.success_limit
                    {
                        state.status = ProviderStatus::Closed;
                        state.opened_at = None;
                        state.consecutive_successes = 0;
                    }
                    return Ok(Some(bytes));
                }
                Err(error) => {
                    state.total_failures = state.total_failures.saturating_add(1);
                    state.consecutive_failures = state.consecutive_failures.saturating_add(1);
                    state.consecutive_successes = 0;
                    state.last_error = Some(error.clone());
                    let should_open = state.status == ProviderStatus::HalfOpen
                        || state.consecutive_failures >= endpoint.failure_limit;
                    if should_open {
                        state.status = ProviderStatus::Open;
                        state.opened_at = Some(Instant::now());
                    }
                    last_error = Some(format!("{}: {error}", endpoint.name));
                }
            }
        }
        if let Some(error) = last_error {
            let attempted_text = if attempted.is_empty() {
                "none".to_owned()
            } else {
                attempted.join(", ")
            };
            let open_text = if skipped_open.is_empty() {
                "none".to_owned()
            } else {
                skipped_open.join(", ")
            };
            let busy_text = if skipped_busy.is_empty() {
                "none".to_owned()
            } else {
                skipped_busy.join(", ")
            };
            Err(format!(
                "all eligible providers failed for {operation}; attempted [{attempted_text}], open [{open_text}], busy [{busy_text}]; last error {error}"
            ))
        } else if !skipped_open.is_empty() || !skipped_busy.is_empty() {
            Ok(None)
        } else {
            Err(format!(
                "no enabled provider accepted operation {operation}"
            ))
        }
    }
}

impl Default for ReplicaSelector {
    fn default() -> Self {
        Self {
            states: Mutex::new(BTreeMap::new()),
            rotation: AtomicU64::new(0),
        }
    }
}
