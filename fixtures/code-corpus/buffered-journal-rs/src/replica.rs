use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::domain::{ProviderEndpoint, ProviderStatus};

/// 提供方调用器:执行一次具体的外部请求。
pub trait ProviderInvoker: Send + Sync {
    fn invoke(
        &self,
        endpoint: &ProviderEndpoint,
        operation: &str,
        deadline: Instant,
    ) -> Result<Vec<u8>, String>;
}

/// 单个端点的熔断器内部状态。
struct CircuitState {
    status: ProviderStatus,
    consecutive_failures: usize,
    consecutive_successes: usize,
    total_attempts: u64,
    total_failures: u64,
    /// 当前在途请求数(限制并发)。
    in_flight: usize,
    opened_at: Option<Instant>,
    /// 半开状态是否已有试探请求在途(只允许一个)。
    probe_in_flight: bool,
    last_attempt: Option<Instant>,
    last_success: Option<Instant>,
    last_latency: Option<Duration>,
    last_error: Option<String>,
    /// 延迟指数移动平均(微秒),用于诊断。
    latency_ewma_micros: u64,
}

/// 副本选择器:按优先级/权重对提供方做加权轮询,并对每个端点维护熔断器。
///
/// 行为:只尝试 enabled 端点;Closed 端点超过并发上限则跳过,Open 端点冷却期
/// 后转为 HalfOpen 放行单个探测请求;任一成功立即返回,全部失败则聚合错误。
pub struct ReplicaSelector {
    states: Mutex<BTreeMap<String, CircuitState>>,
    /// 轮询游标(全局递增,用于加权轮询起点)。
    rotation: AtomicU64,
}

impl ReplicaSelector {
    /// 路由一次操作:在可用端点中选择一个并调用 `invoker`,返回其响应。
    ///
    /// `Ok(None)` 表示没有端点可尝试(全部禁用/熔断/繁忙);
    /// `Err` 表示尝试了但全部失败(或配置非法)。
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
        // 配置校验:名称/地址非空、名称唯一、关键限额非零。
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
            // 没有启用端点:把全部端点状态置为 Disabled。
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
        // 先按优先级排序,再对同优先级组做加权轮询并拼接成完整尝试顺序。
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
            // 加权轮询:以权重和取模选起点,再从起点环形遍历,保证负载分散。
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
            // 清理已不配置的端点状态(仍有在途请求的保留);为每个端点准备/更新状态。
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
                    // 端点重新启用:从 Closed 重新开始。
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
            // 预订阶段:决定本端点是否可尝试(熔断/并发检查),可尝试则登记在途。
            let reservation = {
                let mut states = self
                    .states
                    .lock()
                    .map_err(|_| "provider circuit map is poisoned".to_owned())?;
                let state = states.get_mut(&endpoint.name).ok_or_else(|| {
                    format!("missing circuit state for provider {}", endpoint.name)
                })?;
                // Open 端点冷却期满后转 HalfOpen 放行试探。
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
                        // 半开只放行一个探测请求。
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
            // 锁外执行调用,避免长时间持锁。
            let started = Instant::now();
            let deadline = started
                .checked_add(endpoint.request_timeout)
                .unwrap_or(started);
            let response = invoker.invoke(endpoint, operation, deadline);
            let elapsed = started.elapsed();
            // 调用方未及时返回也按超时失败处理。
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
                    // 半开试探成功且连续成功达标 → 关闭熔断,恢复正常。
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
                    // 半开试探失败或连续失败达标 → 打开熔断。
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
        // 汇总结果:有实际失败 → Err;只因熔断/繁忙没试成 → Ok(None);
        // 没有任何启用端点接受请求 → Err。
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
