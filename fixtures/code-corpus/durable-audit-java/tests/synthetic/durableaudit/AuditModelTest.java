package synthetic.durableaudit;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 审计领域模型(AuditEvent/AuditBatch/WriteReceipt)的行为测试:
 * 字段规范化、校验与转义、批次汇总/排序/分片/公平交错,以及回执契约。
 */
final class AuditModelTest {
    /** 汇总入口:运行全部用例,返回本类新增的断言数。 */
    static int run() throws Exception {
        int before = TestSupport.assertions();
        constructsNormalizedEvent();
        rejectsMalformedEventFields();
        normalizesAmountsAndCurrencies();
        validatesAttributeContracts();
        convertsMapRepresentations();
        escapesCanonicalFields();
        estimatesUtf8PayloadSizes();
        comparesEventsAndCopies();
        constructsBatchSummaries();
        sealsBatchOrdering();
        detectsOrderingViolations();
        partitionsByCountAndBytes();
        groupsAndFairlyInterleavesTenants();
        validatesBatchContracts();
        verifiesReceiptContracts();
        return TestSupport.assertions() - before;
    }

    /** 事件构造应裁剪空白、排序属性、归一化币种。 */
    private static void constructsNormalizedEvent() {
        Map<String, String> attributes = new LinkedHashMap<>();
        attributes.put(" zone ", " east ");
        attributes.put("desk", " london ");
        AuditEvent event = new AuditEvent(
                UUID.fromString("00000000-0000-0000-0000-000000000007"),
                " tenant7 ",
                " trade.approved ",
                "account:EUR/USD",
                " operator seven ",
                TestSupport.BASE,
                Severity.WARNING,
                " eur ",
                new BigDecimal("19.2500"),
                7,
                attributes);
        TestSupport.equal("tenant7", event.tenant(), "tenant should be trimmed");
        TestSupport.equal("trade.approved", event.category(), "category should be trimmed");
        TestSupport.equal("operator seven", event.actor(), "actor should be trimmed");
        TestSupport.equal("EUR", event.currency(), "currency should be normalized");
        TestSupport.equal(new BigDecimal("19.2500"), event.amount(), "supported amount scale should be retained");
        TestSupport.equal(List.of("desk", "zone"), List.copyOf(event.attributes().keySet()), "attributes should be sorted");
        TestSupport.equal("london", event.attributes().get("desk"), "attribute values should be trimmed");
        TestSupport.check(event.canonicalKey().contains("tenant7/trade.approved/account:EUR/USD/7/"), "canonical key should contain stream identity");
        TestSupport.check(event.toString().contains("severity=WARNING"), "diagnostic text should include severity");
    }

    /** 租户/分类/主体/执行者/序号等非法字段应被拒绝。 */
    private static void rejectsMalformedEventFields() {
        UUID id = UUID.randomUUID();
        Map<String, String> none = Map.of();
        TestSupport.expectThrows(NullPointerException.class, () -> new AuditEvent(null, "tenant", "category", "subject", "actor", TestSupport.BASE, Severity.INFO, null, null, 0, none), "event identity is required");
        for (String tenant : List.of("", "A", "1tenant", "x", "contains space", "x".repeat(49))) {
            TestSupport.expectThrows(IllegalArgumentException.class, () -> new AuditEvent(id, tenant, "category", "subject", "actor", TestSupport.BASE, Severity.INFO, null, null, 0, none), "invalid tenant should fail");
        }
        for (String category : List.of("", "A", "x", "two words", "x".repeat(65))) {
            TestSupport.expectThrows(IllegalArgumentException.class, () -> new AuditEvent(id, "tenant", category, "subject", "actor", TestSupport.BASE, Severity.INFO, null, null, 0, none), "invalid category should fail");
        }
        for (String subject : List.of("", "*wildcard", "x".repeat(129))) {
            TestSupport.expectThrows(IllegalArgumentException.class, () -> new AuditEvent(id, "tenant", "category", subject, "actor", TestSupport.BASE, Severity.INFO, null, null, 0, none), "invalid subject should fail");
        }
        for (String actor : List.of("", "  ", "line\nbreak", "x".repeat(129))) {
            TestSupport.expectThrows(IllegalArgumentException.class, () -> new AuditEvent(id, "tenant", "category", "subject", actor, TestSupport.BASE, Severity.INFO, null, null, 0, none), "invalid actor should fail");
        }
        TestSupport.expectThrows(IllegalArgumentException.class, () -> new AuditEvent(id, "tenant", "category", "subject", "actor", TestSupport.BASE, Severity.INFO, null, null, -1, none), "negative sequence should fail");
    }

    /** 币种与金额必须成对出现;金额超精度时银行家舍入,超范围拒绝。 */
    private static void normalizesAmountsAndCurrencies() {
        AuditEvent rounded = TestSupport.event("money", "account:1", 1, TestSupport.BASE, Severity.NOTICE, "gbp", new BigDecimal("1.234567895"), Map.of());
        TestSupport.equal("GBP", rounded.currency(), "lowercase currency should normalize");
        TestSupport.equal(new BigDecimal("1.2345679"), rounded.amount(), "ninth decimal should use half-even rounding");
        AuditEvent negative = TestSupport.event("money", "account:2", 2, TestSupport.BASE, Severity.ERROR, "JPY", new BigDecimal("-500"), Map.of());
        TestSupport.equal(new BigDecimal("-500"), negative.amount(), "negative audit adjustments should be retained");
        AuditEvent absent = TestSupport.event("money", "account:3", 3);
        TestSupport.equal(null, absent.currency(), "currency may be absent with amount");
        TestSupport.equal(null, absent.amount(), "amount may be absent with currency");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> TestSupport.event("money", "account:4", 4, TestSupport.BASE, Severity.INFO, null, BigDecimal.ONE, Map.of()), "amount requires currency");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> TestSupport.event("money", "account:5", 5, TestSupport.BASE, Severity.INFO, "USD", null, Map.of()), "currency requires amount");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> TestSupport.event("money", "account:6", 6, TestSupport.BASE, Severity.INFO, "US", BigDecimal.ONE, Map.of()), "short currency should fail");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> TestSupport.event("money", "account:7", 7, TestSupport.BASE, Severity.INFO, "USD", new BigDecimal("1000000000000000"), Map.of()), "limit amount should fail");
    }

    /** 属性:排序、不可变、去空白后不得重复、保留字与数量/长度受限。 */
    private static void validatesAttributeContracts() {
        AuditEvent event = TestSupport.event("attrs", "account:1", 1, TestSupport.BASE, Severity.INFO, null, null, Map.of("b", "2", "a", "1"));
        TestSupport.equal(List.of("a", "b"), List.copyOf(event.attributes().keySet()), "attributes should have deterministic order");
        TestSupport.expectThrows(UnsupportedOperationException.class, () -> event.attributes().put("c", "3"), "attributes should be immutable");
        Map<String, String> duplicates = new LinkedHashMap<>();
        duplicates.put("same", "one");
        duplicates.put(" same ", "two");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> event.withAttributes(duplicates), "trimmed attribute duplicates should fail");
        for (String reserved : List.of("signature", "previousHash", "ordinal")) {
            TestSupport.expectThrows(IllegalArgumentException.class, () -> event.withAttributes(Map.of(reserved, "x")), "reserved attributes should fail");
        }
        TestSupport.expectThrows(IllegalArgumentException.class, () -> event.withAttributes(TestSupport.attributes(49, 1)), "attribute count should be bounded");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> event.withAttributes(Map.of("k".repeat(65), "v")), "attribute keys should be bounded");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> event.withAttributes(Map.of("key", "v".repeat(513))), "attribute values should be bounded");
    }

    /** fromMap 宽松解析:缺省执行者、大小写不敏感严重级别、类型转换。 */
    private static void convertsMapRepresentations() {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put("eventId", "00000000-0000-0000-0000-000000000123");
        values.put("tenant", "mapped");
        values.put("category", "audit.mapped");
        values.put("subject", "account:123");
        values.put("occurredAt", "2026-07-13T10:15:30Z");
        values.put("severity", "critical");
        values.put("currency", "cad");
        values.put("amount", "12.3400");
        values.put("accountSequence", "81");
        Map<String, Object> attributeValues = new LinkedHashMap<>();
        attributeValues.put("approved", true);
        attributeValues.put("attempts", 3);
        attributeValues.put("nullable", null);
        values.put("attributes", attributeValues);
        AuditEvent event = AuditEvent.fromMap(values);
        TestSupport.equal("system", event.actor(), "missing actor should default");
        TestSupport.equal(Severity.CRITICAL, event.severity(), "severity text should parse case-insensitively");
        TestSupport.equal(81L, event.accountSequence(), "numeric string sequence should parse");
        TestSupport.equal("true", event.attributes().get("approved"), "boolean attribute should become text");
        TestSupport.equal("", event.attributes().get("nullable"), "null attribute should become empty text");
        values.put("eventId", "not-a-uuid");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> AuditEvent.fromMap(values), "invalid map identity should fail");
        values.put("eventId", UUID.randomUUID());
        values.put("occurredAt", "next Tuesday");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> AuditEvent.fromMap(values), "invalid map time should fail");
        values.put("occurredAt", TestSupport.BASE);
        values.put("severity", "unknown");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> AuditEvent.fromMap(values), "unknown severity should fail");
    }

    /** 字段编码应转义换行/分隔符/反斜杠,保证可逆。 */
    private static void escapesCanonicalFields() {
        AuditEvent event = TestSupport.event("escape", "account:pipe", 4, TestSupport.BASE, Severity.INFO, null, null, Map.of("line", "one\ntwo", "pipe", "a|b", "slash", "a\\b"));
        String fields = new String(event.encodeFields(), java.nio.charset.StandardCharsets.UTF_8);
        TestSupport.check(fields.contains("one\\ntwo"), "newlines should be escaped");
        TestSupport.check(fields.contains("a\\|b"), "field separators should be escaped");
        TestSupport.check(fields.contains("a\\\\b"), "backslashes should be escaped");
        TestSupport.check(fields.endsWith("|"), "encoded fields should end at a boundary");
    }

    /** UTF-8 字节估算应正确处理 ASCII/CJK/增补平面字符。 */
    private static void estimatesUtf8PayloadSizes() {
        TestSupport.equal(3, AuditEvent.utf8Length("abc"), "ASCII byte count should match");
        TestSupport.equal(6, AuditEvent.utf8Length("东京"), "CJK byte count should match UTF-8");
        TestSupport.equal(4, AuditEvent.utf8Length("😀"), "supplementary character should use four bytes");
        AuditEvent small = TestSupport.event("bytes", "account:1", 1);
        AuditEvent rich = small.withAttributes(Map.of("emoji", "😀😀", "city", "東京"));
        TestSupport.check(rich.estimatedBytes() > small.estimatedBytes(), "attributes should increase estimate");
    }

    /** 相等性、哈希与全序比较应反映语义字段。 */
    private static void comparesEventsAndCopies() {
        AuditEvent original = TestSupport.event("copy", "account:1", 1, TestSupport.BASE, Severity.WARNING, "EUR", new BigDecimal("5"), Map.of("key", "value"));
        AuditEvent same = original.withActor(original.actor());
        TestSupport.equal(original, same, "semantic copy should compare equal");
        TestSupport.equal(original.hashCode(), same.hashCode(), "equal events should share hash");
        AuditEvent changed = original.withAmount(new BigDecimal("6"));
        TestSupport.check(!original.equals(changed), "amount change should alter equality");
        AuditEvent later = TestSupport.event("copy", "account:1", 2, TestSupport.BASE.plusSeconds(1), Severity.INFO, null, null, Map.of());
        TestSupport.check(original.belongsBefore(later), "earlier event should sort before later event");
        TestSupport.check(!later.belongsBefore(original), "later event should not sort before earlier event");
    }

    /** 批次汇总:租户计数、最大流序号、字节估算、负载与不可变性。 */
    private static void constructsBatchSummaries() {
        List<AuditEvent> events = List.of(
                TestSupport.event("tenant-a", "account:1", 1),
                TestSupport.event("tenant-b", "account:2", 3),
                TestSupport.event("tenant-a", "account:1", 4),
                TestSupport.event("tenant-a", "account:3", 2));
        AuditBatch batch = new AuditBatch(9, TestSupport.BASE, events);
        TestSupport.equal(4, batch.events().size(), "batch should retain all events");
        TestSupport.equal(Map.of("tenant-a", 3, "tenant-b", 1), batch.tenantCounts(), "tenant totals should aggregate");
        TestSupport.equal(4L, batch.greatestSequenceBySubject().get("tenant-a/account:1"), "greatest stream sequence should aggregate");
        TestSupport.check(batch.estimatedBytes() > events.stream().mapToLong(AuditEvent::estimatedBytes).sum(), "batch estimate should include header");
        TestSupport.check(batch.payloadBytes().length > 32, "batch payload should contain header and events");
        TestSupport.equal(Duration.ZERO, batch.ageAt(TestSupport.BASE.minusSeconds(1)), "age before creation should clamp to zero");
        TestSupport.equal(Duration.ofMinutes(3), batch.ageAt(TestSupport.BASE.plusSeconds(180)), "batch age should be measured from creation");
        TestSupport.expectThrows(UnsupportedOperationException.class, () -> batch.events().add(events.get(0)), "batch events should be immutable");
    }

    /** 密封排序按 租户/主体/序号/时间/ID;已有序批次返回自身。 */
    private static void sealsBatchOrdering() {
        AuditEvent third = TestSupport.event("tenant-b", "account:2", 5);
        AuditEvent second = TestSupport.event("tenant-a", "account:2", 3);
        AuditEvent first = TestSupport.event("tenant-a", "account:1", 8);
        AuditBatch source = new AuditBatch(1, TestSupport.BASE, List.of(third, second, first));
        AuditBatch sealed = source.sealed();
        TestSupport.equal(List.of(first, second, third), sealed.events(), "sealed order should use tenant, subject, then sequence");
        TestSupport.check(sealed != source, "unsorted batch should create sealed copy");
        TestSupport.check(sealed.sealed() == sealed, "already sealed batch should return itself");
        TestSupport.check(source.checksum() != sealed.checksum(), "event order should affect checksum");
    }

    /** 同一流内序号回归或重复都应被识别为顺序违规。 */
    private static void detectsOrderingViolations() {
        List<AuditEvent> events = List.of(
                TestSupport.eventWithId("v1", "tenant-a", "account:1", 1),
                TestSupport.eventWithId("v3", "tenant-a", "account:1", 3),
                TestSupport.eventWithId("v2", "tenant-a", "account:1", 2),
                TestSupport.eventWithId("equal", "tenant-a", "account:1", 2),
                TestSupport.eventWithId("other", "tenant-a", "account:2", 1));
        List<String> violations = new AuditBatch(4, TestSupport.BASE, events).orderingViolations();
        TestSupport.equal(2, violations.size(), "regression and equality should both violate ordering");
        TestSupport.check(violations.get(0).contains("follows 3 with 2"), "regression should describe prior sequence");
        TestSupport.check(violations.get(1).contains("follows 2 with 2"), "equal sequence should be rejected");
    }

    /** 按 事件数/字节数 双维度分片,子批次号可追溯,事件不丢失。 */
    private static void partitionsByCountAndBytes() {
        AuditBatch batch = TestSupport.batch(7, 11);
        List<AuditBatch> byCount = batch.partition(4, Long.MAX_VALUE);
        TestSupport.equal(List.of(4, 4, 3), byCount.stream().map(part -> part.events().size()).toList(), "count partitions should respect limit");
        TestSupport.equal(List.of(700000L, 700001L, 700002L), byCount.stream().map(AuditBatch::batchNumber).toList(), "part numbers should derive from source");
        long twoEvents = 64 + batch.events().get(0).estimatedBytes() + batch.events().get(1).estimatedBytes();
        List<AuditBatch> byBytes = batch.partition(100, twoEvents);
        TestSupport.check(byBytes.stream().allMatch(part -> part.events().size() <= 2), "byte partitions should be bounded");
        TestSupport.equal(11, byBytes.stream().mapToInt(part -> part.events().size()).sum(), "partitioning should retain every event");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> batch.partition(0, 10), "zero count should fail");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> batch.partition(1, 0), "zero bytes should fail");
    }

    /** 按租户分组保持首次出现顺序;公平交错轮转不丢事件。 */
    private static void groupsAndFairlyInterleavesTenants() {
        List<AuditEvent> events = new ArrayList<>();
        for (int index = 0; index < 6; index++) {
            events.add(TestSupport.eventWithId("large-" + index, "large", "account:1", index));
        }
        events.add(TestSupport.eventWithId("small-a", "small", "account:2", 1));
        events.add(TestSupport.eventWithId("small-b", "small", "account:2", 2));
        events.add(TestSupport.eventWithId("middle-a", "middle", "account:3", 1));
        AuditBatch batch = new AuditBatch(2, TestSupport.BASE, events);
        Map<String, List<AuditEvent>> grouped = batch.groupByTenant();
        TestSupport.equal(List.of("large", "small", "middle"), List.copyOf(grouped.keySet()), "grouping should preserve first encounter");
        TestSupport.equal(6, grouped.get("large").size(), "large tenant group should retain volume");
        TestSupport.expectThrows(UnsupportedOperationException.class, () -> grouped.put("new", List.of()), "group map should be immutable");
        List<AuditEvent> fair = batch.fairTenantOrder();
        TestSupport.equal(events.size(), fair.size(), "fair ordering should retain all events");
        TestSupport.equal(3L, fair.subList(0, 3).stream().map(AuditEvent::tenant).distinct().count(), "first cycle should include each tenant");
        TestSupport.equal(events.stream().map(AuditEvent::eventId).sorted().toList(), fair.stream().map(AuditEvent::eventId).sorted().toList(), "fair ordering should preserve identities");
    }

    /** 批次契约:编号非负、非空、事件去重、数量上限。 */
    private static void validatesBatchContracts() {
        AuditEvent source = TestSupport.event("batch", "account:1", 1);
        TestSupport.expectThrows(IllegalArgumentException.class, () -> new AuditBatch(-1, TestSupport.BASE, List.of(source)), "negative number should fail");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> new AuditBatch(0, TestSupport.BASE, List.of()), "empty batch should fail");
        TestSupport.expectThrows(NullPointerException.class, () -> new AuditBatch(0, null, List.of(source)), "creation time should be required");
        TestSupport.expectThrows(NullPointerException.class, () -> new AuditBatch(0, TestSupport.BASE, null), "source should be required");
        TestSupport.expectThrows(NullPointerException.class, () -> new AuditBatch(0, TestSupport.BASE, java.util.Arrays.asList(source, null)), "null event should fail");
        TestSupport.expectThrows(IllegalArgumentException.class, () -> new AuditBatch(0, TestSupport.BASE, List.of(source, source)), "duplicate identity should fail");
        List<AuditEvent> tooMany = new ArrayList<>();
        for (int index = 0; index < 10_001; index++) {
            tooMany.add(TestSupport.eventWithId("limit-" + index, "limit", "account:1", index));
        }
        TestSupport.expectThrows(IllegalArgumentException.class, () -> new AuditBatch(0, TestSupport.BASE, tooMany), "event limit should be enforced");
    }

    /** 回执契约:位置/大小非负、事件数/字节数正、摘要为 64 位十六进制。 */
    private static void verifiesReceiptContracts() {
        WriteReceipt receipt = new WriteReceipt(4, 2, 99, 3, 500, TestSupport.BASE, "a".repeat(64));
        TestSupport.equal(4L, receipt.batchNumber(), "receipt should retain batch number");
        TestSupport.equal(3, receipt.eventCount(), "receipt should retain event count");
        for (TestSupport.ThrowingRunnable invalid : List.<TestSupport.ThrowingRunnable>of(
                () -> new WriteReceipt(-1, 0, 0, 1, 1, TestSupport.BASE, "a".repeat(64)),
                () -> new WriteReceipt(0, -1, 0, 1, 1, TestSupport.BASE, "a".repeat(64)),
                () -> new WriteReceipt(0, 0, -1, 1, 1, TestSupport.BASE, "a".repeat(64)),
                () -> new WriteReceipt(0, 0, 0, 0, 1, TestSupport.BASE, "a".repeat(64)),
                () -> new WriteReceipt(0, 0, 0, 1, 0, TestSupport.BASE, "a".repeat(64)),
                () -> new WriteReceipt(0, 0, 0, 1, 1, TestSupport.BASE, "short"))) {
            TestSupport.expectThrows(IllegalArgumentException.class, invalid, "invalid receipt field should fail");
        }
    }
}
