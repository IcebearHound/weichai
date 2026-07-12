use account_stream_rs::{
    Payout, PayoutResult, RetryingPayoutBook, SequenceLedger, SequenceObservation,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;
use std::time::Duration;

type PayoutMutation = (&'static str, Box<dyn Fn(&mut Payout)>);

fn payout(identity: &str, amount_minor: i64, currency: &str) -> Payout {
    Payout {
        id: identity.to_owned(),
        account: format!("source-{identity}"),
        beneficiary: format!("target-{identity}"),
        amount_minor,
        currency: currency.to_owned(),
        reference: format!("invoice-{identity}"),
    }
}

#[test]
fn sequence_ledger_tracks_contiguous_progress() {
    let mut ledger = SequenceLedger::default();
    assert_eq!(
        ledger.observe("account-a", 1).unwrap(),
        SequenceObservation::First { sequence: 1 }
    );
    assert_eq!(
        ledger.observe("account-a", 2).unwrap(),
        SequenceObservation::Advanced {
            previous: 1,
            sequence: 2
        }
    );
    assert_eq!(
        ledger.observe("account-a", 3).unwrap(),
        SequenceObservation::Advanced {
            previous: 2,
            sequence: 3
        }
    );
    assert_eq!(ledger.high_water("account-a"), Some(3));
    assert_eq!(ledger.contiguous_through("account-a"), Some(3));
    assert!(ledger.missing("account-a").is_empty());
}

#[test]
fn sequence_ledger_opens_and_fills_gaps() {
    let mut ledger = SequenceLedger::default();
    let opened = ledger.observe("account-gap", 5).unwrap();
    assert_eq!(
        opened,
        SequenceObservation::GapOpened {
            previous: 0,
            sequence: 5,
            missing: vec![1, 2, 3, 4]
        }
    );
    assert_eq!(ledger.contiguous_through("account-gap"), Some(0));
    assert_eq!(
        ledger.observe("account-gap", 2).unwrap(),
        SequenceObservation::GapFilled {
            sequence: 2,
            remaining: 3
        }
    );
    assert_eq!(
        ledger.observe("account-gap", 1).unwrap(),
        SequenceObservation::GapFilled {
            sequence: 1,
            remaining: 2
        }
    );
    assert_eq!(ledger.contiguous_through("account-gap"), Some(2));
    assert_eq!(
        ledger.observe("account-gap", 4).unwrap(),
        SequenceObservation::GapFilled {
            sequence: 4,
            remaining: 1
        }
    );
    assert_eq!(ledger.contiguous_through("account-gap"), Some(2));
    assert_eq!(
        ledger.observe("account-gap", 3).unwrap(),
        SequenceObservation::GapFilled {
            sequence: 3,
            remaining: 0
        }
    );
    assert_eq!(ledger.contiguous_through("account-gap"), Some(5));
}

#[test]
fn sequence_ledger_distinguishes_duplicates_and_late_values() {
    let mut ledger = SequenceLedger::default();
    ledger.observe("account-late", 1).unwrap();
    ledger.observe("account-late", 2).unwrap();
    ledger.observe("account-late", 4).unwrap();
    assert_eq!(
        ledger.observe("account-late", 4).unwrap(),
        SequenceObservation::Duplicate { sequence: 4 }
    );
    assert_eq!(
        ledger.observe("account-late", 3).unwrap(),
        SequenceObservation::GapFilled {
            sequence: 3,
            remaining: 0
        }
    );
    assert_eq!(
        ledger.observe("account-late", 2).unwrap(),
        SequenceObservation::Duplicate { sequence: 2 }
    );
    let snapshots = ledger.snapshots();
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].duplicate_count, 2);
    assert_eq!(snapshots[0].late_count, 1);
    assert_eq!(snapshots[0].observed_count, 4);
}

#[test]
fn sequence_ledger_tracks_streams_independently_and_sorts_snapshots() {
    let mut ledger = SequenceLedger::default();
    ledger.observe("zulu", 20).unwrap();
    ledger.observe("alpha", 1).unwrap();
    ledger.observe("middle", 7).unwrap();
    ledger.observe("alpha", 2).unwrap();
    ledger.observe("zulu", 22).unwrap();
    let snapshots = ledger.snapshots();
    assert_eq!(
        snapshots
            .iter()
            .map(|snapshot| snapshot.stream.as_str())
            .collect::<Vec<_>>(),
        vec!["alpha", "middle", "zulu"]
    );
    assert_eq!(snapshots[0].high_water, 2);
    assert_eq!(snapshots[1].missing, (1..7).collect::<Vec<_>>());
    assert_eq!(snapshots[2].missing.last(), Some(&21));
}

#[test]
fn sequence_ledger_merge_replays_observations_without_losing_gaps() {
    let mut left = SequenceLedger::default();
    left.observe("merge-a", 1).unwrap();
    left.observe("merge-a", 4).unwrap();
    left.observe("left-only", 9).unwrap();
    let mut right = SequenceLedger::default();
    right.observe("merge-a", 2).unwrap();
    right.observe("merge-a", 3).unwrap();
    right.observe("right-only", 1).unwrap();
    let outcomes = left.merge(&right).unwrap();
    assert!(!outcomes.is_empty());
    assert_eq!(left.contiguous_through("merge-a"), Some(4));
    assert_eq!(left.high_water("left-only"), Some(9));
    assert_eq!(left.high_water("right-only"), Some(1));
}

#[test]
fn sequence_ledger_prunes_old_identity_memory_and_removes_stream() {
    let mut ledger = SequenceLedger::default();
    for sequence in 1..=12 {
        ledger.observe("prune-stream", sequence).unwrap();
    }
    assert_eq!(ledger.prune_observed_through("prune-stream", 8), 8);
    assert_eq!(ledger.snapshots()[0].observed_count, 4);
    assert_eq!(ledger.high_water("prune-stream"), Some(12));
    assert_eq!(ledger.prune_observed_through("missing-stream", 5), 0);
    assert!(ledger.remove_stream("prune-stream"));
    assert!(!ledger.remove_stream("prune-stream"));
    assert!(ledger.snapshots().is_empty());
}

#[test]
fn sequence_ledger_rejects_invalid_inputs() {
    let mut ledger = SequenceLedger::default();
    assert_eq!(
        ledger.observe("", 1),
        Err("stream identity is required".to_owned())
    );
    assert_eq!(
        ledger.observe("   ", 1),
        Err("stream identity is required".to_owned())
    );
    assert_eq!(
        ledger.observe("valid", 0),
        Err("sequence must be positive".to_owned())
    );
    assert_eq!(ledger.high_water("valid"), None);
    assert_eq!(ledger.contiguous_through("valid"), None);
    assert!(ledger.missing("valid").is_empty());
}

#[test]
fn payout_validation_and_fingerprint_cover_business_fields() {
    let base = payout("payout-valid", 12_345, "USD");
    assert_eq!(base.validate(), Ok(()));
    assert_eq!(base.fingerprint().len(), 16);
    let mut cases: Vec<PayoutMutation> = vec![
        ("identity", Box::new(|value| value.id = " ".to_owned())),
        ("account", Box::new(|value| value.account.clear())),
        ("beneficiary", Box::new(|value| value.beneficiary.clear())),
        (
            "same account",
            Box::new(|value| value.beneficiary = value.account.clone()),
        ),
        ("zero amount", Box::new(|value| value.amount_minor = 0)),
        ("negative amount", Box::new(|value| value.amount_minor = -1)),
        (
            "short currency",
            Box::new(|value| value.currency = "US".to_owned()),
        ),
        (
            "lower currency",
            Box::new(|value| value.currency = "usd".to_owned()),
        ),
        (
            "long reference",
            Box::new(|value| value.reference = "r".repeat(141)),
        ),
    ];
    for (name, mutate) in cases.drain(..) {
        let mut changed = base.clone();
        mutate(&mut changed);
        assert!(changed.validate().is_err(), "case {name} was accepted");
        assert_ne!(
            changed.fingerprint(),
            base.fingerprint(),
            "case {name} fingerprint"
        );
    }
}

#[test]
fn payout_book_retries_partial_failures_and_preserves_order() {
    let book = RetryingPayoutBook::new(4).expect("book");
    let items = vec![
        payout("stable-a", 100, "USD"),
        payout("retry-b", 200, "EUR"),
        payout("retry-c", 300, "GBP"),
        payout("stable-d", 400, "JPY"),
    ];
    let attempts = Mutex::new(std::collections::BTreeMap::<String, u32>::new());
    let results = book
        .apply_batch("payout-batch-0001", &items, |item, attempt| {
            *attempts.lock().unwrap().entry(item.id.clone()).or_default() += 1;
            let fail_until = match item.id.as_str() {
                "retry-b" => 1,
                "retry-c" => 2,
                _ => 0,
            };
            if attempt <= fail_until {
                Err(format!("temporary failure {attempt}"))
            } else {
                Ok((
                    format!("provider-{}-{attempt}", item.id),
                    "clearing-main".to_owned(),
                ))
            }
        })
        .expect("batch");
    assert_eq!(results.len(), items.len());
    let expected_attempts = [1, 2, 3, 1];
    for (index, result) in results.iter().enumerate() {
        let PayoutResult::Settled(receipt) = result else {
            panic!("item {index} did not settle: {result:?}");
        };
        assert_eq!(receipt.payout_id, items[index].id);
        assert_eq!(receipt.attempt, expected_attempts[index]);
    }
    let observed = attempts.into_inner().unwrap();
    assert_eq!(observed["stable-a"], 1);
    assert_eq!(observed["retry-b"], 2);
    assert_eq!(observed["retry-c"], 3);
    assert_eq!(observed["stable-d"], 1);
    let snapshot = book.snapshot().unwrap();
    assert_eq!(snapshot.completed_batches, 1);
    assert_eq!(snapshot.receipt_count, 4);
}

#[test]
fn payout_book_keeps_exhausted_failure_at_input_position() {
    let book = RetryingPayoutBook::new(3).unwrap();
    let items = vec![
        payout("good-first", 100, "USD"),
        payout("bad-middle", 200, "USD"),
        payout("good-last", 300, "USD"),
    ];
    let results = book
        .apply_batch("payout-batch-0002", &items, |item, attempt| {
            if item.id == "bad-middle" {
                Err(format!("provider denied attempt {attempt}"))
            } else {
                Ok((format!("token-{}", item.id), "rail".to_owned()))
            }
        })
        .unwrap();
    assert!(matches!(results[0], PayoutResult::Settled(_)));
    assert_eq!(
        results[1],
        PayoutResult::Failed {
            attempts: 3,
            reason: "provider denied attempt 3".to_owned()
        }
    );
    assert!(matches!(results[2], PayoutResult::Settled(_)));
    assert_eq!(book.snapshot().unwrap().receipt_count, 2);
}

#[test]
fn payout_book_replay_returns_same_receipts_without_operations() {
    let book = RetryingPayoutBook::new(2).unwrap();
    let items = vec![
        payout("replay-a", 100, "USD"),
        payout("replay-b", 200, "EUR"),
    ];
    let first_calls = AtomicUsize::new(0);
    let first = book
        .apply_batch("payout-replay-key", &items, |item, attempt| {
            first_calls.fetch_add(1, Ordering::SeqCst);
            Ok((
                format!("first-{}-{attempt}", item.id),
                "rail-one".to_owned(),
            ))
        })
        .unwrap();
    let replay_calls = AtomicUsize::new(0);
    let replay = book
        .apply_batch("payout-replay-key", &items, |_, _| {
            replay_calls.fetch_add(1, Ordering::SeqCst);
            Err("must not run".to_owned())
        })
        .unwrap();
    assert_eq!(first, replay);
    assert_eq!(first_calls.load(Ordering::SeqCst), 2);
    assert_eq!(replay_calls.load(Ordering::SeqCst), 0);
    assert_eq!(book.snapshot().unwrap().replayed_batches, 1);
}

#[test]
fn payout_book_rejects_key_reuse_with_different_values() {
    let book = RetryingPayoutBook::new(2).unwrap();
    let original = vec![payout("conflict", 100, "USD")];
    book.apply_batch("payout-conflict-key", &original, |item, _| {
        Ok((format!("token-{}", item.id), "rail".to_owned()))
    })
    .unwrap();
    let mut changed = original.clone();
    changed[0].amount_minor = 101;
    let result = book.apply_batch("payout-conflict-key", &changed, |_, _| {
        panic!("conflicting replay must not run operation")
    });
    assert_eq!(
        result,
        Err("batch key already names a different payout set".to_owned())
    );
}

#[test]
fn concurrent_same_batch_joins_one_execution() {
    let book = Arc::new(RetryingPayoutBook::new(2).unwrap());
    let items = Arc::new(vec![
        payout("joined-a", 100, "USD"),
        payout("joined-b", 200, "EUR"),
    ]);
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let calls = Arc::new(AtomicUsize::new(0));
    let leader_book = book.clone();
    let leader_items = items.clone();
    let leader_entered = entered.clone();
    let leader_release = release.clone();
    let leader_calls = calls.clone();
    let leader = thread::spawn(move || {
        leader_book.apply_batch("payout-joined-key", &leader_items, |item, attempt| {
            let call = leader_calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                leader_entered.wait();
                leader_release.wait();
            }
            Ok((format!("joined-{}-{attempt}", item.id), "main".to_owned()))
        })
    });
    entered.wait();
    let mut followers = Vec::new();
    for _ in 0..6 {
        let follower_book = book.clone();
        let follower_items = items.clone();
        let follower_calls = calls.clone();
        followers.push(thread::spawn(move || {
            follower_book.apply_batch("payout-joined-key", &follower_items, |_, _| {
                follower_calls.fetch_add(1, Ordering::SeqCst);
                Err("follower operation should not run".to_owned())
            })
        }));
    }
    thread::sleep(Duration::from_millis(10));
    release.wait();
    let canonical = leader.join().unwrap().unwrap();
    for follower in followers {
        assert_eq!(follower.join().unwrap().unwrap(), canonical);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let snapshot = book.snapshot().unwrap();
    assert_eq!(snapshot.joined_batches, 6);
    assert_eq!(snapshot.completed_batches, 1);
    assert_eq!(snapshot.receipt_count, 2);
}

#[test]
fn payout_book_validates_batch_and_attempt_configuration() {
    assert!(RetryingPayoutBook::new(0).is_err());
    assert!(RetryingPayoutBook::new(13).is_err());
    let book = RetryingPayoutBook::new(1).unwrap();
    let item = payout("valid-item", 100, "USD");
    assert!(book
        .apply_batch("short", std::slice::from_ref(&item), |_, _| unreachable!())
        .is_err());
    assert!(book
        .apply_batch("valid-empty-key", &[], |_, _| unreachable!())
        .is_err());
    assert!(book
        .apply_batch(
            "duplicate-items-key",
            &[item.clone(), item],
            |_, _| unreachable!()
        )
        .is_err());
}

#[test]
fn payout_book_forgets_old_completed_batches_but_keeps_receipts() {
    let book = RetryingPayoutBook::new(1).unwrap();
    let item = payout("forgotten", 500, "GBP");
    book.apply_batch("forgotten-batch-key", &[item], |payout, _| {
        Ok((format!("token-{}", payout.id), "main".to_owned()))
    })
    .unwrap();
    thread::sleep(Duration::from_millis(2));
    assert_eq!(
        book.forget_batches_older_than(Duration::from_millis(1))
            .unwrap(),
        1
    );
    let snapshot = book.snapshot().unwrap();
    assert_eq!(snapshot.completed_batches, 0);
    assert_eq!(snapshot.receipt_count, 1);
}
