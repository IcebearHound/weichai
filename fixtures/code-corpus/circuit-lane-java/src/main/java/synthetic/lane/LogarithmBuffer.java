package synthetic.lane;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.zip.CRC32;

public final class LogarithmBuffer {
    private final double base;
    private final int maximumValues;

    public LogarithmBuffer(double base, int maximumValues) {
        if (!Double.isFinite(base) || base <= 1.0 || base > 100.0) {
            throw new IllegalArgumentException("logarithm base is outside supported range");
        }
        if (maximumValues < 1 || maximumValues > 10_000_000) {
            throw new IllegalArgumentException("logarithm buffer capacity is outside supported range");
        }
        this.base = base;
        this.maximumValues = maximumValues;
    }

    public byte[] compute(List<Double> values) {
        Objects.requireNonNull(values, "logarithm values");
        if (values.size() > maximumValues) {
            throw new IllegalArgumentException("logarithm values exceed configured capacity");
        }
        int headerBytes = Integer.BYTES + Double.BYTES + Integer.BYTES;
        int payloadBytes = Math.multiplyExact(values.size(), Double.BYTES);
        ByteBuffer buffer = ByteBuffer.allocate(Math.addExact(headerBytes + payloadBytes, Long.BYTES))
                .order(ByteOrder.BIG_ENDIAN);
        buffer.putInt(0x4c4f4731);
        buffer.putDouble(base);
        buffer.putInt(values.size());
        double previous = Double.NEGATIVE_INFINITY;
        for (int index = 0; index < values.size(); index++) {
            Double boxed = Objects.requireNonNull(values.get(index), "logarithm value");
            double value = boxed;
            if (!Double.isFinite(value) || value <= 0.0) {
                throw new IllegalArgumentException("logarithm input must be positive and finite at " + index);
            }
            double encoded = Math.log(value) / Math.log(base);
            if (!Double.isFinite(encoded)) {
                throw new IllegalStateException("logarithm transform produced a non-finite value");
            }
            if (encoded == 0.0) {
                encoded = 0.0;
            }
            buffer.putDouble(encoded);
            previous = encoded;
        }
        CRC32 checksum = new CRC32();
        checksum.update(buffer.array(), 0, buffer.position());
        buffer.putLong(checksum.getValue());
        if (buffer.hasRemaining()) {
            throw new IllegalStateException("logarithm buffer allocation did not match encoded payload");
        }
        return buffer.array();
    }

    public List<Double> restore(byte[] encoded) {
        Objects.requireNonNull(encoded, "encoded logarithm buffer");
        int minimum = Integer.BYTES + Double.BYTES + Integer.BYTES + Long.BYTES;
        if (encoded.length < minimum) {
            throw new IllegalArgumentException("encoded logarithm buffer is too short");
        }
        ByteBuffer buffer = ByteBuffer.wrap(encoded).order(ByteOrder.BIG_ENDIAN);
        if (buffer.getInt() != 0x4c4f4731) {
            throw new IllegalArgumentException("encoded logarithm buffer has an invalid header");
        }
        double encodedBase = buffer.getDouble();
        if (Double.compare(encodedBase, base) != 0) {
            throw new IllegalArgumentException("encoded logarithm buffer uses another base");
        }
        int count = buffer.getInt();
        if (count < 0 || count > maximumValues) {
            throw new IllegalArgumentException("encoded logarithm value count is invalid");
        }
        int expected = Math.addExact(
                Integer.BYTES + Double.BYTES + Integer.BYTES + Math.multiplyExact(count, Double.BYTES),
                Long.BYTES
        );
        if (encoded.length != expected) {
            throw new IllegalArgumentException("encoded logarithm buffer length is inconsistent");
        }
        CRC32 checksum = new CRC32();
        checksum.update(encoded, 0, encoded.length - Long.BYTES);
        List<Double> result = new ArrayList<>(count);
        for (int index = 0; index < count; index++) {
            double exponent = buffer.getDouble();
            if (!Double.isFinite(exponent)) {
                throw new IllegalArgumentException("encoded logarithm exponent is not finite");
            }
            double value = Math.pow(base, exponent);
            if (!Double.isFinite(value) || value <= 0.0) {
                throw new IllegalArgumentException("restored logarithm value is invalid");
            }
            result.add(value);
        }
        long suppliedChecksum = buffer.getLong();
        if (suppliedChecksum != checksum.getValue()) {
            throw new IllegalArgumentException("encoded logarithm checksum does not match");
        }
        if (buffer.hasRemaining()) {
            throw new IllegalArgumentException("encoded logarithm buffer has trailing bytes");
        }
        return Collections.unmodifiableList(result);
    }
}
