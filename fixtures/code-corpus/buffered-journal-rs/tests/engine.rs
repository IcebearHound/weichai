mod support;

use std::time::Duration;

use buffered_journal_rs::{
    Durability, EngineCommand, EngineOutcome, JournalEngine, RetryClass, SchedulerCommand,
    SchedulerOutcome,
};
use support::{record, TempWorkspace};

/// 达到阈值后追加即落盘,快照计数与磁盘段一致。
#[test]
fn engine_threshold_append_reaches_segment_and_snapshot() {
    let workspace = TempWorkspace::new("engine-threshold");
    let engine = JournalEngine::open(workspace.path(), Durability::DataSync, 2 * 1024 * 1024)
        .expect("open journal engine");
    let records = (0..64)
        .map(|index| {
            record(
                &format!("audit-{index}"),
                &format!("account-{}", index % 4),
                10_000 + index,
                &format!("audit|entry={index}"),
            )
        })
        .collect::<Vec<_>>();
    let append = engine
        .execute(EngineCommand::Append {
            records: records.clone(),
        })
        .expect("append records");
    match append {
        EngineOutcome::Append { accepted, durable } => {
            assert_eq!(accepted, 64);
            assert_eq!(durable, 64);
        }
        _ => panic!("expected append outcome"),
    }
    let snapshot = engine.execute(EngineCommand::Snapshot).expect("snapshot");
    match snapshot {
        EngineOutcome::Snapshot(snapshot) => {
            assert_eq!(snapshot.accepted_records, 64);
            assert_eq!(snapshot.durable_records, 64);
            assert_eq!(snapshot.active_accounts, 4);
        }
        _ => panic!("expected runtime snapshot"),
    }
    assert!(workspace.path().join("segment-1-g0.bjseg").exists());
}

/// 未达阈值的少量记录先缓冲,定时刷盘命令可将其落盘。
#[test]
fn engine_timer_flushes_a_small_batch() {
    let workspace = TempWorkspace::new("engine-timer");
    let engine = JournalEngine::open(workspace.path(), Durability::Buffered, 1024 * 1024)
        .expect("open journal engine");
    let append = engine
        .execute(EngineCommand::Append {
            records: vec![record("single", "account", 1, "audit|single")],
        })
        .unwrap();
    // 单条记录低于阈值(64),先缓冲不落盘。
    assert!(matches!(append, EngineOutcome::Append { durable: 0, .. }));
    // 等待超过累积器定时间隔(500ms)后主动刷盘。
    std::thread::sleep(Duration::from_millis(550));
    let flush = engine
        .execute(EngineCommand::FlushDue)
        .expect("timer flush");
    assert!(matches!(flush, EngineOutcome::Flushed(1)));
}

/// 优雅停机:排空缓冲、提交检查点,检查点文件包含最新进度。
#[test]
fn engine_shutdown_durably_drains_and_commits_checkpoint() {
    let workspace = TempWorkspace::new("engine-shutdown");
    let engine = JournalEngine::open(workspace.path(), Durability::FullSync, 1024 * 1024)
        .expect("open journal engine");
    engine
        .execute(EngineCommand::Append {
            records: vec![
                record("one", "account-a", 1, "audit|one"),
                record("two", "account-b", 2, "audit|two"),
            ],
        })
        .expect("buffer records");
    let shutdown = engine
        .execute(EngineCommand::Shutdown)
        .expect("clean shutdown");
    match shutdown {
        EngineOutcome::Shutdown {
            durable,
            checkpoint_epoch,
        } => {
            assert_eq!(durable, 2);
            assert_eq!(checkpoint_epoch, 1);
        }
        _ => panic!("expected shutdown outcome"),
    }
    let checkpoint = workspace.path().join("checkpoints/journal.checkpoint");
    let content = std::fs::read_to_string(checkpoint).expect("read shutdown checkpoint");
    assert!(content.contains("durable_sequence=2"));
    assert!(content.contains("account-a"));
    assert!(content.contains("account-b"));
}

/// 重试调度可通过引擎命令推进,且反映在运行时快照中。
#[test]
fn engine_exposes_retry_scheduler_without_crossing_storage_state() {
    let workspace = TempWorkspace::new("engine-retry");
    let engine = JournalEngine::open(workspace.path(), Durability::Buffered, 1024 * 1024)
        .expect("open journal engine");
    let outcome = engine
        .execute(EngineCommand::Retry(SchedulerCommand::Schedule {
            now_ms: 100,
            identity: "retry-engine".to_owned(),
            account: "account".to_owned(),
            class: RetryClass::ProviderUnavailable,
            attempt: 1,
            requested_delay_ms: 5,
            deadline_ms: Some(10_000),
            payload: b"provider-request".to_vec(),
            last_error: "feed disconnected".to_owned(),
        }))
        .expect("schedule through engine");
    match outcome {
        EngineOutcome::Retry(SchedulerOutcome::Scheduled { identity, .. }) => {
            assert_eq!(identity, "retry-engine");
        }
        _ => panic!("expected scheduler outcome"),
    }
    let snapshot = engine.execute(EngineCommand::Snapshot).unwrap();
    assert!(matches!(snapshot, EngineOutcome::Snapshot(snapshot) if snapshot.retry_depth == 1));
}

/// 只读维护:扫描段、产生动作报告,但不实际删除任何段。
#[test]
fn maintenance_scans_segments_and_reports_actions_without_deleting() {
    let workspace = TempWorkspace::new("engine-maintenance");
    let engine = JournalEngine::open(workspace.path(), Durability::DataSync, 1024 * 1024)
        .expect("open journal engine");
    let records = (0..64)
        .map(|index| record(&format!("event-{index}"), "account", index, "audit|event"))
        .collect();
    engine
        .execute(EngineCommand::Append { records })
        .expect("write a segment batch");
    let maintenance = engine
        .execute(EngineCommand::Maintain {
            repair: false,
            disk_pressure_per_mille: 100,
        })
        .expect("run read-only maintenance");
    match maintenance {
        EngineOutcome::Maintenance(report) => {
            assert_eq!(report.scanned_segments, 1);
            assert_eq!(report.deleted_segments, 0);
            assert!(report.records_recovered >= 64);
            assert!(report.errors.is_empty());
        }
        _ => panic!("expected maintenance report"),
    }
}
