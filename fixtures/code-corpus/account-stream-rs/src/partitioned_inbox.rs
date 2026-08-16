use std::collections::{BTreeMap, HashMap};
use std::fmt::{Display, Formatter};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// 一条待投递的流消息。`id` 是全局唯一标识,用于幂等去重;
/// `account` 决定消息归属于哪个处理通道,同一账户内的消息严格按 `sequence` 有序处理。
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
    /// 校验消息字段是否合法,阻止畸形消息进入投递流程。
    ///
    /// 边界(消息体 1 MiB、头 32 个)既是资源保护,也是与下游解码方达成的协议约束。
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
        // 序列号从 1 开始,0 作为“尚未开始”的哨兵值保留。
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

/// 单次投递的结果:要么被处理并推进了序列,要么因消息已处理过而作为重复投递返回。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeliveryOutcome {
    /// 消息已成功处理:`next_sequence` 是下一次可被接收的序列号。
    Processed { next_sequence: u64 },
    /// 消息此前已完成处理,本次为重复投递,`completed_at` 为首次完成时刻。
    Duplicate { completed_at: Instant },
}

/// 投递过程中可能出现的错误分类。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InboxError {
    /// 消息字段非法。
    InvalidMessage(String),
    /// 消息序列落后于通道期望,已不可能再被接受。
    SequenceBehind { expected: u64, received: u64 },
    /// 等待缺失的前序序列超时,消息被放弃。
    SequenceWaitExpired { expected: u64, received: u64 },
    /// 用户消息处理器失败。
    HandlerFailed(String),
    /// 确认回调失败。
    AcknowledgeFailed(String),
    /// 内部锁中毒(持锁线程 panic)。
    StatePoisoned(&'static str),
    /// 收件箱已关闭,拒绝新消息。
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

/// 已完成的投递记录,仅用于幂等去重(通过消息 id 索引)。
#[derive(Clone, Debug)]
struct CompletedDelivery {
    account: String,
    sequence: u64,
    completed_at: Instant,
}

/// 单个账户通道的运行状态。
#[derive(Debug)]
struct LaneState {
    /// 下一个期望接收的序列号(即已处理序列 + 1)。
    expected_sequence: u64,
    /// 正在执行处理器(尚未完成)的消息 id;同一时刻每通道最多一个。
    active_message: Option<String>,
    /// 正在等待某序列号的调用方计数(键为等待的序列号)。
    waiting: BTreeMap<u64, usize>,
    processed: u64,
    failed: u64,
    last_completed_at: Option<Instant>,
}

/// 一个账户通道:状态锁 + 条件变量,用于等待序列就绪或通道空闲。
#[derive(Debug)]
struct AccountLane {
    state: Mutex<LaneState>,
    changed: Condvar,
}

impl AccountLane {
    /// 新建通道;`expected_sequence` 至少为 1(允许从历史位置恢复消费)。
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

/// 全局注册表:所有账户通道、已完成投递与统计计数。
#[derive(Debug)]
struct RegistryState {
    lanes: HashMap<String, Arc<AccountLane>>,
    completed: HashMap<String, CompletedDelivery>,
    closed: bool,
    accepted: u64,
    duplicates: u64,
    rejected: u64,
}

/// 单个账户通道的只读快照,供监控与诊断使用。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaneSnapshot {
    pub account: String,
    pub expected_sequence: u64,
    pub active_message: Option<String>,
    /// 有调用方正在等待的序列号(升序)。
    pub waiting_sequences: Vec<u64>,
    /// 所有通道上的等待调用方总数。
    pub waiting_callers: usize,
    pub processed: u64,
    pub failed: u64,
    /// 距上次完成处理的时间(毫秒),无完成记录时为 None。
    pub last_completed_millis_ago: Option<u128>,
}

/// 收件箱整体的只读快照。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InboxSnapshot {
    pub closed: bool,
    pub accepted: u64,
    pub duplicates: u64,
    pub rejected: u64,
    /// 幂等去重表中保留的已完成投递数。
    pub completed_count: usize,
    pub lane_count: usize,
    pub lanes: Vec<LaneSnapshot>,
}

/// 按账户分区的有序收件箱。
///
/// 核心不变量:同一账户内的消息严格按序列顺序投递,后一消息会等待前一消息完成;
/// 不同账户之间互不阻塞,可并行处理。消息 id 的已完成记录用于幂等去重。
#[derive(Debug)]
pub struct PartitionedInbox {
    registry: Mutex<RegistryState>,
    /// 缺失前序序列时的最长等待时间。
    sequence_wait: Duration,
    /// 去重表最多保留的已完成投递记录数。
    completed_limit: usize,
}

impl PartitionedInbox {
    /// 创建收件箱。`sequence_wait` 必须在 (0, 30 秒] 内,`completed_limit` 在 [1, 100 万] 内。
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

    /// 从历史起点创建收件箱:每个账户的通道从给定序列号开始,用于分区恢复。
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

    /// 投递一条消息:先校验并去重,再按账户通道保证有序执行 `handler`,
    /// 成功后调用 `acknowledge` 确认。任一环节失败都不推进序列,调用方可重试同一消息。
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
            // 已完成记录命中:按 id 校验其归属的流位置,防止同一 id 被复用到其他位置。
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
            // 首次见到该账户时惰性创建通道,从序列 1 开始。
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
        // 登记本调用方正在等待该序列号,便于快照观测。
        *state.waiting.entry(message.sequence).or_insert(0) += 1;
        loop {
            // 序列已落后:不可再被接受(去重表可能刚好淘汰了它,因此先查一次去重表)。
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
            // 恰好轮到它且通道空闲:获得执行权。
            if message.sequence == state.expected_sequence && state.active_message.is_none() {
                break;
            }
            // 等待条件:前序消息未完成,或通道被其他消息占用。超时则放弃并标记失败。
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
            // 条件变量可能被无关事件唤醒,需要在超时后再次核对条件是否满足。
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

        // 获得执行权后再次查去重表:等待期间可能有其他线程先处理完了同 id 消息。
        if let Some(completed_at) = self.completed_time(&message)? {
            lane.changed.notify_all();
            return Ok(DeliveryOutcome::Duplicate { completed_at });
        }
        state.active_message = Some(message.id.clone());
        // 释放通道锁再执行用户回调,避免长时间占用锁阻塞同一账户的其他调用方。
        drop(state);

        // 处理器或确认失败时:释放通道占用但不推进序列,让同序列消息可被重试。
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
            // 先登记完成记录,再推进序列:若中途 panic,重放仍会命中去重而不是重复处理。
            let mut registry = self.lock_registry()?;
            registry.completed.insert(
                message.id.clone(),
                CompletedDelivery {
                    account: message.account.clone(),
                    sequence: message.sequence,
                    completed_at,
                },
            );
            // 超过容量时淘汰最旧的记录,控制内存占用。
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
        // 唤醒所有等待者(包括等待该序列、以及等待通道空闲的其他序列)。
        lane.changed.notify_all();
        Ok(DeliveryOutcome::Processed { next_sequence })
    }

    /// 生成收件箱及所有通道的只读快照。
    pub fn snapshot(&self) -> Result<InboxSnapshot, InboxError> {
        let (closed, accepted, duplicates, rejected, completed_count, lanes) = {
            let registry = self.lock_registry()?;
            (
                registry.closed,
                registry.accepted,
                registry.duplicates,
                registry.rejected,
                registry.completed.len(),
                // 在注册表锁内复制通道引用,避免在逐个加锁通道时死锁。
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
        // 按账户排序,保证快照输出稳定可比较。
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

    /// 关闭收件箱:之后的新消息一律拒绝,已入队消息继续按原规则完成。
    pub fn close(&self) -> Result<(), InboxError> {
        let mut registry = self.lock_registry()?;
        registry.closed = true;
        // 唤醒所有正在等待的调用方,让它们尽快看到关闭状态并退出。
        for lane in registry.lanes.values() {
            lane.changed.notify_all();
        }
        Ok(())
    }

    /// 遗忘早于给定年龄的已完成记录,释放去重表内存(不再能识别这些重复投递)。
    pub fn forget_completed_before(&self, age: Duration) -> Result<usize, InboxError> {
        let threshold = Instant::now().checked_sub(age).unwrap_or_else(Instant::now);
        let mut registry = self.lock_registry()?;
        let before = registry.completed.len();
        registry
            .completed
            .retain(|_, delivery| delivery.completed_at >= threshold);
        Ok(before - registry.completed.len())
    }

    /// 查消息 id 是否已完成;若完成但流位置不一致,说明 id 被非法复用,报错。
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

    /// 处理失败后的收尾:清空通道占用、累计失败计数并唤醒等待者,但不推进序列。
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

/// 从等待表中移除一个序列号的一次登记;计数归零时删除该键。
fn remove_waiter(state: &mut LaneState, sequence: u64) {
    if let Some(count) = state.waiting.get_mut(&sequence) {
        *count -= 1;
        if *count == 0 {
            state.waiting.remove(&sequence);
        }
    }
}

/// 淘汰最旧的完成记录,使去重表不超过容量上限。
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
