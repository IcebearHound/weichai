mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, SystemTime};

use buffered_journal_rs::{
    audit_flush_label, provider_route_slug, quote_frame_caption, settlement_banner,
    trade_event_title, CheckpointLedger, CheckpointOperation, CheckpointOutcome, CompactionAction,
    CompactionPlanner, RetentionDecision, RetentionPolicy, RetryClass, RetryTicket,
    SchedulerCommand, SchedulerOutcome, SparseIndex,
};
use support::{descriptor, scheduler, TempWorkspace};

#[test]
fn scheduler_applies_backoff_then_leases_due_work() {
    let mut scheduler = scheduler();
    let scheduled = scheduler
        .advance(SchedulerCommand::Schedule {
            now_ms: 1_000,
            identity: "retry-1".to_owned(),
            account: "account-a".to_owned(),
            class: RetryClass::Transient,
            attempt: 0,
            requested_delay_ms: 10,
            deadline_ms: Some(10_000),
            payload: b"settlement".to_vec(),
            last_error: "temporary database refusal".to_owned(),
        })
        .expect("schedule retry");
    let ready_at = match scheduled {
        SchedulerOutcome::Scheduled { ready_at_ms, .. } => ready_at_ms,
        _ => panic!("expected scheduled outcome"),
    };
    let early = scheduler
        .advance(SchedulerCommand::Poll {
            now_ms: ready_at - 1,
            capacity: 4,
            maximum_per_account: 1,
            lease_ms: 100,
        })
        .unwrap();
    assert!(matches!(early, SchedulerOutcome::Dispatch(items) if items.is_empty()));
    let due = scheduler
        .advance(SchedulerCommand::Poll {
            now_ms: ready_at,
            capacity: 4,
            maximum_per_account: 1,
            lease_ms: 100,
        })
        .unwrap();
    match due {
        SchedulerOutcome::Dispatch(items) => {
            assert_eq!(items.len(), 1);
            assert!(
                matches!(items[0], RetryTicket::Leased { ref identity, .. } if identity == "retry-1")
            );
        }
        _ => panic!("expected dispatch"),
    }
}

#[test]
fn scheduler_poll_is_fair_across_accounts() {
    let mut scheduler = scheduler();
    for (identity, account) in [("a-1", "a"), ("a-2", "a"), ("b-1", "b")] {
        scheduler
            .advance(SchedulerCommand::Schedule {
                now_ms: 0,
                identity: identity.to_owned(),
                account: account.to_owned(),
                class: RetryClass::Immediate,
                attempt: 0,
                requested_delay_ms: 1,
                deadline_ms: None,
                payload: identity.as_bytes().to_vec(),
                last_error: "retry".to_owned(),
            })
            .unwrap();
    }
    let outcome = scheduler
        .advance(SchedulerCommand::Poll {
            now_ms: 100,
            capacity: 3,
            maximum_per_account: 1,
            lease_ms: 50,
        })
        .unwrap();
    let accounts = match outcome {
        SchedulerOutcome::Dispatch(items) => items
            .into_iter()
            .map(|ticket| match ticket {
                RetryTicket::Leased { account, .. } => account,
                RetryTicket::Waiting { .. } => panic!("poll returned waiting ticket"),
            })
            .collect::<BTreeSet<_>>(),
        _ => panic!("expected dispatch"),
    };
    assert_eq!(accounts, BTreeSet::from(["a".to_owned(), "b".to_owned()]));
    assert_eq!(
        scheduler.entries.len(),
        3,
        "leased and deferred work remain tracked"
    );
}

#[test]
fn expired_lease_is_reclaimed_without_losing_payload() {
    let mut scheduler = scheduler();
    let scheduled = scheduler
        .advance(SchedulerCommand::Schedule {
            now_ms: 20,
            identity: "lease".to_owned(),
            account: "account".to_owned(),
            class: RetryClass::StorageBusy,
            attempt: 0,
            requested_delay_ms: 1,
            deadline_ms: Some(100_000),
            payload: b"durable-work".to_vec(),
            last_error: "writer busy".to_owned(),
        })
        .unwrap();
    let ready = match scheduled {
        SchedulerOutcome::Scheduled { ready_at_ms, .. } => ready_at_ms,
        _ => unreachable!(),
    };
    scheduler
        .advance(SchedulerCommand::Poll {
            now_ms: ready,
            capacity: 1,
            maximum_per_account: 1,
            lease_ms: 10,
        })
        .unwrap();
    let reclaimed = scheduler
        .advance(SchedulerCommand::ReclaimExpired { now_ms: ready + 11 })
        .unwrap();
    assert_eq!(reclaimed, SchedulerOutcome::Reclaimed(1));
    assert!(matches!(
        scheduler.entries.get("lease"),
        Some(RetryTicket::Waiting { payload, .. }) if payload == b"durable-work"
    ));
}

#[test]
fn checkpoint_commit_is_atomic_and_compare_and_swap_protected() {
    let workspace = TempWorkspace::new("checkpoint");
    let ledger = CheckpointLedger::new(workspace.path().to_path_buf(), "consumer", 100, true)
        .expect("create checkpoint ledger");
    assert_eq!(
        ledger.transact(CheckpointOperation::Load).unwrap(),
        CheckpointOutcome::Missing
    );
    let committed = ledger
        .transact(CheckpointOperation::Commit {
            expected_epoch: Some(0),
            durable_sequence: 40,
            account_positions: BTreeMap::from([
                ("account-a".to_owned(), 39),
                ("account-b".to_owned(), 40),
            ]),
            remove_accounts: BTreeSet::new(),
        })
        .expect("commit first checkpoint");
    assert!(matches!(
        committed,
        CheckpointOutcome::Committed { epoch: 1, .. }
    ));
    let stale = ledger.transact(CheckpointOperation::Commit {
        expected_epoch: Some(0),
        durable_sequence: 41,
        account_positions: BTreeMap::new(),
        remove_accounts: BTreeSet::new(),
    });
    assert!(stale.unwrap_err().contains("expected epoch 0"));
    let loaded = ledger.transact(CheckpointOperation::Load).unwrap();
    match loaded {
        CheckpointOutcome::Loaded {
            epoch,
            durable_sequence,
            account_positions,
            warnings,
        } => {
            assert_eq!(epoch, 1);
            assert_eq!(durable_sequence, 40);
            assert_eq!(account_positions["account-a"], 39);
            assert!(warnings.is_empty());
        }
        _ => panic!("expected loaded checkpoint"),
    }
}

#[test]
fn sparse_index_combines_account_time_and_identity_filters() {
    let workspace = TempWorkspace::new("index");
    let rows = (1..=40)
        .map(|sequence| {
            (
                sequence,
                64 + sequence * 100,
                1_700_000_000_000 + sequence as i64 * 1000,
                if sequence % 2 == 0 { "even" } else { "odd" }.to_owned(),
                format!("identity-{sequence}"),
            )
        })
        .collect::<Vec<_>>();
    let path = workspace.path().join("segment-1.idx");
    let (index, diagnostics) =
        SparseIndex::rebuild(&path, 1, 0, 10_000, 4, &rows).expect("rebuild sparse index");
    assert!(diagnostics.is_empty());
    assert!(path.exists());
    let anchors = index.seek(
        Some("even"),
        Some(10),
        Some(30),
        Some(1_700_000_010_000),
        Some(1_700_000_030_000),
        Some("identity-22"),
    );
    assert!(!anchors.is_empty());
    assert!(anchors.iter().all(|entry| entry.0 <= 22));
}

#[test]
fn compaction_groups_adjacent_sealed_segments_for_real_reclaim() {
    let workspace = TempWorkspace::new("compaction");
    let mut segments = vec![
        descriptor(workspace.path(), 1, 1, 100, 100_000),
        descriptor(workspace.path(), 2, 101, 200, 110_000),
        descriptor(workspace.path(), 3, 201, 300, 90_000),
    ];
    segments[0].tombstone_records = 30;
    segments[1].duplicate_records = 20;
    let planner = CompactionPlanner {
        target_segment_bytes: 1_000_000,
        maximum_input_segments: 4,
        minimum_reclaim_bytes: 1_000,
        tombstone_ratio_per_mille: 50,
        fragmentation_ratio_per_mille: 100,
        required_replica_acks: 0,
        minimum_sealed_age: Duration::ZERO,
        maximum_generation: 8,
    };
    let plans = planner
        .plan(&segments, SystemTime::now())
        .expect("plan compaction");
    let merge = plans
        .iter()
        .find(|plan| plan.action == CompactionAction::Merge)
        .expect("adjacent segments should merge");
    assert_eq!(merge.inputs, vec![1, 2, 3]);
    assert!(merge.estimated_reclaimed_bytes > 0);
    assert!(merge.accounts.len() >= 2);
}

#[test]
fn retention_honors_reader_lease_and_legal_hold_under_pressure() {
    let workspace = TempWorkspace::new("retention");
    let mut segments = vec![
        descriptor(workspace.path(), 1, 1, 100, 100_000),
        descriptor(workspace.path(), 2, 101, 200, 100_000),
        descriptor(workspace.path(), 3, 201, 300, 100_000),
        descriptor(workspace.path(), 4, 301, 400, 100_000),
    ];
    segments[0].legal_hold = true;
    segments[1].reader_leases = 2;
    let policy = RetentionPolicy {
        minimum_segments: 1,
        maximum_total_bytes: 150_000,
        minimum_age: Duration::ZERO,
        maximum_age: Duration::from_secs(1),
        required_replicas: BTreeSet::new(),
        preserve_sequence_span: 0,
        pressure_delete_batch: 4,
    };
    let decisions = policy
        .choose(&segments, SystemTime::now(), 400, 980)
        .expect("evaluate retention");
    let by_id = decisions
        .into_iter()
        .map(|entry| (entry.0, entry.1))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(by_id[&1], RetentionDecision::DelayForLegalHold);
    assert_eq!(by_id[&2], RetentionDecision::DelayForReader);
    assert_ne!(
        by_id[&4],
        RetentionDecision::Delete,
        "newest segment is protected"
    );
}

#[test]
fn formatting_helpers_are_presentation_only_distractors() {
    assert_eq!(quote_frame_caption(" eur ", "usd", 1.25), "EUR/USD 1.25000");
    assert_eq!(
        settlement_banner(" asia pacific ", "20260712"),
        "Settlement board | ASIA-PACIFIC | 2026-07-12"
    );
    assert_eq!(
        provider_route_slug(&["Primary Feed".to_owned(), "Backup Feed".to_owned()]),
        "providers/primary-feed/backup-feed"
    );
    assert_eq!(trade_event_title("bid", "eur-usd"), "BUY EUR/USD");
    assert_eq!(audit_flush_label(1_500), "1.5k audit rows ready");
}
