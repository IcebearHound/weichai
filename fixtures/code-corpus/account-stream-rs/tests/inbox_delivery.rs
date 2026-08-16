use account_stream_rs::{DeliveryOutcome, InboxError, PartitionedInbox, StreamMessage};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Barrier, Mutex};
use std::thread;
use std::time::{Duration, Instant};

type MessageMutation = (&'static str, Box<dyn Fn(&mut StreamMessage)>);

/// 构造一条测试消息:序列号同时用于派生时间戳与消息体,保证每条消息可区分。
fn message(identity: &str, account: &str, sequence: u64) -> StreamMessage {
    StreamMessage {
        id: identity.to_owned(),
        account: account.to_owned(),
        sequence,
        occurred_at_millis: 1_840_000_000_000 + sequence as i64,
        kind: "balance.changed".to_owned(),
        body: format!("{{\"identity\":\"{identity}\",\"sequence\":{sequence}}}").into_bytes(),
        headers: BTreeMap::from([
            ("content-type".to_owned(), "application/json".to_owned()),
            ("trace-id".to_owned(), format!("trace-{identity}")),
        ]),
    }
}

/// 成功投递的基本路径:处理器与确认回调按“先处理、后确认”的顺序各执行一次。
#[test]
fn successful_delivery_processes_then_acknowledges() {
    let inbox = PartitionedInbox::new(Duration::from_secs(1), 100).expect("inbox");
    let calls = Mutex::new(Vec::new());
    let outcome = inbox
        .handle(
            message("message-1", "account-a", 1),
            |received| {
                calls
                    .lock()
                    .unwrap()
                    .push(format!("handle:{}", received.id));
                Ok(())
            },
            |identity| {
                calls.lock().unwrap().push(format!("ack:{identity}"));
                Ok(())
            },
        )
        .expect("delivery");
    assert_eq!(outcome, DeliveryOutcome::Processed { next_sequence: 2 });
    assert_eq!(
        calls.into_inner().unwrap(),
        vec!["handle:message-1", "ack:message-1"]
    );
    let snapshot = inbox.snapshot().expect("snapshot");
    assert_eq!(snapshot.accepted, 1);
    assert_eq!(snapshot.completed_count, 1);
    assert_eq!(snapshot.rejected, 0);
    assert_eq!(snapshot.lanes[0].expected_sequence, 2);
    assert_eq!(snapshot.lanes[0].processed, 1);
}

/// 已完成的消息再次投递时不触发处理器或确认,直接返回重复结果。
#[test]
fn completed_identity_is_deduplicated_without_handler_or_ack() {
    let inbox = PartitionedInbox::new(Duration::from_millis(200), 100).expect("inbox");
    let first = message("duplicate-1", "account-dedup", 1);
    inbox
        .handle(first.clone(), |_| Ok(()), |_| Ok(()))
        .expect("first delivery");
    let handler_calls = AtomicUsize::new(0);
    let ack_calls = AtomicUsize::new(0);
    let outcome = inbox
        .handle(
            first,
            |_| {
                handler_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            |_| {
                ack_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .expect("duplicate delivery");
    assert!(matches!(outcome, DeliveryOutcome::Duplicate { .. }));
    assert_eq!(handler_calls.load(Ordering::SeqCst), 0);
    assert_eq!(ack_calls.load(Ordering::SeqCst), 0);
    let snapshot = inbox.snapshot().expect("snapshot");
    assert_eq!(snapshot.accepted, 1);
    assert_eq!(snapshot.duplicates, 1);
    assert_eq!(snapshot.completed_count, 1);
}

/// 处理器失败时不确认、不推进序列;同序列重试成功后恢复正常推进。
#[test]
fn handler_failure_never_acknowledges_and_sequence_can_retry() {
    let inbox = PartitionedInbox::new(Duration::from_secs(1), 100).expect("inbox");
    let acknowledgements = AtomicUsize::new(0);
    let failed = inbox.handle(
        message("handler-failure", "account-handler", 1),
        |_| Err("ledger temporarily unavailable".to_owned()),
        |_| {
            acknowledgements.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
    );
    assert_eq!(
        failed,
        Err(InboxError::HandlerFailed(
            "ledger temporarily unavailable".to_owned()
        ))
    );
    assert_eq!(acknowledgements.load(Ordering::SeqCst), 0);
    let after_failure = inbox.snapshot().expect("snapshot");
    assert_eq!(after_failure.completed_count, 0);
    assert_eq!(after_failure.lanes[0].expected_sequence, 1);
    assert_eq!(after_failure.lanes[0].failed, 1);
    // 同一身份、同一序列重试,应能正常完成。
    let retried = inbox
        .handle(
            message("handler-failure", "account-handler", 1),
            |_| Ok(()),
            |_| {
                acknowledgements.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .expect("retry");
    assert_eq!(retried, DeliveryOutcome::Processed { next_sequence: 2 });
    assert_eq!(acknowledgements.load(Ordering::SeqCst), 1);
}

/// 确认回调失败同样不标记完成,消息可被再次投递(处理器会再执行一次)。
#[test]
fn acknowledgement_failure_does_not_mark_message_completed() {
    let inbox = PartitionedInbox::new(Duration::from_secs(1), 100).expect("inbox");
    let handler_calls = AtomicUsize::new(0);
    let first = inbox.handle(
        message("ack-failure", "account-ack", 1),
        |_| {
            handler_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        |_| Err("broker connection closed".to_owned()),
    );
    assert_eq!(
        first,
        Err(InboxError::AcknowledgeFailed(
            "broker connection closed".to_owned()
        ))
    );
    assert_eq!(inbox.snapshot().unwrap().completed_count, 0);
    let second = inbox
        .handle(
            message("ack-failure", "account-ack", 1),
            |_| {
                handler_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            |_| Ok(()),
        )
        .expect("retry acknowledgement");
    assert_eq!(second, DeliveryOutcome::Processed { next_sequence: 2 });
    assert_eq!(handler_calls.load(Ordering::SeqCst), 2);
}

/// 高序列号消息会等待缺失的前序序列完成后才被处理,保证同账户严格有序。
#[test]
fn higher_sequence_waits_until_missing_predecessor_completes() {
    let inbox = Arc::new(PartitionedInbox::new(Duration::from_secs(2), 100).expect("inbox"));
    let order = Arc::new(Mutex::new(Vec::new()));
    let later_inbox = inbox.clone();
    let later_order = order.clone();
    let later = thread::spawn(move || {
        later_inbox.handle(
            message("ordered-2", "account-ordered", 2),
            |received| {
                later_order.lock().unwrap().push(received.sequence);
                Ok(())
            },
            |_| Ok(()),
        )
    });
    // 轮询快照直至序列 2 进入等待状态,再提交序列 1。
    let wait_deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let snapshot = inbox.snapshot().expect("snapshot while waiting");
        if !snapshot.lanes.is_empty() && snapshot.lanes[0].waiting_sequences == vec![2] {
            break;
        }
        assert!(
            Instant::now() < wait_deadline,
            "sequence two never entered wait state"
        );
        thread::yield_now();
    }
    let first_order = order.clone();
    let first = inbox
        .handle(
            message("ordered-1", "account-ordered", 1),
            |received| {
                first_order.lock().unwrap().push(received.sequence);
                Ok(())
            },
            |_| Ok(()),
        )
        .expect("first sequence");
    assert_eq!(first, DeliveryOutcome::Processed { next_sequence: 2 });
    let second = later
        .join()
        .expect("later thread")
        .expect("second sequence");
    assert_eq!(second, DeliveryOutcome::Processed { next_sequence: 3 });
    assert_eq!(*order.lock().unwrap(), vec![1, 2]);
}

/// 缺失的前序序列在等待超时后放弃:不处理、不确认,并记为拒绝。
#[test]
fn missing_predecessor_times_out_without_processing_or_acknowledging() {
    let inbox = PartitionedInbox::new(Duration::from_millis(25), 100).expect("inbox");
    let handler_calls = AtomicUsize::new(0);
    let ack_calls = AtomicUsize::new(0);
    let started = Instant::now();
    let outcome = inbox.handle(
        message("gap-3", "account-gap", 3),
        |_| {
            handler_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        |_| {
            ack_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
    );
    assert!(matches!(
        outcome,
        Err(InboxError::SequenceWaitExpired {
            expected: 1,
            received: 3
        })
    ));
    assert!(started.elapsed() >= Duration::from_millis(15));
    assert_eq!(handler_calls.load(Ordering::SeqCst), 0);
    assert_eq!(ack_calls.load(Ordering::SeqCst), 0);
    let snapshot = inbox.snapshot().expect("snapshot");
    assert_eq!(snapshot.rejected, 1);
    assert_eq!(snapshot.completed_count, 0);
    assert_eq!(snapshot.lanes[0].waiting_callers, 0);
}

/// 同账户的多条消息即使并发提交,处理器也绝不重叠执行。
#[test]
fn same_account_handlers_never_overlap() {
    let inbox = Arc::new(PartitionedInbox::new(Duration::from_secs(3), 100).expect("inbox"));
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let processed = Arc::new(Mutex::new(Vec::new()));
    let mut workers = Vec::new();
    // 逆序提交制造竞争:处理器必须按序列正序执行。
    for sequence in (1..=8).rev() {
        let worker_inbox = inbox.clone();
        let worker_active = active.clone();
        let worker_maximum = maximum.clone();
        let worker_processed = processed.clone();
        workers.push(thread::spawn(move || {
            worker_inbox.handle(
                message(&format!("serial-{sequence}"), "account-serial", sequence),
                |received| {
                    let current = worker_active.fetch_add(1, Ordering::SeqCst) + 1;
                    worker_maximum.fetch_max(current, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(3));
                    worker_processed.lock().unwrap().push(received.sequence);
                    worker_active.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                },
                |_| Ok(()),
            )
        }));
    }
    for worker in workers {
        worker.join().expect("worker").expect("delivery");
    }
    assert_eq!(maximum.load(Ordering::SeqCst), 1);
    assert_eq!(*processed.lock().unwrap(), (1..=8).collect::<Vec<_>>());
    let lane = inbox.snapshot().unwrap().lanes.remove(0);
    assert_eq!(lane.expected_sequence, 9);
    assert_eq!(lane.processed, 8);
}

/// 不同账户的处理器可以真正并行执行(最大并发观测值应达到 2)。
#[test]
fn different_accounts_can_process_in_parallel() {
    let inbox = Arc::new(PartitionedInbox::new(Duration::from_secs(1), 100).expect("inbox"));
    let barrier = Arc::new(Barrier::new(3));
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let (entered_sender, entered_receiver) = mpsc::channel();
    let mut workers = Vec::new();
    for account in ["parallel-a", "parallel-b"] {
        let worker_inbox = inbox.clone();
        let worker_barrier = barrier.clone();
        let worker_active = active.clone();
        let worker_maximum = maximum.clone();
        let worker_sender = entered_sender.clone();
        workers.push(thread::spawn(move || {
            worker_inbox.handle(
                message(&format!("message-{account}"), account, 1),
                |_| {
                    let current = worker_active.fetch_add(1, Ordering::SeqCst) + 1;
                    worker_maximum.fetch_max(current, Ordering::SeqCst);
                    worker_sender.send(account).unwrap();
                    // 两个账户都进入处理器后再一起放行,验证确实重叠执行。
                    worker_barrier.wait();
                    worker_active.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                },
                |_| Ok(()),
            )
        }));
    }
    let mut entered = vec![
        entered_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap(),
        entered_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap(),
    ];
    entered.sort();
    assert_eq!(entered, vec!["parallel-a", "parallel-b"]);
    barrier.wait();
    for worker in workers {
        worker.join().unwrap().expect("parallel delivery");
    }
    assert_eq!(maximum.load(Ordering::SeqCst), 2);
    let snapshot = inbox.snapshot().unwrap();
    assert_eq!(snapshot.lane_count, 2);
    assert_eq!(snapshot.completed_count, 2);
}

/// 同一消息并发提交时,只有第一个线程执行处理器,其余作为重复返回。
#[test]
fn concurrent_duplicate_joins_lane_and_runs_side_effect_once() {
    let inbox = Arc::new(PartitionedInbox::new(Duration::from_secs(1), 100).expect("inbox"));
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let handler_calls = Arc::new(AtomicUsize::new(0));
    let leader_inbox = inbox.clone();
    let leader_entered = entered.clone();
    let leader_release = release.clone();
    let leader_calls = handler_calls.clone();
    let leader = thread::spawn(move || {
        leader_inbox.handle(
            message("concurrent-duplicate", "account-duplicate", 1),
            |_| {
                leader_calls.fetch_add(1, Ordering::SeqCst);
                leader_entered.wait();
                leader_release.wait();
                Ok(())
            },
            |_| Ok(()),
        )
    });
    // 等领队进入处理器后再让跟随者提交,确保其排入等待序列。
    entered.wait();
    let follower_inbox = inbox.clone();
    let follower_calls = handler_calls.clone();
    let follower = thread::spawn(move || {
        follower_inbox.handle(
            message("concurrent-duplicate", "account-duplicate", 1),
            |_| {
                follower_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            |_| Ok(()),
        )
    });
    thread::sleep(Duration::from_millis(10));
    release.wait();
    assert!(matches!(
        leader.join().unwrap().unwrap(),
        DeliveryOutcome::Processed { .. }
    ));
    assert!(matches!(
        follower.join().unwrap().unwrap(),
        DeliveryOutcome::Duplicate { .. }
    ));
    assert_eq!(handler_calls.load(Ordering::SeqCst), 1);
}

/// 从指定起始序列恢复分区:首条消息不必从 1 开始。
#[test]
fn starting_sequences_support_resumed_partitions() {
    let starts = BTreeMap::from([("resumed-a".to_owned(), 41), ("resumed-b".to_owned(), 900)]);
    let inbox =
        PartitionedInbox::with_starting_sequences(Duration::from_millis(100), 1_000, &starts)
            .expect("resumed inbox");
    let first = inbox
        .handle(
            message("resumed-41", "resumed-a", 41),
            |_| Ok(()),
            |_| Ok(()),
        )
        .expect("resumed-a");
    let second = inbox
        .handle(
            message("resumed-900", "resumed-b", 900),
            |_| Ok(()),
            |_| Ok(()),
        )
        .expect("resumed-b");
    assert_eq!(first, DeliveryOutcome::Processed { next_sequence: 42 });
    assert_eq!(second, DeliveryOutcome::Processed { next_sequence: 901 });
    let snapshot = inbox.snapshot().unwrap();
    assert_eq!(snapshot.lanes[0].account, "resumed-a");
    assert_eq!(snapshot.lanes[1].account, "resumed-b");
}

/// 已完成的消息 id 不能复用到其他账户或序列位置,否则视为非法输入。
#[test]
fn identity_reuse_for_other_position_is_rejected() {
    let inbox = PartitionedInbox::new(Duration::from_millis(100), 100).expect("inbox");
    inbox
        .handle(
            message("identity-reuse", "reuse-a", 1),
            |_| Ok(()),
            |_| Ok(()),
        )
        .expect("first delivery");
    let changed_account = inbox.handle(
        message("identity-reuse", "reuse-b", 1),
        |_| panic!("reused identity must not be handled"),
        |_| panic!("reused identity must not be acknowledged"),
    );
    assert!(matches!(
        changed_account,
        Err(InboxError::InvalidMessage(_))
    ));
    let changed_sequence = inbox.handle(
        message("identity-reuse", "reuse-a", 2),
        |_| panic!("reused identity must not be handled"),
        |_| panic!("reused identity must not be acknowledged"),
    );
    assert!(matches!(
        changed_sequence,
        Err(InboxError::InvalidMessage(_))
    ));
}

/// 关闭后拒绝新消息,但已完成的记录仍保留在快照中;重复关闭是幂等的。
#[test]
fn close_rejects_new_messages_but_preserves_snapshot() {
    let inbox = PartitionedInbox::new(Duration::from_millis(100), 100).expect("inbox");
    inbox
        .handle(
            message("before-close", "closing-account", 1),
            |_| Ok(()),
            |_| Ok(()),
        )
        .expect("before close");
    inbox.close().expect("close");
    inbox.close().expect("idempotent close");
    let result = inbox.handle(
        message("after-close", "closing-account", 2),
        |_| panic!("closed inbox must not handle"),
        |_| panic!("closed inbox must not acknowledge"),
    );
    assert_eq!(result, Err(InboxError::Closed));
    let snapshot = inbox.snapshot().expect("snapshot");
    assert!(snapshot.closed);
    assert_eq!(snapshot.completed_count, 1);
    assert_eq!(snapshot.rejected, 1);
}

/// 构造一批字段非法的消息,逐一验证 `validate` 拒绝它们。
#[test]
fn validation_rejects_malformed_messages() {
    let base = message("valid", "valid-account", 1);
    let mut cases: Vec<MessageMutation> = vec![
        (
            "blank identity",
            Box::new(|value| value.id = " ".to_owned()),
        ),
        ("blank account", Box::new(|value| value.account.clear())),
        ("zero sequence", Box::new(|value| value.sequence = 0)),
        ("blank kind", Box::new(|value| value.kind = "\t".to_owned())),
        ("long kind", Box::new(|value| value.kind = "x".repeat(81))),
        (
            "large body",
            Box::new(|value| value.body = vec![1; 1024 * 1024 + 1]),
        ),
        (
            "blank header",
            Box::new(|value| {
                value.headers.insert("".to_owned(), "value".to_owned());
            }),
        ),
        (
            "long header value",
            Box::new(|value| {
                value.headers.insert("memo".to_owned(), "v".repeat(513));
            }),
        ),
    ];
    for (name, mutate) in cases.drain(..) {
        let mut changed = base.clone();
        mutate(&mut changed);
        assert!(
            matches!(changed.validate(), Err(InboxError::InvalidMessage(_))),
            "case {name} was accepted"
        );
    }
    // 单独验证超量头(33 个)的边界。
    let mut too_many = base;
    too_many.headers = (0..33)
        .map(|index| (format!("header-{index}"), "value".to_owned()))
        .collect();
    assert!(matches!(
        too_many.validate(),
        Err(InboxError::InvalidMessage(_))
    ));
}
