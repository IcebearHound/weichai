package synthetic.durableaudit;

import java.io.EOFException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Properties;
import java.util.concurrent.locks.ReentrantLock;

public final class SegmentJournal implements BatchWriter {
    private static final String PREFIX = "audit-";
    private static final String SUFFIX = ".ledger";
    private static final String CHECKPOINT = "checkpoint.properties";
    private final Path directory;
    private final long maximumSegmentBytes;
    private final LedgerCodec codec;
    private final HashChain chain;
    private final Clock clock;
    private final ReentrantLock ioLock = new ReentrantLock();
    private FileChannel channel;
    private long segmentNumber;
    private long segmentOffset;
    private long nextBatchNumber;
    private byte[] previousDigest;
    private boolean closed;

    public SegmentJournal(Path directory, long maximumSegmentBytes, LedgerCodec codec, Clock clock) throws IOException {
        this.directory = Objects.requireNonNull(directory, "directory").toAbsolutePath().normalize();
        if (maximumSegmentBytes < 64 * 1024) {
            throw new IllegalArgumentException("maximumSegmentBytes must be at least 64 KiB");
        }
        this.maximumSegmentBytes = maximumSegmentBytes;
        this.codec = Objects.requireNonNull(codec, "codec");
        this.chain = new HashChain(codec);
        this.clock = Objects.requireNonNull(clock, "clock");
        Files.createDirectories(this.directory);
        restorePosition();
        openCurrentSegment();
    }

    @Override
    public WriteReceipt write(AuditBatch requested) throws IOException {
        Objects.requireNonNull(requested, "requested");
        ioLock.lock();
        try {
            ensureOpen();
            if (requested.batchNumber() != nextBatchNumber) {
                throw new IOException("expected batch " + nextBatchNumber + " but received " + requested.batchNumber());
            }
            AuditBatch batch = requested.sealed();
            byte[] frame = codec.encode(batch, previousDigest);
            if (frame.length > maximumSegmentBytes) {
                throw new IOException("single frame exceeds segment capacity");
            }
            if (segmentOffset > 0 && segmentOffset + frame.length > maximumSegmentBytes) {
                rotateSegment();
            }
            long offset = segmentOffset;
            writeFully(channel, ByteBuffer.wrap(frame), offset);
            channel.force(false);
            byte[] digest = chain.append(batch, previousDigest);
            segmentOffset += frame.length;
            nextBatchNumber += 1;
            previousDigest = digest;
            storeCheckpoint();
            return new WriteReceipt(
                    batch.batchNumber(),
                    segmentNumber,
                    offset,
                    batch.events().size(),
                    frame.length,
                    clock.instant(),
                    HexFormat.of().formatHex(digest));
        } finally {
            ioLock.unlock();
        }
    }

    @Override
    public List<AuditBatch> recover() throws IOException {
        ioLock.lock();
        try {
            ensureOpen();
            List<Path> segments = listSegments();
            List<AuditBatch> batches = new ArrayList<>();
            List<byte[]> frames = new ArrayList<>();
            long expectedNumber = 0;
            for (int segmentIndex = 0; segmentIndex < segments.size(); segmentIndex++) {
                Path path = segments.get(segmentIndex);
                byte[] bytes = Files.readAllBytes(path);
                int validLength = codec.findLastCompleteOffset(bytes);
                boolean finalSegment = segmentIndex + 1 == segments.size();
                if (validLength != bytes.length) {
                    if (!finalSegment) {
                        throw new IOException("corruption in sealed segment " + path.getFileName());
                    }
                    truncateTail(path, validLength);
                    bytes = Arrays.copyOf(bytes, validLength);
                }
                for (byte[] frame : codec.splitFrames(bytes)) {
                    AuditBatch batch = codec.decode(frame);
                    if (batch.batchNumber() != expectedNumber) {
                        throw new IOException("batch numbering gap at " + path.getFileName());
                    }
                    batches.add(batch);
                    frames.add(frame);
                    expectedNumber += 1;
                }
            }
            Verification verification = chain.verify(frames);
            if (!verification.valid()) {
                throw new IOException("hash-chain verification failed: " + String.join("; ", verification.faults()));
            }
            nextBatchNumber = expectedNumber;
            previousDigest = verification.digestCopy();
            if (segments.isEmpty()) {
                segmentNumber = 0;
                segmentOffset = 0;
            } else {
                segmentNumber = parseSegmentNumber(segments.get(segments.size() - 1));
                segmentOffset = Files.size(segments.get(segments.size() - 1));
            }
            reopenAtRecoveredPosition();
            storeCheckpoint();
            return List.copyOf(batches);
        } finally {
            ioLock.unlock();
        }
    }

    @Override
    public void sync() throws IOException {
        ioLock.lock();
        try {
            ensureOpen();
            channel.force(true);
            storeCheckpoint();
        } finally {
            ioLock.unlock();
        }
    }

    @Override
    public void close() throws IOException {
        ioLock.lock();
        try {
            if (closed) {
                return;
            }
            closed = true;
            IOException failure = null;
            try {
                channel.force(true);
            } catch (IOException syncFailure) {
                failure = syncFailure;
            }
            try {
                channel.close();
            } catch (IOException closeFailure) {
                if (failure == null) {
                    failure = closeFailure;
                } else {
                    failure.addSuppressed(closeFailure);
                }
            }
            if (failure != null) {
                throw failure;
            }
        } finally {
            ioLock.unlock();
        }
    }

    long nextBatchNumber() {
        ioLock.lock();
        try {
            return nextBatchNumber;
        } finally {
            ioLock.unlock();
        }
    }

    long currentSegmentNumber() {
        ioLock.lock();
        try {
            return segmentNumber;
        } finally {
            ioLock.unlock();
        }
    }

    List<SegmentInfo> inspectSegments() throws IOException {
        ioLock.lock();
        try {
            List<SegmentInfo> result = new ArrayList<>();
            for (Path segment : listSegments()) {
                byte[] bytes = Files.readAllBytes(segment);
                List<byte[]> frames = codec.splitFrames(bytes);
                long first = -1;
                long last = -1;
                int events = 0;
                Instant earliest = null;
                Instant latest = null;
                for (byte[] frame : frames) {
                    AuditBatch batch = codec.decode(frame);
                    if (first < 0) {
                        first = batch.batchNumber();
                    }
                    last = batch.batchNumber();
                    events += batch.events().size();
                    if (earliest == null || batch.createdAt().isBefore(earliest)) {
                        earliest = batch.createdAt();
                    }
                    if (latest == null || batch.createdAt().isAfter(latest)) {
                        latest = batch.createdAt();
                    }
                }
                result.add(new SegmentInfo(
                        parseSegmentNumber(segment),
                        segment,
                        bytes.length,
                        frames.size(),
                        events,
                        first,
                        last,
                        earliest,
                        latest));
            }
            return List.copyOf(result);
        } finally {
            ioLock.unlock();
        }
    }

    Map<Long, Long> batchOffsets(Path segment) throws IOException {
        byte[] bytes = Files.readAllBytes(segment);
        Map<Long, Long> offsets = new LinkedHashMap<>();
        int position = 0;
        for (byte[] frame : codec.splitFrames(bytes)) {
            AuditBatch batch = codec.decode(frame);
            offsets.put(batch.batchNumber(), (long) position);
            position += frame.length;
        }
        return offsets;
    }

    void restorePosition() throws IOException {
        List<Path> segments = listSegments();
        if (segments.isEmpty()) {
            segmentNumber = 0;
            segmentOffset = 0;
            nextBatchNumber = 0;
            previousDigest = chain.genesis();
            return;
        }
        Optional<CheckpointState> checkpoint = readCheckpoint();
        if (checkpoint.isPresent() && checkpoint.get().matches(segments)) {
            CheckpointState state = checkpoint.get();
            segmentNumber = state.segmentNumber;
            segmentOffset = state.segmentOffset;
            nextBatchNumber = state.nextBatchNumber;
            previousDigest = state.digest;
            Path last = segments.get(segments.size() - 1);
            if (Files.size(last) == segmentOffset) {
                return;
            }
        }
        segmentNumber = parseSegmentNumber(segments.get(segments.size() - 1));
        segmentOffset = Files.size(segments.get(segments.size() - 1));
        nextBatchNumber = 0;
        previousDigest = chain.genesis();
    }

    Optional<CheckpointState> readCheckpoint() {
        Path checkpoint = directory.resolve(CHECKPOINT);
        if (!Files.isRegularFile(checkpoint)) {
            return Optional.empty();
        }
        Properties properties = new Properties();
        try (var input = Files.newInputStream(checkpoint)) {
            properties.load(input);
            long segment = Long.parseLong(properties.getProperty("segment"));
            long offset = Long.parseLong(properties.getProperty("offset"));
            long nextBatch = Long.parseLong(properties.getProperty("nextBatch"));
            byte[] digest = HexFormat.of().parseHex(properties.getProperty("digest"));
            String token = properties.getProperty("token");
            if (digest.length != 32 || !chain.validateCheckpoint(token)) {
                return Optional.empty();
            }
            return Optional.of(new CheckpointState(segment, offset, nextBatch, digest));
        } catch (IOException | IllegalArgumentException invalid) {
            return Optional.empty();
        }
    }

    void storeCheckpoint() throws IOException {
        Path temporary = directory.resolve(CHECKPOINT + ".tmp");
        Path destination = directory.resolve(CHECKPOINT);
        Properties properties = new Properties();
        properties.setProperty("segment", Long.toString(segmentNumber));
        properties.setProperty("offset", Long.toString(segmentOffset));
        properties.setProperty("nextBatch", Long.toString(nextBatchNumber));
        properties.setProperty("digest", HexFormat.of().formatHex(previousDigest));
        properties.setProperty("token", chain.checkpointToken(segmentNumber, segmentOffset, previousDigest));
        try (var output = Files.newOutputStream(
                temporary,
                StandardOpenOption.CREATE,
                StandardOpenOption.TRUNCATE_EXISTING,
                StandardOpenOption.WRITE)) {
            properties.store(output, "durable audit checkpoint");
        }
        try (FileChannel checkpoint = FileChannel.open(temporary, StandardOpenOption.WRITE)) {
            checkpoint.force(true);
        }
        try {
            Files.move(temporary, destination, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (java.nio.file.AtomicMoveNotSupportedException unsupported) {
            Files.move(temporary, destination, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    void openCurrentSegment() throws IOException {
        Path path = segmentPath(segmentNumber);
        channel = FileChannel.open(
                path,
                StandardOpenOption.CREATE,
                StandardOpenOption.READ,
                StandardOpenOption.WRITE);
        segmentOffset = channel.size();
        channel.position(segmentOffset);
    }

    void reopenAtRecoveredPosition() throws IOException {
        if (channel != null) {
            channel.close();
        }
        openCurrentSegment();
    }

    void rotateSegment() throws IOException {
        channel.force(true);
        channel.close();
        segmentNumber += 1;
        segmentOffset = 0;
        openCurrentSegment();
    }

    void truncateTail(Path path, long length) throws IOException {
        if (channel != null && path.equals(segmentPath(segmentNumber))) {
            channel.close();
            channel = null;
        }
        try (FileChannel tail = FileChannel.open(path, StandardOpenOption.WRITE)) {
            tail.truncate(length);
            tail.force(true);
        }
    }

    List<Path> listSegments() throws IOException {
        List<Path> result = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(directory, PREFIX + "*" + SUFFIX)) {
            for (Path candidate : stream) {
                if (Files.isRegularFile(candidate)) {
                    parseSegmentNumber(candidate);
                    result.add(candidate);
                }
            }
        }
        result.sort(Comparator.comparingLong(this::parseSegmentNumber));
        long expected = 0;
        for (Path path : result) {
            long actual = parseSegmentNumber(path);
            if (actual != expected) {
                throw new IOException("missing segment " + expected + " before " + path.getFileName());
            }
            expected += 1;
        }
        return result;
    }

    Path segmentPath(long number) {
        return directory.resolve(PREFIX + String.format("%08d", number) + SUFFIX);
    }

    long parseSegmentNumber(Path path) {
        String name = path.getFileName().toString();
        if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) {
            throw new IllegalArgumentException("not a journal segment: " + name);
        }
        String digits = name.substring(PREFIX.length(), name.length() - SUFFIX.length());
        try {
            return Long.parseLong(digits);
        } catch (NumberFormatException failure) {
            throw new IllegalArgumentException("invalid segment number: " + name, failure);
        }
    }

    void ensureOpen() throws IOException {
        if (closed || channel == null || !channel.isOpen()) {
            throw new IOException("journal is closed");
        }
    }

    static void writeFully(FileChannel channel, ByteBuffer bytes, long position) throws IOException {
        long cursor = position;
        while (bytes.hasRemaining()) {
            int written = channel.write(bytes, cursor);
            if (written < 0) {
                throw new EOFException("channel closed while writing frame");
            }
            if (written == 0) {
                Thread.onSpinWait();
                continue;
            }
            cursor += written;
        }
    }

    private final class CheckpointState {
        private final long segmentNumber;
        private final long segmentOffset;
        private final long nextBatchNumber;
        private final byte[] digest;

        private CheckpointState(long segmentNumber, long segmentOffset, long nextBatchNumber, byte[] digest) {
            this.segmentNumber = segmentNumber;
            this.segmentOffset = segmentOffset;
            this.nextBatchNumber = nextBatchNumber;
            this.digest = Arrays.copyOf(digest, digest.length);
        }

        private boolean matches(List<Path> segments) {
            if (segmentNumber < 0 || segmentOffset < 0 || nextBatchNumber < 0 || digest.length != 32) {
                return false;
            }
            if (segments.isEmpty()) {
                return segmentNumber == 0 && segmentOffset == 0 && nextBatchNumber == 0;
            }
            Path last = segments.get(segments.size() - 1);
            try {
                return parseSegmentNumber(last) == segmentNumber && Files.size(last) == segmentOffset;
            } catch (IOException failure) {
                return false;
            }
        }
    }
}

record SegmentInfo(
        long number,
        Path path,
        long bytes,
        int batches,
        int events,
        long firstBatch,
        long lastBatch,
        Instant earliest,
        Instant latest) {
    boolean empty() {
        return batches == 0;
    }
}
