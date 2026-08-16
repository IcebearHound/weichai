package synthetic.lane;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.zip.CRC32;

/**
 * 对数缓冲区:把一组正数换算为指定底数的对数并编码为紧凑的二进制帧(带 CRC32 校验),
 * 支持从帧数据无损还原出原始数值,用于校验数据序列化/反序列化的一致性。
 *
 * <p>帧结构(大端序):魔数(0x4C4F4731) + 底数 + 条目数 + 条目对数(每个 8 字节) + CRC32。
 */
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

    /**
     * 编码:对每个正数计算 {@code log_base(value)},写入二进制帧并在末尾追加 CRC32。
     */
    public byte[] compute(List<Double> values) {
        Objects.requireNonNull(values, "logarithm values");
        if (values.size() > maximumValues) {
            throw new IllegalArgumentException("logarithm values exceed configured capacity");
        }
        int headerBytes = Integer.BYTES + Double.BYTES + Integer.BYTES;
        int payloadBytes = Math.multiplyExact(values.size(), Double.BYTES);
        // 帧头固定 + 数据区 + 校验和(8 字节),用 addExact 防止超大输入导致整数溢出
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
            // 用换底公式把自然对数换算到指定底数;结果以 double 写入帧
            if (encoded == 0.0) {
                encoded = 0.0;
            }
            buffer.putDouble(encoded);
            previous = encoded;
        }
        // 只对已写入部分计算校验和,再把校验和追加到帧尾
        CRC32 checksum = new CRC32();
        checksum.update(buffer.array(), 0, buffer.position());
        buffer.putLong(checksum.getValue());
        if (buffer.hasRemaining()) {
            throw new IllegalStateException("logarithm buffer allocation did not match encoded payload");
        }
        return buffer.array();
    }

    /**
     * 解码:校验魔数、底数、长度与校验和,再把每个对数还原为原值(幂运算)。
     */
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
        // 校验和覆盖除帧尾 8 字节校验和本身之外的全部内容
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
