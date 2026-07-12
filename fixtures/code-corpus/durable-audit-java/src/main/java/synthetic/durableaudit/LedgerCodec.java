package synthetic.durableaudit;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.zip.CRC32C;

public final class LedgerCodec {
    static final int MAGIC = 0x41554432;
    static final short VERSION = 2;
    static final int MAX_FRAME_BYTES = 16 * 1024 * 1024;
    static final int MAX_TEXT_BYTES = 256 * 1024;

    public byte[] encode(AuditBatch batch, byte[] previousDigest) {
        Objects.requireNonNull(batch, "batch");
        Objects.requireNonNull(previousDigest, "previousDigest");
        if (previousDigest.length != 32) {
            throw new IllegalArgumentException("previousDigest must contain 32 bytes");
        }
        try {
            ByteArrayOutputStream contentBuffer = new ByteArrayOutputStream();
            DataOutputStream content = new DataOutputStream(contentBuffer);
            content.writeLong(batch.batchNumber());
            content.writeLong(batch.createdAt().getEpochSecond());
            content.writeInt(batch.createdAt().getNano());
            content.writeInt(batch.events().size());
            content.writeInt(batch.checksum());
            content.write(previousDigest);
            for (AuditEvent event : batch.events()) {
                writeUuid(content, event.eventId());
                writeText(content, event.tenant());
                writeText(content, event.category());
                writeText(content, event.subject());
                writeText(content, event.actor());
                content.writeLong(event.occurredAt().getEpochSecond());
                content.writeInt(event.occurredAt().getNano());
                content.writeByte(event.severity().ordinal());
                writeNullableText(content, event.currency());
                writeNullableText(content, event.amount() == null ? null : event.amount().toPlainString());
                content.writeLong(event.accountSequence());
                content.writeShort(event.attributes().size());
                for (Map.Entry<String, String> attribute : event.attributes().entrySet()) {
                    writeText(content, attribute.getKey());
                    writeText(content, attribute.getValue());
                }
            }
            content.flush();
            byte[] body = contentBuffer.toByteArray();
            if (body.length > MAX_FRAME_BYTES) {
                throw new IllegalArgumentException("encoded batch exceeds frame limit");
            }
            CRC32C crc = new CRC32C();
            crc.update(body, 0, body.length);
            ByteArrayOutputStream frameBuffer = new ByteArrayOutputStream(body.length + 24);
            DataOutputStream frame = new DataOutputStream(frameBuffer);
            frame.writeInt(MAGIC);
            frame.writeShort(VERSION);
            frame.writeShort(0);
            frame.writeInt(body.length);
            frame.writeInt((int) crc.getValue());
            frame.write(body);
            frame.writeInt(~body.length);
            frame.writeInt(MAGIC ^ body.length);
            frame.flush();
            return frameBuffer.toByteArray();
        } catch (IOException impossible) {
            throw new IllegalStateException("memory encoding failed", impossible);
        }
    }

    public AuditBatch decode(byte[] frame) {
        Objects.requireNonNull(frame, "frame");
        if (frame.length < 24) {
            throw new DecodeException("frame is shorter than the header and trailer");
        }
        try {
            DataInputStream input = new DataInputStream(new ByteArrayInputStream(frame));
            int magic = input.readInt();
            if (magic != MAGIC) {
                throw new DecodeException("unexpected frame magic");
            }
            short version = input.readShort();
            if (version != VERSION) {
                throw new DecodeException("unsupported frame version: " + version);
            }
            short flags = input.readShort();
            if (flags != 0) {
                throw new DecodeException("unknown frame flags: " + flags);
            }
            int bodyLength = input.readInt();
            if (bodyLength < 0 || bodyLength > MAX_FRAME_BYTES) {
                throw new DecodeException("invalid body length: " + bodyLength);
            }
            int expectedCrc = input.readInt();
            if (frame.length != bodyLength + 24) {
                throw new DecodeException("frame length does not match its header");
            }
            byte[] body = input.readNBytes(bodyLength);
            if (body.length != bodyLength) {
                throw new DecodeException("truncated frame body");
            }
            int invertedLength = input.readInt();
            int trailingMagic = input.readInt();
            if (invertedLength != ~bodyLength || trailingMagic != (MAGIC ^ bodyLength)) {
                throw new DecodeException("invalid frame trailer");
            }
            CRC32C crc = new CRC32C();
            crc.update(body, 0, body.length);
            if ((int) crc.getValue() != expectedCrc) {
                throw new DecodeException("frame checksum mismatch");
            }
            return decodeBody(body);
        } catch (EOFException failure) {
            throw new DecodeException("truncated frame", failure);
        } catch (IOException failure) {
            throw new DecodeException("could not decode frame", failure);
        }
    }

    byte[] readPreviousDigest(byte[] frame) {
        if (frame.length < 24) {
            throw new DecodeException("frame is too short");
        }
        ByteBuffer buffer = ByteBuffer.wrap(frame);
        if (buffer.getInt() != MAGIC) {
            throw new DecodeException("unexpected frame magic");
        }
        buffer.getShort();
        buffer.getShort();
        int length = buffer.getInt();
        buffer.getInt();
        if (length < 56 || length > MAX_FRAME_BYTES || frame.length != length + 24) {
            throw new DecodeException("frame body has invalid length");
        }
        buffer.position(16 + 8 + 8 + 4 + 4 + 4);
        byte[] digest = new byte[32];
        buffer.get(digest);
        return digest;
    }

    List<byte[]> splitFrames(byte[] journalBytes) {
        Objects.requireNonNull(journalBytes, "journalBytes");
        List<byte[]> frames = new ArrayList<>();
        int position = 0;
        while (position < journalBytes.length) {
            int remaining = journalBytes.length - position;
            if (remaining < 16) {
                throw new DecodeException("journal ends inside a frame header");
            }
            ByteBuffer header = ByteBuffer.wrap(journalBytes, position, 16);
            int magic = header.getInt();
            if (magic != MAGIC) {
                throw new DecodeException("journal lost frame alignment at byte " + position);
            }
            header.getShort();
            header.getShort();
            int bodyLength = header.getInt();
            header.getInt();
            if (bodyLength < 0 || bodyLength > MAX_FRAME_BYTES) {
                throw new DecodeException("frame length is invalid at byte " + position);
            }
            int frameLength = bodyLength + 24;
            if (frameLength > remaining) {
                throw new DecodeException("journal has a partial tail frame");
            }
            byte[] frame = new byte[frameLength];
            System.arraycopy(journalBytes, position, frame, 0, frameLength);
            decode(frame);
            frames.add(frame);
            position += frameLength;
        }
        return List.copyOf(frames);
    }

    int findLastCompleteOffset(byte[] bytes) {
        int position = 0;
        int complete = 0;
        while (bytes.length - position >= 16) {
            ByteBuffer header = ByteBuffer.wrap(bytes, position, 16);
            if (header.getInt() != MAGIC) {
                break;
            }
            short version = header.getShort();
            short flags = header.getShort();
            int bodyLength = header.getInt();
            header.getInt();
            if (version != VERSION || flags != 0 || bodyLength < 0 || bodyLength > MAX_FRAME_BYTES) {
                break;
            }
            int frameLength = bodyLength + 24;
            if (bytes.length - position < frameLength) {
                break;
            }
            byte[] frame = new byte[frameLength];
            System.arraycopy(bytes, position, frame, 0, frameLength);
            try {
                decode(frame);
            } catch (DecodeException invalid) {
                break;
            }
            position += frameLength;
            complete = position;
        }
        return complete;
    }

    AuditBatch decodeBody(byte[] body) throws IOException {
        DataInputStream input = new DataInputStream(new ByteArrayInputStream(body));
        long batchNumber = input.readLong();
        long createdSeconds = input.readLong();
        int createdNanos = input.readInt();
        int eventCount = input.readInt();
        int expectedBatchChecksum = input.readInt();
        if (batchNumber < 0) {
            throw new DecodeException("negative batch number");
        }
        if (createdNanos < 0 || createdNanos > 999_999_999) {
            throw new DecodeException("invalid creation nanoseconds");
        }
        if (eventCount <= 0 || eventCount > 10_000) {
            throw new DecodeException("invalid event count: " + eventCount);
        }
        byte[] ignoredPreviousDigest = input.readNBytes(32);
        if (ignoredPreviousDigest.length != 32) {
            throw new DecodeException("missing previous digest");
        }
        List<AuditEvent> events = new ArrayList<>(eventCount);
        for (int eventIndex = 0; eventIndex < eventCount; eventIndex++) {
            UUID eventId = readUuid(input);
            String tenant = readText(input);
            String category = readText(input);
            String subject = readText(input);
            String actor = readText(input);
            long occurredSeconds = input.readLong();
            int occurredNanos = input.readInt();
            if (occurredNanos < 0 || occurredNanos > 999_999_999) {
                throw new DecodeException("invalid event nanoseconds at index " + eventIndex);
            }
            int severityOrdinal = input.readUnsignedByte();
            if (severityOrdinal >= Severity.values().length) {
                throw new DecodeException("invalid severity at index " + eventIndex);
            }
            String currency = readNullableText(input);
            String decimalText = readNullableText(input);
            BigDecimal amount = decimalText == null ? null : parseDecimal(decimalText, eventIndex);
            long accountSequence = input.readLong();
            int attributeCount = input.readUnsignedShort();
            if (attributeCount > 48) {
                throw new DecodeException("too many attributes at index " + eventIndex);
            }
            Map<String, String> attributes = new LinkedHashMap<>();
            for (int attributeIndex = 0; attributeIndex < attributeCount; attributeIndex++) {
                String key = readText(input);
                String value = readText(input);
                if (attributes.put(key, value) != null) {
                    throw new DecodeException("duplicate attribute: " + key);
                }
            }
            try {
                events.add(new AuditEvent(
                        eventId,
                        tenant,
                        category,
                        subject,
                        actor,
                        Instant.ofEpochSecond(occurredSeconds, occurredNanos),
                        Severity.values()[severityOrdinal],
                        currency,
                        amount,
                        accountSequence,
                        attributes));
            } catch (IllegalArgumentException invalidEvent) {
                throw new DecodeException("invalid event at index " + eventIndex, invalidEvent);
            }
        }
        if (input.available() != 0) {
            throw new DecodeException("unexpected bytes after final event");
        }
        AuditBatch batch = new AuditBatch(batchNumber, Instant.ofEpochSecond(createdSeconds, createdNanos), events);
        if (batch.checksum() != expectedBatchChecksum) {
            throw new DecodeException("batch semantic checksum mismatch");
        }
        return batch;
    }

    static void writeUuid(DataOutputStream output, UUID uuid) throws IOException {
        output.writeLong(uuid.getMostSignificantBits());
        output.writeLong(uuid.getLeastSignificantBits());
    }

    static UUID readUuid(DataInputStream input) throws IOException {
        return new UUID(input.readLong(), input.readLong());
    }

    static void writeNullableText(DataOutputStream output, String value) throws IOException {
        if (value == null) {
            output.writeInt(-1);
        } else {
            writeText(output, value);
        }
    }

    static String readNullableText(DataInputStream input) throws IOException {
        int length = input.readInt();
        if (length == -1) {
            return null;
        }
        return readTextWithLength(input, length);
    }

    static void writeText(DataOutputStream output, String value) throws IOException {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_TEXT_BYTES) {
            throw new IllegalArgumentException("text field exceeds codec limit");
        }
        output.writeInt(bytes.length);
        output.write(bytes);
    }

    static String readText(DataInputStream input) throws IOException {
        return readTextWithLength(input, input.readInt());
    }

    static String readTextWithLength(DataInputStream input, int length) throws IOException {
        if (length < 0 || length > MAX_TEXT_BYTES) {
            throw new DecodeException("invalid text length: " + length);
        }
        byte[] bytes = input.readNBytes(length);
        if (bytes.length != length) {
            throw new DecodeException("truncated text value");
        }
        String value = new String(bytes, StandardCharsets.UTF_8);
        if (!java.util.Arrays.equals(value.getBytes(StandardCharsets.UTF_8), bytes)) {
            throw new DecodeException("text is not canonical UTF-8");
        }
        return value;
    }

    static BigDecimal parseDecimal(String text, int eventIndex) {
        try {
            return new BigDecimal(text);
        } catch (NumberFormatException failure) {
            throw new DecodeException("invalid amount at event " + eventIndex, failure);
        }
    }
}

final class DecodeException extends RuntimeException {
    DecodeException(String message) {
        super(message);
    }

    DecodeException(String message, Throwable cause) {
        super(message, cause);
    }
}
