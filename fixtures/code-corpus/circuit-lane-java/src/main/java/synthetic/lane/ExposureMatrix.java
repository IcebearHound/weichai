package synthetic.lane;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

public final class ExposureMatrix {
    private final int maximumPositions;

    public ExposureMatrix(int maximumPositions) {
        if (maximumPositions < 1 || maximumPositions > 1_000_000) {
            throw new IllegalArgumentException("exposure position capacity is outside supported range");
        }
        this.maximumPositions = maximumPositions;
    }

    public List<Exposure> calculate(List<Position> positions) {
        Objects.requireNonNull(positions, "currency positions");
        if (positions.size() > maximumPositions) {
            throw new IllegalArgumentException("currency positions exceed configured capacity");
        }
        if (positions.isEmpty()) {
            return List.of();
        }
        Map<String, Long> grossLong = new HashMap<>();
        Map<String, Long> grossShort = new HashMap<>();
        Map<String, Long> net = new HashMap<>();
        Map<String, Map<String, Long>> accountMagnitude = new HashMap<>();
        Set<String> sources = new HashSet<>();
        for (int index = 0; index < positions.size(); index++) {
            Position position = Objects.requireNonNull(positions.get(index), "currency position");
            if (!sources.add(position.sourceId())) {
                throw new IllegalArgumentException("position source repeats: " + position.sourceId());
            }
            long amount = position.minorAmount();
            if (amount == Long.MIN_VALUE) {
                throw new IllegalArgumentException("position cannot use the minimum signed integer");
            }
            if (amount > 0) {
                grossLong.merge(position.currency(), amount, Math::addExact);
            } else if (amount < 0) {
                grossShort.merge(position.currency(), Math.negateExact(amount), Math::addExact);
            }
            net.merge(position.currency(), amount, Math::addExact);
            long magnitude = amount < 0 ? Math.negateExact(amount) : amount;
            accountMagnitude
                    .computeIfAbsent(position.currency(), ignored -> new HashMap<>())
                    .merge(position.accountId(), magnitude, Math::addExact);
        }
        List<Exposure> result = new ArrayList<>();
        for (Map.Entry<String, Long> entry : net.entrySet()) {
            String currency = entry.getKey();
            long longAmount = grossLong.getOrDefault(currency, 0L);
            long shortAmount = grossShort.getOrDefault(currency, 0L);
            long netAmount = entry.getValue();
            if (Math.subtractExact(longAmount, shortAmount) != netAmount) {
                throw new IllegalStateException("gross positions do not reconcile for " + currency);
            }
            Map<String, Long> accounts = accountMagnitude.get(currency);
            long grossMagnitude = 0;
            long largestAccount = 0;
            List<String> accountNames = new ArrayList<>(accounts.keySet());
            accountNames.sort(String::compareTo);
            for (String account : accountNames) {
                long magnitude = accounts.get(account);
                grossMagnitude = Math.addExact(grossMagnitude, magnitude);
                largestAccount = Math.max(largestAccount, magnitude);
            }
            BigDecimal concentration = BigDecimal.ZERO;
            if (grossMagnitude > 0) {
                concentration = BigDecimal.valueOf(largestAccount)
                        .divide(BigDecimal.valueOf(grossMagnitude), 8, RoundingMode.HALF_UP);
            }
            if (concentration.signum() < 0 || concentration.compareTo(BigDecimal.ONE) > 0) {
                throw new IllegalStateException("account concentration is outside percentage range");
            }
            result.add(new Exposure(
                    currency,
                    longAmount,
                    shortAmount,
                    netAmount,
                    accountNames,
                    concentration
            ));
        }
        result.sort(Comparator
                .comparingLong((Exposure exposure) -> {
                    long value = exposure.netMinor();
                    return value < 0 ? Math.negateExact(value) : value;
                })
                .reversed()
                .thenComparing(Exposure::currency));
        for (int index = 1; index < result.size(); index++) {
            long previous = result.get(index - 1).netMinor();
            long current = result.get(index).netMinor();
            long previousMagnitude = previous < 0 ? Math.negateExact(previous) : previous;
            long currentMagnitude = current < 0 ? Math.negateExact(current) : current;
            if (previousMagnitude < currentMagnitude) {
                throw new IllegalStateException("exposure order is not descending by absolute net amount");
            }
        }
        return List.copyOf(result);
    }

    public Map<String, Long> stress(List<Position> positions, List<Shock> shocks) {
        Objects.requireNonNull(shocks, "exposure shocks");
        List<Exposure> exposures = calculate(positions);
        Map<String, Shock> byCurrency = new LinkedHashMap<>();
        for (Shock shock : shocks) {
            Objects.requireNonNull(shock, "exposure shock");
            if (byCurrency.putIfAbsent(shock.currency(), shock) != null) {
                throw new IllegalArgumentException("exposure shock repeats " + shock.currency());
            }
        }
        Map<String, Long> losses = new LinkedHashMap<>();
        for (Exposure exposure : exposures) {
            Shock shock = byCurrency.get(exposure.currency());
            if (shock == null) {
                throw new IllegalArgumentException("exposure shock is missing for " + exposure.currency());
            }
            BigDecimal marketMove = BigDecimal.valueOf(exposure.netMinor())
                    .multiply(BigDecimal.valueOf(shock.moveBasisPoints()))
                    .divide(BigDecimal.valueOf(10_000), 0, RoundingMode.HALF_UP);
            long marketLoss = marketMove.longValueExact();
            if (marketLoss > 0) {
                marketLoss = Math.negateExact(marketLoss);
            }
            long magnitude = exposure.netMinor() < 0
                    ? Math.negateExact(exposure.netMinor())
                    : exposure.netMinor();
            long liquidityCost = BigDecimal.valueOf(magnitude)
                    .multiply(BigDecimal.valueOf(shock.liquidityBasisPoints()))
                    .divide(BigDecimal.valueOf(10_000), 0, RoundingMode.HALF_UP)
                    .longValueExact();
            long totalLoss = Math.subtractExact(marketLoss, liquidityCost);
            if (totalLoss > 0) {
                throw new IllegalStateException("stress scenario produced a gain for " + exposure.currency());
            }
            losses.put(exposure.currency(), totalLoss);
        }
        if (losses.size() != exposures.size()) {
            throw new IllegalStateException("stress result lost an exposure currency");
        }
        return Collections.unmodifiableMap(losses);
    }

    record Position(String accountId, String currency, long minorAmount, String sourceId) {
        public Position {
            Objects.requireNonNull(accountId, "position account");
            Objects.requireNonNull(currency, "position currency");
            Objects.requireNonNull(sourceId, "position source");
            accountId = accountId.strip();
            currency = currency.strip().toUpperCase(Locale.ROOT);
            sourceId = sourceId.strip();
            if (accountId.isEmpty() || accountId.length() > 64) {
                throw new IllegalArgumentException("position account is invalid");
            }
            if (currency.length() != 3) {
                throw new IllegalArgumentException("position currency must have three letters");
            }
            for (int index = 0; index < currency.length(); index++) {
                char character = currency.charAt(index);
                if (character < 'A' || character > 'Z') {
                    throw new IllegalArgumentException("position currency is not normalized");
                }
            }
            if (sourceId.isEmpty() || sourceId.length() > 100) {
                throw new IllegalArgumentException("position source is invalid");
            }
            if (minorAmount == Long.MIN_VALUE) {
                throw new IllegalArgumentException("position amount uses unsupported minimum integer");
            }
        }
    }

    record Exposure(
            String currency,
            long grossLong,
            long grossShort,
            long netMinor,
            List<String> accounts,
            BigDecimal largestAccountShare
    ) {
        public Exposure {
            Objects.requireNonNull(currency, "exposure currency");
            Objects.requireNonNull(accounts, "exposure accounts");
            Objects.requireNonNull(largestAccountShare, "exposure concentration");
            if (currency.length() != 3) {
                throw new IllegalArgumentException("exposure currency is invalid");
            }
            if (grossLong < 0 || grossShort < 0) {
                throw new IllegalArgumentException("exposure gross values cannot be negative");
            }
            if (Math.subtractExact(grossLong, grossShort) != netMinor) {
                throw new IllegalArgumentException("exposure gross values do not reconcile");
            }
            LinkedHashSet<String> uniqueAccounts = new LinkedHashSet<>();
            for (String account : accounts) {
                String normalized = Objects.requireNonNull(account, "exposure account").strip();
                if (normalized.isEmpty() || !uniqueAccounts.add(normalized)) {
                    throw new IllegalArgumentException("exposure account list is invalid");
                }
            }
            accounts = List.copyOf(uniqueAccounts);
            if (largestAccountShare.signum() < 0 || largestAccountShare.compareTo(BigDecimal.ONE) > 0) {
                throw new IllegalArgumentException("exposure concentration is outside percentage range");
            }
        }
    }

    record Shock(String currency, int moveBasisPoints, int liquidityBasisPoints) {
        public Shock {
            Objects.requireNonNull(currency, "shock currency");
            currency = currency.strip().toUpperCase(Locale.ROOT);
            if (currency.length() != 3) {
                throw new IllegalArgumentException("shock currency is invalid");
            }
            if (moveBasisPoints < -10_000 || moveBasisPoints > 10_000) {
                throw new IllegalArgumentException("shock market move is outside supported range");
            }
            if (liquidityBasisPoints < 0 || liquidityBasisPoints > 10_000) {
                throw new IllegalArgumentException("shock liquidity cost is outside supported range");
            }
        }
    }
}
