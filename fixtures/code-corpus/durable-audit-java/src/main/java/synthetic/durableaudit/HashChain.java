package synthetic.durableaudit;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public final class HashChain {
    private static final byte[] GENESIS = new byte[32];
    private final LedgerCodec codec;

    public HashChain(LedgerCodec codec) {
        this.codec = Objects.requireNonNull(codec, "codec");
    }

    public byte[] append(AuditBatch batch, byte[] priorDigest) {
        Objects.requireNonNull(batch, "batch");
        requireDigest(priorDigest);
        byte[] frame = codec.encode(batch, priorDigest);
        MessageDigest digest = sha256();
        digest.update((byte) 2);
        digest.update(priorDigest);
        digest.update(longBytes(batch.batchNumber()));
        digest.update(longBytes(batch.createdAt().toEpochMilli()));
        digest.update(frame);
        return digest.digest();
    }

    public Verification verify(List<byte[]> frames) {
        Objects.requireNonNull(frames, "frames");
        byte[] expectedPrior = Arrays.copyOf(GENESIS, GENESIS.length);
        List<String> faults = new ArrayList<>();
        List<String> digests = new ArrayList<>();
        Map<String, Long> sequenceBySubject = new LinkedHashMap<>();
        long previousBatchNumber = -1;
        Instant previousCreation = Instant.MIN;
        int eventCount = 0;
        for (int index = 0; index < frames.size(); index++) {
            byte[] frame = frames.get(index);
            AuditBatch batch;
            try {
                batch = codec.decode(frame);
            } catch (DecodeException invalid) {
                faults.add("frame " + index + " cannot be decoded: " + invalid.getMessage());
                continue;
            }
            byte[] actualPrior;
            try {
                actualPrior = codec.readPreviousDigest(frame);
            } catch (DecodeException invalid) {
                faults.add("frame " + index + " has no readable predecessor");
                continue;
            }
            if (!MessageDigest.isEqual(expectedPrior, actualPrior)) {
                faults.add("frame " + index + " does not reference the previous digest");
            }
            if (batch.batchNumber() <= previousBatchNumber) {
                faults.add("frame " + index + " repeats or regresses batch numbering");
            } else if (previousBatchNumber >= 0 && batch.batchNumber() != previousBatchNumber + 1) {
                faults.add("frame " + index + " skips batch numbers after " + previousBatchNumber);
            }
            if (batch.createdAt().isBefore(previousCreation)) {
                faults.add("frame " + index + " has a creation time before its predecessor");
            }
            for (AuditEvent event : batch.events()) {
                String stream = event.tenant() + '/' + event.subject();
                Long previousSequence = sequenceBySubject.put(stream, event.accountSequence());
                if (previousSequence != null && event.accountSequence() <= previousSequence) {
                    faults.add("stream " + stream + " regresses at event " + event.eventId());
                }
                if (event.occurredAt().isAfter(batch.createdAt().plusSeconds(60))) {
                    faults.add("event " + event.eventId() + " occurs too far after batch creation");
                }
                eventCount += 1;
            }
            expectedPrior = hashFrame(batch, frame, actualPrior);
            digests.add(HexFormat.of().formatHex(expectedPrior));
            previousBatchNumber = batch.batchNumber();
            previousCreation = batch.createdAt();
        }
        return new Verification(
                faults.isEmpty(),
                List.copyOf(faults),
                List.copyOf(digests),
                frames.size(),
                eventCount,
                Arrays.copyOf(expectedPrior, expectedPrior.length));
    }

    byte[] genesis() {
        return Arrays.copyOf(GENESIS, GENESIS.length);
    }

    String checkpointToken(long segmentNumber, long byteOffset, byte[] digest) {
        if (segmentNumber < 0 || byteOffset < 0) {
            throw new IllegalArgumentException("checkpoint positions must be non-negative");
        }
        requireDigest(digest);
        ByteBuffer values = ByteBuffer.allocate(48);
        values.putLong(segmentNumber);
        values.putLong(byteOffset);
        values.put(digest);
        MessageDigest checksum = sha256();
        checksum.update("audit-checkpoint-v2".getBytes(StandardCharsets.UTF_8));
        byte[] signature = checksum.digest(values.array());
        return segmentNumber
                + ":"
                + byteOffset
                + ":"
                + HexFormat.of().formatHex(digest)
                + ":"
                + HexFormat.of().formatHex(signature, 0, 8);
    }

    boolean validateCheckpoint(String token) {
        if (token == null) {
            return false;
        }
        String[] parts = token.split(":", -1);
        if (parts.length != 4) {
            return false;
        }
        long segment;
        long offset;
        byte[] digest;
        byte[] signature;
        try {
            segment = Long.parseLong(parts[0]);
            offset = Long.parseLong(parts[1]);
            digest = HexFormat.of().parseHex(parts[2]);
            signature = HexFormat.of().parseHex(parts[3]);
        } catch (IllegalArgumentException failure) {
            return false;
        }
        if (segment < 0 || offset < 0 || digest.length != 32 || signature.length != 8) {
            return false;
        }
        String expected = checkpointToken(segment, offset, digest);
        byte[] expectedSignature = HexFormat.of().parseHex(expected.substring(expected.lastIndexOf(':') + 1));
        return MessageDigest.isEqual(signature, expectedSignature);
    }

    Map<Long, byte[]> checkpoints(List<byte[]> frames, int interval) {
        if (interval <= 0) {
            throw new IllegalArgumentException("interval must be positive");
        }
        Map<Long, byte[]> result = new LinkedHashMap<>();
        byte[] prior = genesis();
        for (int index = 0; index < frames.size(); index++) {
            AuditBatch batch = codec.decode(frames.get(index));
            byte[] embedded = codec.readPreviousDigest(frames.get(index));
            if (!MessageDigest.isEqual(prior, embedded)) {
                throw new IllegalArgumentException("chain breaks at frame " + index);
            }
            prior = hashFrame(batch, frames.get(index), embedded);
            if ((index + 1) % interval == 0 || index + 1 == frames.size()) {
                result.put(batch.batchNumber(), Arrays.copyOf(prior, prior.length));
            }
        }
        return result;
    }

    int longestValidPrefix(List<byte[]> frames) {
        byte[] prior = genesis();
        long batchNumber = -1;
        for (int index = 0; index < frames.size(); index++) {
            try {
                byte[] frame = frames.get(index);
                AuditBatch batch = codec.decode(frame);
                byte[] embedded = codec.readPreviousDigest(frame);
                if (!MessageDigest.isEqual(prior, embedded)) {
                    return index;
                }
                if (batchNumber >= 0 && batch.batchNumber() != batchNumber + 1) {
                    return index;
                }
                prior = hashFrame(batch, frame, embedded);
                batchNumber = batch.batchNumber();
            } catch (RuntimeException invalid) {
                return index;
            }
        }
        return frames.size();
    }

    byte[] hashFrame(AuditBatch batch, byte[] frame, byte[] priorDigest) {
        MessageDigest digest = sha256();
        digest.update((byte) 2);
        digest.update(priorDigest);
        digest.update(longBytes(batch.batchNumber()));
        digest.update(longBytes(batch.createdAt().toEpochMilli()));
        digest.update(frame);
        return digest.digest();
    }

    static void requireDigest(byte[] digest) {
        Objects.requireNonNull(digest, "digest");
        if (digest.length != 32) {
            throw new IllegalArgumentException("digest must contain 32 bytes");
        }
    }

    static byte[] longBytes(long value) {
        return ByteBuffer.allocate(Long.BYTES).putLong(value).array();
    }

    static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException unavailable) {
            throw new IllegalStateException("SHA-256 is required by the Java runtime", unavailable);
        }
    }
}

record Verification(
        boolean valid,
        List<String> faults,
        List<String> digests,
        int frameCount,
        int eventCount,
        byte[] finalDigest) {
    Verification {
        faults = List.copyOf(faults);
        digests = List.copyOf(digests);
        finalDigest = Arrays.copyOf(finalDigest, finalDigest.length);
    }

    byte[] digestCopy() {
        return Arrays.copyOf(finalDigest, finalDigest.length);
    }
}
