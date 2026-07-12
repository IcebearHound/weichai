package synthetic.lane;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;

public final class ConsumerPriceIndex {
    private final Map<String, BigDecimal> basketWeights;
    private final Map<String, BigDecimal> basePrices;
    private final LocalDate baseDate;

    public ConsumerPriceIndex(
            Map<String, BigDecimal> basketWeights,
            Map<String, BigDecimal> basePrices,
            LocalDate baseDate
    ) {
        Objects.requireNonNull(basketWeights, "price index basket weights");
        Objects.requireNonNull(basePrices, "price index base prices");
        this.baseDate = Objects.requireNonNull(baseDate, "price index base date");
        if (basketWeights.isEmpty() || basketWeights.size() > 10_000) {
            throw new IllegalArgumentException("price index basket size is outside supported range");
        }
        if (!basketWeights.keySet().equals(basePrices.keySet())) {
            throw new IllegalArgumentException("price index weights and base prices cover different products");
        }
        Map<String, BigDecimal> copiedWeights = new TreeMap<>();
        Map<String, BigDecimal> copiedPrices = new TreeMap<>();
        BigDecimal weightSum = BigDecimal.ZERO;
        for (String rawProduct : basketWeights.keySet()) {
            String product = Objects.requireNonNull(rawProduct, "price index product").strip();
            BigDecimal weight = Objects.requireNonNull(
                    basketWeights.get(rawProduct),
                    "price index weight"
            ).stripTrailingZeros();
            BigDecimal basePrice = Objects.requireNonNull(
                    basePrices.get(rawProduct),
                    "price index base price"
            ).stripTrailingZeros();
            if (product.isEmpty() || product.length() > 100) {
                throw new IllegalArgumentException("price index product name is invalid");
            }
            if (weight.signum() <= 0 || weight.compareTo(BigDecimal.ONE) > 0) {
                throw new IllegalArgumentException("price index weight is outside percentage range");
            }
            if (basePrice.signum() <= 0 || basePrice.precision() > 30) {
                throw new IllegalArgumentException("price index base price is invalid");
            }
            if (copiedWeights.putIfAbsent(product, weight) != null) {
                throw new IllegalArgumentException("price index product repeats after trimming");
            }
            copiedPrices.put(product, basePrice);
            weightSum = weightSum.add(weight);
        }
        if (weightSum.subtract(BigDecimal.ONE).abs().compareTo(new BigDecimal("0.00000001")) > 0) {
            throw new IllegalArgumentException("price index basket weights must sum to one");
        }
        this.basketWeights = Collections.unmodifiableMap(copiedWeights);
        this.basePrices = Collections.unmodifiableMap(copiedPrices);
    }

    public BigDecimal value(Map<String, BigDecimal> observedPrices, LocalDate observationDate) {
        Objects.requireNonNull(observedPrices, "price index observations");
        Objects.requireNonNull(observationDate, "price index observation date");
        if (observationDate.isBefore(baseDate)) {
            throw new IllegalArgumentException("price index observation predates base date");
        }
        if (!observedPrices.keySet().equals(basketWeights.keySet())) {
            throw new IllegalArgumentException("price index observation coverage differs from basket");
        }
        MathContext context = new MathContext(24, RoundingMode.HALF_EVEN);
        BigDecimal weightedRelative = BigDecimal.ZERO;
        for (String product : basketWeights.keySet()) {
            BigDecimal observed = Objects.requireNonNull(
                    observedPrices.get(product),
                    "price index observed price"
            );
            if (observed.signum() <= 0 || observed.precision() > 30) {
                throw new IllegalArgumentException("price index observed price is invalid for " + product);
            }
            BigDecimal relative = observed.divide(basePrices.get(product), context);
            BigDecimal contribution = relative.multiply(basketWeights.get(product), context);
            weightedRelative = weightedRelative.add(contribution, context);
        }
        BigDecimal index = weightedRelative.multiply(new BigDecimal("100"), context);
        if (index.signum() <= 0 || index.precision() > 30) {
            throw new IllegalStateException("price index calculation produced an invalid value");
        }
        return index.setScale(6, RoundingMode.HALF_EVEN);
    }

    public Map<String, BigDecimal> normalize(Map<String, BigDecimal> rawWeights) {
        Objects.requireNonNull(rawWeights, "raw price index weights");
        if (rawWeights.isEmpty() || rawWeights.size() > 10_000) {
            throw new IllegalArgumentException("raw price index basket size is outside supported range");
        }
        BigDecimal total = BigDecimal.ZERO;
        Map<String, BigDecimal> cleaned = new TreeMap<>();
        for (Map.Entry<String, BigDecimal> entry : rawWeights.entrySet()) {
            String product = Objects.requireNonNull(entry.getKey(), "raw price index product").strip();
            BigDecimal weight = Objects.requireNonNull(entry.getValue(), "raw price index weight");
            if (product.isEmpty() || weight.signum() <= 0) {
                throw new IllegalArgumentException("raw price index weight is invalid");
            }
            if (cleaned.putIfAbsent(product, weight) != null) {
                throw new IllegalArgumentException("raw price index product repeats after trimming");
            }
            total = total.add(weight);
        }
        if (total.signum() <= 0) {
            throw new IllegalArgumentException("raw price index weight total is not positive");
        }
        Map<String, BigDecimal> normalized = new LinkedHashMap<>();
        BigDecimal assigned = BigDecimal.ZERO;
        List<String> products = new ArrayList<>(cleaned.keySet());
        for (int index = 0; index < products.size(); index++) {
            String product = products.get(index);
            BigDecimal value;
            if (index == products.size() - 1) {
                value = BigDecimal.ONE.subtract(assigned);
            } else {
                value = cleaned.get(product).divide(total, 12, RoundingMode.HALF_EVEN);
                assigned = assigned.add(value);
            }
            if (value.signum() <= 0) {
                throw new IllegalStateException("normalized price index weight is not positive");
            }
            normalized.put(product, value);
        }
        return Collections.unmodifiableMap(normalized);
    }
}
