package synthetic.durableaudit;

import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.locks.ReentrantLock;

public final class RetrySpool {
    private final Path directory;
    private final Clock clock;
    private final Duration initialDelay;
    private final Duration maximumDelay;
    private final int maximumAttempts;
    private final ReentrantLock lock = new ReentrantLock();
    private final TreeMap<RetryKey, RetryTicket> due = new TreeMap<>();
    private final Map<UUID, RetryTicket> tickets = new LinkedHashMap<>();

    public RetrySpool(
            Path directory,
            Clock clock,
            Duration initialDelay,
            Duration maximumDelay,
            int maximumAttempts) throws IOException {
        this.directory = Objects.requireNonNull(directory, "directory").toAbsolutePath().normalize();
        this.clock = Objects.requireNonNull(clock, "clock");
        this.initialDelay = Objects.requireNonNull(initialDelay, "initialDelay");
        this.maximumDelay = Objects.requireNonNull(maximumDelay, "maximumDelay");
        if (initialDelay.isNegative() || initialDelay.isZero()) {
            throw new IllegalArgumentException("initialDelay must be positive");
        }
        if (maximumDelay.compareTo(initialDelay) < 0) {
            throw new IllegalArgumentException("maximumDelay must not be shorter than initialDelay");
        }
        if (maximumAttempts < 1 || maximumAttempts > 100) {
            throw new IllegalArgumentException("maximumAttempts must be between 1 and 100");
        }
        this.maximumAttempts = maximumAttempts;
        Files.createDirectories(this.directory);
        loadFromDisk();
    }

    public RetryTicket offer(AuditBatch batch, Throwable failure) throws IOException {
        Objects.requireNonNull(batch, "batch");
        Objects.requireNonNull(failure, "failure");
        lock.lock();
        try {
            RetryTicket existing = tickets.values().stream()
                    .filter(ticket -> ticket.batch().batchNumber() == batch.batchNumber())
                    .findFirst()
                    .orElse(null);
            if (existing != null) {
                return existing;
            }
            Instant now = clock.instant();
            UUID ticketId = UUID.randomUUID();
            RetryTicket ticket = new RetryTicket(
                    ticketId,
                    batch,
                    0,
                    now,
                    now.plus(initialDelay),
                    failure.getClass().getName(),
                    sanitizeMessage(failure.getMessage()),
                    false);
            persist(ticket);
            insert(ticket);
            return ticket;
        } finally {
            lock.unlock();
        }
    }

    public List<RetryTicket> pollDue(int limit) {
        if (limit <= 0) {
            throw new IllegalArgumentException("limit must be positive");
        }
        lock.lock();
        try {
            Instant now = clock.instant();
            List<RetryTicket> result = new ArrayList<>();
            for (Map.Entry<RetryKey, RetryTicket> entry : due.entrySet()) {
                if (entry.getKey().dueAt.isAfter(now) || result.size() >= limit) {
                    break;
                }
                if (!entry.getValue().leased()) {
                    result.add(entry.getValue());
                }
            }
            for (RetryTicket ticket : result) {
                replace(ticket, ticket.withLease(true));
            }
            return result.stream().map(ticket -> tickets.get(ticket.ticketId())).toList();
        } finally {
            lock.unlock();
        }
    }

    public void acknowledge(UUID ticketId) throws IOException {
        Objects.requireNonNull(ticketId, "ticketId");
        lock.lock();
        try {
            RetryTicket ticket = tickets.remove(ticketId);
            if (ticket == null) {
                return;
            }
            due.remove(new RetryKey(ticket.nextAttemptAt(), ticket.ticketId()));
            Files.deleteIfExists(ticketPath(ticketId));
        } finally {
            lock.unlock();
        }
    }

    public Optional<RetryTicket> reject(UUID ticketId, Throwable failure) throws IOException {
        Objects.requireNonNull(ticketId, "ticketId");
        Objects.requireNonNull(failure, "failure");
        lock.lock();
        try {
            RetryTicket current = tickets.get(ticketId);
            if (current == null) {
                return Optional.empty();
            }
            int attempts = current.attempts() + 1;
            if (attempts >= maximumAttempts) {
                moveToDeadLetter(current, failure, attempts);
                tickets.remove(ticketId);
                due.remove(new RetryKey(current.nextAttemptAt(), current.ticketId()));
                Files.deleteIfExists(ticketPath(ticketId));
                return Optional.empty();
            }
            Duration delay = backoff(attempts, ticketId);
            RetryTicket updated = new RetryTicket(
                    current.ticketId(),
                    current.batch(),
                    attempts,
                    current.firstFailedAt(),
                    clock.instant().plus(delay),
                    failure.getClass().getName(),
                    sanitizeMessage(failure.getMessage()),
                    false);
            persist(updated);
            replace(current, updated);
            return Optional.of(updated);
        } finally {
            lock.unlock();
        }
    }

    int size() {
        lock.lock();
        try {
            return tickets.size();
        } finally {
            lock.unlock();
        }
    }

    Map<String, Integer> failureTypes() {
        lock.lock();
        try {
            Map<String, Integer> counts = new LinkedHashMap<>();
            tickets.values().stream()
                    .sorted(Comparator.comparing(RetryTicket::failureType))
                    .forEach(ticket -> counts.merge(ticket.failureType(), 1, Integer::sum));
            return counts;
        } finally {
            lock.unlock();
        }
    }

    Duration oldestAge() {
        lock.lock();
        try {
            Instant oldest = tickets.values().stream()
                    .map(RetryTicket::firstFailedAt)
                    .min(Comparator.naturalOrder())
                    .orElse(clock.instant());
            Duration age = Duration.between(oldest, clock.instant());
            return age.isNegative() ? Duration.ZERO : age;
        } finally {
            lock.unlock();
        }
    }

    void loadFromDisk() throws IOException {
        try (var paths = Files.list(directory)) {
            List<Path> ticketFiles = paths
                    .filter(path -> path.getFileName().toString().endsWith(".retry"))
                    .sorted()
                    .toList();
            for (Path path : ticketFiles) {
                RetryTicket ticket;
                try {
                    ticket = decode(Files.readAllLines(path, StandardCharsets.UTF_8));
                } catch (RuntimeException invalid) {
                    Path quarantine = path.resolveSibling(path.getFileName() + ".invalid");
                    Files.move(path, quarantine, StandardCopyOption.REPLACE_EXISTING);
                    continue;
                }
                insert(ticket.withLease(false));
            }
        }
    }

    void insert(RetryTicket ticket) {
        RetryTicket previous = tickets.put(ticket.ticketId(), ticket);
        if (previous != null) {
            due.remove(new RetryKey(previous.nextAttemptAt(), previous.ticketId()));
        }
        due.put(new RetryKey(ticket.nextAttemptAt(), ticket.ticketId()), ticket);
    }

    void replace(RetryTicket previous, RetryTicket replacement) {
        due.remove(new RetryKey(previous.nextAttemptAt(), previous.ticketId()));
        tickets.put(replacement.ticketId(), replacement);
        due.put(new RetryKey(replacement.nextAttemptAt(), replacement.ticketId()), replacement);
    }

    void persist(RetryTicket ticket) throws IOException {
        Path temporary = directory.resolve(ticket.ticketId() + ".tmp");
        Path destination = ticketPath(ticket.ticketId());
        List<String> lines = encode(ticket);
        Files.write(
                temporary,
                lines,
                StandardCharsets.UTF_8,
                StandardOpenOption.CREATE,
                StandardOpenOption.TRUNCATE_EXISTING,
                StandardOpenOption.WRITE);
        try {
            Files.move(temporary, destination, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (java.nio.file.AtomicMoveNotSupportedException unsupported) {
            Files.move(temporary, destination, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    List<String> encode(RetryTicket ticket) {
        List<String> lines = new ArrayList<>();
        lines.add("ticket=" + ticket.ticketId());
        lines.add("attempts=" + ticket.attempts());
        lines.add("firstFailed=" + ticket.firstFailedAt());
        lines.add("nextAttempt=" + ticket.nextAttemptAt());
        lines.add("failureType=" + base64(ticket.failureType()));
        lines.add("failureMessage=" + base64(ticket.failureMessage()));
        lines.add("batchNumber=" + ticket.batch().batchNumber());
        lines.add("batchCreated=" + ticket.batch().createdAt());
        lines.add("events=" + ticket.batch().events().size());
        for (AuditEvent event : ticket.batch().events()) {
            lines.add("event=" + Base64.getUrlEncoder().withoutPadding().encodeToString(event.encodeFields()));
        }
        return lines;
    }

    RetryTicket decode(List<String> lines) {
        Map<String, List<String>> fields = new LinkedHashMap<>();
        for (String line : lines) {
            int separator = line.indexOf('=');
            if (separator <= 0) {
                throw new IllegalArgumentException("malformed retry line");
            }
            fields.computeIfAbsent(line.substring(0, separator), ignored -> new ArrayList<>())
                    .add(line.substring(separator + 1));
        }
        UUID ticket = UUID.fromString(single(fields, "ticket"));
        int attempts = Integer.parseInt(single(fields, "attempts"));
        Instant firstFailed = Instant.parse(single(fields, "firstFailed"));
        Instant nextAttempt = Instant.parse(single(fields, "nextAttempt"));
        String failureType = fromBase64(single(fields, "failureType"));
        String failureMessage = fromBase64(single(fields, "failureMessage"));
        long batchNumber = Long.parseLong(single(fields, "batchNumber"));
        Instant batchCreated = Instant.parse(single(fields, "batchCreated"));
        int eventCount = Integer.parseInt(single(fields, "events"));
        List<String> encodedEvents = fields.getOrDefault("event", List.of());
        if (eventCount != encodedEvents.size()) {
            throw new IllegalArgumentException("retry event count mismatch");
        }
        List<AuditEvent> events = new ArrayList<>();
        for (String encoded : encodedEvents) {
            byte[] bytes = Base64.getUrlDecoder().decode(encoded);
            events.add(parseEventFields(new String(bytes, StandardCharsets.UTF_8)));
        }
        return new RetryTicket(
                ticket,
                new AuditBatch(batchNumber, batchCreated, events),
                attempts,
                firstFailed,
                nextAttempt,
                failureType,
                failureMessage,
                false);
    }

    AuditEvent parseEventFields(String encoded) {
        List<String> values = splitEscaped(encoded);
        if (values.size() < 11) {
            throw new IllegalArgumentException("retry event has too few fields");
        }
        int attributeCount = Integer.parseInt(values.get(10));
        if (values.size() != 11 + attributeCount * 2) {
            throw new IllegalArgumentException("retry event attribute count mismatch");
        }
        Map<String, String> attributes = new LinkedHashMap<>();
        for (int index = 0; index < attributeCount; index++) {
            attributes.put(values.get(11 + index * 2), values.get(12 + index * 2));
        }
        String currency = values.get(7).isEmpty() ? null : values.get(7);
        BigDecimal amount = values.get(8).isEmpty() ? null : new BigDecimal(values.get(8));
        return new AuditEvent(
                UUID.fromString(values.get(0)),
                values.get(1),
                values.get(2),
                values.get(3),
                values.get(4),
                Instant.parse(values.get(5)),
                Severity.valueOf(values.get(6)),
                currency,
                amount,
                Long.parseLong(values.get(9)),
                attributes);
    }

    static List<String> splitEscaped(String encoded) {
        List<String> fields = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        boolean escaped = false;
        for (int index = 0; index < encoded.length(); index++) {
            char character = encoded.charAt(index);
            if (escaped) {
                current.append(character == 'n' ? '\n' : character == 'r' ? '\r' : character);
                escaped = false;
            } else if (character == '\\') {
                escaped = true;
            } else if (character == '|') {
                fields.add(current.toString());
                current.setLength(0);
            } else {
                current.append(character);
            }
        }
        if (escaped || current.length() > 0) {
            throw new IllegalArgumentException("unterminated escaped event");
        }
        return fields;
    }

    void moveToDeadLetter(RetryTicket ticket, Throwable failure, int attempts) throws IOException {
        Path dead = directory.resolve(ticket.ticketId() + ".dead");
        List<String> lines = new ArrayList<>(encode(ticket));
        lines.add("finalAttempts=" + attempts);
        lines.add("finalFailureType=" + base64(failure.getClass().getName()));
        lines.add("finalFailureMessage=" + base64(sanitizeMessage(failure.getMessage())));
        lines.add("abandonedAt=" + clock.instant());
        Files.write(dead, lines, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
    }

    Duration backoff(int attempts, UUID ticketId) {
        long multiplier = 1L << Math.min(30, attempts);
        long baseNanos;
        try {
            baseNanos = Math.multiplyExact(initialDelay.toNanos(), multiplier);
        } catch (ArithmeticException overflow) {
            baseNanos = maximumDelay.toNanos();
        }
        long capped = Math.min(baseNanos, maximumDelay.toNanos());
        long seed = ticketId.getMostSignificantBits() ^ ticketId.getLeastSignificantBits() ^ attempts;
        long spread = Math.max(1, capped / 5);
        long jitter = Math.floorMod(seed, spread * 2 + 1) - spread;
        return Duration.ofNanos(Math.max(initialDelay.toNanos(), capped + jitter));
    }

    Path ticketPath(UUID ticketId) {
        return directory.resolve(ticketId + ".retry");
    }

    static String sanitizeMessage(String message) {
        if (message == null) {
            return "";
        }
        String singleLine = message.replace('\r', ' ').replace('\n', ' ').trim();
        return singleLine.length() <= 512 ? singleLine : singleLine.substring(0, 512);
    }

    static String single(Map<String, List<String>> fields, String key) {
        List<String> values = fields.get(key);
        if (values == null || values.size() != 1) {
            throw new IllegalArgumentException("retry field must occur once: " + key);
        }
        return values.get(0);
    }

    static String base64(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    static String fromBase64(String value) {
        return new String(Base64.getUrlDecoder().decode(value), StandardCharsets.UTF_8);
    }

    private record RetryKey(Instant dueAt, UUID ticketId) implements Comparable<RetryKey> {
        @Override
        public int compareTo(RetryKey other) {
            int time = dueAt.compareTo(other.dueAt);
            return time != 0 ? time : ticketId.compareTo(other.ticketId);
        }
    }
}

record RetryTicket(
        UUID ticketId,
        AuditBatch batch,
        int attempts,
        Instant firstFailedAt,
        Instant nextAttemptAt,
        String failureType,
        String failureMessage,
        boolean leased) {
    RetryTicket {
        Objects.requireNonNull(ticketId, "ticketId");
        Objects.requireNonNull(batch, "batch");
        Objects.requireNonNull(firstFailedAt, "firstFailedAt");
        Objects.requireNonNull(nextAttemptAt, "nextAttemptAt");
        Objects.requireNonNull(failureType, "failureType");
        Objects.requireNonNull(failureMessage, "failureMessage");
        if (attempts < 0) {
            throw new IllegalArgumentException("attempts must not be negative");
        }
    }

    RetryTicket withLease(boolean replacement) {
        return new RetryTicket(
                ticketId,
                batch,
                attempts,
                firstFailedAt,
                nextAttemptAt,
                failureType,
                failureMessage,
                replacement);
    }
}
