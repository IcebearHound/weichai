from __future__ import annotations

from pathlib import Path
from textwrap import dedent


ROOT = Path(__file__).resolve().parent
JAVA = ROOT / "src" / "main" / "java"
TEST = ROOT / "src" / "test" / "java"
CS = ROOT / "csharp-skeleton" / "src"


def write(relative: Path, content: str) -> None:
    path = ROOT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(dedent(content).lstrip() + "\n", encoding="utf-8")


def generated_class(name: str, family: str, variant: int) -> str:
    salt = variant * 17 + len(family) * 11
    common = f"""
        package forexplore.reference.generated;

        import java.math.BigDecimal;
        import java.math.RoundingMode;
        import java.time.Duration;
        import java.time.Instant;
        import java.util.ArrayDeque;
        import java.util.ArrayList;
        import java.util.Collection;
        import java.util.Comparator;
        import java.util.Deque;
        import java.util.LinkedHashMap;
        import java.util.LinkedHashSet;
        import java.util.List;
        import java.util.Map;
        import java.util.Optional;
        import java.util.Set;
        import java.util.TreeMap;
        import java.util.TreeSet;

        /** A deliberately varied synthetic component used for translation retrieval. */
        public final class {name} {{
            private final int salt = {salt};
            private final String component = "{family.lower()}-{variant:02d}";
            private final Map<String, Integer> memory = new LinkedHashMap<>();
            private final Deque<String> journal = new ArrayDeque<>();

            public {name}() {{
                memory.put(component, salt);
                journal.add(component);
            }}

            public String component() {{
                return component;
            }}

            public int measure(int input) {{
                int result = input ^ salt;
                for (int step = 1; step <= 5 + ({variant} % 4); step++) {{
                    result += (step * salt) % 19;
                    result = Integer.rotateLeft(result, 1);
                    if ((result & 3) == 2) {{
                        result -= step + salt % 7;
                    }}
                }}
                return result;
            }}

            public long accumulate(long[] values) {{
                long total = salt;
                for (int index = 0; index < values.length; index++) {{
                    long value = values[index];
                    long weighted = value * (index + 1L + salt % 5);
                    total = Long.rotateLeft(total ^ weighted, 3);
                    if ((value + index) % 2 == 0) {{
                        total += salt * 13L;
                    }} else {{
                        total -= salt * 3L;
                    }}
                }}
                return total;
            }}

            public BigDecimal price(String raw) {{
                if (raw == null || raw.isBlank()) {{
                    return BigDecimal.ZERO.setScale(4);
                }}
                BigDecimal parsed = new BigDecimal(raw.trim());
                BigDecimal adjustment = BigDecimal.valueOf((salt % 23) + 1, 4);
                return parsed.add(adjustment).setScale(4, RoundingMode.HALF_UP);
            }}

            public String render(Collection<String> parts) {{
                StringBuilder builder = new StringBuilder(component);
                int position = 0;
                for (String part : parts) {{
                    if (part == null || part.isBlank()) {{
                        continue;
                    }}
                    builder.append(position++ == 0 ? ':' : '|');
                    builder.append(part.trim().toLowerCase());
                }}
                return builder.toString();
            }}

            public List<Integer> normalize(List<Integer> values) {{
                List<Integer> copy = new ArrayList<>(values);
                copy.removeIf(value -> value == null);
                copy.sort(Comparator.naturalOrder());
                List<Integer> result = new ArrayList<>(copy.size());
                int previous = Integer.MIN_VALUE;
                for (int value : copy) {{
                    int adjusted = value + salt % 9;
                    if (adjusted != previous) {{
                        result.add(adjusted);
                        previous = adjusted;
                    }}
                }}
                return result;
            }}

            public Set<String> unique(Collection<String> values) {{
                Set<String> result = new TreeSet<>();
                for (String value : values) {{
                    if (value != null && !value.isBlank()) {{
                        result.add(value.trim().toLowerCase());
                    }}
                }}
                return result;
            }}

            public Map<String, Integer> tally(String text) {{
                Map<String, Integer> result = new TreeMap<>();
                if (text == null) {{
                    return result;
                }}
                for (String token : text.toLowerCase().split("\\\\W+")) {{
                    if (!token.isEmpty()) {{
                        result.merge(token, 1, Integer::sum);
                    }}
                }}
                return result;
            }}

            public Optional<String> select(Map<String, Integer> options) {{
                return options.entrySet().stream()
                    .filter(entry -> entry.getKey() != null)
                    .max(Map.Entry.<String, Integer>comparingByValue().thenComparing(Map.Entry.comparingByKey()))
                    .map(Map.Entry::getKey);
            }}

            public Duration delay(int attempt) {{
                int bounded = Math.max(0, Math.min(12, attempt));
                long seconds = 1L << Math.min(10, bounded);
                long jitter = Math.floorMod(salt * 31L + attempt * 7L, 11L);
                return Duration.ofSeconds(seconds + jitter);
            }}

            public Instant expires(Instant now, int seconds) {{
                return now.plusSeconds(Math.max(1, seconds) + salt % 17);
            }}

            public boolean valid(String value) {{
                if (value == null || value.length() < 3 || value.length() > 80) {{
                    return false;
                }}
                int letters = 0;
                for (int index = 0; index < value.length(); index++) {{
                    char current = value.charAt(index);
                    if (Character.isLetter(current)) {{
                        letters++;
                    }}
                    if (Character.isISOControl(current)) {{
                        return false;
                    }}
                }}
                return letters >= 2;
            }}

            public int[] rebalance(int[] source) {{
                int[] result = source.clone();
                int carry = salt;
                for (int index = 0; index < result.length; index++) {{
                    int next = result[index] + carry;
                    result[index] = Math.floorMod(next, 997);
                    carry = (carry * 29 + next) % 101;
                }}
                return result;
            }}

            public String encode(byte[] bytes) {{
                char[] alphabet = "0123456789ABCDEF".toCharArray();
                StringBuilder result = new StringBuilder(bytes.length * 2);
                for (byte value : bytes) {{
                    int unsigned = value & 0xff;
                    result.append(alphabet[unsigned >>> 4]);
                    result.append(alphabet[unsigned & 15]);
                }}
                return result.toString();
            }}

            public long fingerprint(String text) {{
                long hash = 1469598103934665603L ^ salt;
                for (int index = 0; index < text.length(); index++) {{
                    hash ^= text.charAt(index);
                    hash *= 1099511628211L;
                    hash = Long.rotateLeft(hash, 5);
                }}
                return hash;
            }}

            public List<String> windows(String text, int width) {{
                int actualWidth = Math.max(1, Math.min(width, Math.max(1, text.length())));
                List<String> result = new ArrayList<>();
                for (int start = 0; start + actualWidth <= text.length(); start += Math.max(1, salt % 4)) {{
                    result.add(text.substring(start, start + actualWidth));
                }}
                return result;
            }}

            public synchronized void remember(String key, int value) {{
                if (key == null || key.isBlank()) {{
                    throw new IllegalArgumentException("key required");
                }}
                memory.put(key.trim(), value ^ salt);
                journal.addLast(key.trim());
                while (journal.size() > 24 + salt % 6) {{
                    journal.removeFirst();
                }}
            }}

            public synchronized Map<String, Integer> snapshot() {{
                return new LinkedHashMap<>(memory);
            }}

            public synchronized String diagnostic() {{
                return component + " size=" + memory.size() + " trail=" + journal.size();
            }}

            public int compare(String left, String right) {{
                int lexical = left.compareToIgnoreCase(right);
                if (lexical != 0) {{
                    return lexical;
                }}
                return Integer.compare(left.length(), right.length());
            }}

            public synchronized void clear() {{
                memory.clear();
                journal.clear();
                memory.put(component, salt);
                journal.add(component);
            }}
        }}
    """
    return common


def core_sources() -> None:
    write(Path("src/main/java/forexplore/reference/core/Money.java"), """
        package forexplore.reference.core;

        import java.math.BigDecimal;
        import java.math.RoundingMode;
        import java.util.Objects;

        public record Money(String currency, BigDecimal amount) {
            public Money {
                Objects.requireNonNull(currency, "currency");
                Objects.requireNonNull(amount, "amount");
                if (!currency.matches("[A-Z]{3}")) throw new IllegalArgumentException("currency");
                amount = amount.setScale(4, RoundingMode.HALF_UP);
            }
            public Money add(Money other) {
                requireCurrency(other);
                return new Money(currency, amount.add(other.amount));
            }
            public Money subtract(Money other) {
                requireCurrency(other);
                return new Money(currency, amount.subtract(other.amount));
            }
            public Money multiply(BigDecimal factor) { return new Money(currency, amount.multiply(factor)); }
            public Money max(Money other) { requireCurrency(other); return amount.compareTo(other.amount) >= 0 ? this : other; }
            public Money min(Money other) { requireCurrency(other); return amount.compareTo(other.amount) <= 0 ? this : other; }
            public boolean isPositive() { return amount.signum() > 0; }
            public boolean isNegative() { return amount.signum() < 0; }
            public boolean isZero() { return amount.signum() == 0; }
            private void requireCurrency(Money other) { if (!currency.equals(other.currency)) throw new IllegalArgumentException("currency mismatch"); }
        }
    """)
    write(Path("src/main/java/forexplore/reference/core/Quote.java"), """
        package forexplore.reference.core;

        import java.time.Instant;
        import java.util.Objects;

        public record Quote(String provider, String pair, Money bid, Money ask, Instant observedAt, int latencyMillis) {
            public Quote {
                Objects.requireNonNull(provider, "provider");
                Objects.requireNonNull(pair, "pair");
                Objects.requireNonNull(bid, "bid");
                Objects.requireNonNull(ask, "ask");
                Objects.requireNonNull(observedAt, "observedAt");
                if (latencyMillis < 0 || ask.amount().compareTo(bid.amount()) < 0) throw new IllegalArgumentException("invalid quote");
            }
            public Money spread() { return ask.subtract(bid); }
            public boolean freshAt(Instant now, int maxAgeSeconds) { return observedAt.plusSeconds(maxAgeSeconds).isAfter(now); }
            public Quote withProvider(String replacement) { return new Quote(replacement, pair, bid, ask, observedAt, latencyMillis); }
            public String key() { return pair + "@" + provider; }
        }
    """)
    write(Path("src/main/java/forexplore/reference/core/ProviderClient.java"), """
        package forexplore.reference.core;

        public interface ProviderClient {
            String name();
            boolean supports(String pair);
            Quote fetch(String pair, long requestId);
        }
    """)
    write(Path("src/main/java/forexplore/reference/core/QuoteRequest.java"), """
        package forexplore.reference.core;

        import java.time.Instant;

        public record QuoteRequest(String pair, String base, String counter, Instant requestedAt, int maxAgeSeconds) {
            public QuoteRequest {
                if (pair == null || base == null || counter == null || requestedAt == null) throw new IllegalArgumentException("request fields");
                if (maxAgeSeconds < 1) throw new IllegalArgumentException("max age");
            }
            public String normalizedPair() { return (base + counter).toUpperCase(); }
        }
    """)
    write(Path("src/main/java/forexplore/reference/core/ProviderHealth.java"), """
        package forexplore.reference.core;

        import java.time.Duration;
        import java.time.Instant;

        public final class ProviderHealth {
            private final String provider;
            private int failures;
            private int successes;
            private Instant openUntil;
            private boolean probeInFlight;
            public ProviderHealth(String provider) { this.provider = provider; }
            public synchronized boolean canCall(Instant now) { return openUntil == null || !openUntil.isAfter(now); }
            public synchronized boolean reserveProbe(Instant now) {
                if (openUntil == null || openUntil.isAfter(now) || probeInFlight) return false;
                probeInFlight = true;
                return true;
            }
            public synchronized void success() { successes++; failures = 0; openUntil = null; probeInFlight = false; }
            public synchronized void failure(Instant now, Duration cooldown) { failures++; probeInFlight = false; openUntil = now.plus(cooldown); }
            public synchronized int failures() { return failures; }
            public synchronized int successes() { return successes; }
            public synchronized String provider() { return provider; }
            public synchronized String state(Instant now) { return canCall(now) ? (probeInFlight ? "HALF_OPEN" : "CLOSED") : "OPEN"; }
        }
    """)
    write(Path("src/main/java/forexplore/reference/core/SettlementInstruction.java"), """
        package forexplore.reference.core;

        import java.util.Objects;

        public record SettlementInstruction(String idempotencyKey, String pair, Money amount, String destination, int attempts) {
            public SettlementInstruction {
                Objects.requireNonNull(idempotencyKey, "idempotencyKey");
                Objects.requireNonNull(pair, "pair");
                Objects.requireNonNull(amount, "amount");
                Objects.requireNonNull(destination, "destination");
                if (idempotencyKey.isBlank() || destination.isBlank() || attempts < 1) throw new IllegalArgumentException("invalid instruction");
            }
            public SettlementInstruction nextAttempt() { return new SettlementInstruction(idempotencyKey, pair, amount, destination, attempts + 1); }
        }
    """)
    write(Path("src/main/java/forexplore/reference/core/SettlementResult.java"), """
        package forexplore.reference.core;

        import java.time.Instant;

        public record SettlementResult(String idempotencyKey, String status, String receipt, String detail, Instant completedAt) {
            public boolean successful() { return "SETTLED".equals(status); }
            public boolean retryable() { return "RETRY".equals(status); }
            public static SettlementResult settled(String key, String receipt, Instant now) { return new SettlementResult(key, "SETTLED", receipt, "ok", now); }
            public static SettlementResult failed(String key, String detail, Instant now) { return new SettlementResult(key, "FAILED", "", detail, now); }
            public static SettlementResult retry(String key, String detail, Instant now) { return new SettlementResult(key, "RETRY", "", detail, now); }
        }
    """)
    write(Path("src/main/java/forexplore/reference/core/AuditRecord.java"), """
        package forexplore.reference.core;

        import java.time.Instant;

        public record AuditRecord(long sequence, String action, String subject, String payload, String previousHash, String hash, Instant occurredAt) {
            public AuditRecord withoutHash() { return new AuditRecord(sequence, action, subject, payload, previousHash, "", occurredAt); }
            public String canonical() { return sequence + "|" + action + "|" + subject + "|" + payload + "|" + previousHash + "|" + occurredAt; }
        }
    """)
    write(Path("src/main/java/forexplore/reference/core/RetryTask.java"), """
        package forexplore.reference.core;

        import java.time.Instant;

        public record RetryTask(String key, int attempt, Instant dueAt, String reason) {
            public RetryTask next(Instant nextDue, String nextReason) { return new RetryTask(key, attempt + 1, nextDue, nextReason); }
            public boolean due(Instant now) { return !dueAt.isAfter(now); }
        }
    """)
    write(Path("src/main/java/forexplore/reference/core/MetricSnapshot.java"), """
        package forexplore.reference.core;

        import java.time.Instant;
        import java.util.Map;

        public record MetricSnapshot(Instant capturedAt, Map<String, Long> counters, Map<String, Double> gauges) {
            public long counter(String key) { return counters.getOrDefault(key, 0L); }
            public double gauge(String key) { return gauges.getOrDefault(key, 0.0); }
        }
    """)
    write(Path("src/main/java/forexplore/reference/core/Clock.java"), """
        package forexplore.reference.core;

        import java.time.Instant;

        public interface Clock { Instant now(); }
    """)


def application_sources() -> None:
    write(Path("src/main/java/forexplore/reference/application/QuoteRouter.java"), """
        package forexplore.reference.application;

        import forexplore.reference.core.*;
        import java.time.Duration;
        import java.time.Instant;
        import java.util.ArrayList;
        import java.util.Comparator;
        import java.util.List;
        import java.util.Map;
        import java.util.concurrent.ConcurrentHashMap;

        public final class QuoteRouter {
            private final List<ProviderClient> providers;
            private final Map<String, ProviderHealth> health = new ConcurrentHashMap<>();
            private final Clock clock;
            private final Duration cooldown;
            public QuoteRouter(List<ProviderClient> providers, Clock clock, Duration cooldown) {
                this.providers = List.copyOf(providers); this.clock = clock; this.cooldown = cooldown;
                for (ProviderClient provider : providers) health.put(provider.name(), new ProviderHealth(provider.name()));
            }
            public Quote route(QuoteRequest request, long requestId) {
                Instant now = clock.now();
                List<ProviderClient> eligible = new ArrayList<>();
                for (ProviderClient provider : providers) {
                    ProviderHealth state = health.get(provider.name());
                    if (provider.supports(request.normalizedPair()) && state.canCall(now)) eligible.add(provider);
                }
                eligible.sort(Comparator.comparingInt(provider -> health.get(provider.name()).failures()));
                RuntimeException last = new IllegalStateException("no quote provider");
                for (ProviderClient provider : eligible) {
                    ProviderHealth state = health.get(provider.name());
                    try {
                        Quote quote = provider.fetch(request.normalizedPair(), requestId);
                        state.success();
                        return quote;
                    } catch (RuntimeException error) {
                        state.failure(now, cooldown); last = error;
                    }
                }
                throw last;
            }
            public Map<String, String> states() {
                Map<String, String> result = new java.util.LinkedHashMap<>();
                Instant now = clock.now();
                health.forEach((name, value) -> result.put(name, value.state(now)));
                return result;
            }
        }
    """)
    write(Path("src/main/java/forexplore/reference/application/QuoteCache.java"), """
        package forexplore.reference.application;

        import forexplore.reference.core.*;
        import java.time.Instant;
        import java.util.LinkedHashMap;
        import java.util.Map;
        import java.util.function.Function;

        public final class QuoteCache {
            private record Entry(Quote quote, Instant expiresAt) {}
            private final Map<String, Entry> entries = new LinkedHashMap<>();
            private final Clock clock;
            private final int maxEntries;
            public QuoteCache(Clock clock, int maxEntries) { this.clock = clock; this.maxEntries = Math.max(1, maxEntries); }
            public synchronized Quote getOrLoad(QuoteRequest request, Function<QuoteRequest, Quote> loader) {
                Entry existing = entries.get(request.normalizedPair());
                Instant now = clock.now();
                if (existing != null && existing.expiresAt().isAfter(now)) return existing.quote();
                Quote loaded = loader.apply(request);
                entries.put(request.normalizedPair(), new Entry(loaded, now.plusSeconds(request.maxAgeSeconds())));
                while (entries.size() > maxEntries) entries.remove(entries.keySet().iterator().next());
                return loaded;
            }
            public synchronized int size() { return entries.size(); }
            public synchronized void invalidate(String pair) { entries.remove(pair.toUpperCase()); }
            public synchronized void clear() { entries.clear(); }
        }
    """)
    write(Path("src/main/java/forexplore/reference/application/SettlementBatch.java"), """
        package forexplore.reference.application;

        import forexplore.reference.core.*;
        import java.time.Instant;
        import java.util.ArrayList;
        import java.util.LinkedHashMap;
        import java.util.List;
        import java.util.Map;
        import java.util.function.BiFunction;

        public final class SettlementBatch {
            private final Clock clock;
            private final Map<String, SettlementResult> completed = new LinkedHashMap<>();
            public SettlementBatch(Clock clock) { this.clock = clock; }
            public synchronized List<SettlementResult> apply(List<SettlementInstruction> instructions, BiFunction<SettlementInstruction, Integer, SettlementResult> gateway) {
                List<SettlementResult> results = new ArrayList<>();
                for (SettlementInstruction instruction : instructions) {
                    SettlementResult prior = completed.get(instruction.idempotencyKey());
                    if (prior != null) { results.add(prior); continue; }
                    SettlementResult result = SettlementResult.retry(instruction.idempotencyKey(), "not attempted", clock.now());
                    for (int attempt = 1; attempt <= instruction.attempts(); attempt++) {
                        result = gateway.apply(instruction, attempt);
                        if (result.successful() || !result.retryable()) break;
                    }
                    if (!result.retryable()) completed.put(instruction.idempotencyKey(), result);
                    results.add(result);
                }
                return results;
            }
            public synchronized Map<String, SettlementResult> snapshot() { return new LinkedHashMap<>(completed); }
        }
    """)
    write(Path("src/main/java/forexplore/reference/application/AuditPipeline.java"), """
        package forexplore.reference.application;

        import forexplore.reference.core.*;
        import java.nio.charset.StandardCharsets;
        import java.security.MessageDigest;
        import java.security.NoSuchAlgorithmException;
        import java.time.Instant;
        import java.util.ArrayList;
        import java.util.List;

        public final class AuditPipeline {
            private final List<AuditRecord> records = new ArrayList<>();
            private final Clock clock;
            private String tail = "GENESIS";
            public AuditPipeline(Clock clock) { this.clock = clock; }
            public synchronized AuditRecord append(String action, String subject, String payload) {
                long sequence = records.size() + 1L;
                AuditRecord candidate = new AuditRecord(sequence, action, subject, payload, tail, "", clock.now());
                String hash = digest(candidate.canonical());
                AuditRecord record = new AuditRecord(sequence, action, subject, payload, tail, hash, candidate.occurredAt());
                records.add(record); tail = hash; return record;
            }
            public synchronized boolean verify() {
                String previous = "GENESIS";
                for (AuditRecord record : records) {
                    if (!previous.equals(record.previousHash()) || !digest(record.withoutHash().canonical()).equals(record.hash())) return false;
                    previous = record.hash();
                }
                return true;
            }
            public synchronized List<AuditRecord> records() { return List.copyOf(records); }
            private String digest(String text) {
                try {
                    byte[] bytes = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
                    StringBuilder value = new StringBuilder();
                    for (byte item : bytes) value.append(String.format("%02x", item));
                    return value.toString();
                } catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
            }
        }
    """)
    write(Path("src/main/java/forexplore/reference/application/RetryScheduler.java"), """
        package forexplore.reference.application;

        import forexplore.reference.core.*;
        import java.time.Duration;
        import java.time.Instant;
        import java.util.ArrayList;
        import java.util.Comparator;
        import java.util.List;
        import java.util.PriorityQueue;

        public final class RetryScheduler {
            private final PriorityQueue<RetryTask> queue = new PriorityQueue<>(Comparator.comparing(RetryTask::dueAt));
            private final Clock clock;
            public RetryScheduler(Clock clock) { this.clock = clock; }
            public synchronized void schedule(String key, int attempt, String reason) {
                long seconds = Math.min(3600L, 1L << Math.min(10, Math.max(0, attempt)));
                queue.add(new RetryTask(key, attempt, clock.now().plusSeconds(seconds), reason));
            }
            public synchronized List<RetryTask> pollDue(int limit) {
                List<RetryTask> result = new ArrayList<>();
                Instant now = clock.now();
                while (result.size() < Math.max(0, limit) && !queue.isEmpty() && queue.peek().due(now)) result.add(queue.remove());
                return result;
            }
            public synchronized int size() { return queue.size(); }
            public synchronized void cancel(String key) { queue.removeIf(task -> task.key().equals(key)); }
            public synchronized Duration nextDelay() {
                RetryTask head = queue.peek();
                if (head == null) return Duration.ZERO;
                Duration delay = Duration.between(clock.now(), head.dueAt());
                return delay.isNegative() ? Duration.ZERO : delay;
            }
        }
    """)
    write(Path("src/main/java/forexplore/reference/application/RateLimiter.java"), """
        package forexplore.reference.application;

        import forexplore.reference.core.Clock;
        import java.time.Duration;

        public final class RateLimiter {
            private final Clock clock;
            private final int capacity;
            private final double refillPerSecond;
            private double tokens;
            private long lastNanos;
            public RateLimiter(Clock clock, int capacity, double refillPerSecond) {
                if (capacity < 1) throw new IllegalArgumentException("capacity must be positive");
                if (!(refillPerSecond > 0.0) || Double.isInfinite(refillPerSecond)) throw new IllegalArgumentException("refill rate must be finite and positive");
                this.clock = clock; this.capacity = capacity; this.refillPerSecond = refillPerSecond; this.tokens = capacity; this.lastNanos = System.nanoTime();
            }
            public synchronized boolean tryAcquire(int requested) {
                refill();
                int amount = Math.max(1, requested);
                if (tokens < amount) return false;
                tokens -= amount; return true;
            }
            public synchronized double available() { refill(); return tokens; }
            public synchronized Duration waitFor(int requested) {
                refill();
                double missing = Math.max(0, requested - tokens);
                if (missing == 0) return Duration.ZERO;
                double millis = Math.ceil(missing / refillPerSecond * 1000);
                return Duration.ofMillis(Math.min(Long.MAX_VALUE, (long) millis));
            }
            private void refill() {
                long now = System.nanoTime();
                double elapsed = Math.max(0, now - lastNanos) / 1_000_000_000.0;
                tokens = Math.min(capacity, tokens + elapsed * refillPerSecond);
                lastNanos = now;
            }
        }
    """)
    write(Path("src/main/java/forexplore/reference/application/ReferencePlatform.java"), """
        package forexplore.reference.application;

        import forexplore.reference.core.*;
        import forexplore.reference.infrastructure.*;
        import java.math.BigDecimal;
        import java.time.Duration;
        import java.time.Instant;
        import java.util.List;

        public final class ReferencePlatform {
            private final MutableClock clock = new MutableClock(Instant.parse("2026-01-02T09:00:00Z"));
            private final QuoteRouter router;
            private final QuoteCache cache;
            private final SettlementBatch settlements;
            private final AuditPipeline audits;
            private final RetryScheduler retries;
            public ReferencePlatform() {
                ProviderSimulator primary = new ProviderSimulator("northstar", 101, 0, clock);
                ProviderSimulator backup = new ProviderSimulator("harbor", 137, 2, clock);
                router = new QuoteRouter(List.of(primary, backup), clock, Duration.ofSeconds(15));
                cache = new QuoteCache(clock, 32); settlements = new SettlementBatch(clock); audits = new AuditPipeline(clock); retries = new RetryScheduler(clock);
            }
            public Quote quote(String base, String counter) {
                QuoteRequest request = new QuoteRequest(base + counter, base, counter, clock.now(), 30);
                Quote quote = cache.getOrLoad(request, value -> router.route(value, audits.records().size() + 1L));
                audits.append("QUOTE", quote.key(), quote.spread().amount().toPlainString());
                return quote;
            }
            public List<SettlementResult> settle() {
                List<SettlementInstruction> instructions = List.of(
                    new SettlementInstruction("order-100", "EURUSD", new Money("EUR", new BigDecimal("1200.50")), "ledger-a", 3),
                    new SettlementInstruction("order-101", "GBPUSD", new Money("GBP", new BigDecimal("700.25")), "ledger-b", 2));
                List<SettlementResult> result = settlements.apply(instructions, (instruction, attempt) -> {
                    if (instruction.idempotencyKey().endsWith("101") && attempt == 1) return SettlementResult.retry(instruction.idempotencyKey(), "temporary gateway", clock.now());
                    String receipt = instruction.idempotencyKey() + "-r" + attempt;
                    return SettlementResult.settled(instruction.idempotencyKey(), receipt, clock.now());
                });
                result.forEach(value -> audits.append("SETTLEMENT", value.idempotencyKey(), value.status()));
                return result;
            }
            public String report() { return "quotes=" + cache.size() + ", settlements=" + settlements.snapshot().size() + ", auditValid=" + audits.verify() + ", retries=" + retries.size(); }
            public MutableClock clock() { return clock; }
            public AuditPipeline audits() { return audits; }
        }
    """)


def infrastructure_sources() -> None:
    write(Path("src/main/java/forexplore/reference/infrastructure/MutableClock.java"), """
        package forexplore.reference.infrastructure;

        import forexplore.reference.core.Clock;
        import java.time.Duration;
        import java.time.Instant;

        public final class MutableClock implements Clock {
            private Instant current;
            public MutableClock(Instant initial) { current = initial; }
            public synchronized Instant now() { return current; }
            public synchronized void advance(Duration amount) { current = current.plus(amount); }
            public synchronized void set(Instant value) { current = value; }
        }
    """)
    write(Path("src/main/java/forexplore/reference/infrastructure/ProviderSimulator.java"), """
        package forexplore.reference.infrastructure;

        import forexplore.reference.core.*;
        import java.math.BigDecimal;
        import java.time.Instant;
        import java.util.Set;

        public final class ProviderSimulator implements ProviderClient {
            private final String name;
            private final int basis;
            private final int failuresBeforeSuccess;
            private final Clock clock;
            private int calls;
            public ProviderSimulator(String name, int basis, int failuresBeforeSuccess, Clock clock) { this.name = name; this.basis = basis; this.failuresBeforeSuccess = failuresBeforeSuccess; this.clock = clock; }
            public String name() { return name; }
            public boolean supports(String pair) { return Set.of("EURUSD", "GBPUSD", "USDJPY", "AUDUSD").contains(pair); }
            public synchronized Quote fetch(String pair, long requestId) {
                calls++;
                if (calls <= failuresBeforeSuccess) throw new IllegalStateException(name + " temporary failure");
                int offset = Math.floorMod(basis + pair.hashCode() + (int) requestId, 41);
                Money bid = new Money(pair.substring(0, 3), BigDecimal.valueOf(1000 + offset, 2));
                Money ask = new Money(pair.substring(0, 3), bid.amount().add(BigDecimal.valueOf(3, 2)));
                return new Quote(name, pair, bid, ask, clock.now(), 5 + offset);
            }
        }
    """)
    write(Path("src/main/java/forexplore/reference/infrastructure/ConsoleReport.java"), """
        package forexplore.reference.infrastructure;

        import forexplore.reference.core.AuditRecord;
        import java.util.List;

        public final class ConsoleReport {
            public String format(String title, List<AuditRecord> records) {
                StringBuilder value = new StringBuilder(title).append('\\n');
                for (AuditRecord record : records) {
                    value.append(record.sequence()).append(' ')
                        .append(record.action()).append(' ')
                        .append(record.subject()).append(' ')
                        .append(record.hash(), 0, Math.min(12, record.hash().length())).append('\\n');
                }
                return value.toString();
            }
        }
    """)
    write(Path("src/main/java/forexplore/reference/infrastructure/ReplayLog.java"), """
        package forexplore.reference.infrastructure;

        import java.util.ArrayList;
        import java.util.Collections;
        import java.util.List;

        public final class ReplayLog {
            private final List<String> entries = new ArrayList<>();
            public synchronized void add(String value) { entries.add(value); }
            public synchronized List<String> readFrom(int index) {
                int start = Math.min(Math.max(0, index), entries.size());
                return List.copyOf(entries.subList(start, entries.size()));
            }
            public synchronized int size() { return entries.size(); }
            public synchronized void trimBefore(int index) {
                int end = Math.min(Math.max(0, index), entries.size());
                if (end > 0) entries.subList(0, end).clear();
            }
            public synchronized List<String> reversed() { List<String> copy = new ArrayList<>(entries); Collections.reverse(copy); return copy; }
        }
    """)


def test_sources() -> None:
    write(Path("src/test/java/forexplore/reference/ReferenceTestSuite.java"), """
        package forexplore.reference;

        import forexplore.reference.application.*;
        import forexplore.reference.core.*;
        import forexplore.reference.infrastructure.*;
        import forexplore.reference.generated.*;
        import java.math.BigDecimal;
        import java.time.Duration;
        import java.time.Instant;
        import java.util.List;

        public final class ReferenceTestSuite {
            public static void main(String[] args) {
                moneyMath(); quoteRouting(); cacheExpiry(); settlementIdempotency(); auditIntegrity(); retryOrdering(); replayBounds(); rateLimiterValidation(); deterministicProvider(); generatedComponents();
                System.out.println("forexplore translation fixture tests passed");
            }
            private static void moneyMath() {
                Money left = new Money("USD", new BigDecimal("2.10"));
                assert left.add(new Money("USD", new BigDecimal("1.20"))).amount().compareTo(new BigDecimal("3.3000")) == 0;
                assert left.multiply(new BigDecimal("2")).amount().compareTo(new BigDecimal("4.2000")) == 0;
            }
            private static void quoteRouting() {
                MutableClock clock = new MutableClock(Instant.parse("2026-01-02T09:00:00Z"));
                ProviderSimulator failing = new ProviderSimulator("failing", 4, 2, clock);
                ProviderSimulator healthy = new ProviderSimulator("healthy", 8, 0, clock);
                QuoteRouter router = new QuoteRouter(List.of(failing, healthy), clock, Duration.ofSeconds(10));
                Quote quote = router.route(new QuoteRequest("EURUSD", "EUR", "USD", clock.now(), 10), 1);
                assert quote.provider().equals("healthy");
            }
            private static void cacheExpiry() {
                MutableClock clock = new MutableClock(Instant.parse("2026-01-02T09:00:00Z"));
                QuoteCache cache = new QuoteCache(clock, 2);
                int[] calls = {0};
                QuoteRequest request = new QuoteRequest("EURUSD", "EUR", "USD", clock.now(), 5);
                Quote first = cache.getOrLoad(request, value -> { calls[0]++; return new Quote("p", "EURUSD", new Money("EUR", new BigDecimal("1")), new Money("EUR", new BigDecimal("2")), clock.now(), 1); });
                Quote second = cache.getOrLoad(request, value -> { calls[0]++; return first; });
                assert first.equals(second) && calls[0] == 1;
                clock.advance(Duration.ofSeconds(6));
                cache.getOrLoad(request, value -> { calls[0]++; return first; });
                assert calls[0] == 2;
            }
            private static void settlementIdempotency() {
                MutableClock clock = new MutableClock(Instant.parse("2026-01-02T09:00:00Z"));
                SettlementBatch batch = new SettlementBatch(clock);
                SettlementInstruction instruction = new SettlementInstruction("same", "EURUSD", new Money("EUR", BigDecimal.ONE), "ledger", 2);
                List<SettlementResult> first = batch.apply(List.of(instruction), (value, attempt) -> SettlementResult.settled(value.idempotencyKey(), "receipt", clock.now()));
                List<SettlementResult> second = batch.apply(List.of(instruction), (value, attempt) -> { throw new AssertionError("must not call gateway"); });
                assert first.get(0).equals(second.get(0));
            }
            private static void auditIntegrity() {
                MutableClock clock = new MutableClock(Instant.parse("2026-01-02T09:00:00Z"));
                AuditPipeline pipeline = new AuditPipeline(clock);
                pipeline.append("A", "one", "payload"); pipeline.append("B", "two", "payload2");
                assert pipeline.verify() && pipeline.records().size() == 2;
            }
            private static void retryOrdering() {
                MutableClock clock = new MutableClock(Instant.parse("2026-01-02T09:00:00Z"));
                RetryScheduler scheduler = new RetryScheduler(clock);
                scheduler.schedule("a", 0, "first"); scheduler.schedule("b", 2, "later");
                assert scheduler.pollDue(3).isEmpty();
                clock.advance(Duration.ofSeconds(2));
                assert scheduler.pollDue(3).size() == 1;
                clock.advance(Duration.ofMinutes(3));
                assert scheduler.pollDue(3).size() == 1;
            }
            private static void replayBounds() {
                ReplayLog log = new ReplayLog();
                log.add("one"); log.add("two");
                assert log.readFrom(99).isEmpty();
                log.trimBefore(99);
                assert log.size() == 0;
            }
            private static void rateLimiterValidation() {
                MutableClock clock = new MutableClock(Instant.parse("2026-01-02T09:00:00Z"));
                boolean badCapacity = false;
                try { new RateLimiter(clock, 0, 1.0); } catch (IllegalArgumentException expected) { badCapacity = true; }
                boolean badRate = false;
                try { new RateLimiter(clock, 2, 0.0); } catch (IllegalArgumentException expected) { badRate = true; }
                assert badCapacity && badRate;
                assert new RateLimiter(clock, 2, 1.0).waitFor(1).isZero();
            }
            private static void deterministicProvider() {
                MutableClock clock = new MutableClock(Instant.parse("2026-01-02T09:00:00Z"));
                ProviderSimulator provider = new ProviderSimulator("fixed", 3, 0, clock);
                assert provider.fetch("EURUSD", 1).observedAt().equals(clock.now());
            }
            private static void generatedComponents() {
                RiskLens01 lens = new RiskLens01();
                assert lens.valid("EURUSD") && !lens.valid("x");
                assert lens.normalize(List.of(3, 1, 3)).size() == 2;
                assert lens.snapshot().containsKey(lens.component());
            }
        }
    """)
    write(Path("src/main/java/forexplore/reference/ReferenceCli.java"), """
        package forexplore.reference;

        import forexplore.reference.application.ReferencePlatform;

        public final class ReferenceCli {
            public static void main(String[] args) {
                ReferencePlatform platform = new ReferencePlatform();
                System.out.println(platform.quote("EUR", "USD"));
                System.out.println(platform.settle());
                System.out.println(platform.report());
            }
        }
    """)


def csharp_sources() -> None:
    write(Path("csharp-skeleton/ForeXplore.Skeleton.csproj"), """
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup>
            <TargetFramework>net8.0</TargetFramework>
            <Nullable>enable</Nullable>
            <ImplicitUsings>enable</ImplicitUsings>
            <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
          </PropertyGroup>
        </Project>
    """)
    write(Path("csharp-skeleton/src/Domain/QuoteModels.cs"), """
        namespace ForeXplore.Skeleton.Domain;

        // REQ: Keep currency uppercase and reject values with more than four fractional digits.
        public readonly record struct Money(string Currency, decimal Amount);

        // REQ: Bid must not exceed Ask; ObservedAt is the provider timestamp, not local receipt time.
        public sealed record Quote(string Provider, string Pair, Money Bid, Money Ask, DateTimeOffset ObservedAt, int LatencyMilliseconds);

        // REQ: Base and Counter remain separately addressable even when Pair is normalized.
        public sealed record QuoteRequest(string Base, string Counter, DateTimeOffset RequestedAt, TimeSpan MaxAge);

        // REQ: Routing state must expose whether a provider is closed, open, or serving one half-open probe.
        public sealed record ProviderState(string Name, string Status, int ConsecutiveFailures, DateTimeOffset? RetryAfter);
    """)
    write(Path("csharp-skeleton/src/Domain/SettlementModels.cs"), """
        namespace ForeXplore.Skeleton.Domain;

        // REQ: IdempotencyKey is stable across retries and must be unique within one batch.
        public sealed record SettlementInstruction(string IdempotencyKey, string Pair, Money Amount, string Destination, int MaxAttempts);

        // REQ: Unlike the Java reference, a C# caller receives a discriminated result instead of status strings.
        public abstract record SettlementOutcome(string IdempotencyKey);

        // REQ: Receipt is immutable evidence and must be emitted exactly once for a successful key.
        public sealed record Settled(string IdempotencyKey, string Receipt, DateTimeOffset CompletedAt) : SettlementOutcome(IdempotencyKey);

        // REQ: Retryable failures carry a delay chosen by the policy, not by the gateway.
        public sealed record RetryLater(string IdempotencyKey, TimeSpan Delay, string Reason) : SettlementOutcome(IdempotencyKey);

        // REQ: Permanent failures are safe to persist and must include an operator-facing reason.
        public sealed record Rejected(string IdempotencyKey, string Reason) : SettlementOutcome(IdempotencyKey);
    """)
    write(Path("csharp-skeleton/src/Ports/ProviderPorts.cs"), """
        using ForeXplore.Skeleton.Domain;

        namespace ForeXplore.Skeleton.Ports;

        // REQ: Providers are asynchronous because a production adapter may use HTTP or a message bus.
        public interface IQuoteProvider
        {
            // REQ: The name is stable for audit records and breaker snapshots.
            string Name { get; }
            // REQ: Capability checks must be side-effect free and case insensitive.
            bool Supports(string pair);
            // REQ: Cancellation must stop this call, but must not cancel later fallback providers.
            ValueTask<Quote> FetchAsync(QuoteRequest request, CancellationToken cancellationToken);
        }

        // REQ: The router reports all attempts so a human can explain why a fallback was selected.
        public interface IQuoteRouter
        {
            // REQ: Return the first valid quote ordered by policy; throw only after all eligible providers fail.
            Task<Quote> RouteAsync(QuoteRequest request, CancellationToken cancellationToken);
        }
    """)
    write(Path("csharp-skeleton/src/Ports/StoragePorts.cs"), """
        using ForeXplore.Skeleton.Domain;

        namespace ForeXplore.Skeleton.Ports;

        // REQ: Cache storage owns expiration and must not leak mutable provider objects.
        public interface IQuoteCache
        {
            // REQ: A fresh value is returned without invoking loader; stale values may be served only by explicit policy.
            Task<Quote> GetOrLoadAsync(QuoteRequest request, Func<CancellationToken, Task<Quote>> loader, CancellationToken cancellationToken);
            // REQ: Invalidation is idempotent and safe when the key is absent.
            void Invalidate(string pair);
        }

        // REQ: Journal append is durable before the returned sequence is observable to callers.
        public interface IAuditJournal
        {
            // REQ: Store the previous hash and computed hash to support chain verification.
            ValueTask<long> AppendAsync(string action, string subject, string payload, CancellationToken cancellationToken);
            // REQ: Verification returns diagnostics rather than silently accepting a broken chain.
            Task<bool> VerifyAsync(CancellationToken cancellationToken);
        }
    """)
    write(Path("csharp-skeleton/src/Application/QuoteOrchestrationService.cs"), """
        using ForeXplore.Skeleton.Domain;
        using ForeXplore.Skeleton.Ports;

        namespace ForeXplore.Skeleton.Application;

        public sealed class QuoteOrchestrationService
        {
            private readonly IReadOnlyList<IQuoteProvider> providers;
            private readonly IQuoteCache cache;
            private readonly IAuditJournal audit;

            // REQ: Dependencies are injected so tests can model time, provider faults, and persistence failures.
            public QuoteOrchestrationService(IReadOnlyList<IQuoteProvider> providers, IQuoteCache cache, IAuditJournal audit)
            {
                this.providers = providers;
                this.cache = cache;
                this.audit = audit;
            }

            // REQ: Normalize pair once, cache by normalized pair, and preserve request cancellation semantics.
            public async Task<Quote> GetQuoteAsync(QuoteRequest request, CancellationToken cancellationToken)
            {
                // REQ: Java uses a synchronous loader; the C# port must keep the async boundary visible.
                throw new NotImplementedException("Translation exercise: implement cache and fallback orchestration");
            }

            // REQ: Providers are attempted in policy order and every failure is appended to the audit journal.
            private async Task<Quote> FetchWithFallbackAsync(QuoteRequest request, CancellationToken cancellationToken)
            {
                throw new NotImplementedException("Translation exercise: preserve retryability without swallowing cancellation");
            }
        }
    """)
    write(Path("csharp-skeleton/src/Application/SettlementOrchestrationService.cs"), """
        using ForeXplore.Skeleton.Domain;
        using ForeXplore.Skeleton.Ports;

        namespace ForeXplore.Skeleton.Application;

        public sealed class SettlementOrchestrationService
        {
            private readonly IAuditJournal audit;
            // REQ: The C# contract returns a typed outcome per instruction instead of Java's status record.
            public SettlementOrchestrationService(IAuditJournal audit) { this.audit = audit; }

            // REQ: Preserve input order, deduplicate idempotency keys, and retry only transient gateway errors.
            public async Task<IReadOnlyList<SettlementOutcome>> SettleBatchAsync(
                IReadOnlyList<SettlementInstruction> instructions,
                Func<SettlementInstruction, int, CancellationToken, Task<SettlementOutcome>> gateway,
                CancellationToken cancellationToken)
            {
                // REQ: A failed item must not hide the outcome of later items in the same batch.
                throw new NotImplementedException("Translation exercise: map Java retry loop to typed async outcomes");
            }
        }
    """)
    write(Path("csharp-skeleton/src/Application/AuditPipeline.cs"), """
        using System.Security.Cryptography;
        using System.Text;
        using ForeXplore.Skeleton.Ports;

        namespace ForeXplore.Skeleton.Application;

        public sealed class AuditPipeline
        {
            private readonly IAuditJournal journal;
            // REQ: Hash canonicalization must be stable across machines and use UTF-8 bytes.
            public AuditPipeline(IAuditJournal journal) { this.journal = journal; }
            // REQ: Sequence allocation and persistence are one observable operation to callers.
            public ValueTask<long> AppendAsync(string action, string subject, string payload, CancellationToken cancellationToken)
            {
                throw new NotImplementedException("Translation exercise: implement canonical hash-chain append");
            }
            // REQ: Return false with diagnostics captured by the journal adapter when a link is broken.
            public Task<bool> VerifyAsync(CancellationToken cancellationToken) => journal.VerifyAsync(cancellationToken);
            private static byte[] Digest(string value) => SHA256.HashData(Encoding.UTF8.GetBytes(value));
        }
    """)
    write(Path("csharp-skeleton/src/Infrastructure/InMemoryAdapters.cs"), """
        using System.Collections.Concurrent;
        using ForeXplore.Skeleton.Domain;
        using ForeXplore.Skeleton.Ports;

        namespace ForeXplore.Skeleton.Infrastructure;

        // REQ: Test adapter records calls and can be configured to fail a fixed number of times.
        public sealed class InMemoryQuoteProvider : IQuoteProvider
        {
            private readonly int failuresBeforeSuccess;
            private int calls;
            // REQ: Name participates in deterministic routing and audit output.
            public string Name { get; }
            public InMemoryQuoteProvider(string name, int failuresBeforeSuccess)
            {
                Name = name;
                this.failuresBeforeSuccess = failuresBeforeSuccess;
            }
            // REQ: Capability data is immutable for the lifetime of the adapter.
            public bool Supports(string pair) => pair is "EURUSD" or "GBPUSD" or "USDJPY";
            // REQ: Simulate latency and transient errors without blocking a thread.
            public ValueTask<Quote> FetchAsync(QuoteRequest request, CancellationToken cancellationToken)
            {
                throw new NotImplementedException("Skeleton adapter: add deterministic quote generation");
            }
        }

        // REQ: Concurrent callers must observe one logical value per normalized pair.
        public sealed class InMemoryQuoteCache : IQuoteCache
        {
            private readonly ConcurrentDictionary<string, Quote> values = new();
            public Task<Quote> GetOrLoadAsync(QuoteRequest request, Func<CancellationToken, Task<Quote>> loader, CancellationToken cancellationToken)
            {
                throw new NotImplementedException("Skeleton adapter: add TTL and single-flight behavior");
            }
            public void Invalidate(string pair) => values.TryRemove(pair.ToUpperInvariant(), out _);
        }
    """)
    write(Path("csharp-skeleton/src/Program.cs"), """
        using ForeXplore.Skeleton.Application;
        using ForeXplore.Skeleton.Infrastructure;

        namespace ForeXplore.Skeleton;

        public static class Program
        {
            // REQ: The sample host wires ports explicitly and must never create global mutable state.
            public static async Task Main(string[] args)
            {
                // REQ: Keep this entry point executable once the translation exercise is completed.
                throw new NotImplementedException("Skeleton host: compose providers, cache, journal, and services");
            }
        }
    """)
    write(Path("csharp-skeleton/tests/RequirementsMatrix.cs"), """
        namespace ForeXplore.Skeleton.Tests;

        // This file is a requirements-analysis artifact, not a runnable test framework dependency.
        public static class RequirementsMatrix
        {
            // REQ: A translated implementation must cover normal, boundary, failure, and concurrency cases.
            public static IReadOnlyDictionary<string, string[]> Cases => new Dictionary<string, string[]>
            {
                ["quote-routing"] = new[] { "healthy-primary", "fallback-after-timeout", "open-breaker", "half-open-probe" },
                ["quote-cache"] = new[] { "fresh-hit", "stale-reload", "single-flight", "capacity-eviction" },
                ["settlement"] = new[] { "ordered-results", "idempotent-replay", "retryable-error", "permanent-error" },
                ["audit"] = new[] { "canonical-hash", "tamper-detection", "durable-sequence", "cancellation" },
            };
        }
    """)


def main() -> None:
    core_sources()
    application_sources()
    infrastructure_sources()
    test_sources()
    families = ["RiskLens", "QuotePolicy", "SettlementRule", "AuditWindow", "ProviderModel", "LedgerProjection", "ReplayPlanner", "ExposureGrid"]
    for family_index, family in enumerate(families):
        for variant in range(1, 8):
            name = f"{family}{variant:02d}"
            write(Path("src/main/java/forexplore/reference/generated") / f"{name}.java", generated_class(name, family, variant))
    csharp_sources()
    print("generated Java and C# fixture sources")


if __name__ == "__main__":
    main()
