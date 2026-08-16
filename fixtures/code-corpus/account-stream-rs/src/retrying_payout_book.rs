use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// 一笔待发起的付款。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Payout {
    pub id: String,
    /// 出账账户(资金来源)。
    pub account: String,
    /// 收款人账户。
    pub beneficiary: String,
    /// 金额(最小货币单位,如分)。
    pub amount_minor: i64,
    /// ISO 风格的三位大写货币代码。
    pub currency: String,
    /// 业务引用(如发票号)。
    pub reference: String,
}

impl Payout {
    /// 校验付款字段的业务约束。
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("payout identity is required".to_owned());
        }
        if self.account.trim().is_empty() || self.beneficiary.trim().is_empty() {
            return Err("payout accounts are required".to_owned());
        }
        // 禁止自我转账,规避冲账/套利类歧义。
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

    /// 生成业务指纹:所有关键字段的 FNV-1a 哈希。
    ///
    /// 相同业务内容的付款必然产生相同指纹,用于识别批次内容是否变化;
    /// 字段间以 0xff 分隔,防止相邻字段拼接产生碰撞。
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
        // 金额按字节混入,保证 (100, USD) 与 (10000, USD) 等数值差异体现在指纹中。
        for byte in self.amount_minor.to_be_bytes() {
            state ^= u64::from(byte);
            state = state.wrapping_mul(0x100000001b3);
        }
        format!("{state:016x}")
    }
}

/// 一次成功付款后由服务方签发的回执。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutReceipt {
    /// 由批次键、付款 id 与服务方令牌派生的唯一回执标识。
    pub identity: String,
    pub payout_id: String,
    pub provider_token: String,
    pub route: String,
    /// 成功时的尝试次数(1 起)。
    pub attempt: u32,
    /// 自批次开始到完成所经过的毫秒数。
    pub completed_millis: u128,
}

/// 单笔付款的最终结果。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PayoutResult {
    /// 已结清,附回执。
    Settled(PayoutReceipt),
    /// 所有尝试均失败。
    Failed { attempts: u32, reason: String },
}

/// 一次批量执行的中途状态,用于并发加入者的等待与结果广播。
#[derive(Debug)]
struct BatchFlightState {
    finished: bool,
    fingerprint: String,
    result: Vec<PayoutResult>,
    error: Option<String>,
}

/// 一次“进行中”的批量执行:条件变量唤醒等待该批次完成的加入者。
#[derive(Debug)]
struct BatchFlight {
    state: Mutex<BatchFlightState>,
    changed: Condvar,
}

/// 已完成的批次缓存,供相同批次键的重放直接返回结果。
#[derive(Clone, Debug)]
struct CompletedBatch {
    fingerprint: String,
    result: Vec<PayoutResult>,
    completed_at: Instant,
}

/// 付款簿的内部状态。
#[derive(Debug, Default)]
struct BookState {
    /// 批次键 -> 已完成的批次(用于重放去重)。
    completed: HashMap<String, CompletedBatch>,
    /// 付款 id -> 已签发的回执(跨批次幂等)。
    receipts: HashMap<String, PayoutReceipt>,
    /// 批次键 -> 进行中的执行。
    running: HashMap<String, Arc<BatchFlight>>,
    /// 付款 id -> 累计尝试次数(诊断用)。
    attempts_by_payout: BTreeMap<String, u32>,
    joined_batches: u64,
    replayed_batches: u64,
}

/// 付款簿的只读快照。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutBookSnapshot {
    pub completed_batches: usize,
    pub running_batches: usize,
    pub receipt_count: usize,
    pub joined_batches: u64,
    pub replayed_batches: u64,
    pub attempts_by_payout: BTreeMap<String, u32>,
}

/// 带重试与并发合并的付款簿。
///
/// 不变量:
/// - 同一批次键只执行一次底层操作,后续重放直接返回缓存结果;
/// - 同一付款 id 只会得到一份回执(即使跨批次重复出现);
/// - 并发提交相同批次键时,只有一个“领队”执行,其余线程等待并分享结果。
#[derive(Debug)]
pub struct RetryingPayoutBook {
    /// 每笔付款的最大尝试次数。
    attempts: u32,
    state: Mutex<BookState>,
}

impl RetryingPayoutBook {
    /// 创建付款簿。尝试次数必须在 [1, 12] 内(上限限制重试风暴)。
    pub fn new(attempts: u32) -> Result<Self, String> {
        if attempts == 0 || attempts > 12 {
            return Err("attempt limit must be between one and twelve".to_owned());
        }
        Ok(Self {
            attempts,
            state: Mutex::new(BookState::default()),
        })
    }

    /// 应用一批付款。
    ///
    /// `operation` 对每笔付款尝试执行外部支付操作,返回(服务方令牌, 路由)。
    /// 流程:校验 → 幂等去重/并发合并 → 领队逐笔重试执行 → 缓存结果供重放。
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
            // 已完成:校验指纹一致后直接返回缓存结果,绝不重复执行操作。
            if let Some(completed) = state.completed.get(key).cloned() {
                if completed.fingerprint != fingerprint {
                    return Err("batch key already names a different payout set".to_owned());
                }
                state.replayed_batches = state.replayed_batches.saturating_add(1);
                return Ok(completed.result);
            }
            // 进行中:作为加入者共享同一执行;指纹不一致则报冲突。
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
                // 首次提交:创建执行航班,成为领队。
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
            // 加入者:挂起等待领队完成,然后取回结果或错误。
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
            // 成功才缓存;失败不缓存,允许同键后续重试。
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
            // 唤醒所有加入者并公布结果。
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

    /// 生成付款簿快照。
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

    /// 遗忘早于给定年龄的已完成批次缓存(回执保留,重放能力随之失效)。
    pub fn forget_batches_older_than(&self, age: Duration) -> Result<usize, String> {
        let threshold = Instant::now().checked_sub(age).unwrap_or_else(Instant::now);
        let mut state = self.state.lock().map_err(|_| "payout book lock poisoned")?;
        let before = state.completed.len();
        state
            .completed
            .retain(|_, completed| completed.completed_at >= threshold);
        Ok(before - state.completed.len())
    }

    /// 逐笔执行:已有回执的付款直接复用;否则按 `attempts` 上限重试,
    /// 首个成功结果作为该付款的规范化回执(即使后续批次再次出现也返回同一份)。
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
                        // 首次写入胜出,后续批次(即使令牌不同)也返回第一次的回执,保证幂等。
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

/// 批次指纹:对所有付款指纹做加盐旋转哈希,任一字段变化都会改变结果。
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

/// 回执标识:由批次键 + 付款 id + 服务方令牌混合哈希生成,确保全局唯一且可追溯。
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
