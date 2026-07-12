use account_stream_rs::{DeliveryOutcome, InboxError, PartitionedInbox, StreamMessage};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;
use std::time::{Duration, Instant};

fn retained_message(identity: &str, account: &str, sequence: u64) -> StreamMessage {
    StreamMessage {
        id: identity.to_owned(),
        account: account.to_owned(),
        sequence,
        occurred_at_millis: 1_900_000_000_000 + sequence as i64,
        kind: "trade.recorded".to_owned(),
        body: format!("{account}:{sequence}:{identity}").into_bytes(),
        headers: BTreeMap::from([("schema".to_owned(), "trade-v2".to_owned())]),
    }
}

#[test]
fn completion_retention_evicts_oldest_identity_at_capacity() {
    let inbox = PartitionedInbox::new(Duration::from_millis(100), 3).unwrap();
    for sequence in 1..=5 {
        inbox
            .handle(
                retained_message(
                    &format!("retention-{sequence}"),
                    "retention-account",
                    sequence,
                ),
                |_| Ok(()),
                |_| Ok(()),
            )
            .unwrap();
        thread::sleep(Duration::from_millis(1));
    }
    let snapshot = inbox.snapshot().unwrap();
    assert_eq!(snapshot.completed_count, 3);
    assert_eq!(snapshot.accepted, 5);
    assert_eq!(snapshot.lanes[0].expected_sequence, 6);
    let recent = inbox
        .handle(
            retained_message("retention-5", "retention-account", 5),
            |_| panic!("retained duplicate should not run"),
            |_| panic!("retained duplicate should not ack"),
        )
        .unwrap();
    assert!(matches!(recent, DeliveryOutcome::Duplicate { .. }));
    let evicted = inbox.handle(
        retained_message("retention-1", "retention-account", 1),
        |_| panic!("old sequence should not run"),
        |_| panic!("old sequence should not ack"),
    );
    assert_eq!(
        evicted,
        Err(InboxError::SequenceBehind {
            expected: 6,
            received: 1
        })
    );
}

#[test]
fn explicit_forget_removes_only_records_older_than_threshold() {
    let inbox = PartitionedInbox::new(Duration::from_millis(100), 100).unwrap();
    inbox
        .handle(
            retained_message("forget-old", "forget-account", 1),
            |_| Ok(()),
            |_| Ok(()),
        )
        .unwrap();
    thread::sleep(Duration::from_millis(8));
    inbox
        .handle(
            retained_message("forget-new", "forget-account", 2),
            |_| Ok(()),
            |_| Ok(()),
        )
        .unwrap();
    assert_eq!(
        inbox
            .forget_completed_before(Duration::from_millis(4))
            .unwrap(),
        1
    );
    assert_eq!(inbox.snapshot().unwrap().completed_count, 1);
    let recent = inbox
        .handle(
            retained_message("forget-new", "forget-account", 2),
            |_| panic!("recent duplicate should not run"),
            |_| panic!("recent duplicate should not ack"),
        )
        .unwrap();
    assert!(matches!(recent, DeliveryOutcome::Duplicate { .. }));
}

#[test]
fn snapshots_show_waiting_sequence_and_active_identity() {
    let inbox = Arc::new(PartitionedInbox::new(Duration::from_secs(2), 100).unwrap());
    let leader_entered = Arc::new(Barrier::new(2));
    let leader_release = Arc::new(Barrier::new(2));
    let leader_inbox = inbox.clone();
    let entered = leader_entered.clone();
    let release = leader_release.clone();
    let leader = thread::spawn(move || {
        leader_inbox.handle(
            retained_message("snapshot-1", "snapshot-account", 1),
            |_| {
                entered.wait();
                release.wait();
                Ok(())
            },
            |_| Ok(()),
        )
    });
    leader_entered.wait();
    let follower_inbox = inbox.clone();
    let follower = thread::spawn(move || {
        follower_inbox.handle(
            retained_message("snapshot-2", "snapshot-account", 2),
            |_| Ok(()),
            |_| Ok(()),
        )
    });
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let snapshot = inbox.snapshot().unwrap();
        let lane = &snapshot.lanes[0];
        if lane.active_message.as_deref() == Some("snapshot-1")
            && lane.waiting_sequences == vec![2]
            && lane.waiting_callers == 1
        {
            assert_eq!(lane.expected_sequence, 1);
            assert_eq!(lane.processed, 0);
            break;
        }
        assert!(
            Instant::now() < deadline,
            "snapshot never exposed active and waiting state"
        );
        thread::yield_now();
    }
    leader_release.wait();
    leader.join().unwrap().unwrap();
    follower.join().unwrap().unwrap();
    let finished = inbox.snapshot().unwrap();
    assert_eq!(finished.lanes[0].active_message, None);
    assert!(finished.lanes[0].waiting_sequences.is_empty());
    assert_eq!(finished.lanes[0].expected_sequence, 3);
}

#[test]
fn failed_handler_releases_lane_for_another_copy_of_same_sequence() {
    let inbox = Arc::new(PartitionedInbox::new(Duration::from_secs(2), 100).unwrap());
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let first_inbox = inbox.clone();
    let first_entered = entered.clone();
    let first_release = release.clone();
    let first = thread::spawn(move || {
        first_inbox.handle(
            retained_message("retry-copy-a", "retry-copy-account", 1),
            |_| {
                first_entered.wait();
                first_release.wait();
                Err("first copy failed".to_owned())
            },
            |_| panic!("failed handler must not ack"),
        )
    });
    entered.wait();
    let second_inbox = inbox.clone();
    let second = thread::spawn(move || {
        second_inbox.handle(
            retained_message("retry-copy-b", "retry-copy-account", 1),
            |_| Ok(()),
            |_| Ok(()),
        )
    });
    thread::sleep(Duration::from_millis(10));
    release.wait();
    assert_eq!(
        first.join().unwrap(),
        Err(InboxError::HandlerFailed("first copy failed".to_owned()))
    );
    assert_eq!(
        second.join().unwrap().unwrap(),
        DeliveryOutcome::Processed { next_sequence: 2 }
    );
    let snapshot = inbox.snapshot().unwrap();
    assert_eq!(snapshot.completed_count, 1);
    assert_eq!(snapshot.lanes[0].failed, 1);
    assert_eq!(snapshot.lanes[0].processed, 1);
}

#[test]
fn failure_on_one_account_does_not_stall_another_account() {
    let inbox = Arc::new(PartitionedInbox::new(Duration::from_secs(1), 100).unwrap());
    let blocking_entered = Arc::new(Barrier::new(2));
    let blocking_release = Arc::new(Barrier::new(2));
    let blocked_inbox = inbox.clone();
    let entered = blocking_entered.clone();
    let release = blocking_release.clone();
    let blocked = thread::spawn(move || {
        blocked_inbox.handle(
            retained_message("blocked-a", "blocked-account", 1),
            |_| {
                entered.wait();
                release.wait();
                Err("account-specific failure".to_owned())
            },
            |_| unreachable!(),
        )
    });
    blocking_entered.wait();
    let other_started = Instant::now();
    let other = inbox
        .handle(
            retained_message("healthy-b", "healthy-account", 1),
            |_| Ok(()),
            |_| Ok(()),
        )
        .unwrap();
    assert_eq!(other, DeliveryOutcome::Processed { next_sequence: 2 });
    assert!(other_started.elapsed() < Duration::from_millis(100));
    blocking_release.wait();
    assert!(matches!(
        blocked.join().unwrap(),
        Err(InboxError::HandlerFailed(_))
    ));
}

#[test]
fn many_accounts_advance_independently_under_load() {
    let inbox = Arc::new(PartitionedInbox::new(Duration::from_secs(3), 10_000).unwrap());
    let acknowledgements = Arc::new(AtomicUsize::new(0));
    let handled = Arc::new(Mutex::new(BTreeMap::<String, Vec<u64>>::new()));
    let mut workers = Vec::new();
    for account_index in 0..12 {
        for sequence in 1..=10 {
            let worker_inbox = inbox.clone();
            let worker_acks = acknowledgements.clone();
            let worker_handled = handled.clone();
            let account = format!("load-account-{account_index:02}");
            workers.push(thread::spawn(move || {
                worker_inbox.handle(
                    retained_message(
                        &format!("load-{account_index:02}-{sequence:02}"),
                        &account,
                        sequence,
                    ),
                    |received| {
                        worker_handled
                            .lock()
                            .unwrap()
                            .entry(received.account.clone())
                            .or_default()
                            .push(received.sequence);
                        Ok(())
                    },
                    |_| {
                        worker_acks.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                )
            }));
        }
    }
    for worker in workers {
        worker.join().unwrap().unwrap();
    }
    assert_eq!(acknowledgements.load(Ordering::SeqCst), 120);
    let handled = handled.lock().unwrap();
    assert_eq!(handled.len(), 12);
    for sequences in handled.values() {
        assert_eq!(sequences, &(1..=10).collect::<Vec<_>>());
    }
    let snapshot = inbox.snapshot().unwrap();
    assert_eq!(snapshot.lane_count, 12);
    assert_eq!(snapshot.completed_count, 120);
    assert_eq!(snapshot.accepted, 120);
    assert_eq!(snapshot.rejected, 0);
    for lane in snapshot.lanes {
        assert_eq!(lane.expected_sequence, 11);
        assert_eq!(lane.processed, 10);
    }
}

#[test]
fn constructor_rejects_wait_and_retention_limits() {
    assert!(PartitionedInbox::new(Duration::ZERO, 10).is_err());
    assert!(PartitionedInbox::new(Duration::from_secs(31), 10).is_err());
    assert!(PartitionedInbox::new(Duration::from_millis(1), 0).is_err());
    assert!(PartitionedInbox::new(Duration::from_millis(1), 1_000_001).is_err());
    let invalid_account = BTreeMap::from([("".to_owned(), 1)]);
    assert!(PartitionedInbox::with_starting_sequences(
        Duration::from_millis(1),
        10,
        &invalid_account
    )
    .is_err());
    let invalid_sequence = BTreeMap::from([("account".to_owned(), 0)]);
    assert!(PartitionedInbox::with_starting_sequences(
        Duration::from_millis(1),
        10,
        &invalid_sequence
    )
    .is_err());
}

#[test]
fn older_unseen_sequence_reports_behind_after_progress() {
    let starts = BTreeMap::from([("behind-account".to_owned(), 10)]);
    let inbox =
        PartitionedInbox::with_starting_sequences(Duration::from_millis(20), 100, &starts).unwrap();
    inbox
        .handle(
            retained_message("sequence-10", "behind-account", 10),
            |_| Ok(()),
            |_| Ok(()),
        )
        .unwrap();
    let calls = AtomicUsize::new(0);
    let result = inbox.handle(
        retained_message("unseen-sequence-9", "behind-account", 9),
        |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        |_| Ok(()),
    );
    assert_eq!(
        result,
        Err(InboxError::SequenceBehind {
            expected: 11,
            received: 9
        })
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
