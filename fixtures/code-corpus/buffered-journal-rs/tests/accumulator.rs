mod support;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use buffered_journal_rs::{BatchWriter, JournalAccumulator, JournalRecord};
use support::record;

#[derive(Default)]
struct MemoryWriter {
    batches: Mutex<Vec<Vec<JournalRecord>>>,
    fail_next: AtomicBool,
}

impl BatchWriter for MemoryWriter {
    fn persist(&self, records: &[JournalRecord]) -> Result<(), String> {
        if self.fail_next.swap(false, Ordering::SeqCst) {
            return Err("injected disk failure".to_owned());
        }
        self.batches
            .lock()
            .expect("memory writer lock")
            .push(records.to_vec());
        Ok(())
    }
}

struct GateWriter {
    state: Mutex<(bool, bool, Vec<JournalRecord>)>,
    changed: Condvar,
}

impl GateWriter {
    fn new() -> Self {
        Self {
            state: Mutex::new((false, false, Vec::new())),
            changed: Condvar::new(),
        }
    }
}

impl BatchWriter for GateWriter {
    fn persist(&self, records: &[JournalRecord]) -> Result<(), String> {
        let mut state = self.state.lock().expect("gate writer lock");
        state.0 = true;
        self.changed.notify_all();
        while !state.1 {
            state = self.changed.wait(state).expect("gate writer wait");
        }
        state.2.extend_from_slice(records);
        Ok(())
    }
}

#[test]
fn threshold_flushes_once_and_duplicate_delivery_is_ignored() {
    let accumulator =
        JournalAccumulator::new(2, 8, 2, Duration::from_secs(60), 32).expect("valid accumulator");
    let writer = MemoryWriter::default();
    let first = record("first", "account-a", 1, "audit|one");
    let second = record("second", "account-a", 2, "audit|two");
    assert_eq!(
        accumulator
            .drain(std::slice::from_ref(&first), false, &writer)
            .unwrap(),
        0
    );
    assert_eq!(
        accumulator
            .drain(&[first.clone(), second.clone()], false, &writer)
            .unwrap(),
        2
    );
    let batches = writer.batches.lock().unwrap();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0], vec![first, second]);
}

#[test]
fn failed_batch_is_requeued_in_original_order_for_shutdown_retry() {
    let accumulator =
        JournalAccumulator::new(2, 8, 1, Duration::from_secs(60), 32).expect("valid accumulator");
    let writer = MemoryWriter::default();
    writer.fail_next.store(true, Ordering::SeqCst);
    let records = vec![
        record("a", "account", 1, "audit|a"),
        record("b", "account", 2, "audit|b"),
        record("c", "account", 3, "audit|c"),
    ];
    let error = accumulator
        .drain(&records, false, &writer)
        .expect_err("injected failure must surface");
    assert!(error.contains("retaining 3 records"));
    assert_eq!(accumulator.drain(&[], true, &writer).unwrap(), 3);
    let batches = writer.batches.lock().unwrap();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0], records);
}

#[test]
fn shutdown_waits_for_lock_free_in_flight_writer() {
    let accumulator = Arc::new(
        JournalAccumulator::new(1, 8, 2, Duration::from_secs(60), 32).expect("valid accumulator"),
    );
    let writer = Arc::new(GateWriter::new());
    let first_accumulator = accumulator.clone();
    let first_writer = writer.clone();
    let producer = std::thread::spawn(move || {
        first_accumulator
            .drain(
                &[record("in-flight", "account", 1, "audit|in-flight")],
                false,
                first_writer.as_ref(),
            )
            .expect("background write succeeds")
    });
    {
        let mut state = writer.state.lock().unwrap();
        while !state.0 {
            state = writer.changed.wait(state).unwrap();
        }
    }
    let shutdown_completed = Arc::new(AtomicBool::new(false));
    let shutdown_accumulator = accumulator.clone();
    let shutdown_writer = writer.clone();
    let completion_flag = shutdown_completed.clone();
    let shutdown = std::thread::spawn(move || {
        let count = shutdown_accumulator
            .drain(&[], true, shutdown_writer.as_ref())
            .expect("shutdown drain");
        completion_flag.store(true, Ordering::SeqCst);
        count
    });
    std::thread::sleep(Duration::from_millis(30));
    assert!(!shutdown_completed.load(Ordering::SeqCst));
    {
        let mut state = writer.state.lock().unwrap();
        state.1 = true;
        writer.changed.notify_all();
    }
    assert_eq!(producer.join().unwrap(), 1);
    assert_eq!(shutdown.join().unwrap(), 0);
    assert!(shutdown_completed.load(Ordering::SeqCst));
    assert_eq!(writer.state.lock().unwrap().2.len(), 1);
}

#[test]
fn concurrent_callers_do_not_write_the_same_identity_twice() {
    let accumulator = Arc::new(
        JournalAccumulator::new(1, 4, 4, Duration::from_secs(60), 256).expect("valid accumulator"),
    );
    let writer = Arc::new(MemoryWriter::default());
    let attempts = Arc::new(AtomicUsize::new(0));
    let mut threads = Vec::new();
    for worker in 0..12 {
        let accumulator = accumulator.clone();
        let writer = writer.clone();
        let attempts = attempts.clone();
        threads.push(std::thread::spawn(move || {
            attempts.fetch_add(1, Ordering::SeqCst);
            accumulator
                .drain(
                    &[record("shared", "account", worker, "audit|shared")],
                    false,
                    writer.as_ref(),
                )
                .unwrap()
        }));
    }
    let durable = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .sum::<usize>();
    assert_eq!(attempts.load(Ordering::SeqCst), 12);
    assert_eq!(durable, 1);
    let occurrences = writer
        .batches
        .lock()
        .unwrap()
        .iter()
        .flatten()
        .filter(|record| record.identity == "shared")
        .count();
    assert_eq!(occurrences, 1);
}
