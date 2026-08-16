package synthetic.lane;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;

/**
 * 节假日日历索引:为每个币种维护「节假日闭市日期」与「异常开市日期」两张表,
 * 并提供营业日判断与按营业日推进日期的能力(用于结算日/交割日计算)。
 *
 * <p>周末(默认闭市)通过 DayOfWeek 集合配置;某天若同时出现在闭市与异常开市表中会被拒绝。
 */
public final class HolidayIndex {
    private final ZoneId zone;
    // 每周的周末天(这些天默认不是营业日)
    private final Set<DayOfWeek> weekends;
    // 币种 -> 闭市日期集合(节假日)
    private final Map<String, Set<LocalDate>> closures;
    // 币种 -> 异常开市日期集合(通常周末/节假日临时开市)
    private final Map<String, Set<LocalDate>> exceptionalOpenings;

    public HolidayIndex(
            ZoneId zone,
            Set<DayOfWeek> weekends,
            Map<String, List<String>> closureDates,
            Map<String, List<String>> openingDates
    ) {
        this.zone = Objects.requireNonNull(zone, "holiday zone");
        Objects.requireNonNull(weekends, "holiday weekend days");
        Objects.requireNonNull(closureDates, "holiday closures");
        Objects.requireNonNull(openingDates, "holiday exceptional openings");
        if (weekends.isEmpty() || weekends.size() > 6) {
            throw new IllegalArgumentException("holiday weekend definition is invalid");
        }
        EnumSet<DayOfWeek> copiedWeekends = EnumSet.noneOf(DayOfWeek.class);
        for (DayOfWeek day : weekends) {
            if (!copiedWeekends.add(Objects.requireNonNull(day, "weekend day"))) {
                throw new IllegalArgumentException("holiday weekend day repeats");
            }
        }
        this.weekends = Collections.unmodifiableSet(copiedWeekends);
        Map<String, Set<LocalDate>> parsedClosures = new LinkedHashMap<>();
        Map<String, Set<LocalDate>> parsedOpenings = new LinkedHashMap<>();
        Set<String> currencyNames = new TreeSet<>();
        currencyNames.addAll(closureDates.keySet());
        currencyNames.addAll(openingDates.keySet());
        if (currencyNames.size() > 500) {
            throw new IllegalArgumentException("holiday currency coverage exceeds capacity");
        }
        for (String rawCurrency : currencyNames) {
            String currency = Objects.requireNonNull(rawCurrency, "holiday currency")
                    .strip()
                    .toUpperCase(Locale.ROOT);
            if (currency.length() != 3) {
                throw new IllegalArgumentException("holiday currency must have three letters");
            }
            for (int index = 0; index < currency.length(); index++) {
                char character = currency.charAt(index);
                if (character < 'A' || character > 'Z') {
                    throw new IllegalArgumentException("holiday currency is not normalized");
                }
            }
            List<String> rawClosures = closureDates.getOrDefault(rawCurrency, List.of());
            List<String> rawOpenings = openingDates.getOrDefault(rawCurrency, List.of());
            if (rawClosures.size() > 20_000 || rawOpenings.size() > 20_000) {
                throw new IllegalArgumentException("holiday date coverage exceeds capacity for " + currency);
            }
            Set<LocalDate> currencyClosures = new TreeSet<>();
            for (String text : rawClosures) {
                try {
                    LocalDate date = LocalDate.parse(Objects.requireNonNull(text, "holiday closure"));
                    if (!currencyClosures.add(date)) {
                        throw new IllegalArgumentException("holiday closure repeats for " + currency + ": " + text);
                    }
                } catch (DateTimeParseException failure) {
                    throw new IllegalArgumentException("holiday closure date is invalid: " + text, failure);
                }
            }
            Set<LocalDate> currencyOpenings = new TreeSet<>();
            for (String text : rawOpenings) {
                try {
                    LocalDate date = LocalDate.parse(Objects.requireNonNull(text, "holiday opening"));
                    if (!currencyOpenings.add(date)) {
                        throw new IllegalArgumentException("holiday opening repeats for " + currency + ": " + text);
                    }
                    if (currencyClosures.contains(date)) {
                        throw new IllegalArgumentException("date is both closed and exceptionally open: " + text);
                    }
                } catch (DateTimeParseException failure) {
                    throw new IllegalArgumentException("holiday opening date is invalid: " + text, failure);
                }
            }
            parsedClosures.put(currency, Collections.unmodifiableSet(currencyClosures));
            parsedOpenings.put(currency, Collections.unmodifiableSet(currencyOpenings));
        }
        this.closures = Collections.unmodifiableMap(parsedClosures);
        this.exceptionalOpenings = Collections.unmodifiableMap(parsedOpenings);
    }

    /**
     * 判断某天是否为某币种的营业日。
     * 优先级:异常开市 > 节假日闭市 > 周末,即异常开市可以覆盖节假日和周末。
     */
    public boolean isBusinessDay(LocalDate date, String currency) {
        Objects.requireNonNull(date, "business date");
        Objects.requireNonNull(currency, "business currency");
        String normalized = currency.strip().toUpperCase(Locale.ROOT);
        if (normalized.length() != 3) {
            throw new IllegalArgumentException("business currency must have three letters");
        }
        if (!closures.containsKey(normalized) && !exceptionalOpenings.containsKey(normalized)) {
            throw new IllegalArgumentException("holiday index has no calendar for " + normalized);
        }
        Set<LocalDate> openings = exceptionalOpenings.getOrDefault(normalized, Set.of());
        if (openings.contains(date)) {
            return true;
        }
        Set<LocalDate> currencyClosures = closures.getOrDefault(normalized, Set.of());
        if (currencyClosures.contains(date)) {
            return false;
        }
        return !weekends.contains(date.getDayOfWeek());
    }

    /**
     * 从起始日期向前(或原地)推进指定的营业日数,返回结果营业日。
     *
     * @param businessDays 要跨越的营业日数(0 表示推进到下一个营业日)
     * @param includeStart 为 true 时起始日若是营业日则计入第一天
     * @return 推进后的营业日;若恰逢闭市会继续向前取最近的营业日
     */
    public LocalDate nextBusinessDate(
            LocalDate start,
            String currency,
            int businessDays,
            boolean includeStart
    ) {
        Objects.requireNonNull(start, "business-date start");
        if (businessDays < 0 || businessDays > 60) {
            throw new IllegalArgumentException("business-day offset is outside supported range");
        }
        String normalized = Objects.requireNonNull(currency, "business currency")
                .strip()
                .toUpperCase(Locale.ROOT);
        LocalDate cursor = start;
        int counted = 0;
        int searched = 0;
        if (!includeStart || !isBusinessDay(cursor, normalized)) {
            cursor = cursor.plusDays(1);
            searched++;
        }
        if (businessDays == 0) {
            while (!isBusinessDay(cursor, normalized)) {
                cursor = cursor.plusDays(1);
                searched++;
                if (searched > 90) {
                    throw new IllegalStateException("business-date search exceeded ninety days");
                }
            }
            return cursor;
        }
        while (counted < businessDays) {
            if (isBusinessDay(cursor, normalized)) {
                counted++;
                if (counted == businessDays) {
                    break;
                }
            }
            cursor = cursor.plusDays(1);
            searched++;
            if (searched > 180) {
                throw new IllegalStateException("business-date search exceeded one hundred eighty days");
            }
        }
        if (cursor.isBefore(start)) {
            throw new IllegalStateException("business-date search moved backward");
        }
        if (!isBusinessDay(cursor, normalized)) {
            throw new IllegalStateException("business-date search ended on a closed day");
        }
        return cursor;
    }
}
