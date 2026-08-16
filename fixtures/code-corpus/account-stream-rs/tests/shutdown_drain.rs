use account_stream_rs::{PendingRecord, ShutdownLedger};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// 构造一条待持久化记录。
fn record(identity: &str, partition: &str, sequence: u64) -> PendingRecord {
    PendingRecord {
        identity: identity.to_owned(),
        partition: partition.to_owned(),
        sequence,
        payload: format!("record={identity}&partition={partition}&sequence={sequence}")
            .into_bytes(),
        accepted_at: Instant::now(),
    }
}

/// 追加与排空保持严格的 FIFO 顺序,统计计数一致。
#[test]
fn append_and_drain_preserve_fifo_order() {
    let ledger = ShutdownLedger::new(100).expect("ledger");
    for sequence in 1..=5 {
        let pending = ledger
            .append(record(
                &format!("fifo-{sequence}"),
                "partition-fifo",
                sequence,
            ))
            .expect("append");
        assert_eq!(pending, sequence as usize);
    }
    let persisted = Mutex::new(Vec::new());
    let drained = ledger
        .drain(3, |batch| {
            persisted
                .lock()
                .unwrap()
                .extend(batch.iter().map(|item| item.identity.clone()));
            Ok(())
        })
        .expect("first drain");
    assert_eq!(drained, 3);
    assert_eq!(ledger.snapshot().unwrap().pending, 2);
    let second = ledger
        .drain(10, |batch| {
            persisted
                .lock()
                .unwrap()
                .extend(batch.iter().map(|item| item.identity.clone()));
            Ok(())
        })
        .expect("second drain");
    assert_eq!(second, 2);
    assert_eq!(
        *persisted.lock().unwrap(),
        vec!["fifo-1", "fifo-2", "fifo-3", "fifo-4", "fifo-5"]
    );
    let snapshot = ledger.snapshot().unwrap();
    assert_eq!(snapshot.pending, 0);
    assert_eq!(snapshot.accepted, 5);
    assert_eq!(snapshot.persisted, 5);
    assert_eq!(snapshot.failed_writes, 0);
}

/// 写入失败时整批回退到队首,顺序不变,后续可重试成功。
#[test]
fn failed_write_restores_batch_before_newer_records() {
    let ledger = ShutdownLedger::new(100).unwrap();
    for sequence in 1..=6 {
        ledger
            .append(record(
                &format!("restore-{sequence}"),
                "partition-restore",
                sequence,
            ))
            .unwrap();
    }
    let error = ledger.drain(4, |_| Err("synthetic disk failure".to_owned()));
    assert_eq!(error, Err("synthetic disk failure".to_owned()));
    let pending = ledger.pending_records().unwrap();
    assert_eq!(
        pending.iter().map(|item| item.sequence).collect::<Vec<_>>(),
        vec![1, 2, 3, 4, 5, 6]
    );
    let snapshot = ledger.snapshot().unwrap();
    assert_eq!(snapshot.pending, 6);
    assert_eq!(snapshot.persisted, 0);
    assert_eq!(snapshot.failed_writes, 1);
    let persisted = Mutex::new(Vec::new());
    ledger
        .drain(6, |batch| {
            persisted
                .lock()
                .unwrap()
                .extend(batch.iter().map(|item| item.sequence));
            Ok(())
        })
        .unwrap();
    assert_eq!(*persisted.lock().unwrap(), vec![1, 2, 3, 4, 5, 6]);
}

/// 相同 identity 的记录不会被追加两次,保留首次提交的字段。
#[test]
fn duplicate_pending_identity_is_not_appended_twice() {
    let ledger = ShutdownLedger::new(10).unwrap();
    assert_eq!(
        ledger
            .append(record("duplicate", "partition-a", 1))
            .unwrap(),
        1
    );
    assert_eq!(
        ledger
            .append(record("duplicate", "partition-b", 9))
            .unwrap(),
        1
    );
    let pending = ledger.pending_records().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].partition, "partition-a");
    assert_eq!(pending[0].sequence, 1);
    assert_eq!(ledger.snapshot().unwrap().accepted, 1);
}

/// 多线程并发追加不丢记录,去重后身份集合大小等于记录总数。
#[test]
fn concurrent_callers_append_without_losing_records() {
    let ledger = Arc::new(ShutdownLedger::new(1_000).unwrap());
    let mut workers = Vec::new();
    for worker in 0..8 {
        let worker_ledger = ledger.clone();
        workers.push(thread::spawn(move || {
            for offset in 0..25 {
                let identity = format!("concurrent-{worker}-{offset}");
                worker_ledger
                    .append(record(
                        &identity,
                        &format!("partition-{worker}"),
                        offset + 1,
                    ))
                    .expect("concurrent append");
            }
        }));
    }
    for worker in workers {
        worker.join().expect("worker");
    }
    let snapshot = ledger.snapshot().unwrap();
    assert_eq!(snapshot.pending, 200);
    assert_eq!(snapshot.accepted, 200);
    let identities: std::collections::HashSet<_> = ledger
        .pending_records()
        .unwrap()
        .into_iter()
        .map(|item| item.identity)
        .collect();
    assert_eq!(identities.len(), 200);
}

/// 并发排空时同时只有一个写者在执行,所有记录恰好被持久化一次。
#[test]
fn concurrent_drains_use_only_one_writer_at_a_time() {
    let ledger = Arc::new(ShutdownLedger::new(100).unwrap());
    for sequence in 1..=20 {
        ledger
            .append(record(
                &format!("serial-writer-{sequence}"),
                "writer-partition",
                sequence,
            ))
            .unwrap();
    }
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let persisted = Arc::new(Mutex::new(Vec::new()));
    let mut workers = Vec::new();
    for _ in 0..4 {
        let worker_ledger = ledger.clone();
        let worker_active = active.clone();
        let worker_maximum = maximum.clone();
        let worker_persisted = persisted.clone();
        workers.push(thread::spawn(move || {
            worker_ledger.drain(5, |batch| {
                let current = worker_active.fetch_add(1, Ordering::SeqCst) + 1;
                worker_maximum.fetch_max(current, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(4));
                worker_persisted
                    .lock()
                    .unwrap()
                    .extend(batch.iter().map(|item| item.identity.clone()));
                worker_active.fetch_sub(1, Ordering::SeqCst);
                Ok(())
            })
        }));
    }
    let mut total = 0;
    for worker in workers {
        total += worker.join().unwrap().unwrap();
    }
    assert_eq!(total, 20);
    assert_eq!(maximum.load(Ordering::SeqCst), 1);
    assert_eq!(persisted.lock().unwrap().len(), 20);
    assert_eq!(ledger.snapshot().unwrap().pending, 0);
}

/// finish 等待活动写入者完成后,再排空剩余记录,总量守恒。
#[test]
fn finish_waits_for_active_writer_then_drains_remainder() {
    let ledger = Arc::new(ShutdownLedger::new(100).unwrap());
    for sequence in 1..=8 {
        ledger
            .append(record(
                &format!("finish-{sequence}"),
                "finish-partition",
                sequence,
            ))
            .unwrap();
    }
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let persisted = Arc::new(Mutex::new(Vec::new()));
    let writer_ledger = ledger.clone();
    let writer_entered = entered.clone();
    let writer_release = release.clone();
    let writer_persisted = persisted.clone();
    let writer = thread::spawn(move || {
        writer_ledger.drain(3, |batch| {
            writer_entered.wait();
            writer_release.wait();
            writer_persisted
                .lock()
                .unwrap()
                .extend(batch.iter().map(|item| item.sequence));
            Ok(())
        })
    });
    entered.wait();
    let finisher_ledger = ledger.clone();
    let finisher_persisted = persisted.clone();
    let finisher = thread::spawn(move || {
        finisher_ledger.finish(Duration::from_secs(2), |batch| {
            finisher_persisted
                .lock()
                .unwrap()
                .extend(batch.iter().map(|item| item.sequence));
            Ok(())
        })
    });
    thread::sleep(Duration::from_millis(10));
    // 写入者尚未放行时,finish 应阻塞等待而非直接返回。
    assert!(!finisher.is_finished());
    release.wait();
    assert_eq!(writer.join().unwrap().unwrap(), 3);
    assert_eq!(finisher.join().unwrap().unwrap(), 5);
    assert_eq!(*persisted.lock().unwrap(), (1..=8).collect::<Vec<_>>());
    let snapshot = ledger.snapshot().unwrap();
    assert!(snapshot.closing);
    assert!(!snapshot.writer_active);
    assert_eq!(snapshot.pending, 0);
    assert_eq!(snapshot.persisted, 8);
}

/// 排空失败时记录留在队列中,便于诊断与后续恢复。
#[test]
fn finish_failure_keeps_unwritten_records_for_diagnostics() {
    let ledger = ShutdownLedger::new(10).unwrap();
    ledger
        .append(record("finish-fail-a", "partition", 1))
        .unwrap();
    ledger
        .append(record("finish-fail-b", "partition", 2))
        .unwrap();
    let result = ledger.finish(Duration::from_secs(1), |_| {
        Err("volume read-only".to_owned())
    });
    assert_eq!(result, Err("volume read-only".to_owned()));
    let snapshot = ledger.snapshot().unwrap();
    assert!(snapshot.closing);
    assert_eq!(snapshot.pending, 2);
    assert_eq!(snapshot.persisted, 0);
    assert_eq!(snapshot.failed_writes, 1);
    assert_eq!(
        ledger
            .pending_records()
            .unwrap()
            .iter()
            .map(|item| item.identity.as_str())
            .collect::<Vec<_>>(),
        vec!["finish-fail-a", "finish-fail-b"]
    );
}

/// 追加对非法字段、容量上限与关闭状态的拒绝行为。
#[test]
fn append_rejects_invalid_records_capacity_and_closing_state() {
    let ledger = ShutdownLedger::new(2).unwrap();
    let mut blank_identity = record("valid", "partition", 1);
    blank_identity.identity = " ".to_owned();
    assert!(ledger.append(blank_identity).is_err());
    let mut blank_partition = record("valid", "partition", 1);
    blank_partition.partition.clear();
    assert!(ledger.append(blank_partition).is_err());
    let mut zero_sequence = record("valid", "partition", 1);
    zero_sequence.sequence = 0;
    assert!(ledger.append(zero_sequence).is_err());
    let mut empty_payload = record("valid", "partition", 1);
    empty_payload.payload.clear();
    assert!(ledger.append(empty_payload).is_err());
    ledger.append(record("capacity-a", "partition", 1)).unwrap();
    ledger.append(record("capacity-b", "partition", 2)).unwrap();
    assert_eq!(
        ledger.append(record("capacity-c", "partition", 3)),
        Err("shutdown ledger capacity exceeded".to_owned())
    );
    ledger.finish(Duration::from_secs(1), |_| Ok(())).unwrap();
    assert_eq!(
        ledger.append(record("after-close", "partition", 4)),
        Err("shutdown ledger is closing".to_owned())
    );
}

/// 构造器与 drain/finish 对参数的边界校验;空队列 drain 返回 0。
#[test]
fn constructor_and_drain_validate_limits() {
    assert!(ShutdownLedger::new(0).is_err());
    assert!(ShutdownLedger::new(1_000_001).is_err());
    let ledger = ShutdownLedger::new(10).unwrap();
    assert_eq!(
        ledger.drain(0, |_| Ok(())),
        Err("drain maximum must be positive".to_owned())
    );
    assert_eq!(
        ledger.finish(Duration::ZERO, |_| Ok(())),
        Err("shutdown timeout must be positive".to_owned())
    );
    assert_eq!(ledger.drain(5, |_| unreachable!()).unwrap(), 0);
}
