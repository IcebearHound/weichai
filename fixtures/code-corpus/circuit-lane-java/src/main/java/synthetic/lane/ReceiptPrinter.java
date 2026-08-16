package synthetic.lane;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * 结算回执打印机:把结算结果渲染为带 HMAC 式签名的纯文本回执,并支持验签。
 *
 * <p>签名算法:SHA-256(key + 0x00 + body + 0x00 + key),其中 0x00 作为分隔符
 * 防止拼接歧义(类似 HMAC 的 key 包裹结构)。验签用常数时间比较。
 */
public final class ReceiptPrinter {
    private final String issuer;
    // 签名密钥(构造时复制,防止外部引用被修改)
    private final byte[] signingKey;

    public ReceiptPrinter(String issuer, byte[] signingKey) {
        this.issuer = Objects.requireNonNull(issuer, "receipt issuer").strip();
        Objects.requireNonNull(signingKey, "receipt signing key");
        if (this.issuer.isEmpty() || this.issuer.length() > 80) {
            throw new IllegalArgumentException("receipt issuer is invalid");
        }
        if (signingKey.length < 16 || signingKey.length > 256) {
            throw new IllegalArgumentException("receipt signing key length is outside supported range");
        }
        this.signingKey = signingKey.clone();
    }

    /**
     * 生成回执:先把结算结果各字段拼成固定行式文本(字符串字段 Base64 编码),
     * 再对 body 计算签名并追加 signature 行。
     */
    public String print(MarketModels.SettlementResult result, Instant printedAt) {
        Objects.requireNonNull(result, "settlement result");
        Objects.requireNonNull(printedAt, "receipt print time");
        if (printedAt.isBefore(Instant.parse("2000-01-01T00:00:00Z"))) {
            throw new IllegalArgumentException("receipt print time predates platform support");
        }
        List<String> alternatives = new ArrayList<>(result.alternatives());
        alternatives.sort(String::compareTo);
        String body = "receipt-v1\n"
                + "issuer=" + Base64.getUrlEncoder().withoutPadding().encodeToString(
                        issuer.getBytes(StandardCharsets.UTF_8)
                ) + "\n"
                + "instruction=" + Base64.getUrlEncoder().withoutPadding().encodeToString(
                        result.instructionId().getBytes(StandardCharsets.UTF_8)
                ) + "\n"
                + "rail=" + Base64.getUrlEncoder().withoutPadding().encodeToString(
                        result.rail().getBytes(StandardCharsets.UTF_8)
                ) + "\n"
                + "value-date=" + result.valueDate() + "\n"
                + "after-cutoff=" + result.afterCutoff() + "\n"
                + "searched=" + result.calendarDaysSearched() + "\n"
                + "alternatives=" + String.join(",", alternatives) + "\n"
                + "printed=" + printedAt + "\n";
        if (body.length() > 64_000) {
            throw new IllegalStateException("receipt body exceeds sixty-four kilobytes");
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            // 密钥以 0x00 分隔包裹 body,使 key 边界唯一化
            digest.update(signingKey);
            digest.update((byte) 0);
            digest.update(body.getBytes(StandardCharsets.UTF_8));
            digest.update((byte) 0);
            digest.update(signingKey);
            String signature = Base64.getUrlEncoder().withoutPadding().encodeToString(digest.digest());
            return body + "signature=" + signature + "\n";
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    /**
     * 验签:定位签名行并重新计算 body 的签名做常数时间比对。
     * 同时校验字段集合完整性与签发方身份,任何不匹配都返回 false 而非抛异常。
     */
    public boolean verify(String receipt) {
        Objects.requireNonNull(receipt, "printed receipt");
        if (receipt.length() > 64_000) {
            throw new IllegalArgumentException("printed receipt exceeds sixty-four kilobytes");
        }
        String normalized = receipt.replace("\r\n", "\n");
        String marker = "signature=";
        // 签名行必须是最后一个字段:lastIndexOf 与 indexOf 一致才能确认唯一
        int signatureStart = normalized.lastIndexOf(marker);
        if (signatureStart < 0 || normalized.indexOf(marker) != signatureStart) {
            return false;
        }
        String body = normalized.substring(0, signatureStart);
        String signatureLine = normalized.substring(signatureStart + marker.length());
        if (!signatureLine.endsWith("\n")) {
            return false;
        }
        String encodedSignature = signatureLine.substring(0, signatureLine.length() - 1);
        byte[] supplied;
        try {
            supplied = Base64.getUrlDecoder().decode(encodedSignature);
        } catch (IllegalArgumentException failure) {
            return false;
        }
        String[] lines = body.split("\n");
        if (lines.length != 9 || !lines[0].equals("receipt-v1")) {
            return false;
        }
        Map<String, String> fields = new LinkedHashMap<>();
        for (int index = 1; index < lines.length; index++) {
            int separator = lines[index].indexOf('=');
            if (separator < 1) {
                return false;
            }
            if (fields.putIfAbsent(
                    lines[index].substring(0, separator),
                    lines[index].substring(separator + 1)
            ) != null) {
                return false;
            }
        }
        if (!fields.keySet().equals(Set.of(
                "issuer",
                "instruction",
                "rail",
                "value-date",
                "after-cutoff",
                "searched",
                "alternatives",
                "printed"
        ))) {
            return false;
        }
        String decodedIssuer;
        try {
            decodedIssuer = new String(
                    Base64.getUrlDecoder().decode(fields.get("issuer")),
                    StandardCharsets.UTF_8
            );
        } catch (IllegalArgumentException failure) {
            return false;
        }
        if (!decodedIssuer.equals(issuer)) {
            return false;
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(signingKey);
            digest.update((byte) 0);
            digest.update(body.getBytes(StandardCharsets.UTF_8));
            digest.update((byte) 0);
            digest.update(signingKey);
            byte[] expected = digest.digest();
            return MessageDigest.isEqual(expected, supplied);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }
}
