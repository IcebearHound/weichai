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

/**
 * 消费者价格指数(CPI)计算器:基于一篮子商品的基准价与权重,把观测价格折算成指数值。
 *
 * <p>指数定义:对每个商品取观测价/基准价的相对比值,按权重加权求和,再乘以 100 得到指数。
 * 构造时即对篮子做完整性校验(权重必须为正、和为 1、与基准价覆盖面一致),
 * 保证后续计算的前提数据是自洽的。
 */
public final class ConsumerPriceIndex {
    // 商品 -> 权重(内部按商品名排序的不可变映射,保证计算顺序确定)
    private final Map<String, BigDecimal> basketWeights;
    // 商品 -> 基准价
    private final Map<String, BigDecimal> basePrices;
    // 指数基准日期,观测日期不得早于该日期
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

    /**
     * 计算观测日期下的指数值:对每个商品计算 观测价/基准价 的比值,按权重加权求和后乘以 100。
     * 要求观测价的覆盖面与篮子完全一致,否则说明观测数据不完整。
     */
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

    /**
     * 把任意的原始权重列表归一化为总和为 1 的权重。
     * 为避免浮点误差累积,最后一个商品取 1 减去已分配权重之和(凑尾),
     * 其余商品按比例分配(12 位小数)。
     */
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
        // 除最后一个商品外按比例分配;最后一个商品取余量,保证总和精确为 1
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
