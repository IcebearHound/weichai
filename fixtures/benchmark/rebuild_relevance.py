from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
FRAGMENTS = HERE / "fragments"
ORDER = {"high": 0, "medium": 1, "low": 2, "distractor": 3}
GROUP_A = {
    "swift-cache-ts",
    "ledger-flow-ts",
    "resilient-pricing-py",
    "circuit-lane-java",
    "quote-fanout-go",
    "account-stream-rs",
}


def judgement(
    task: str,
    repository: str,
    path: str,
    symbol: str,
    language: str,
    relevance: str,
    reusable: list[str],
    incompatible: list[str],
    strategy: str,
    risks: list[str],
    mappings: dict[str, str],
) -> dict[str, Any]:
    return {
        "taskId": task,
        "candidateRepository": repository,
        "candidatePath": path,
        "candidateSymbol": symbol,
        "candidateLanguage": language,
        "relevance": relevance,
        "reusableParts": reusable,
        "incompatibleParts": incompatible,
        "recommendedStrategy": strategy,
        "risks": risks,
        "expectedInterfaceMappings": mappings,
    }


RECORDS: list[dict[str, Any]] = []

RECORDS.extend([
    judgement(
        "quote-cache-001", "quote-fanout-go", "fanout/timed_snapshot.go", "TimedSnapshot.Lookup", "Go", "high",
        ["per-pair fresh cache", "single-flight waiter joining", "bounded loader context", "stale fallback with retention", "capacity-aware eviction"],
        ["Go returns a value/error pair", "fresh duration is policy-driven rather than fixed in the type"],
        "translate",
        ["a loader that ignores context can outlive the timeout goroutine", "copy tag enrichment must not alter the target Quote contract"],
        {"QuoteRequest": "fanout.QuoteRequest", "Promise<Quote>": "(fanout.Quote, error)", "currency-pair key": "Pair.String()", "5000 ms TTL": "SnapshotPolicy.FreshFor"},
    ),
    judgement(
        "quote-cache-001", "signal-buffer-ts", "src/request-mux.ts", "ExpiringRequestMux.load", "TypeScript", "high",
        ["generic keyed TTL cells", "one pending promise per key", "AbortController provider deadline", "bounded stale retention", "fresh/shared/stale counters"],
        ["generic loader receives AbortSignal", "TTL and retention are constructor parameters"],
        "reuse",
        ["the provider must honor AbortSignal for real cancellation", "pair normalization remains the caller's responsibility"],
        {"currency pair": "mux key", "provider fetch": "Loader<V>", "Quote": "V", "five-second TTL": "ttlMs=5000"},
    ),
    judgement(
        "quote-cache-001", "swift-cache-ts", "src/coalescing-window.ts", "CoalescingWindow.resolve", "TypeScript", "medium",
        ["fresh TTL check", "one promise per key", "provider timeout race", "stale value on loader failure"],
        ["timed-out provider is observed but not aborted", "stale entries have no hard retention bound", "generic keys are not normalized pairs"],
        "wrap",
        ["late provider completion can retain resources", "unbounded stale fallback may violate a future retention policy"],
        {"QuoteRequest pair": "K", "provider request": "loader", "Quote": "V", "TTL": "constructor ttlMs"},
    ),
    judgement(
        "quote-cache-001", "resilient-pricing-py", "src/resilient_pricing/expiring_quote_pool.py", "ExpiringQuotePool.obtain", "Python", "medium",
        ["currency-pair normalization", "five-second default TTL", "condition-variable single flight", "stale-on-loader-error"],
        ["synchronous thread blocking", "no provider timeout", "stale data is retained without an age limit"],
        "bridge",
        ["calling through a Python bridge can block the TypeScript event loop", "BaseException handling is broader than the target error model"],
        {"QuoteRequest.pair": "pair string", "async provider": "synchronous loader callback", "Quote": "generic return value", "concurrent promise": "Condition wait"},
    ),
    judgement(
        "quote-cache-001", "ledger-flow-ts", "src/market-memo.ts", "MarketMemo.read", "TypeScript", "medium",
        ["TTL-based read-through memo", "bounded entry count", "least-used/least-recent eviction"],
        ["concurrent misses intentionally run independently", "no provider deadline", "no stale-on-error path", "default TTL is two seconds"],
        "wrap",
        ["parallel cache misses can stampede the provider", "target must override ttlMs with exactly 5000"],
        {"currency pair": "memo key", "provider fetch": "loader", "Quote": "memo value", "five-second TTL": "read ttlMs argument"},
    ),
    judgement(
        "quote-cache-001", "batch-reconcile-go", "src/reconcile/store.go", "MemoryReceiptStore.FindByPayment", "Go", "medium",
        ["thread-safe keyed lookup", "stable identity-to-value association", "read/write lock separation"],
        ["stores receipts rather than quotes", "no expiration", "no read-through loader", "no request coalescing or stale state"],
        "wrap",
        ["adapting this store alone would leave every cache timing behavior unimplemented", "Go locking cannot be shared directly with Node"],
        {"currency pair": "paymentID key", "Quote": "Receipt value", "cache hit": "exists result", "provider load": "not represented"},
    ),
    judgement(
        "quote-cache-001", "durable-audit-java", "src/main/java/synthetic/durableaudit/RetrySpool.java", "RetrySpool.pollDue", "Java", "low",
        ["clock-based eligibility", "exclusive leasing of due entries"],
        ["persistent retry tickets are not cached quotes", "no fresh-hit path", "no shared loader or stale fallback"],
        "translate",
        ["filesystem recovery and leasing add unnecessary state", "wall-clock retry semantics differ from TTL freshness"],
        {"cache deadline": "RetryKey.dueAt", "cache key": "ticket UUID", "load ownership": "leased ticket", "Quote": "not represented"},
    ),
    judgement(
        "quote-cache-001", "signal-buffer-ts", "src/retry-wheel.ts", "RetryWheel.takeDue", "TypeScript", "low",
        ["keyed time buckets", "identity deduplication", "bounded selection at a clock boundary"],
        ["models delayed retries rather than cached values", "does not execute or join a loader", "removes due tickets instead of serving fresh hits"],
        "wrap",
        ["rounding to a time quantum changes the exact five-second boundary", "fairness budget is unrelated to quote freshness"],
        {"pair key": "RetryTicket.identity", "TTL boundary": "slot dueAt", "cache read": "takeDue selection", "Quote": "not represented"},
    ),
    judgement(
        "quote-cache-001", "ledger-flow-ts", "src/quoted-fee-table.ts", "QuotedFeeTable.lookup", "TypeScript", "distractor",
        ["keyed lookup syntax"],
        ["computes a fee tier from a static table", "has no TTL, provider call, concurrency merge, or stale quote"],
        "reuse",
        ["the word quoted can cause a lexical false positive"],
        {"QuoteRequest": "no mapping", "Quote": "fee result only"},
    ),
    judgement(
        "quote-cache-001", "resilient-pricing-py", "src/resilient_pricing/quote_archive.py", "QuoteArchive.search", "Python", "distractor",
        ["searches quote-shaped historical rows"],
        ["archive ranking is not a live cache", "no provider execution or single flight", "historical results are intentionally old"],
        "translate",
        ["returning an archive row would confuse historical and live pricing"],
        {"QuoteRequest pair": "archive query", "Quote": "historical search row"},
    ),
    judgement(
        "quote-cache-001", "circuit-lane-java", "src/main/java/synthetic/lane/QuotationFormatter.java", "QuotationFormatter.render", "Java", "distractor",
        ["serializes a quote value"],
        ["pure presentation codec", "does not fetch, cache, time out, merge calls, or recover stale data"],
        "translate",
        ["quotation naming is lexical only"],
        {"Quote": "formatted text", "QuoteRequest": "not accepted"},
    ),
    judgement(
        "quote-cache-001", "quote-fanout-go", "fanout/quote_path_encoder.go", "QuotePathEncoder.Encode", "Go", "distractor",
        ["normalizes a currency-pair path"],
        ["URL encoding only", "no cached value or provider interaction"],
        "translate",
        ["a path key is not a cache implementation"],
        {"currency pair": "QuotePath.Pair", "Quote": "not represented"},
    ),
    judgement(
        "quote-cache-001", "account-stream-rs", "src/quote_token_parser.rs", "QuoteTokenParser.parse", "Rust", "distractor",
        ["parses quote-like command tokens"],
        ["text grammar parser", "no freshness, concurrency, timeout, or fallback behavior"],
        "translate",
        ["quote vocabulary can overstate behavioral relevance"],
        {"QuoteRequest": "ParsedCommand", "Quote": "not produced"},
    ),
    judgement(
        "quote-cache-001", "signal-buffer-ts", "src/presentation.ts", "PresentationLabels.quote", "TypeScript", "distractor",
        ["produces a quote label"],
        ["presentation helper only", "does not retain or load quotes"],
        "reuse",
        ["same-language reuse would still provide no target behavior"],
        {"Quote": "label input", "Promise<Quote>": "string output"},
    ),
    judgement(
        "quote-cache-001", "settlement-queue-py", "src/settlement_queue/formatting.py", "quote_queue_label", "Python", "distractor",
        ["formats queue metadata with quote terminology"],
        ["stateless label function", "no provider or cache state"],
        "translate",
        ["name similarity is the only retrieval signal"],
        {"QuoteRequest": "formatting arguments", "Quote": "label string"},
    ),
    judgement(
        "quote-cache-001", "durable-audit-java", "src/main/java/synthetic/durableaudit/LedgerCodec.java", "LedgerCodec.decode", "Java", "distractor",
        ["decodes durable ledger bytes"],
        ["audit serialization is unrelated to quote loading", "no TTL or call coalescing"],
        "translate",
        ["durability semantics may be mistaken for cache persistence"],
        {"QuoteRequest": "not represented", "Quote": "AuditBatch decode result"},
    ),
    judgement(
        "quote-cache-001", "batch-reconcile-go", "src/reconcile/operations.go", "QuoteSeries.Summarize", "Go", "distractor",
        ["summarizes numeric quote-series values"],
        ["offline statistics only", "does not load or retain a quote by pair"],
        "translate",
        ["QuoteSeries name is a deliberate lexical distractor"],
        {"Quote": "float sample", "result": "summary text"},
    ),
    judgement(
        "quote-cache-001", "buffered-journal-rs", "src/formatting.rs", "quote_frame_caption", "Rust", "distractor",
        ["renders a quote frame caption"],
        ["pure string formatting", "no cache lifecycle or provider failure handling"],
        "translate",
        ["formatting symbol shares quote terms without behavior"],
        {"Quote": "caption fields", "Promise<Quote>": "string"},
    ),
])


def sort_key(record: dict[str, Any]) -> tuple[str, int, str, str, str]:
    return (
        str(record["taskId"]),
        ORDER[str(record["relevance"])],
        str(record["candidateRepository"]),
        str(record["candidatePath"]),
        str(record["candidateSymbol"]),
    )


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(
            json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
            for row in sorted(rows, key=sort_key)
        ),
        encoding="utf-8",
    )


def main() -> None:
    expected_tasks = {
        "quote-cache-001",
        "batch-settlement-002",
        "provider-routing-003",
        "trade-consumer-004",
        "audit-buffer-005",
    }
    if len(RECORDS) != 90:
        raise ValueError(f"expected 90 judgements, found {len(RECORDS)}")
    identities: set[tuple[str, str, str, str]] = set()
    distributions: dict[str, Counter[str]] = {
        task: Counter() for task in expected_tasks
    }
    corpus = HERE.parent / "code-corpus"
    for row in RECORDS:
        task = str(row["taskId"])
        if task not in expected_tasks:
            raise ValueError(f"unknown task: {task}")
        distributions[task][str(row["relevance"])] += 1
        identity = (
            task,
            str(row["candidateRepository"]),
            str(row["candidatePath"]),
            str(row["candidateSymbol"]),
        )
        if identity in identities:
            raise ValueError(f"duplicate judgement: {identity}")
        identities.add(identity)
        repository = corpus / str(row["candidateRepository"])
        path = repository / str(row["candidatePath"])
        if not path.is_file():
            raise FileNotFoundError(path)
        manifest = json.loads((repository / "manifest.json").read_text(encoding="utf-8"))
        if manifest["language"] != row["candidateLanguage"]:
            raise ValueError(f"language mismatch for {identity}")
        text = path.read_text(encoding="utf-8")
        for part in str(row["candidateSymbol"]).replace(".", " ").split():
            if part not in text:
                raise ValueError(f"symbol part {part} is absent from {path}")
    expected = Counter({"high": 2, "medium": 4, "low": 2, "distractor": 10})
    for task, counts in distributions.items():
        if counts != expected:
            raise ValueError(f"{task} distribution is {counts}, expected {expected}")
    strategies = {str(row["recommendedStrategy"]) for row in RECORDS}
    if strategies != {"reuse", "translate", "wrap", "bridge"}:
        raise ValueError(f"strategy coverage is incomplete: {strategies}")
    group_a = [row for row in RECORDS if row["candidateRepository"] in GROUP_A]
    group_b = [row for row in RECORDS if row["candidateRepository"] not in GROUP_A]
    write_jsonl(FRAGMENTS / "relevance-group-a.jsonl", group_a)
    write_jsonl(FRAGMENTS / "relevance-group-b.jsonl", group_b)
    write_jsonl(HERE / "relevance.jsonl", RECORDS)
    print(
        json.dumps(
            {
                "records": len(RECORDS),
                "groupA": len(group_a),
                "groupB": len(group_b),
                "distribution": distributions,
                "strategies": sorted(strategies),
            },
            default=dict,
            sort_keys=True,
        )
    )


RECORDS.extend([
    judgement(
        "audit-buffer-005", "quote-fanout-go", "fanout/journal_batcher.go", "JournalBatcher", "Go", "high",
        ["channel-owned multi-producer buffer", "threshold-triggered writes", "periodic ticker", "single drain owner", "failed-write retention", "close drains every remaining batch"],
        ["requires a dedicated Run goroutine", "Go context/error API", "entry canonicalization and chronological sorting are built in"],
        "translate",
        ["shutdown must start the run loop before calling Close", "writer cancellation behavior must map to the target sink contract"],
        {"AuditLogEntry": "JournalEntry", "durable sink": "JournalWriter", "manual drain": "Drain", "shutdown": "Close"},
    ),
    judgement(
        "audit-buffer-005", "durable-audit-java", "src/main/java/synthetic/durableaudit/ConcurrentAuditAccumulator.java", "ConcurrentAuditAccumulator", "Java", "high",
        ["lock-protected concurrent append", "event and byte thresholds", "scheduled interval callback", "single writer executor", "failed-batch reinsertion", "blocking final drain and sync on close"],
        ["thread/executor lifecycle rather than promises", "flush returns write receipts", "requires explicit start"],
        "translate",
        ["close can block a Node worker if bridged directly", "non-daemon writer executor must always terminate on error"],
        {"AuditLogEntry": "AuditEvent", "sink": "BatchWriter", "buffer append": "add", "manual flush": "class flush operation", "shutdown": "close"},
    ),
    judgement(
        "audit-buffer-005", "swift-cache-ts", "src/buffered-appender.ts", "BufferedAppender.flushNow", "TypeScript", "medium",
        ["serialized write tail", "deterministic batch partitioning", "post-write durable identity marking", "retry resumes at first unconfirmed record"],
        ["records are supplied to each call rather than owned by the object", "no threshold, timer, or shutdown hook"],
        "wrap",
        ["caller must atomically transfer target buffered entries into the supplied array", "persisted ID memory is process-local"],
        {"AuditLogEntry": "BufferedRecord", "sink": "writer callback", "threshold": "batchSize only", "flush result": "FlushReport"},
    ),
    judgement(
        "audit-buffer-005", "resilient-pricing-py", "src/resilient_pricing/async_log_reservoir.py", "AsyncLogReservoir.drain", "Python", "medium",
        ["async mutual exclusion", "chunked durable writes", "content digest dedupe", "failed chunks remain unmarked for retry"],
        ["rows are call arguments, not an internal buffer", "no timer or shutdown", "holds one asyncio lock across writer await"],
        "bridge",
        ["a slow writer blocks every reservoir caller", "content-based dedupe may collapse distinct audit entries with equal bytes"],
        {"AuditLogEntry": "bytes row", "sink": "async writer", "batch size": "chunk_size", "flush": "drain call"},
    ),
    judgement(
        "audit-buffer-005", "signal-buffer-ts", "src/threshold-sink.ts", "ThresholdSink.append", "TypeScript", "medium",
        ["owned audit buffer", "threshold-triggered drain", "timer scheduling", "serialized write chain", "failure reinsertion", "shutdown close"],
        ["duplicate IDs inside one drain are silently collapsed", "timer callback swallows persistence rejection", "append and buffer swap assume one JavaScript event loop"],
        "reuse",
        ["silent timer failure needs observable shutdown propagation", "multiple worker threads would require an explicit mutex"],
        {"AuditLogEntry": "AuditEntry", "sink": "persist callback", "threshold": "constructor threshold", "shutdown": "close"},
    ),
    judgement(
        "audit-buffer-005", "buffered-journal-rs", "src/accumulator.rs", "JournalAccumulator.drain", "Rust", "medium",
        ["mutex-protected owned queue", "identity dedupe", "threshold and elapsed checks", "writes outside lock", "failure reinsertion", "shutdown waits for active writers"],
        ["timer is checked only when drain is called", "allows multiple concurrent writer slots", "synchronous persistence trait"],
        "bridge",
        ["quiet traffic will not flush without an external call", "more than one writer may violate the target single-owner batch rule"],
        {"AuditLogEntry": "JournalRecord", "sink": "BatchWriter", "append plus drain": "incoming slice", "shutdown": "shutdown boolean"},
    ),
    judgement(
        "audit-buffer-005", "account-stream-rs", "src/shutdown_ledger.rs", "ShutdownLedger.finish", "Rust", "low",
        ["exclusive writer ownership", "failed-batch reinsertion", "shutdown rejects new records and drains to empty", "timeout while waiting"],
        ["no automatic threshold or timer", "separate append/drain calls", "synchronous writer closure"],
        "translate",
        ["without an external scheduler normal traffic never persists", "shutdown timeout can leave retained records in memory"],
        {"AuditLogEntry": "PendingRecord", "sink": "writer closure", "shutdown": "finish", "flush": "drain"},
    ),
    judgement(
        "audit-buffer-005", "settlement-queue-py", "src/settlement_queue/journal.py", "AppendJournal.append", "Python", "low",
        ["fsync before atomic replacement", "hash-chained durable records", "recovery validation"],
        ["persists one record per call", "rewrites the whole file", "no buffer, threshold, timer, or concurrent-call guard"],
        "wrap",
        ["quadratic file copying is unsuitable for a buffered hot path", "simultaneous callers can race temporary-file replacement"],
        {"AuditLogEntry": "JournalRecord", "sink write": "append", "batch": "single record", "shutdown": "not represented"},
    ),
    judgement(
        "audit-buffer-005", "swift-cache-ts", "src/buffer-geometry.ts", "BufferGeometry.area", "TypeScript", "distractor",
        ["operates on something named buffer"],
        ["computational geometry only", "no log entries or persistence"],
        "reuse",
        ["buffer has a geometric rather than storage meaning"],
        {"audit buffer": "no mapping", "result": "polygon area"},
    ),
    judgement(
        "audit-buffer-005", "ledger-flow-ts", "src/audit-name-codec.ts", "AuditNameCodec.encode", "TypeScript", "distractor",
        ["encodes audit-oriented names"],
        ["stateless codec", "no buffering, threshold, timer, or durable sink"],
        "reuse",
        ["audit vocabulary is the only shared feature"],
        {"AuditLogEntry": "name components", "result": "encoded string"},
    ),
    judgement(
        "audit-buffer-005", "resilient-pricing-py", "src/resilient_pricing/flush_color_mixer.py", "FlushColorMixer.mix", "Python", "distractor",
        ["mixes values under a flush-themed class name"],
        ["color arithmetic only", "no records or I/O"],
        "translate",
        ["flush naming is deliberately behaviorally unrelated"],
        {"flush input": "color channels", "result": "mixed color"},
    ),
    judgement(
        "audit-buffer-005", "circuit-lane-java", "src/main/java/synthetic/lane/LogarithmBuffer.java", "LogarithmBuffer.compute", "Java", "distractor",
        ["encodes numeric values into a byte buffer"],
        ["numeric transform and checksum only", "no audit entries or persistence schedule"],
        "translate",
        ["Buffer in the class name is a lexical false positive"],
        {"AuditLogEntry": "double sample", "result": "encoded bytes"},
    ),
    judgement(
        "audit-buffer-005", "quote-fanout-go", "fanout/audit_trail_sorter.go", "AuditTrailSorter.Sort", "Go", "distractor",
        ["orders audit entries"],
        ["pure in-memory sorting", "does not own a buffer or write a sink"],
        "translate",
        ["audit entry type similarity hides missing lifecycle behavior"],
        {"AuditLogEntry": "JournalEntry", "result": "ordered slice"},
    ),
    judgement(
        "audit-buffer-005", "signal-buffer-ts", "src/presentation.ts", "PresentationLabels.audit", "TypeScript", "distractor",
        ["formats an audit label"],
        ["presentation helper only", "no buffered persistence"],
        "reuse",
        ["same language and audit term can mislead retrieval"],
        {"AuditLogEntry": "label fields", "result": "string"},
    ),
    judgement(
        "audit-buffer-005", "ordered-events-py", "src/ordered_events/formatting.py", "audit_trail_caption", "Python", "distractor",
        ["creates audit-trail caption text"],
        ["stateless formatting", "no sink or concurrency"],
        "translate",
        ["audit trail phrase is non-behavioral"],
        {"audit data": "caption arguments", "result": "string"},
    ),
    judgement(
        "audit-buffer-005", "settlement-queue-py", "src/settlement_queue/formatting.py", "audit_batch_heading", "Python", "distractor",
        ["formats an audit batch heading"],
        ["text formatting only", "does not form or persist a batch"],
        "translate",
        ["batch and audit terms produce a strong lexical decoy"],
        {"audit batch": "heading fields", "result": "string"},
    ),
    judgement(
        "audit-buffer-005", "durable-audit-java", "src/main/java/synthetic/durableaudit/AuditEvent.java", "AuditEvent.encodeFields", "Java", "distractor",
        ["serializes one audit event"],
        ["record codec only", "no buffer ownership, trigger, or shutdown"],
        "translate",
        ["correct domain type but wrong lifecycle layer"],
        {"AuditLogEntry": "AuditEvent", "result": "encoded byte fields"},
    ),
    judgement(
        "audit-buffer-005", "buffered-journal-rs", "src/formatting.rs", "audit_flush_label", "Rust", "distractor",
        ["formats a flush label"],
        ["pure string helper", "no journal accumulation or persistence"],
        "translate",
        ["symbol nearly mirrors task words without implementation"],
        {"flush": "label input", "result": "string"},
    ),
])


RECORDS.extend([
    judgement(
        "trade-consumer-004", "account-stream-rs", "src/partitioned_inbox.rs", "PartitionedInbox.handle", "Rust", "high",
        ["completed-message registry", "per-account mutex/condition lane", "strict sequence waiting", "cross-account independence", "handler-before-ack ordering", "failure releases lane without acknowledgement"],
        ["synchronous callbacks", "a known duplicate returns an outcome without calling the acknowledger", "sequence numbering starts at one"],
        "translate",
        ["duplicate deliveries need an outer acknowledgement adapter", "Condvar wait timeout semantics differ from promise queues"],
        {"TradeMessage": "StreamMessage", "processor": "handler closure", "broker ack": "acknowledge closure", "Promise<void>": "Result<DeliveryOutcome, InboxError>"},
    ),
    judgement(
        "trade-consumer-004", "ordered-events-py", "src/ordered_events/pump.py", "PartitionedEventPump", "Python", "high",
        ["message-id dedupe retention", "promise tail per account", "parallel independent account lanes", "processing and acknowledgement timeouts", "checkpoint sequence validation", "failure leaves message unacknowledged"],
        ["checkpoint commit occurs after broker acknowledgement", "duplicate fast paths return without invoking acknowledge", "Python asyncio runtime"],
        "bridge",
        ["a crash after ack but before checkpoint commit creates a dedupe gap", "bridge cancellation must preserve the lane gate finally block"],
        {"TradeMessage": "TradeEvent plus EventHeaders", "processor": "Processor", "broker ack": "Acknowledger", "completion": "ProcessOutcome"},
    ),
    judgement(
        "trade-consumer-004", "quote-fanout-go", "fanout/account_lane_worker.go", "AccountLaneWorker.Accept", "Go", "medium",
        ["per-account lock lanes", "message-id completion map", "duplicate acknowledgement", "cross-account concurrency", "handler failure rejection without ack", "sequence-gap rejection"],
        ["first sequence must be zero", "records completion after broker ack", "reject callback is part of the API", "Go context/error model"],
        "translate",
        ["process crash between acknowledgement and completion recording can replay the handler", "dedupe retention pruning needs a lifecycle hook"],
        {"TradeMessage": "AccountMessage", "processor": "AccountHandler", "acknowledge": "AccountMessage.Acknowledge", "failed delivery": "RejectDelivery"},
    ),
    judgement(
        "trade-consumer-004", "ledger-flow-ts", "src/ordered-message-pump.ts", "OrderedMessagePump.dispatch", "TypeScript", "medium",
        ["promise tail per account", "independent account maps", "completed-id dedupe", "handler-before-ack", "failure-safe lane release"],
        ["completed IDs are unbounded process memory", "sequence check rejects only regression, not gaps", "duplicates return without acknowledgement"],
        "wrap",
        ["duplicate redelivery may remain outstanding at the broker", "restart loses both dedupe and high-water state"],
        {"TradeMessage": "PumpMessage", "processor": "handler", "broker ack": "acknowledge(id)", "consume result": "processed or duplicate"},
    ),
    judgement(
        "trade-consumer-004", "signal-buffer-ts", "src/partition-runner.ts", "PartitionedSignalRunner.accept", "TypeScript", "medium",
        ["account-specific promise lanes", "cross-account concurrency", "message-id dedupe", "handler-before-ack ordering", "failed sequence observation"],
        ["dedupe set has no retention", "no explicit duplicate acknowledgement", "only monotonic rather than contiguous sequence enforcement"],
        "reuse",
        ["unbounded acknowledged IDs can grow indefinitely", "a gap can be accepted and hide missing account events"],
        {"TradeMessage": "TradeSignal", "processor": "handler", "ack": "acknowledge", "completion": "handled or duplicate"},
    ),
    judgement(
        "trade-consumer-004", "buffered-journal-rs", "src/executor.rs", "KeyedRecordExecutor.drive", "Rust", "medium",
        ["grouping and sorting per account", "parallel account waves", "remembered identities", "handler-before-ack", "failure blocks later same-account records", "input-order reports"],
        ["batch-oriented synchronous drive", "sorts by sequence instead of preserving broker arrival order", "duplicate identity includes account and sequence", "state is process-local"],
        "bridge",
        ["resorting can change source order when sequences collide", "thread-scoped execution is expensive behind a runtime bridge"],
        {"TradeMessage": "WorkItem", "processor": "RecordHandler", "ack": "RecordAcknowledger", "result": "LaneReport"},
    ),
    judgement(
        "trade-consumer-004", "resilient-pricing-py", "src/resilient_pricing/duplicate_stamp_book.py", "DuplicateStampBook.seen", "Python", "low",
        ["thread-safe message-id dedupe", "bounded least-recent identity retention"],
        ["no account lanes", "no processing or acknowledgement", "eviction is count-based rather than time-based"],
        "wrap",
        ["an evicted redelivery is treated as new", "does not prevent concurrent handlers for one account"],
        {"message id": "seen key", "duplicate": "boolean return", "processor": "not represented"},
    ),
    judgement(
        "trade-consumer-004", "ordered-events-py", "src/ordered_events/checkpoint.py", "CheckpointStore.commit", "Python", "low",
        ["per-account sequence high-water", "message identity at checkpoint", "atomic file replacement", "rewind/collision rejection"],
        ["storage primitive only", "no lanes, handler, or broker ack", "single asyncio lock serializes all accounts during commits"],
        "wrap",
        ["global checkpoint lock can reduce cross-account parallelism", "checkpoint persistence alone does not deduplicate in-flight delivery"],
        {"account": "checkpoint key", "sequence": "Checkpoint.sequence", "message id": "Checkpoint.message_id", "consume": "not represented"},
    ),
    judgement(
        "trade-consumer-004", "swift-cache-ts", "src/trade-event-label.ts", "TradeEventLabel.format", "TypeScript", "distractor",
        ["formats a trade-event identifier"],
        ["presentation/token operation", "no delivery processing, order, or ack"],
        "reuse",
        ["exact trade/event terms are lexical distractors"],
        {"TradeMessage": "label input", "result": "string"},
    ),
    judgement(
        "trade-consumer-004", "resilient-pricing-py", "src/resilient_pricing/account_order_sorter.py", "AccountOrderSorter.sort", "Python", "distractor",
        ["sorts records by account fields"],
        ["offline ordering utility", "no handler, dedupe, concurrency, or acknowledgement"],
        "translate",
        ["account/order vocabulary overstates relevance"],
        {"account order": "sorted rows", "consume": "not represented"},
    ),
    judgement(
        "trade-consumer-004", "circuit-lane-java", "src/main/java/synthetic/lane/ConsumerPriceIndex.java", "ConsumerPriceIndex.value", "Java", "distractor",
        ["computes a consumer index"],
        ["economic calculation unrelated to message consumers", "no event or account lane"],
        "translate",
        ["consumer is used in a completely different sense"],
        {"TradeMessage": "no mapping", "result": "BigDecimal index"},
    ),
    judgement(
        "trade-consumer-004", "quote-fanout-go", "fanout/message_digest.go", "MessageDigest.Sum", "Go", "distractor",
        ["hashes message identity and payload"],
        ["stateless integrity function", "does not decide duplicates or process/ack messages"],
        "translate",
        ["message terminology can look relevant despite no consumer behavior"],
        {"TradeMessage": "DigestMessage", "result": "digest string"},
    ),
    judgement(
        "trade-consumer-004", "account-stream-rs", "src/quote_token_parser.rs", "QuoteTokenParser.tokenize", "Rust", "distractor",
        ["tokenizes a textual command"],
        ["parser only", "no trade delivery or account concurrency"],
        "translate",
        ["repository account domain does not make every symbol relevant"],
        {"TradeMessage": "command text", "result": "tokens"},
    ),
    judgement(
        "trade-consumer-004", "signal-buffer-ts", "src/presentation.ts", "PresentationLabels.trade", "TypeScript", "distractor",
        ["formats a trade label"],
        ["presentation method", "no broker interaction"],
        "reuse",
        ["same-language symbol is semantically empty for consumption"],
        {"TradeMessage": "label fields", "result": "string"},
    ),
    judgement(
        "trade-consumer-004", "settlement-queue-py", "src/settlement_queue/formatting.py", "trade_receipt_formatter", "Python", "distractor",
        ["renders a trade receipt"],
        ["formatting only", "no message ordering, dedupe, or ack"],
        "translate",
        ["trade and receipt terms create a false positive"],
        {"TradeMessage": "format fields", "result": "receipt text"},
    ),
    judgement(
        "trade-consumer-004", "ordered-events-py", "src/ordered_events/formatting.py", "trade_event_caption", "Python", "distractor",
        ["creates a trade-event caption"],
        ["stateless text helper", "does not consume events"],
        "translate",
        ["located in the right repository but wrong module behavior"],
        {"TradeEvent": "caption input", "consume": "not represented"},
    ),
    judgement(
        "trade-consumer-004", "batch-reconcile-go", "src/reconcile/operations.go", "TradeEventChart.Add", "Go", "distractor",
        ["adds a numeric point to a trade-named chart"],
        ["bounded chart buffer only", "no messages, accounts, or acknowledgement"],
        "translate",
        ["TradeEvent type name is deliberately non-behavioral"],
        {"TradeMessage": "numeric chart value", "result": "chart length"},
    ),
    judgement(
        "trade-consumer-004", "buffered-journal-rs", "src/formatting.rs", "trade_event_title", "Rust", "distractor",
        ["formats a trade-event title"],
        ["pure string formatting", "no consumption lifecycle"],
        "translate",
        ["symbol shares the target nouns only"],
        {"TradeMessage": "title fields", "result": "string"},
    ),
])

RECORDS.extend([
    judgement(
        "provider-routing-003", "circuit-lane-java", "src/main/java/synthetic/lane/FallbackCircuitLane.java", "FallbackCircuitLane.acquire", "Java", "high",
        ["independent mutable state per provider", "ordered primary/backup execution", "open cooldown skip", "strict one-owner half-open probe", "successful probe recovery"],
        ["Supplier<String> rather than an async quote provider", "no request timeout", "failure classification is exception-agnostic"],
        "translate",
        ["blocking provider operations must be converted to promises", "clock and cooldown units must be mapped without truncation"],
        {"provider list": "ordered names", "provider fetch": "Supplier<String>", "Quote": "successful string value", "breaker snapshot": "ProviderStateView"},
    ),
    judgement(
        "provider-routing-003", "quote-fanout-go", "fanout/health_switch.go", "HealthSwitch.Select", "Go", "high",
        ["provider-local breaker map", "priority-ordered failover", "request deadlines", "open cooldown", "single in-flight half-open probe", "recovery and reset snapshots"],
        ["Go context/error API", "provider registrations are static", "non-retryable failures use configurable weight"],
        "translate",
        ["JavaScript error taxonomy must preserve retryability weighting", "canceled parent context currently stops later failover"],
        {"QuoteRequest": "fanout.QuoteRequest", "QuoteProvider": "fanout.QuoteProvider", "Promise<Quote>": "(Quote, error)", "provider breaker": "sourceCircuit"},
    ),
    judgement(
        "provider-routing-003", "resilient-pricing-py", "src/resilient_pricing/adaptive_source_lane.py", "AdaptiveSourceLane.request", "Python", "medium",
        ["source-local failure counters", "ordered fallback", "open cooldown", "single half-open probe flag", "success closes the source"],
        ["synchronous callbacks", "no per-request timeout", "catches BaseException", "untyped object response"],
        "bridge",
        ["thread bridge can serialize long provider calls", "catching process-control exceptions is too broad"],
        {"providers": "sequence of name/callable pairs", "fetchQuote": "request", "Quote": "object result", "breaker state": "source_health_report"},
    ),
    judgement(
        "provider-routing-003", "signal-buffer-ts", "src/health-channel.ts", "HealthAwareChannel.choose", "TypeScript", "medium",
        ["provider-local counters", "open-provider filtering", "cooldown eligibility", "one half-open selection flag", "latency-aware candidate ranking"],
        ["selection and execution are separate", "there is no success-recording method to close a recovered channel", "does not aggregate provider errors"],
        "wrap",
        ["a half-open channel can remain probeInFlight without an adapter completion hook", "ranking may choose a backup before the declared primary"],
        {"provider registrations": "candidate ids", "request time": "now", "failure completion": "recordFailure", "provider call": "external wrapper"},
    ),
    judgement(
        "provider-routing-003", "buffered-journal-rs", "src/replica.rs", "ReplicaSelector.route", "Rust", "medium",
        ["per-endpoint circuit records", "failure/success thresholds", "cooldown and probe ownership", "in-flight limits", "deadline-aware fallback invocation"],
        ["synchronous byte operation API", "endpoint policy is embedded in each ProviderEndpoint", "selector rotates equal candidates"],
        "bridge",
        ["runtime bridging can block Node worker threads", "rotation may conflict with strict primary-first semantics"],
        {"QuoteProvider": "ProviderEndpoint plus ProviderInvoker", "fetchQuote": "route operation", "Quote": "byte vector", "breaker state": "CircuitState"},
    ),
    judgement(
        "provider-routing-003", "swift-cache-ts", "src/failure-gauge.ts", "FailureGauge.rank", "TypeScript", "medium",
        ["independent provider observation grouping", "consecutive-failure tracking", "decayed health evidence", "latency and reliability ranking"],
        ["offline ranking only", "no open/half-open state", "does not invoke providers or perform failover"],
        "wrap",
        ["health score must not replace the target breaker state machine", "decay can hide a failure-threshold boundary"],
        {"provider failures": "ProviderSample outcomes", "provider state": "ProviderRank", "route choice": "rank order", "fetch": "not represented"},
    ),
    judgement(
        "provider-routing-003", "circuit-lane-java", "src/main/java/synthetic/lane/ProviderCatalog.java", "ProviderCatalog.order", "Java", "low",
        ["pair capability filtering", "region/latency/failure weighted ordering", "deterministic fallback list"],
        ["no circuit transitions", "no provider invocation", "failure input is supplied as aggregate counts"],
        "translate",
        ["ranking alone permits calls to providers that should be open"],
        {"provider registry": "ProviderDefinition", "QuoteRequest": "MarketModels.QuoteRequest", "fallback order": "returned list", "breaker": "not represented"},
    ),
    judgement(
        "provider-routing-003", "batch-reconcile-go", "src/reconcile/operations.go", "RankClearingRoutes", "Go", "low",
        ["route reliability and latency scoring", "deterministic route order"],
        ["aggregates historical observations", "no provider-local breaker state", "no live call or half-open probe"],
        "wrap",
        ["historical reliability cannot enforce an immediate circuit open"],
        {"provider": "RouteObservation.Provider", "candidate order": "RouteScore order", "fetchQuote": "not represented"},
    ),
    judgement(
        "provider-routing-003", "ledger-flow-ts", "src/route-code-parser.ts", "RouteCodeParser.parse", "TypeScript", "distractor",
        ["parses route-code syntax"],
        ["grammar parser only", "no providers, failures, or state transitions"],
        "reuse",
        ["route terminology is the only shared signal"],
        {"provider route": "parsed code", "Quote": "not produced"},
    ),
    judgement(
        "provider-routing-003", "resilient-pricing-py", "src/resilient_pricing/fetch_route_table.py", "FetchRouteTable.path", "Python", "distractor",
        ["returns a configured graph path"],
        ["static topology traversal", "does not fetch or track provider health"],
        "translate",
        ["fetch and route words are lexical rather than behavioral"],
        {"providers": "graph nodes", "result": "path tuple"},
    ),
    judgement(
        "provider-routing-003", "circuit-lane-java", "src/main/java/synthetic/lane/QuoteRouteFormatter.java", "QuoteRouteFormatter.format", "Java", "distractor",
        ["formats a quote route URI"],
        ["stateless codec", "no call execution or breaker state"],
        "translate",
        ["formatted hops can be mistaken for live failover"],
        {"QuoteRequest.pair": "route pair", "providers": "hop strings", "Quote": "not produced"},
    ),
    judgement(
        "provider-routing-003", "quote-fanout-go", "fanout/circuit_drawing.go", "CircuitDrawing.Render", "Go", "distractor",
        ["renders circuit mode labels"],
        ["presentation table only", "does not update or enforce breaker state"],
        "translate",
        ["circuit terminology is deliberately misleading"],
        {"breaker state": "CircuitNode input", "result": "drawing text"},
    ),
    judgement(
        "provider-routing-003", "account-stream-rs", "src/account_partitioner.rs", "AccountPartitioner.partition", "Rust", "distractor",
        ["chooses a partition for an account"],
        ["hash partitioning is unrelated to provider failover", "no quote or breaker behavior"],
        "translate",
        ["selection behavior alone is not routing resilience"],
        {"provider": "no mapping", "selection": "account partition index"},
    ),
    judgement(
        "provider-routing-003", "signal-buffer-ts", "src/presentation.ts", "PresentationLabels.provider", "TypeScript", "distractor",
        ["formats provider text"],
        ["presentation method only", "no failover state"],
        "reuse",
        ["provider naming creates a false positive"],
        {"provider": "label input", "Quote": "string output"},
    ),
    judgement(
        "provider-routing-003", "ordered-events-py", "src/ordered_events/formatting.py", "provider_labeler", "Python", "distractor",
        ["labels provider metadata"],
        ["stateless formatting", "no provider invocation or circuit"],
        "translate",
        ["provider term is not operational routing"],
        {"provider": "format argument", "result": "label"},
    ),
    judgement(
        "provider-routing-003", "settlement-queue-py", "src/settlement_queue/formatting.py", "provider_route_caption", "Python", "distractor",
        ["renders route caption text"],
        ["presentation helper", "no health observations or recovery"],
        "translate",
        ["route caption can rank highly by tokens only"],
        {"route": "caption fields", "fetchQuote": "not represented"},
    ),
    judgement(
        "provider-routing-003", "batch-reconcile-go", "src/reconcile/operations.go", "ProviderInvoiceRouter.Route", "Go", "distractor",
        ["selects a queue from an invoice prefix"],
        ["static string-prefix router", "no provider calls or circuit breaker"],
        "translate",
        ["Provider and Route appear in a financially unrelated utility"],
        {"provider": "invoice prefix", "route result": "queue string"},
    ),
    judgement(
        "provider-routing-003", "buffered-journal-rs", "src/formatting.rs", "provider_route_slug", "Rust", "distractor",
        ["creates a provider route slug"],
        ["pure formatting", "no primary/backup or half-open behavior"],
        "translate",
        ["symbol name closely resembles the requirement without semantics"],
        {"provider route": "text fields", "Quote": "not produced"},
    ),
])

RECORDS.extend([
    judgement(
        "batch-settlement-002", "ledger-flow-ts", "src/ordered-batch-committer.ts", "OrderedBatchCommitter.commit", "TypeScript", "high",
        ["batch fingerprint per idempotency key", "concurrent duplicate promise joining", "retry only unresolved or failed slots", "stable input-index output", "canonical receipt reuse"],
        ["process-local state only", "writer retry classification treats every thrown error as retryable"],
        "reuse",
        ["a process restart loses completed keys and receipts", "permanent business failures need explicit classification before retry"],
        {"SettlementInstruction": "SettlementItem", "SettlementResult": "SettlementOutcome", "batch key": "idempotencyKey", "settlement gateway": "writer callback"},
    ),
    judgement(
        "batch-settlement-002", "batch-reconcile-go", "src/reconcile/coordinator.go", "BatchCommitCoordinator.Reconcile", "Go", "high",
        ["batch-key fingerprint and in-flight joining", "bounded parallel item execution", "transient-only retry policy", "per-payment receipt gate", "position-indexed results and durable archive"],
        ["Go context/value-error API", "an archived terminal item failure is replayed rather than retried on a later batch call"],
        "translate",
        ["a transfer that succeeds before receipt persistence fails needs upstream idempotency", "archive and receipt store durability must match target lifetime"],
        {"SettlementInstruction": "reconcile.Payment", "SettlementResult": "reconcile.BatchEntry", "idempotency key": "CommitRequest.IdempotencyKey", "gateway": "TransferOperation"},
    ),
    judgement(
        "batch-settlement-002", "circuit-lane-java", "src/main/java/synthetic/lane/TransactionalBatch.java", "TransactionalBatch.apply", "Java", "medium",
        ["ordered result slots", "bounded per-item attempts", "batch fingerprint conflict detection", "receipt collision detection"],
        ["synchronizes the entire instance", "retries every RuntimeException", "stores failed outcomes as completed", "returns encoded failure strings"],
        "translate",
        ["whole-instance locking removes useful batch concurrency", "failure strings lose the target error type"],
        {"SettlementInstruction": "instruction string", "SettlementResult": "receipt or FAILED string", "gateway": "BiFunction item/attempt", "idempotency key": "apply key"},
    ),
    judgement(
        "batch-settlement-002", "account-stream-rs", "src/retrying_payout_book.rs", "RetryingPayoutBook.apply_batch", "Rust", "medium",
        ["same-key flight joining", "input-order result vector", "per-payout receipt reuse", "bounded item retries"],
        ["synchronous sequential gateway callback", "all errors are retried", "completed batches retain failed results", "mutex poison is surfaced as strings"],
        "translate",
        ["blocking Condvar semantics do not map directly to promises", "a replay cannot selectively retry a stored failed item"],
        {"SettlementInstruction": "Payout", "SettlementResult": "PayoutResult", "idempotency key": "key", "gateway": "operation closure"},
    ),
    judgement(
        "batch-settlement-002", "settlement-queue-py", "src/settlement_queue/engine.py", "QueuedPayoutEngine.execute_group", "Python", "medium",
        ["ordered asyncio.gather output", "bounded cross-item concurrency", "per-item idempotency leases", "receipt reuse", "attempt loop"],
        ["no batch-level idempotency fingerprint", "each item key is supplied externally", "gateway exception classification is embedded in reply handling"],
        "bridge",
        ["a Python runtime bridge complicates cancellation", "identity factory must be stable across batch replays"],
        {"SettlementInstruction": "PayoutIntent", "SettlementResult": "PayoutResult", "item key": "IdentityFactory result", "gateway": "async Gateway"},
    ),
    judgement(
        "batch-settlement-002", "signal-buffer-ts", "src/ordered-batch.ts", "OrderedBatchMap.collect", "TypeScript", "medium",
        ["one output per input ordinal", "parallel identities", "per-identity receipt reuse", "bounded retry loop"],
        ["no batch idempotency key or fingerprint", "duplicate input identities share one outcome", "all failures are retryable", "state is process-local"],
        "wrap",
        ["target duplicate-key boundary may require rejection instead of shared output", "receipt cache can collide across unrelated batches"],
        {"SettlementInstruction": "SettlementIntent", "SettlementResult": "SettlementOutcome", "gateway": "BatchWorker", "batch key": "not represented"},
    ),
    judgement(
        "batch-settlement-002", "resilient-pricing-py", "src/resilient_pricing/receipt_registry.py", "ReceiptRegistry.reserve", "Python", "low",
        ["idempotency-key receipt reuse", "cross-key receipt collision prevention", "thread-safe reservation"],
        ["single receipt at a time", "no batch ordering or retries", "reservation happens after a receipt is proposed"],
        "wrap",
        ["using only this registry leaves partial failure orchestration absent"],
        {"instruction idempotency key": "reserve key", "Receipt": "proposed_receipt", "batch": "not represented"},
    ),
    judgement(
        "batch-settlement-002", "settlement-queue-py", "src/settlement_queue/ledger.py", "ReceiptLedger.reserve", "Python", "low",
        ["leased idempotency reservation", "existing receipt replay", "owner/version conflict checks"],
        ["per-item primitive only", "no result ordering, retry loop, or batch fingerprint"],
        "bridge",
        ["lease expiry can permit a second worker while the first gateway call is still alive"],
        {"instruction key": "reservation key", "receipt replay": "existing DeliveryReceipt", "batch results": "not represented"},
    ),
    judgement(
        "batch-settlement-002", "swift-cache-ts", "src/settlement-date-table.ts", "SettlementDateTable.adjust", "TypeScript", "distractor",
        ["calculates a settlement date"],
        ["calendar calculation only", "does not execute a batch or issue receipts"],
        "reuse",
        ["settlement vocabulary is not settlement execution behavior"],
        {"SettlementInstruction": "date input", "SettlementResult": "adjusted date"},
    ),
    judgement(
        "batch-settlement-002", "resilient-pricing-py", "src/resilient_pricing/batch_name_resolver.py", "BatchNameResolver.resolve", "Python", "distractor",
        ["normalizes a batch name"],
        ["identifier grammar helper", "no item execution, retry, or receipt state"],
        "translate",
        ["batch in the symbol name is a lexical false positive"],
        {"batch key": "name string", "SettlementResult": "not produced"},
    ),
    judgement(
        "batch-settlement-002", "circuit-lane-java", "src/main/java/synthetic/lane/ReceiptPrinter.java", "ReceiptPrinter.print", "Java", "distractor",
        ["renders an existing settlement result"],
        ["presentation/signature operation only", "does not create a receipt through settlement"],
        "translate",
        ["receipt naming can be confused with receipt uniqueness"],
        {"SettlementResult": "printer input", "output": "signed text"},
    ),
    judgement(
        "batch-settlement-002", "quote-fanout-go", "fanout/batch_window_sizer.go", "BatchWindowSizer.Size", "Go", "distractor",
        ["chooses a numeric batch size"],
        ["capacity arithmetic only", "no settlements, item retries, keys, or receipts"],
        "translate",
        ["shared batch terminology is non-behavioral"],
        {"input batch": "BatchWindowInput metrics", "result": "BatchWindow capacity"},
    ),
    judgement(
        "batch-settlement-002", "account-stream-rs", "src/receipt_codec.rs", "ReceiptCodec.encode", "Rust", "distractor",
        ["encodes an already-created receipt envelope"],
        ["binary codec only", "no idempotency or gateway execution"],
        "translate",
        ["receipt-shaped output does not prevent duplicate creation"],
        {"Receipt": "ReceiptEnvelope", "SettlementInstruction": "not accepted"},
    ),
    judgement(
        "batch-settlement-002", "signal-buffer-ts", "src/presentation.ts", "PresentationLabels.settlement", "TypeScript", "distractor",
        ["formats a settlement label"],
        ["stateless presentation method", "no batch processing"],
        "reuse",
        ["same-language symbol is behaviorally unrelated"],
        {"SettlementInstruction": "label fields", "SettlementResult": "string"},
    ),
    judgement(
        "batch-settlement-002", "settlement-queue-py", "src/settlement_queue/formatting.py", "settlement_queue_name", "Python", "distractor",
        ["builds a queue name"],
        ["naming helper only", "no payout execution or ordered results"],
        "translate",
        ["repository domain can inflate lexical relevance"],
        {"batch key": "formatting input", "result": "queue-name string"},
    ),
    judgement(
        "batch-settlement-002", "ordered-events-py", "src/ordered_events/formatting.py", "settlement_topic_parser", "Python", "distractor",
        ["parses settlement topic text"],
        ["message-topic grammar only", "does not settle instructions"],
        "translate",
        ["settlement term occurs in an unrelated transport label"],
        {"SettlementInstruction": "not represented", "input": "topic string"},
    ),
    judgement(
        "batch-settlement-002", "durable-audit-java", "src/main/java/synthetic/durableaudit/AuditBatch.java", "AuditBatch.calculateChecksum", "Java", "distractor",
        ["calculates integrity for an audit batch"],
        ["audit hashing only", "no settlement retry or receipt generation"],
        "translate",
        ["batch type is from another domain"],
        {"settlement batch": "no mapping", "output": "audit checksum"},
    ),
    judgement(
        "batch-settlement-002", "buffered-journal-rs", "src/formatting.rs", "settlement_banner", "Rust", "distractor",
        ["renders settlement-themed text"],
        ["pure formatting", "no item state or idempotency"],
        "translate",
        ["banner naming is deliberately similar"],
        {"SettlementResult": "caption fields", "output": "string"},
    ),
])


if __name__ == "__main__":
    main()
