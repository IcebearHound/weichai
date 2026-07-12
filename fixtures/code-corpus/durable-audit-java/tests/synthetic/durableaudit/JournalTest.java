package synthetic.durableaudit;

import java.io.IOException;
import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Properties;

final class JournalTest {
    static int run() throws Exception {
        int before = TestSupport.assertions();
        writesRecoversAndReopens();
        sealsEventsBeforePersistence();
        rotatesAtConfiguredCapacity();
        inspectsSegmentsAndOffsets();
        truncatesPartialFinalTail();
        truncatesCorruptFinalFrame();
        rejectsCorruptionInSealedSegment();
        rejectsMissingSegmentSequence();
        repairsInvalidCheckpointThroughRecovery();
        validatesBatchNumberAndFrameCapacity();
        synchronizesAndClosesIdempotently();
        handlesEmptyJournal();
        parsesSegmentNamesStrictly();
        checkpointTracksLatestCommit();
        return TestSupport.assertions() - before;
    }

    private static void writesRecoversAndReopens() throws Exception {
        Path directory = TestSupport.temporaryDirectory("journal-basic");
        LedgerCodec codec = new LedgerCodec();
        MutableClock clock = new MutableClock(TestSupport.BASE);
        try {
            List<WriteReceipt> receipts = new ArrayList<>();
            try (SegmentJournal journal = new SegmentJournal(directory, 256 * 1024, codec, clock)) {
                for (int number = 0; number < 8; number++) {
                    clock.advance(Duration.ofMillis(10));
                    receipts.add(journal.write(TestSupport.batch(number, number % 4 + 1)));
                }
                journal.sync();
                TestSupport.equal(8L, journal.nextBatchNumber(), "next number should advance after writes");
                TestSupport.equal(8, journal.recover().size(), "live recovery should find every batch");
            }
            TestSupport.equal(List.of(0L, 1L, 2L, 3L, 4L, 5L, 6L, 7L), receipts.stream().map(WriteReceipt::batchNumber).toList(), "receipts should preserve number order");
            TestSupport.check(receipts.stream().allMatch(receipt -> receipt.digest().matches("[0-9a-f]{64}")), "receipts should contain SHA-256 hex");
            try (SegmentJournal reopened = new SegmentJournal(directory, 256 * 1024, codec, clock)) {
                List<AuditBatch> recovered = reopened.recover();
                TestSupport.equal(8, recovered.size(), "reopened journal should recover all batches");
                TestSupport.equal(7L, recovered.get(7).batchNumber(), "last recovered number should match");
                WriteReceipt next = reopened.write(TestSupport.batch(8, 2));
                TestSupport.equal(8L, next.batchNumber(), "write should continue recovered numbering");
            }
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    private static void sealsEventsBeforePersistence() throws Exception {
        Path directory = TestSupport.temporaryDirectory("journal-sealed");
        try {
            AuditEvent laterTenant = TestSupport.event("tenant-z", "account:2", 1);
            AuditEvent laterSubject = TestSupport.event("tenant-a", "account:9", 1);
            AuditEvent first = TestSupport.event("tenant-a", "account:1", 2);
            AuditEvent earliestSequence = TestSupport.event("tenant-a", "account:1", 1);
            AuditBatch unordered = new AuditBatch(0, TestSupport.BASE, List.of(laterTenant, laterSubject, first, earliestSequence));
            try (SegmentJournal journal = new SegmentJournal(directory, 64 * 1024, new LedgerCodec(), new MutableClock(TestSupport.BASE))) {
                journal.write(unordered);
                AuditBatch recovered = journal.recover().get(0);
                TestSupport.equal(List.of(earliestSequence, first, laterSubject, laterTenant), recovered.events(), "journal should persist sealed deterministic order");
                TestSupport.check(!unordered.events().equals(recovered.events()), "requested collection should remain unchanged");
            }
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    private static AuditBatch largeBatch(long number, int events, int fields) {
        List<AuditEvent> rows = new ArrayList<>();
        for (int index = 0; index < events; index++) {
            rows.add(TestSupport.event(
                    "large" + (index % 3),
                    "account:" + index,
                    number * 100 + index,
                    TestSupport.BASE.plusSeconds(number),
                    Severity.NOTICE,
                    "USD",
                    BigDecimal.valueOf(number + index + 1),
                    TestSupport.attributes(fields, 480)));
        }
        return new AuditBatch(number, TestSupport.BASE.plusSeconds(number), rows);
    }

    private static void rotatesAtConfiguredCapacity() throws Exception {
        Path directory = TestSupport.temporaryDirectory("journal-rotate");
        try {
            List<WriteReceipt> receipts = new ArrayList<>();
            try (SegmentJournal journal = new SegmentJournal(directory, 64 * 1024, new LedgerCodec(), new MutableClock(TestSupport.BASE))) {
                for (int number = 0; number < 12; number++) {
                    receipts.add(journal.write(largeBatch(number, 1, 28)));
                }
                TestSupport.check(journal.currentSegmentNumber() >= 2, "large frames should rotate across segments");
                List<SegmentInfo> segments = journal.inspectSegments();
                TestSupport.equal(journal.currentSegmentNumber() + 1, (long) segments.size(), "segment numbers should be contiguous");
                TestSupport.check(segments.stream().allMatch(info -> info.bytes() <= 64 * 1024), "segments should stay within configured capacity");
                TestSupport.equal(12, segments.stream().mapToInt(SegmentInfo::batches).sum(), "rotation should retain all batches");
                TestSupport.equal(12, journal.recover().size(), "rotated journal should recover all batches");
            }
            for (int index = 1; index < receipts.size(); index++) {
                WriteReceipt previous = receipts.get(index - 1);
                WriteReceipt current = receipts.get(index);
                if (current.segmentNumber() == previous.segmentNumber()) {
                    TestSupport.equal(previous.byteOffset() + previous.encodedBytes(), current.byteOffset(), "same segment offsets should be contiguous");
                } else {
                    TestSupport.equal(0L, current.byteOffset(), "rotated segment should start at zero");
                }
            }
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    private static void inspectsSegmentsAndOffsets() throws Exception {
        Path directory = TestSupport.temporaryDirectory("journal-inspect");
        try {
            try (SegmentJournal journal = new SegmentJournal(directory, 256 * 1024, new LedgerCodec(), new MutableClock(TestSupport.BASE))) {
                for (int number = 0; number < 5; number++) {
                    journal.write(TestSupport.batch(number, number + 1));
                }
                List<SegmentInfo> segments = journal.inspectSegments();
                TestSupport.equal(1, segments.size(), "small batches should share one segment");
                SegmentInfo info = segments.get(0);
                TestSupport.equal(0L, info.number(), "first segment number should be zero");
                TestSupport.equal(5, info.batches(), "inspection should count batches");
                TestSupport.equal(15, info.events(), "inspection should count events");
                TestSupport.equal(0L, info.firstBatch(), "inspection should expose first batch");
                TestSupport.equal(4L, info.lastBatch(), "inspection should expose last batch");
                TestSupport.equal(TestSupport.BASE, info.earliest(), "inspection should expose earliest creation");
                TestSupport.equal(TestSupport.BASE.plusSeconds(4), info.latest(), "inspection should expose latest creation");
                Map<Long, Long> offsets = journal.batchOffsets(info.path());
                TestSupport.equal(List.of(0L, 1L, 2L, 3L, 4L), List.copyOf(offsets.keySet()), "offset map should preserve batch order");
                TestSupport.equal(0L, offsets.get(0L), "first frame offset should be zero");
                TestSupport.check(offsets.get(4L) > offsets.get(3L), "later batch offset should increase");
            }
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    private static void truncatesPartialFinalTail() throws Exception {
        Path directory = TestSupport.temporaryDirectory("journal-partial-tail");
        Path segment;
        long validSize;
        try {
            try (SegmentJournal journal = new SegmentJournal(directory, 128 * 1024, new LedgerCodec(), new MutableClock(TestSupport.BASE))) {
                journal.write(TestSupport.batch(0, 2));
                journal.write(TestSupport.batch(1, 3));
                segment = journal.inspectSegments().get(0).path();
                validSize = Files.size(segment);
            }
            Files.write(segment, new byte[] {1, 2, 3, 4, 5, 6, 7, 8, 9}, StandardOpenOption.APPEND);
            TestSupport.equal(validSize + 9, Files.size(segment), "fixture should append partial bytes");
            try (SegmentJournal recovered = new SegmentJournal(directory, 128 * 1024, new LedgerCodec(), new MutableClock(TestSupport.BASE))) {
                List<AuditBatch> batches = recovered.recover();
                TestSupport.equal(2, batches.size(), "valid frames before partial tail should survive");
                TestSupport.equal(validSize, Files.size(segment), "recovery should truncate partial tail");
                TestSupport.equal(2L, recovered.nextBatchNumber(), "recovery should restore next batch number");
            }
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    private static void truncatesCorruptFinalFrame() throws Exception {
        Path directory = TestSupport.temporaryDirectory("journal-corrupt-tail");
        try {
            Path segment;
            long firstFrameEnd;
            try (SegmentJournal journal = new SegmentJournal(directory, 256 * 1024, new LedgerCodec(), new MutableClock(TestSupport.BASE))) {
                WriteReceipt first = journal.write(TestSupport.batch(0, 2));
                journal.write(TestSupport.batch(1, 2));
                segment = journal.inspectSegments().get(0).path();
                firstFrameEnd = first.encodedBytes();
            }
            byte[] bytes = Files.readAllBytes(segment);
            bytes[(int) firstFrameEnd + 20] ^= 0x42;
            Files.write(segment, bytes, StandardOpenOption.TRUNCATE_EXISTING);
            try (SegmentJournal recovered = new SegmentJournal(directory, 256 * 1024, new LedgerCodec(), new MutableClock(TestSupport.BASE))) {
                List<AuditBatch> batches = recovered.recover();
                TestSupport.equal(1, batches.size(), "corrupt final frame should be discarded");
                TestSupport.equal(firstFrameEnd, Files.size(segment), "journal should truncate to previous frame");
                WriteReceipt replacement = recovered.write(TestSupport.batch(1, 1));
                TestSupport.equal(1L, replacement.batchNumber(), "discarded batch number should be reusable");
            }
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    private static void rejectsCorruptionInSealedSegment() throws Exception {
        Path directory = TestSupport.temporaryDirectory("journal-sealed-corruption");
        try {
            List<SegmentInfo> segments;
            try (SegmentJournal journal = new SegmentJournal(directory, 64 * 1024, new LedgerCodec(), new MutableClock(TestSupport.BASE))) {
                for (int number = 0; number < 9; number++) {
                    journal.write(largeBatch(number, 1, 30));
                }
                segments = journal.inspectSegments();
                TestSupport.check(segments.size() >= 2, "fixture should create sealed segment");
            }
            Path sealed = segments.get(0).path();
            byte[] bytes = Files.readAllBytes(sealed);
            bytes[24] ^= 0x11;
            Files.write(sealed, bytes, StandardOpenOption.TRUNCATE_EXISTING);
            try (SegmentJournal journal = new SegmentJournal(directory, 64 * 1024, new LedgerCodec(), new MutableClock(TestSupport.BASE))) {
                IOException failure = TestSupport.expectThrows(IOException.class, journal::recover, "sealed segment corruption should fail recovery");
                TestSupport.check(failure.getMessage().contains("corruption in sealed segment"), "failure should identify sealed segment");
            }
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    private static void rejectsMissingSegmentSequence() throws Exception {
        Path directory = TestSupport.temporaryDirectory("journal-missing-segment");
        try {
            List<SegmentInfo> segments;
            try (SegmentJournal journal = new SegmentJournal(directory, 64 * 1024, new LedgerCodec(), new MutableClock(TestSupport.BASE))) {
                for (int number = 0; number < 14; number++) {
                    journal.write(largeBatch(number, 1, 30));
                }
                segments = journal.inspectSegments();
                TestSupport.check(segments.size() >= 3, "fixture should create at least three segments");
            }
            Files.delete(segments.get(1).path());
            IOException failure = TestSupport.expectThrows(IOException.class, () -> new SegmentJournal(directory, 64 * 1024, new LedgerCodec(), new MutableClock(TestSupport.BASE)), "missing middle segment should fail construction");
            TestSupport.check(failure.getMessage().contains("missing segment 1"), "failure should identify missing ordinal");
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    private static void repairsInvalidCheckpointThroughRecovery() throws Exception {
        Path directory = TestSupport.temporaryDirectory("journal-checkpoint-repair");
        try {
            try (SegmentJournal journal = new SegmentJournal(directory, 256 * 1024, new LedgerCodec(), new MutableClock(TestSupport.BASE))) {
                for (int number = 0; number < 4; number++) {
                    journal.write(TestSupport.batch(number, 2));
                }
            }
            Path checkpoint = directory.resolve("checkpoint.properties");
            Files.writeString(checkpoint, "segment=broken\noffset=-4\nnextBatch=wrong\ndigest=nope\ntoken=bad\n");
            try (SegmentJournal reopened = new SegmentJournal(directory, 256 * 1024, new LedgerCodec(), new MutableClock(TestSupport.BASE))) {
                TestSupport.equal(0L, reopened.nextBatchNumber(), "invalid checkpoint should not be trusted before scan");
                TestSupport.equal(4, reopened.recover().size(), "full scan should recover data without checkpoint");
                TestSupport.equal(4L, reopened.nextBatchNumber(), "full scan should repair next number");
                Properties repaired = new Properties();
                try (var input = Files.newInputStream(checkpoint)) {
                    repaired.load(input);
                }
                TestSupport.equal("4", repaired.getProperty("nextBatch"), "recovery should rewrite next batch");
                TestSupport.check(new HashChain(new LedgerCodec()).validateCheckpoint(repaired.getProperty("token")), "repaired checkpoint token should validate");
            }
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    private static void validatesBatchNumberAndFrameCapacity() throws Exception {
        Path directory = TestSupport.temporaryDirectory("journal-validation");
        try (SegmentJournal journal = new SegmentJournal(directory, 64 * 1024, new LedgerCodec(), new MutableClock(TestSupport.BASE))) {
            IOException wrong = TestSupport.expectThrows(IOException.class, () -> journal.write(TestSupport.batch(1, 1)), "journal should require next batch number");
            TestSupport.check(wrong.getMessage().contains("expected batch 0"), "number error should describe expectation");
            AuditBatch oversized = largeBatch(0, 4, 40);
            IOException large = TestSupport.expectThrows(IOException.class, () -> journal.write(oversized), "frame exceeding segment should fail");
            TestSupport.check(large.getMessage().contains("exceeds segment capacity"), "capacity error should be explicit");
            TestSupport.equal(0L, journal.nextBatchNumber(), "failed writes should not advance number");
            WriteReceipt valid = journal.write(TestSupport.batch(0, 1));
            TestSupport.equal(0L, valid.batchNumber(), "valid write should still succeed after failures");
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    private static void synchronizesAndClosesIdempotently() throws Exception {
        Path directory = TestSupport.temporaryDirectory("journal-close");
        SegmentJournal journal = new SegmentJournal(directory, 64 * 1024, new LedgerCodec(), new MutableClock(TestSupport.BASE));
        try {
            journal.write(TestSupport.batch(0, 1));
            journal.sync();
            journal.sync();
            journal.close();
            journal.close();
            TestSupport.expectThrows(IOException.class, () -> journal.write(TestSupport.batch(1, 1)), "write after close should fail");
            TestSupport.expectThrows(IOException.class, journal::recover, "recover after close should fail");
            TestSupport.expectThrows(IOException.class, journal::sync, "sync after close should fail");
        } finally {
            journal.close();
            TestSupport.deleteTree(directory);
        }
    }

    private static void handlesEmptyJournal() throws Exception {
        Path directory = TestSupport.temporaryDirectory("journal-empty");
        try (SegmentJournal journal = new SegmentJournal(directory, 64 * 1024, new LedgerCodec(), new MutableClock(TestSupport.BASE))) {
            TestSupport.equal(List.of(), journal.recover(), "empty journal should recover no batches");
            List<SegmentInfo> segments = journal.inspectSegments();
            TestSupport.equal(1, segments.size(), "empty journal should own current segment");
            TestSupport.check(segments.get(0).empty(), "current empty segment should report empty");
            TestSupport.equal(-1L, segments.get(0).firstBatch(), "empty segment first batch should be sentinel");
            TestSupport.equal(0L, segments.get(0).bytes(), "empty segment should have zero bytes");
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    private static void parsesSegmentNamesStrictly() throws Exception {
        Path directory = TestSupport.temporaryDirectory("journal-names");
        try (SegmentJournal journal = new SegmentJournal(directory, 64 * 1024, new LedgerCodec(), new MutableClock(TestSupport.BASE))) {
            TestSupport.equal(7L, journal.parseSegmentNumber(Path.of("audit-00000007.ledger")), "padded segment should parse");
            TestSupport.equal(directory.resolve("audit-00000012.ledger"), journal.segmentPath(12), "segment path should be padded");
            for (Path invalid : List.of(Path.of("segment-1.ledger"), Path.of("audit-one.ledger"), Path.of("audit-0001.log"))) {
                TestSupport.expectThrows(IllegalArgumentException.class, () -> journal.parseSegmentNumber(invalid), "invalid segment name should fail");
            }
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    private static void checkpointTracksLatestCommit() throws Exception {
        Path directory = TestSupport.temporaryDirectory("journal-checkpoint");
        try (SegmentJournal journal = new SegmentJournal(directory, 128 * 1024, new LedgerCodec(), new MutableClock(TestSupport.BASE))) {
            WriteReceipt first = journal.write(TestSupport.batch(0, 1));
            WriteReceipt second = journal.write(TestSupport.batch(1, 2));
            Properties properties = new Properties();
            try (var input = Files.newInputStream(directory.resolve("checkpoint.properties"))) {
                properties.load(input);
            }
            TestSupport.equal(Long.toString(second.segmentNumber()), properties.getProperty("segment"), "checkpoint should store segment");
            TestSupport.equal(Long.toString(second.byteOffset() + second.encodedBytes()), properties.getProperty("offset"), "checkpoint should store tail offset");
            TestSupport.equal("2", properties.getProperty("nextBatch"), "checkpoint should store next number");
            TestSupport.equal(second.digest(), properties.getProperty("digest"), "checkpoint should store final digest");
            TestSupport.check(new HashChain(new LedgerCodec()).validateCheckpoint(properties.getProperty("token")), "checkpoint signature should validate");
            TestSupport.check(second.byteOffset() >= first.encodedBytes(), "second receipt offset should follow first frame");
        } finally {
            TestSupport.deleteTree(directory);
        }
    }
}
