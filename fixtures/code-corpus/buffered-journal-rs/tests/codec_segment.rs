mod support;

use std::fs::OpenOptions;
use std::io::Write;

use buffered_journal_rs::{Durability, SegmentFile};
use support::{codec, record, TempWorkspace};

#[test]
fn codec_round_trip_preserves_domain_fields_and_order() {
    let codec = codec();
    let records = vec![
        record("audit-1", "account-a", 1000, "trade.accepted|USD|10"),
        record("audit-2", "account-a", 1004, "quote.observed|EURUSD|1.1"),
        record("audit-3", "account-b", 999, "settlement.completed|batch-7"),
    ];
    let encoded = codec
        .encode_batch(&records)
        .expect("encode valid journal batch");
    assert!(encoded.starts_with(b"BJR2"));
    let (decoded, diagnostics) = codec.decode_stream(&encoded);
    assert_eq!(decoded, records);
    assert!(
        diagnostics.is_empty(),
        "unexpected diagnostics: {diagnostics:?}"
    );
}

#[test]
fn codec_rejects_duplicate_identity_before_writing_bytes() {
    let codec = codec();
    let duplicated = vec![
        record("same", "account-a", 1, "audit|first"),
        record("same", "account-b", 2, "audit|second"),
    ];
    let error = codec
        .encode_batch(&duplicated)
        .expect_err("duplicate must be rejected");
    assert!(error.contains("duplicate identity"));
}

#[test]
fn codec_reports_corrupted_frame_without_returning_it_as_valid() {
    let codec = codec();
    let mut encoded = codec
        .encode_batch(&[record("frame-1", "account-a", 10, "audit|protected")])
        .expect("encode frame");
    let body_byte = encoded.len() - 16;
    encoded[body_byte] ^= 0x5a;
    let (decoded, diagnostics) = codec.decode_stream(&encoded);
    assert!(decoded.is_empty());
    assert!(diagnostics
        .iter()
        .any(|message| message.contains("checksum")));
}

#[test]
fn segment_append_is_durable_and_recovery_reconstructs_ranges() {
    let workspace = TempWorkspace::new("segment-roundtrip");
    let path = workspace.path().join("segment-1-g0.bjseg");
    let segment = SegmentFile::open(&path, 1, 0, codec(), Durability::FullSync, 2 * 1024 * 1024)
        .expect("open synthetic segment");
    let first = vec![
        record("one", "account-a", 100, "audit|one"),
        record("two", "account-b", 101, "audit|two"),
    ];
    let second = vec![record("three", "account-a", 102, "tombstone|obsolete")];
    let receipt_one = segment.append(&first).expect("append first batch");
    let receipt_two = segment.append(&second).expect("append second batch");
    assert_eq!(receipt_one.first_sequence, 1);
    assert_eq!(receipt_one.last_sequence, 2);
    assert_eq!(receipt_two.first_sequence, 3);
    let (descriptor, diagnostics) = segment
        .inspect_and_repair(false)
        .expect("inspect complete segment");
    assert!(
        diagnostics.is_empty(),
        "unexpected diagnostics: {diagnostics:?}"
    );
    assert_eq!(descriptor.first_sequence, 1);
    assert_eq!(descriptor.last_sequence, 3);
    assert_eq!(descriptor.live_records, 3);
    assert_eq!(descriptor.tombstone_records, 1);
    assert_eq!(descriptor.account_ranges["account-a"], (1, 3));
}

#[test]
fn recovery_truncates_only_the_incomplete_tail() {
    let workspace = TempWorkspace::new("segment-tail");
    let path = workspace.path().join("segment-9-g0.bjseg");
    let segment = SegmentFile::open(&path, 9, 0, codec(), Durability::DataSync, 2 * 1024 * 1024)
        .expect("open segment");
    segment
        .append(&[record("stable", "account", 7, "audit|stable")])
        .expect("append stable batch");
    let stable_length = std::fs::metadata(&path).expect("metadata").len();
    let mut file = OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("open corrupt tail");
    file.write_all(&[13, 37, 99, 1, 2, 3, 4])
        .expect("append partial envelope");
    file.sync_all().expect("sync corrupt tail");
    let (descriptor, diagnostics) = segment
        .inspect_and_repair(true)
        .expect("repair incomplete tail");
    assert_eq!(descriptor.last_sequence, 1);
    assert_eq!(
        std::fs::metadata(&path)
            .expect("metadata after repair")
            .len(),
        stable_length
    );
    assert!(diagnostics
        .iter()
        .any(|message| message.contains("truncated")));
}
