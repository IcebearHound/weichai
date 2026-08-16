use account_stream_rs::{
    AccountPartitioner, DeliveryOutcome, PartitionedInbox, PendingRecord, ReceiptCodec,
    ReceiptEnvelope, RetrySchedule, SequenceLedger, ShutdownLedger, StreamMessage,
};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// 端到端场景中使用的账户投影:维护余额、币种与已消费序列。
#[derive(Clone, Debug, Eq, PartialEq)]
struct AccountProjection {
    balance_minor: i64,
    currency: String,
    last_sequence: u64,
    events: Vec<String>,
}

/// 构造一条账户余额变更消息(场景测试专用)。
fn scenario_message(
    identity: &str,
    account: &str,
    sequence: u64,
    currency: &str,
    delta_minor: i64,
) -> StreamMessage {
    StreamMessage {
        id: identity.to_owned(),
        account: account.to_owned(),
        sequence,
        occurred_at_millis: 2_000_000_000_000 + sequence as i64,
        kind: "account.delta".to_owned(),
        body: format!("{currency}:{delta_minor}").into_bytes(),
        headers: BTreeMap::from([
            ("currency".to_owned(), currency.to_owned()),
            ("delta-minor".to_owned(), delta_minor.to_string()),
        ]),
    }
}

/// 把一条消息应用到投影:校验币种一致与序列严格 +1,再累加余额。
fn apply_projection(
    projections: &Mutex<BTreeMap<String, AccountProjection>>,
    message: &StreamMessage,
) -> Result<(), String> {
    let currency = message
        .headers
        .get("currency")
        .cloned()
        .ok_or_else(|| "currency header missing".to_owned())?;
    let delta = message
        .headers
        .get("delta-minor")
        .ok_or_else(|| "delta header missing".to_owned())?
        .parse::<i64>()
        .map_err(|error| format!("invalid delta: {error}"))?;
    let mut projections = projections.lock().map_err(|_| "projection lock poisoned")?;
    let projection = projections
        .entry(message.account.clone())
        .or_insert_with(|| AccountProjection {
            balance_minor: 0,
            currency: currency.clone(),
            last_sequence: 0,
            events: Vec::new(),
        });
    // 币种变化或序列跳跃说明数据流错乱,拒绝应用。
    if projection.currency != currency {
        return Err("projection currency changed".to_owned());
    }
    if message.sequence != projection.last_sequence + 1 {
        return Err(format!(
            "projection expected sequence {} but received {}",
            projection.last_sequence + 1,
            message.sequence
        ));
    }
    projection.balance_minor = projection
        .balance_minor
        .checked_add(delta)
        .ok_or_else(|| "projection balance overflow".to_owned())?;
    projection.last_sequence = message.sequence;
    projection.events.push(message.id.clone());
    Ok(())
}

/// 多账户投影管道:即使消息并发乱序提交,每个账户的投影仍严格按序、并行安全地建立。
#[test]
fn multi_account_projection_pipeline_is_ordered_and_parallel_safe() {
    let inbox = Arc::new(PartitionedInbox::new(Duration::from_secs(3), 10_000).unwrap());
    let projections = Arc::new(Mutex::new(BTreeMap::new()));
    let acknowledged = Arc::new(Mutex::new(Vec::new()));
    let accounts = [
        ("pipeline-usd-a", "USD", vec![100, -30, 75, -20, 10]),
        ("pipeline-eur-b", "EUR", vec![500, 250, -125, -75, 40]),
        ("pipeline-gbp-c", "GBP", vec![900, -100, -200, 50, -25]),
        (
            "pipeline-jpy-d",
            "JPY",
            vec![10_000, 5_000, -2_500, -500, 1_000],
        ),
    ];
    let mut workers = Vec::new();
    for (account, currency, deltas) in accounts {
        // 逆序提交,让收件箱的序列等待逻辑接受真实乱序考验。
        for (offset, delta) in deltas.into_iter().enumerate().rev() {
            let worker_inbox = inbox.clone();
            let worker_projections = projections.clone();
            let worker_acknowledged = acknowledged.clone();
            let sequence = offset as u64 + 1;
            let identity = format!("{account}-{sequence}");
            workers.push(thread::spawn(move || {
                worker_inbox.handle(
                    scenario_message(&identity, account, sequence, currency, delta),
                    |message| apply_projection(&worker_projections, message),
                    |message_id| {
                        worker_acknowledged
                            .lock()
                            .map_err(|_| "acknowledgement lock poisoned".to_owned())?
                            .push(message_id.to_owned());
                        Ok(())
                    },
                )
            }));
        }
    }
    for worker in workers {
        assert!(matches!(
            worker.join().unwrap().unwrap(),
            DeliveryOutcome::Processed { .. }
        ));
    }
    let projections = projections.lock().unwrap();
    assert_eq!(projections.len(), 4);
    assert_eq!(projections["pipeline-usd-a"].balance_minor, 135);
    assert_eq!(projections["pipeline-eur-b"].balance_minor, 590);
    assert_eq!(projections["pipeline-gbp-c"].balance_minor, 625);
    assert_eq!(projections["pipeline-jpy-d"].balance_minor, 13_000);
    for projection in projections.values() {
        assert_eq!(projection.last_sequence, 5);
        assert_eq!(projection.events.len(), 5);
    }
    assert_eq!(acknowledged.lock().unwrap().len(), 20);
    let snapshot = inbox.snapshot().unwrap();
    assert_eq!(snapshot.completed_count, 20);
    assert_eq!(snapshot.lane_count, 4);
}

/// 投影失败时消息不确认、不推进;修正数据后同一序列可重放成功。
#[test]
fn failed_projection_does_not_ack_or_advance_then_corrected_copy_succeeds() {
    let inbox = PartitionedInbox::new(Duration::from_secs(1), 100).unwrap();
    let projections = Mutex::new(BTreeMap::new());
    let acknowledgements = Mutex::new(Vec::new());
    let invalid = scenario_message("bad-currency", "projection-account", 1, "USD", 100);
    let first = inbox.handle(
        invalid,
        |message| {
            {
                // 预置一个币种不一致的投影,让处理器失败。
                let mut guard = projections.lock().unwrap();
                guard.insert(
                    message.account.clone(),
                    AccountProjection {
                        balance_minor: 0,
                        currency: "EUR".to_owned(),
                        last_sequence: 0,
                        events: Vec::new(),
                    },
                );
            }
            apply_projection(&projections, message)
        },
        |identity| {
            acknowledgements.lock().unwrap().push(identity.to_owned());
            Ok(())
        },
    );
    assert!(first.is_err());
    assert!(acknowledgements.lock().unwrap().is_empty());
    projections.lock().unwrap().clear();
    let corrected = scenario_message("corrected-currency", "projection-account", 1, "USD", 100);
    inbox
        .handle(
            corrected,
            |message| apply_projection(&projections, message),
            |identity| {
                acknowledgements.lock().unwrap().push(identity.to_owned());
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(
        projections.lock().unwrap()["projection-account"].balance_minor,
        100
    );
    assert_eq!(
        *acknowledgements.lock().unwrap(),
        vec!["corrected-currency"]
    );
    assert_eq!(inbox.snapshot().unwrap().lanes[0].expected_sequence, 2);
}

/// 端到端演练:回执编码为帧,缓冲进停机账本,关闭时解码并持久化。
#[test]
fn receipt_frames_can_be_buffered_then_drained_on_shutdown() {
    let codec = ReceiptCodec::new(5, 64 * 1024).unwrap();
    let ledger = ShutdownLedger::new(100).unwrap();
    for sequence in 1..=12 {
        let envelope = ReceiptEnvelope {
            instruction: format!("instruction-{sequence:03}"),
            receipt: format!("receipt-{sequence:03}"),
            account: format!("account-{:02}", sequence % 4),
            sequence,
            committed_millis: 2_000_000_000_000 + sequence as i64,
            attributes: BTreeMap::from([
                (
                    "currency".to_owned(),
                    ["USD", "EUR", "GBP"][sequence as usize % 3].to_owned(),
                ),
                ("route".to_owned(), "synthetic-main".to_owned()),
            ]),
        };
        let frame = codec.encode(&envelope).unwrap();
        ledger
            .append(PendingRecord {
                identity: envelope.receipt.clone(),
                partition: envelope.account.clone(),
                sequence,
                payload: frame,
                accepted_at: Instant::now(),
            })
            .unwrap();
    }
    let recovered = Mutex::new(Vec::new());
    let drained = ledger
        .finish(Duration::from_secs(1), |batch| {
            for record in batch {
                recovered.push(codec.decode(&record.payload).map_err(|error| {
                    format!("decode {} during shutdown: {error}", record.identity)
                })?);
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(drained, 12);
    let recovered = recovered.into_inner().unwrap();
    assert_eq!(recovered.len(), 12);
    for (index, envelope) in recovered.iter().enumerate() {
        assert_eq!(envelope.sequence, index as u64 + 1);
        assert_eq!(envelope.receipt, format!("receipt-{:03}", index + 1));
    }
    assert_eq!(ledger.snapshot().unwrap().persisted, 12);
}

/// 小工具 trait:把 `push` 包装到 Mutex<Vec<T>> 上,简化测试断言。
trait MutexVecPush<T> {
    fn push(&self, value: T);
}

impl<T> MutexVecPush<T> for Mutex<Vec<T>> {
    fn push(&self, value: T) {
        self.lock().unwrap().push(value);
    }
}

/// 审计账本与收件箱进度逐账户一致:收件箱完成序 = 审计账本连续序。
#[test]
fn sequence_audit_matches_inbox_progress_for_each_account() {
    let inbox = PartitionedInbox::new(Duration::from_millis(200), 100).unwrap();
    let ledger = Mutex::new(SequenceLedger::default());
    for account in ["audit-a", "audit-b", "audit-c"] {
        for sequence in 1..=6 {
            inbox
                .handle(
                    scenario_message(
                        &format!("{account}-{sequence}"),
                        account,
                        sequence,
                        "USD",
                        sequence as i64,
                    ),
                    |message| {
                        ledger
                            .lock()
                            .unwrap()
                            .observe(&message.account, message.sequence)
                            .map(|_| ())
                    },
                    |_| Ok(()),
                )
                .unwrap();
        }
    }
    let snapshot = inbox.snapshot().unwrap();
    let audit = ledger.lock().unwrap();
    for lane in snapshot.lanes {
        assert_eq!(lane.expected_sequence, 7);
        assert_eq!(audit.high_water(&lane.account), Some(6));
        assert_eq!(audit.contiguous_through(&lane.account), Some(6));
        assert!(audit.missing(&lane.account).is_empty());
    }
}

/// 分片结果稳定:重放同一批账户得到完全相同的分组,消息路由不漂移。
#[test]
fn partition_assignment_is_stable_for_replayed_account_messages() {
    let partitioner = AccountPartitioner::new(16, 0x55aa).unwrap();
    let accounts: Vec<String> = (0..50)
        .map(|index| format!("partitioned-account-{index:03}"))
        .collect();
    let first = partitioner.group(&accounts).unwrap();
    let replay = partitioner.group(&accounts).unwrap();
    assert_eq!(first, replay);
    for (partition, values) in first {
        for account in values {
            for sequence in 1..=5 {
                let event = scenario_message(
                    &format!("{account}-{sequence}"),
                    account,
                    sequence,
                    "EUR",
                    1,
                );
                assert_eq!(partitioner.partition(&event.account).unwrap(), partition);
            }
        }
    }
}

/// 重试计划有界:所有延迟不超过上限,预算与逐项求和一致,预算内次数在预期区间。
#[test]
fn retry_schedule_produces_bounded_redelivery_plan() {
    let schedule = RetrySchedule {
        base: Duration::from_millis(25),
        maximum: Duration::from_secs(2),
        multiplier: 1.8,
        jitter_fraction: 0.15,
        seed: 91_337,
    };
    let delays = schedule.sequence(12).unwrap();
    assert_eq!(delays.len(), 12);
    assert!(delays.iter().all(|delay| *delay <= Duration::from_secs(2)));
    // 抖动幅度 ≤15%,基数 25ms 时下限不会低于 20ms。
    assert!(delays
        .iter()
        .all(|delay| *delay >= Duration::from_millis(20)));
    let total = schedule.budget(12).unwrap();
    assert_eq!(total, delays.iter().copied().sum());
    let admitted = schedule
        .attempts_within(Duration::from_secs(5), 12)
        .unwrap();
    assert!((4..=9).contains(&admitted));
}
