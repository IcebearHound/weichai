use account_stream_rs::{
    AccountPartitioner, ParsedCommand, QuoteTokenParser, ReceiptCodec, ReceiptEnvelope,
    RetrySchedule,
};
use std::collections::BTreeMap;
use std::time::Duration;

#[test]
fn account_partitioning_is_deterministic_salted_and_bounded() {
    let first = AccountPartitioner::new(32, 17).unwrap();
    let same = AccountPartitioner::new(32, 17).unwrap();
    let salted = AccountPartitioner::new(32, 99).unwrap();
    let accounts = [
        "retail-001",
        "retail-002",
        "corporate-europe",
        "corporate-asia",
        "nostro-usd",
        "vostro-eur",
        "merchant-east",
        "merchant-west",
    ];
    let mut moved = 0;
    for account in accounts {
        let original = first.partition(account).unwrap();
        assert_eq!(original, same.partition(account).unwrap());
        assert!(original < 32);
        if original != salted.partition(account).unwrap() {
            moved += 1;
        }
    }
    assert!(moved >= 4, "salt moved only {moved} accounts");
    assert!(first.partition("").is_err());
    assert!(AccountPartitioner::new(0, 1).is_err());
    assert!(AccountPartitioner::new(65_537, 1).is_err());
}

#[test]
fn account_partition_group_sorts_each_shard() {
    let partitioner = AccountPartitioner::new(4, 1_234).unwrap();
    let accounts = vec![
        "zulu-account".to_owned(),
        "alpha-account".to_owned(),
        "middle-account".to_owned(),
        "beta-account".to_owned(),
        "omega-account".to_owned(),
        "delta-account".to_owned(),
    ];
    let grouped = partitioner.group(&accounts).unwrap();
    assert_eq!(
        grouped.values().map(Vec::len).sum::<usize>(),
        accounts.len()
    );
    for (partition, values) in grouped {
        assert!(partition < 4);
        let mut sorted = values.clone();
        sorted.sort_unstable();
        assert_eq!(values, sorted);
        for account in values {
            assert_eq!(partitioner.partition(account).unwrap(), partition);
        }
    }
}

#[test]
fn account_partition_balance_exposes_distribution_shape() {
    let partitioner = AccountPartitioner::new(8, 72).unwrap();
    let accounts: Vec<String> = (0..1_000)
        .map(|index| format!("balance-account-{index:04}"))
        .collect();
    let balance = partitioner.balance(&accounts).unwrap();
    assert_eq!(balance.counts.len(), 8);
    assert_eq!(balance.counts.iter().sum::<usize>(), 1_000);
    assert_eq!(balance.minimum, *balance.counts.iter().min().unwrap());
    assert_eq!(balance.maximum, *balance.counts.iter().max().unwrap());
    assert!((balance.average - 125.0).abs() < f64::EPSILON);
    assert!((0.0..0.25).contains(&balance.coefficient_of_variation));
    assert!(balance.empty_partitions.is_empty());
    let empty = partitioner.balance(&[]).unwrap();
    assert_eq!(empty.average, 0.0);
    assert_eq!(empty.empty_partitions, (0..8).collect::<Vec<_>>());
}

#[test]
fn account_partition_movement_compares_topologies() {
    let four = AccountPartitioner::new(4, 7).unwrap();
    let eight = AccountPartitioner::new(8, 7).unwrap();
    let accounts: Vec<String> = (0..200)
        .map(|index| format!("movement-{index:03}"))
        .collect();
    let moved = four.moved_accounts(&eight, &accounts).unwrap();
    assert!(!moved.is_empty());
    assert!(moved.len() < accounts.len());
    for account in &moved {
        assert_ne!(
            four.partition(account).unwrap(),
            eight.partition(account).unwrap()
        );
    }
    assert!(four.moved_accounts(&four, &accounts).unwrap().is_empty());
}

#[test]
fn command_parser_handles_quotes_escapes_assignments_and_flags() {
    let parser = QuoteTokenParser;
    let parsed = parser
        .parse(r#"PRICE "EUR USD" amount=125000 note='client order' --stream --verbose --stream"#)
        .unwrap();
    assert_eq!(parsed.verb, "price");
    assert_eq!(parsed.positional, vec!["EUR USD"]);
    assert_eq!(parsed.assignments["amount"], "125000");
    assert_eq!(parsed.assignments["note"], "client order");
    assert_eq!(parsed.flags, vec!["stream", "verbose"]);
    let escaped = parser
        .tokenize(r#"emit line\ one "line\ttwo" 'line three'"#)
        .unwrap();
    assert_eq!(escaped, vec!["emit", "line one", "line\ttwo", "line three"]);
}

#[test]
fn command_parser_round_trip_is_canonical() {
    let parser = QuoteTokenParser;
    let command = ParsedCommand {
        verb: "reconcile".to_owned(),
        positional: vec!["account one".to_owned(), "account-two".to_owned()],
        assignments: BTreeMap::from([
            ("currency".to_owned(), "EUR".to_owned()),
            ("memo".to_owned(), "contains spaces".to_owned()),
        ]),
        flags: vec![
            "verbose".to_owned(),
            "dry-run".to_owned(),
            "verbose".to_owned(),
        ],
    };
    let rendered = parser.render(&command).unwrap();
    let reparsed = parser.parse(&rendered).unwrap();
    assert_eq!(reparsed.verb, command.verb);
    assert_eq!(reparsed.positional, command.positional);
    assert_eq!(reparsed.assignments, command.assignments);
    assert_eq!(reparsed.flags, vec!["dry-run", "verbose"]);
    assert_eq!(parser.render(&reparsed).unwrap(), rendered);
}

#[test]
fn command_parser_rejects_ambiguous_or_incomplete_input() {
    let parser = QuoteTokenParser;
    let invalid = [
        "",
        "   ",
        "bad/verb item",
        "price 'unterminated",
        "price ends\\",
        "price amount=",
        "price =value",
        "price --",
        "price --bad=value",
        "price amount=1 amount=2",
        r#"price bad\q"#,
    ];
    for input in invalid {
        assert!(parser.parse(input).is_err(), "input {input:?} was accepted");
    }
}

fn receipt_envelope() -> ReceiptEnvelope {
    ReceiptEnvelope {
        instruction: "instruction-001".to_owned(),
        receipt: "receipt-001".to_owned(),
        account: "account-001".to_owned(),
        sequence: 42,
        committed_millis: 1_840_000_000_123,
        attributes: BTreeMap::from([
            ("currency".to_owned(), "USD".to_owned()),
            ("route".to_owned(), "clearing-main".to_owned()),
            ("trace".to_owned(), "trace-abc".to_owned()),
        ]),
    }
}

#[test]
fn receipt_codec_round_trips_and_checks_version() {
    let codec = ReceiptCodec::new(3, 64 * 1024).unwrap();
    let envelope = receipt_envelope();
    let encoded = codec.encode(&envelope).unwrap();
    assert_eq!(ReceiptCodec::inspect_version(&encoded), Some(3));
    assert_eq!(codec.decode(&encoded).unwrap(), envelope);
    let other = ReceiptCodec::new(4, 64 * 1024).unwrap();
    assert_eq!(
        other.decode(&encoded),
        Err("receipt frame version mismatch".to_owned())
    );
}

#[test]
fn receipt_codec_detects_corruption_and_truncation() {
    let codec = ReceiptCodec::new(7, 64 * 1024).unwrap();
    let encoded = codec.encode(&receipt_envelope()).unwrap();
    for index in [0, 5, encoded.len() / 2, encoded.len() - 5] {
        let mut changed = encoded.clone();
        changed[index] ^= 0x5a;
        assert!(
            codec.decode(&changed).is_err(),
            "corruption at {index} was accepted"
        );
    }
    for length in [0, 1, 8, 16, 24] {
        assert!(codec.decode(&encoded[..length]).is_err());
    }
}

#[test]
fn receipt_codec_validates_envelope_and_size_limits() {
    assert!(ReceiptCodec::new(0, 1_024).is_err());
    assert!(ReceiptCodec::new(1, 63).is_err());
    assert!(ReceiptCodec::new(1, 16 * 1024 * 1024 + 1).is_err());
    let codec = ReceiptCodec::new(1, 256).unwrap();
    let mut blank = receipt_envelope();
    blank.instruction.clear();
    assert!(codec.encode(&blank).is_err());
    let mut zero = receipt_envelope();
    zero.sequence = 0;
    assert!(codec.encode(&zero).is_err());
    let mut large = receipt_envelope();
    large
        .attributes
        .insert("memo".to_owned(), "m".repeat(1_024));
    assert!(codec.encode(&large).is_err());
}

#[test]
fn retry_schedule_grows_caps_and_respects_budget() {
    let schedule = RetrySchedule {
        base: Duration::from_millis(10),
        maximum: Duration::from_millis(80),
        multiplier: 2.0,
        jitter_fraction: 0.0,
        seed: 99,
    };
    assert_eq!(
        schedule.sequence(7).unwrap(),
        vec![
            Duration::from_millis(10),
            Duration::from_millis(20),
            Duration::from_millis(40),
            Duration::from_millis(80),
            Duration::from_millis(80),
            Duration::from_millis(80),
            Duration::from_millis(80),
        ]
    );
    assert_eq!(schedule.budget(4).unwrap(), Duration::from_millis(150));
    assert_eq!(
        schedule
            .attempts_within(Duration::from_millis(69), 10)
            .unwrap(),
        2
    );
    assert_eq!(
        schedule
            .attempts_within(Duration::from_millis(70), 10)
            .unwrap(),
        3
    );
}

#[test]
fn retry_schedule_jitter_is_seeded_and_bounded() {
    let schedule = RetrySchedule {
        base: Duration::from_secs(1),
        maximum: Duration::from_secs(30),
        multiplier: 1.5,
        jitter_fraction: 0.25,
        seed: 12_345,
    };
    for attempt in 1..=20 {
        let first = schedule.delay(attempt).unwrap();
        let second = schedule.delay(attempt).unwrap();
        assert_eq!(first, second);
        assert!(first <= schedule.maximum);
        assert!(first >= Duration::from_millis(750));
    }
    let changed_seed = RetrySchedule {
        seed: 12_346,
        ..schedule.clone()
    };
    assert_ne!(schedule.delay(3).unwrap(), changed_seed.delay(3).unwrap());
}

#[test]
fn retry_schedule_rejects_invalid_parameters() {
    let cases = [
        RetrySchedule {
            base: Duration::ZERO,
            maximum: Duration::from_secs(1),
            multiplier: 2.0,
            jitter_fraction: 0.0,
            seed: 1,
        },
        RetrySchedule {
            base: Duration::from_secs(2),
            maximum: Duration::from_secs(1),
            multiplier: 2.0,
            jitter_fraction: 0.0,
            seed: 1,
        },
        RetrySchedule {
            base: Duration::from_secs(1),
            maximum: Duration::from_secs(2),
            multiplier: 0.5,
            jitter_fraction: 0.0,
            seed: 1,
        },
        RetrySchedule {
            base: Duration::from_secs(1),
            maximum: Duration::from_secs(2),
            multiplier: 2.0,
            jitter_fraction: 1.1,
            seed: 1,
        },
    ];
    for schedule in cases {
        assert!(schedule.validate().is_err());
        assert!(schedule.delay(1).is_err());
    }
}
