mod support;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use buffered_journal_rs::{
    KeyedRecordExecutor, ProviderEndpoint, ProviderInvoker, RecordAcknowledger, RecordHandler,
    ReplicaSelector, WorkItem, WorkOutcome,
};
use support::{endpoint, work};

/// 记录处理顺序与并发度的处理器,可配置在指定键上失败。
struct RecordingHandler {
    order: Mutex<Vec<(String, i64)>>,
    fail_key: Option<String>,
    active: AtomicUsize,
    maximum_active: AtomicUsize,
    delay: Duration,
}

impl RecordingHandler {
    fn successful(delay: Duration) -> Self {
        Self {
            order: Mutex::new(Vec::new()),
            fail_key: None,
            active: AtomicUsize::new(0),
            maximum_active: AtomicUsize::new(0),
            delay,
        }
    }
}

impl RecordHandler for RecordingHandler {
    fn handle(&self, record: &WorkItem) -> Result<(), String> {
        // 记录并跟踪并发度。
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.maximum_active.fetch_max(active, Ordering::SeqCst);
        if !self.delay.is_zero() {
            std::thread::sleep(self.delay);
        }
        self.order
            .lock()
            .expect("handler order lock")
            .push((record.account.clone(), record.sequence));
        self.active.fetch_sub(1, Ordering::SeqCst);
        if self.fail_key.as_deref() == Some(record.key.as_str()) {
            Err(format!("handler rejected {}", record.key))
        } else {
            Ok(())
        }
    }
}

/// 计数确认器,可配置在指定键上失败。
#[derive(Default)]
struct CountingAcknowledger {
    count: AtomicUsize,
    fail_key: Option<String>,
}

impl RecordAcknowledger for CountingAcknowledger {
    fn acknowledge(&self, record: &WorkItem) -> Result<(), String> {
        if self.fail_key.as_deref() == Some(record.key.as_str()) {
            return Err(format!("broker refused acknowledgement for {}", record.key));
        }
        self.count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

/// 按脚本执行的外部提供方:可配置主端点在前 N 次调用失败,并记录调用次数。
struct ScriptedProvider {
    calls: Mutex<BTreeMap<String, usize>>,
    recover_primary_after: usize,
    delay: Duration,
}

impl ProviderInvoker for ScriptedProvider {
    fn invoke(
        &self,
        endpoint: &ProviderEndpoint,
        operation: &str,
        _deadline: Instant,
    ) -> Result<Vec<u8>, String> {
        if !self.delay.is_zero() {
            std::thread::sleep(self.delay);
        }
        let call = {
            let mut calls = self.calls.lock().expect("provider call lock");
            let value = calls.entry(endpoint.name.clone()).or_insert(0);
            *value += 1;
            *value
        };
        if endpoint.name == "primary" && call <= self.recover_primary_after {
            Err(format!("primary unavailable during {operation}"))
        } else {
            Ok(format!("{}:{operation}", endpoint.name).into_bytes())
        }
    }
}

/// 通道内按序列处理,但报告顺序与输入顺序一致。
#[test]
fn account_lane_orders_records_but_results_follow_input_order() {
    let executor = KeyedRecordExecutor::default();
    let handler = RecordingHandler::successful(Duration::ZERO);
    let acknowledger = CountingAcknowledger::default();
    // 同一账户的序列 2 先于序列 1 出现。
    let records = vec![
        work("late-a", "account-a", 2),
        work("other", "account-b", 1),
        work("early-a", "account-a", 1),
    ];
    let reports = executor.drive(&records, &handler, &acknowledger);
    assert_eq!(reports.len(), records.len());
    assert_eq!(reports[0].identity, "account-a:2:late-a");
    assert_eq!(reports[1].identity, "account-b:1:other");
    assert_eq!(reports[2].identity, "account-a:1:early-a");
    assert!(reports
        .iter()
        .all(|report| report.outcome == WorkOutcome::Handled));
    // 处理顺序必须按序列升序。
    let account_a = handler
        .order
        .lock()
        .unwrap()
        .iter()
        .filter(|entry| entry.0 == "account-a")
        .map(|entry| entry.1)
        .collect::<Vec<_>>();
    assert_eq!(account_a, vec![1, 2]);
    assert_eq!(acknowledger.count.load(Ordering::SeqCst), 3);
}

/// 不同账户的通道并行执行(并发度观测 ≥ 2)。
#[test]
fn different_accounts_execute_in_parallel() {
    let executor = KeyedRecordExecutor::default();
    let handler = RecordingHandler::successful(Duration::from_millis(40));
    let acknowledger = CountingAcknowledger::default();
    let records = (0..8)
        .map(|index| work(&format!("item-{index}"), &format!("account-{index}"), 1))
        .collect::<Vec<_>>();
    let reports = executor.drive(&records, &handler, &acknowledger);
    assert!(reports
        .iter()
        .all(|report| report.outcome == WorkOutcome::Handled));
    assert!(
        handler.maximum_active.load(Ordering::SeqCst) >= 2,
        "independent account lanes should overlap"
    );
}

/// 处理器失败不确认,并阻断同一账户后续序列(标记 Pending)。
#[test]
fn handler_failure_never_acknowledges_and_blocks_later_account_sequence() {
    let executor = KeyedRecordExecutor::default();
    let handler = RecordingHandler {
        order: Mutex::new(Vec::new()),
        fail_key: Some("fail".to_owned()),
        active: AtomicUsize::new(0),
        maximum_active: AtomicUsize::new(0),
        delay: Duration::ZERO,
    };
    let acknowledger = CountingAcknowledger::default();
    let records = vec![work("fail", "account", 1), work("later", "account", 2)];
    let reports = executor.drive(&records, &handler, &acknowledger);
    assert_eq!(reports[0].outcome, WorkOutcome::HandlerFailed);
    assert!(!reports[0].acknowledged);
    assert_eq!(reports[1].outcome, WorkOutcome::Pending);
    assert!(!reports[1].acknowledged);
    assert_eq!(acknowledger.count.load(Ordering::SeqCst), 0);
}

/// 相同 identity 只执行一次处理器;重复投递被确认但标记 Duplicate。
#[test]
fn duplicate_is_processed_once_and_repeat_delivery_is_acknowledged() {
    let executor = KeyedRecordExecutor::default();
    let handler = RecordingHandler::successful(Duration::ZERO);
    let acknowledger = CountingAcknowledger::default();
    let item = work("event", "account", 7);
    let first = executor.drive(std::slice::from_ref(&item), &handler, &acknowledger);
    let second = executor.drive(&[item], &handler, &acknowledger);
    assert_eq!(first[0].outcome, WorkOutcome::Handled);
    assert_eq!(second[0].outcome, WorkOutcome::Duplicate);
    assert!(second[0].acknowledged);
    assert_eq!(handler.order.lock().unwrap().len(), 1);
    assert_eq!(acknowledger.count.load(Ordering::SeqCst), 2);
}

/// 主端点失败打开熔断后,流量全部切换到备份端点。
#[test]
fn replica_failure_opens_only_primary_and_fails_over_to_backup() {
    let selector = ReplicaSelector::default();
    let providers = vec![endpoint("primary", 0), endpoint("backup", 1)];
    let invoker = ScriptedProvider {
        calls: Mutex::new(BTreeMap::new()),
        recover_primary_after: usize::MAX,
        delay: Duration::ZERO,
    };
    // 主端点首次调用即失败,应快速切换到备份。
    let first = selector
        .route(&providers, "spot/EURUSD", &invoker)
        .expect("backup responds")
        .expect("one provider response");
    assert_eq!(first, b"backup:spot/EURUSD");
    let second = selector
        .route(&providers, "spot/GBPUSD", &invoker)
        .expect("backup remains independent")
        .expect("backup response");
    assert_eq!(second, b"backup:spot/GBPUSD");
    let calls = invoker.calls.lock().unwrap();
    assert_eq!(calls["primary"], 1, "open primary should be skipped");
    assert_eq!(calls["backup"], 2);
}

/// 半开探测成功并达标后,熔断器关闭恢复正常。
#[test]
fn half_open_probe_closes_circuit_after_success() {
    let selector = ReplicaSelector::default();
    let mut primary = endpoint("primary", 0);
    primary.cooldown = Duration::ZERO;
    let invoker = ScriptedProvider {
        calls: Mutex::new(BTreeMap::new()),
        recover_primary_after: 1,
        delay: Duration::ZERO,
    };
    // 第一次调用失败 → 熔断打开。
    assert!(selector
        .route(&[primary.clone()], "first", &invoker)
        .is_err());
    // 冷却后(冷却期为 0)半开放行探测,探测成功。
    let recovered = selector
        .route(&[primary.clone()], "second", &invoker)
        .expect("half-open probe succeeds")
        .expect("probe response");
    assert_eq!(recovered, b"primary:second");
    // 熔断关闭,后续请求直接成功。
    let closed = selector
        .route(&[primary], "third", &invoker)
        .expect("closed provider succeeds")
        .expect("closed response");
    assert_eq!(closed, b"primary:third");
}

/// 提供方响应超过请求超时视为失败。
#[test]
fn elapsed_provider_timeout_is_treated_as_failure() {
    let selector = ReplicaSelector::default();
    let mut slow = endpoint("slow", 0);
    slow.request_timeout = Duration::from_millis(5);
    let invoker = ScriptedProvider {
        calls: Mutex::new(BTreeMap::new()),
        recover_primary_after: 0,
        delay: Duration::from_millis(20),
    };
    let error = selector
        .route(&[slow], "slow-operation", &invoker)
        .expect_err("elapsed timeout must fail route");
    assert!(error.contains("timeout"));
}
