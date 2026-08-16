package synthetic.durableaudit;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 编解码器与哈希链的行为测试:帧编解码往返、帧信封防篡改、帧切分/截断识别、
 * 链验证/断链诊断/最长有效前缀、检查点令牌与周期检查点。
 */
final class CodecHashTest {
    /** 汇总入口:运行全部用例,返回本类新增的断言数。 */
    static int run() throws Exception {
        int before = TestSupport.assertions();
        roundTripsRichBatch();
        preservesPreviousDigest();
        rejectsMalformedFrameEnvelope();
        splitsConcatenatedFrames();
        findsCompletePrefixBeforePartialTail();
        validatesTextEncodingHelpers();
        buildsAndVerifiesHashChain();
        reportsChainAndSequenceFaults();
        computesLongestValidPrefix();
        createsCheckpointTokens();
        extractsPeriodicCheckpoints();
        protectsVerificationCollections();
        validatesDigestUtilities();
        return TestSupport.assertions() - before;
    }

    /** 构造含全部严重级别/属性/金额的富批次,覆盖各字段编码路径。 */
    private static AuditBatch richBatch(long number) {
        List<AuditEvent> events = new ArrayList<>();
        Severity[] severities = Severity.values();
        for (int index = 0; index < severities.length; index++) {
            Map<String, String> attributes = new LinkedHashMap<>();
            attributes.put("city", index % 2 == 0 ? "東京" : "Zürich");
            attributes.put("note", "line " + index + " | slash \\ newline\nend");
            events.add(TestSupport.event(
                    "codec" + index,
                    "account:" + index,
                    number * 100 + index,
                    TestSupport.BASE.plusNanos(index * 123_456L),
                    severities[index],
                    index % 2 == 0 ? "EUR" : null,
                    index % 2 == 0 ? new BigDecimal(index + ".1250") : null,
                    attributes));
        }
        return new AuditBatch(number, TestSupport.BASE.plusSeconds(number).plusNanos(987_654_321), events);
    }

    /** 富批次编解码应语义等价,帧头携带魔数与版本。 */
    private static void roundTripsRichBatch() {
        LedgerCodec codec = new LedgerCodec();
        AuditBatch source = richBatch(7);
        byte[] previous = new byte[32];
        for (int index = 0; index < previous.length; index++) {
            previous[index] = (byte) (index * 7);
        }
        byte[] frame = codec.encode(source, previous);
        AuditBatch decoded = codec.decode(frame);
        TestSupport.equal(source, decoded, "codec should round-trip batch semantics");
        TestSupport.equal(source.events(), decoded.events(), "codec should retain all event fields");
        TestSupport.check(frame.length > source.events().size() * 100, "frame should contain complete event payload");
        TestSupport.equal(LedgerCodec.MAGIC, ByteBuffer.wrap(frame).getInt(), "frame should begin with magic");
        TestSupport.equal(LedgerCodec.VERSION, ByteBuffer.wrap(frame, 4, 2).getShort(), "frame should declare current version");
    }

    /** 前一帧摘要应嵌入帧内并原样取出,且长度校验严格。 */
    private static void preservesPreviousDigest() {
        LedgerCodec codec = new LedgerCodec();
        byte[] digest = MessageDigestHolder.sha256("previous-frame");
        byte[] frame = codec.encode(TestSupport.batch(0, 3), digest);
        TestSupport.arrayEqual(digest, codec.readPreviousDigest(frame), "embedded predecessor should round-trip");
        byte[] extracted = codec.readPreviousDigest(frame);
        extracted[0] ^= 0x7f;
        TestSupport.check(!Arrays.equals(extracted, codec.readPreviousDigest(frame)), "digest extraction should return a copy");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> codec.encode(TestSupport.batch(0, 1), new byte[31]), "short predecessor should fail");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> codec.encode(TestSupport.batch(0, 1), new byte[33]), "long predecessor should fail");
    }

    /** 魔数/版本/标志/长度/CRC/尾部任一损坏都应解码失败。 */
    private static void rejectsMalformedFrameEnvelope() {
        LedgerCodec codec = new LedgerCodec();
        byte[] valid = codec.encode(TestSupport.batch(0, 2), new byte[32]);
        List<byte[]> invalid = new ArrayList<>();
        invalid.add(Arrays.copyOf(valid, 10));
        byte[] magic = valid.clone();
        magic[0] ^= 0x20;
        invalid.add(magic);
        byte[] version = valid.clone();
        ByteBuffer.wrap(version).putShort(4, (short) 99);
        invalid.add(version);
        byte[] flags = valid.clone();
        ByteBuffer.wrap(flags).putShort(6, (short) 1);
        invalid.add(flags);
        byte[] length = valid.clone();
        ByteBuffer.wrap(length).putInt(8, -1);
        invalid.add(length);
        byte[] wrongLength = valid.clone();
        ByteBuffer.wrap(wrongLength).putInt(8, ByteBuffer.wrap(valid).getInt(8) - 1);
        invalid.add(wrongLength);
        byte[] crc = valid.clone();
        crc[12] ^= 0x01;
        invalid.add(crc);
        byte[] body = valid.clone();
        body[32] ^= 0x01;
        invalid.add(body);
        byte[] trailerLength = valid.clone();
        trailerLength[trailerLength.length - 8] ^= 0x01;
        invalid.add(trailerLength);
        byte[] trailerMagic = valid.clone();
        trailerMagic[trailerMagic.length - 1] ^= 0x01;
        invalid.add(trailerMagic);
        invalid.add(Arrays.copyOf(valid, valid.length - 1));
        for (byte[] frame : invalid) {
            TestSupport.expectThrows(DecodeException.class, () -> codec.decode(frame), "corrupt frame envelope should fail");
        }
        TestSupport.expectThrows(NullPointerException.class, () -> codec.decode(null), "null frame should fail");
    }

    /** 连续帧字节流可切分还原;错位或尾部不完整时报错。 */
    private static void splitsConcatenatedFrames() {
        LedgerCodec codec = new LedgerCodec();
        HashChain chain = new HashChain(codec);
        List<byte[]> frames = chainedFrames(codec, chain, 6);
        int total = frames.stream().mapToInt(frame -> frame.length).sum();
        byte[] journal = new byte[total];
        int cursor = 0;
        for (byte[] frame : frames) {
            System.arraycopy(frame, 0, journal, cursor, frame.length);
            cursor += frame.length;
        }
        List<byte[]> observed = codec.splitFrames(journal);
        TestSupport.equal(frames.size(), observed.size(), "split should find every frame");
        for (int index = 0; index < frames.size(); index++) {
            TestSupport.arrayEqual(frames.get(index), observed.get(index), "split frame should preserve bytes");
        }
        TestSupport.equal(List.of(), codec.splitFrames(new byte[0]), "empty journal should have no frames");
        byte[] shifted = journal.clone();
        shifted[0] = 0;
        TestSupport.expectThrows(DecodeException.class, () -> codec.splitFrames(shifted), "misaligned journal should fail");
        TestSupport.expectThrows(DecodeException.class, () -> codec.splitFrames(Arrays.copyOf(journal, journal.length - 5)), "partial journal tail should fail");
    }

    /** 末帧不完整或 CRC 损坏时,前缀扫描应止于最后一个完整帧。 */
    private static void findsCompletePrefixBeforePartialTail() {
        LedgerCodec codec = new LedgerCodec();
        byte[] first = codec.encode(TestSupport.batch(0, 2), new byte[32]);
        byte[] firstDigest = new HashChain(codec).append(TestSupport.batch(0, 2), new byte[32]);
        byte[] second = codec.encode(TestSupport.batch(1, 3), firstDigest);
        byte[] complete = concat(first, second);
        TestSupport.equal(complete.length, codec.findLastCompleteOffset(complete), "complete bytes should be fully recognized");
        for (int tail : List.of(1, 7, 15, second.length - 1)) {
            byte[] partial = concat(first, Arrays.copyOf(second, tail));
            TestSupport.equal(first.length, codec.findLastCompleteOffset(partial), "partial second frame should be excluded");
        }
        byte[] corruption = complete.clone();
        corruption[first.length + 12] ^= 0x01;
        TestSupport.equal(first.length, codec.findLastCompleteOffset(corruption), "invalid next CRC should stop prefix scan");
    }

    /** 文本长度前缀编解码往返,超限/截断/非法十进制应被拒绝。 */
    private static void validatesTextEncodingHelpers() throws Exception {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        DataOutputStream output = new DataOutputStream(buffer);
        LedgerCodec.writeText(output, "audit 東京 😀");
        LedgerCodec.writeNullableText(output, null);
        LedgerCodec.writeNullableText(output, "present");
        output.flush();
        var input = new java.io.DataInputStream(new java.io.ByteArrayInputStream(buffer.toByteArray()));
        TestSupport.equal("audit 東京 😀", LedgerCodec.readText(input), "UTF-8 text should round-trip");
        TestSupport.equal(null, LedgerCodec.readNullableText(input), "nullable marker should round-trip");
        TestSupport.equal("present", LedgerCodec.readNullableText(input), "nullable text should round-trip");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> {
            ByteArrayOutputStream huge = new ByteArrayOutputStream();
            LedgerCodec.writeText(new DataOutputStream(huge), "x".repeat(LedgerCodec.MAX_TEXT_BYTES + 1));
        }, "oversized text should fail");
        TestSupport.expectThrows(DecodeException.class, () -> LedgerCodec.readTextWithLength(new java.io.DataInputStream(new java.io.ByteArrayInputStream(new byte[0])), -2), "negative text length should fail");
        TestSupport.expectThrows(DecodeException.class, () -> LedgerCodec.readTextWithLength(new java.io.DataInputStream(new java.io.ByteArrayInputStream(new byte[2])), 3), "truncated text should fail");
        TestSupport.equal(new BigDecimal("12.50"), LedgerCodec.parseDecimal("12.50", 0), "decimal parser should retain scale");
        TestSupport.expectThrows(DecodeException.class, () -> LedgerCodec.parseDecimal("twelve", 4), "invalid decimal should fail");
    }

    /** 健康链验证通过,并暴露每帧摘要与最终摘要。 */
    private static void buildsAndVerifiesHashChain() {
        LedgerCodec codec = new LedgerCodec();
        HashChain chain = new HashChain(codec);
        List<byte[]> frames = chainedFrames(codec, chain, 12);
        Verification result = chain.verify(frames);
        TestSupport.check(result.valid(), "well-formed chain should verify: " + result.faults());
        TestSupport.equal(12, result.frameCount(), "verification should count frames");
        TestSupport.equal(36, result.eventCount(), "verification should count events");
        TestSupport.equal(12, result.digests().size(), "verification should expose each digest");
        TestSupport.equal(64, result.digests().get(0).length(), "digest should be hexadecimal SHA-256");
        TestSupport.arrayEqual(chain.checkpoints(frames, 12).get(11L), result.digestCopy(), "verification digest should equal final checkpoint");
    }

    /** 前驱不匹配、批次号跳号、流序号回归、事件时间过晚应被诊断。 */
    private static void reportsChainAndSequenceFaults() {
        LedgerCodec codec = new LedgerCodec();
        HashChain chain = new HashChain(codec);
        AuditBatch zero = TestSupport.batch(0, List.of(TestSupport.eventWithId("chain-0", "chain", "account:1", 1)));
        byte[] frame0 = codec.encode(zero, chain.genesis());
        byte[] digest0 = chain.append(zero, chain.genesis());
        AuditBatch skipped = new AuditBatch(2, TestSupport.BASE.plusSeconds(2), List.of(TestSupport.eventWithId("chain-2", "chain", "account:1", 1)));
        byte[] wrongPrior = codec.encode(skipped, chain.genesis());
        Verification result = chain.verify(List.of(frame0, wrongPrior));
        TestSupport.check(!result.valid(), "broken chain should not verify");
        TestSupport.check(result.faults().stream().anyMatch(fault -> fault.contains("does not reference")), "fault should identify predecessor mismatch");
        TestSupport.check(result.faults().stream().anyMatch(fault -> fault.contains("skips batch")), "fault should identify number gap");
        TestSupport.check(result.faults().stream().anyMatch(fault -> fault.contains("regresses")), "fault should identify stream sequence regression");
        AuditEvent future = TestSupport.event("future", "account:1", 1, TestSupport.BASE.plusSeconds(90), Severity.INFO, null, null, Map.of());
        AuditBatch one = new AuditBatch(1, TestSupport.BASE, List.of(future));
        Verification futureResult = chain.verify(List.of(frame0, codec.encode(one, digest0)));
        TestSupport.check(futureResult.faults().stream().anyMatch(fault -> fault.contains("too far after")), "future event should be diagnosed");
    }

    /** 损坏帧或编号断档应缩短最长有效前缀。 */
    private static void computesLongestValidPrefix() {
        LedgerCodec codec = new LedgerCodec();
        HashChain chain = new HashChain(codec);
        List<byte[]> frames = new ArrayList<>(chainedFrames(codec, chain, 8));
        TestSupport.equal(8, chain.longestValidPrefix(frames), "complete chain prefix should include all frames");
        byte[] invalid = frames.get(5).clone();
        invalid[20] ^= 0x01;
        frames.set(5, invalid);
        TestSupport.equal(5, chain.longestValidPrefix(frames), "corrupt frame should end prefix");
        List<byte[]> numberGap = new ArrayList<>();
        byte[] prior = chain.genesis();
        AuditBatch zero = TestSupport.batch(0, 1);
        numberGap.add(codec.encode(zero, prior));
        prior = chain.append(zero, prior);
        AuditBatch two = TestSupport.batch(2, 1);
        numberGap.add(codec.encode(two, prior));
        TestSupport.equal(1, chain.longestValidPrefix(numberGap), "number gap should end prefix");
    }

    /** 检查点令牌含签名;篡改或格式错误应校验失败。 */
    private static void createsCheckpointTokens() {
        HashChain chain = new HashChain(new LedgerCodec());
        byte[] digest = MessageDigestHolder.sha256("checkpoint");
        String token = chain.checkpointToken(7, 12_345, digest);
        TestSupport.check(chain.validateCheckpoint(token), "generated checkpoint should validate");
        String[] parts = token.split(":");
        TestSupport.equal("7", parts[0], "checkpoint should include segment");
        TestSupport.equal("12345", parts[1], "checkpoint should include offset");
        TestSupport.equal(HexFormat.of().formatHex(digest), parts[2], "checkpoint should include digest");
        for (String invalid : List.of("", "1:2:3", token + ":extra", "-1:" + parts[1] + ":" + parts[2] + ":" + parts[3], parts[0] + ":" + parts[1] + ":" + parts[2] + ":0000000000000000", "x:y:z:q")) {
            TestSupport.check(!chain.validateCheckpoint(invalid), "malformed checkpoint should fail: " + invalid);
        }
        TestSupport.check(!chain.validateCheckpoint(null), "null checkpoint should fail");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> chain.checkpointToken(-1, 0, digest), "negative segment should fail");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> chain.checkpointToken(0, -1, digest), "negative offset should fail");
    }

    /** 按间隔提取周期检查点,且末帧必须包含;断链拒绝。 */
    private static void extractsPeriodicCheckpoints() {
        LedgerCodec codec = new LedgerCodec();
        HashChain chain = new HashChain(codec);
        List<byte[]> frames = chainedFrames(codec, chain, 10);
        Map<Long, byte[]> checkpoints = chain.checkpoints(frames, 3);
        TestSupport.equal(List.of(2L, 5L, 8L, 9L), List.copyOf(checkpoints.keySet()), "periodic checkpoints should include final frame");
        TestSupport.arrayEqual(chain.verify(frames).digestCopy(), checkpoints.get(9L), "final checkpoint should match verified digest");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> chain.checkpoints(frames, 0), "zero interval should fail");
        List<byte[]> broken = new ArrayList<>(frames);
        broken.set(4, codec.encode(TestSupport.batch(4, 3), chain.genesis()));
        TestSupport.expectThrows(IllegalArgumentException.class, () -> chain.checkpoints(broken, 2), "broken chain should reject checkpoints");
    }

    /** 验证结果集合不可变,摘要拷贝隔离外部修改。 */
    private static void protectsVerificationCollections() {
        LedgerCodec codec = new LedgerCodec();
        HashChain chain = new HashChain(codec);
        Verification result = chain.verify(chainedFrames(codec, chain, 2));
        TestSupport.expectThrows(UnsupportedOperationException.class, () -> result.faults().add("new"), "faults should be immutable");
        TestSupport.expectThrows(UnsupportedOperationException.class, () -> result.digests().clear(), "digests should be immutable");
        byte[] first = result.digestCopy();
        byte[] second = result.digestCopy();
        first[0] ^= 0x55;
        TestSupport.check(!Arrays.equals(first, second), "digestCopy should isolate mutation");
    }

    /** 摘要工具:长度校验、大端 long 编码、SHA-256 已知值。 */
    private static void validatesDigestUtilities() {
        TestSupport.expectThrows(NullPointerException.class, () -> HashChain.requireDigest(null), "null digest should fail");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> HashChain.requireDigest(new byte[0]), "empty digest should fail");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> HashChain.requireDigest(new byte[64]), "long digest should fail");
        byte[] value = HashChain.longBytes(0x0102030405060708L);
        TestSupport.equal(0x0102030405060708L, ByteBuffer.wrap(value).getLong(), "long bytes should use network order");
        TestSupport.equal("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", HexFormat.of().formatHex(HashChain.sha256().digest()), "SHA-256 implementation should match known empty digest");
    }

    /** 工具:构造 count 帧的连续哈希链(前一帧摘要衔接)。 */
    private static List<byte[]> chainedFrames(LedgerCodec codec, HashChain chain, int count) {
        List<byte[]> frames = new ArrayList<>();
        byte[] prior = chain.genesis();
        for (int number = 0; number < count; number++) {
            AuditBatch batch = TestSupport.batch(number, 3);
            frames.add(codec.encode(batch, prior));
            prior = chain.append(batch, prior);
        }
        return List.copyOf(frames);
    }

    private static byte[] concat(byte[] left, byte[] right) {
        byte[] result = Arrays.copyOf(left, left.length + right.length);
        System.arraycopy(right, 0, result, left.length, right.length);
        return result;
    }

    private static final class MessageDigestHolder {
        static byte[] sha256(String text) {
            MessageDigest digest = HashChain.sha256();
            return digest.digest(text.getBytes(StandardCharsets.UTF_8));
        }
    }
}
