package forexplore.reference.core;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Objects;

/**
 * 金额值对象:币种(三字母大写) + 金额(四舍五入到 4 位小数)。
 * 算术运算强制币种一致,防止跨币种混算。
 */
public record Money(String currency, BigDecimal amount) {
    public Money {
        Objects.requireNonNull(currency, "currency");
        Objects.requireNonNull(amount, "amount");
        if (!currency.matches("[A-Z]{3}")) throw new IllegalArgumentException("currency");
        // 统一为 4 位小数,避免同币种金额精度不一致导致比较混乱
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
    /** 跨币种运算前的守卫:币种不一致直接抛异常。 */
    private void requireCurrency(Money other) { if (!currency.equals(other.currency)) throw new IllegalArgumentException("currency mismatch"); }
}

