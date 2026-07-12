package synthetic.lane;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;

public final class SettlementCalendar {
    private final ZoneId zone;
    private final HolidayIndex holidays;
    private final List<Rail> rails;

    public SettlementCalendar(ZoneId zone, HolidayIndex holidays, List<Rail> rails) {
        this.zone = Objects.requireNonNull(zone, "settlement zone");
        this.holidays = Objects.requireNonNull(holidays, "settlement holidays");
        Objects.requireNonNull(rails, "settlement rails");
        if (rails.isEmpty() || rails.size() > 1_000) {
            throw new IllegalArgumentException("settlement rail count is outside supported range");
        }
        List<Rail> copied = new ArrayList<>(rails.size());
        Set<String> names = new LinkedHashSet<>();
        for (Rail rail : rails) {
            Rail present = Objects.requireNonNull(rail, "settlement rail");
            if (!names.add(present.name())) {
                throw new IllegalArgumentException("settlement rail repeats: " + present.name());
            }
            copied.add(present);
        }
        copied.sort(Comparator.comparingInt(Rail::priority).thenComparing(Rail::name));
        this.rails = List.copyOf(copied);
    }

    public MarketModels.SettlementResult plan(MarketModels.SettlementInstruction instruction) {
        Objects.requireNonNull(instruction, "settlement instruction");
        List<Rail> candidates = new ArrayList<>();
        for (Rail rail : rails) {
            if (!rail.currency().equals(instruction.pair().counter())) {
                continue;
            }
            if (!rail.countries().contains(instruction.destinationCountry())) {
                continue;
            }
            if (instruction.amountMinor() > rail.maximumAmountMinor()) {
                continue;
            }
            candidates.add(rail);
        }
        if (candidates.isEmpty()) {
            throw new IllegalStateException("no settlement rail supports instruction " + instruction.instructionId());
        }
        candidates.sort(Comparator
                .comparingInt(Rail::priority)
                .thenComparingInt(Rail::businessDays)
                .thenComparing(Rail::cutoff, Comparator.reverseOrder())
                .thenComparing(Rail::name));
        Rail chosen = candidates.get(0);
        ZonedDateTime submission = instruction.submittedAt().atZone(zone);
        boolean afterCutoff = !submission.toLocalTime().isBefore(chosen.cutoff());
        int requiredBusinessDays = chosen.businessDays() + (afterCutoff ? 1 : 0);
        LocalDate requested = instruction.requestedDate();
        if (requested.isBefore(submission.toLocalDate().minusDays(1))) {
            throw new IllegalArgumentException("settlement requested date predates submission");
        }
        LocalDate valueDate = holidays.nextBusinessDate(
                requested,
                chosen.currency(),
                requiredBusinessDays,
                requiredBusinessDays == 0
        );
        int calendarDays = Math.toIntExact(valueDate.toEpochDay() - requested.toEpochDay());
        if (calendarDays < 0 || calendarDays > 90) {
            throw new IllegalStateException("settlement value-date distance is invalid");
        }
        if (!holidays.isBusinessDay(valueDate, chosen.currency())) {
            throw new IllegalStateException("settlement value date is not a business day");
        }
        List<String> alternatives = new ArrayList<>();
        for (int index = 1; index < candidates.size(); index++) {
            Rail alternative = candidates.get(index);
            if (!alternatives.add(alternative.name())) {
                throw new IllegalStateException("settlement alternative repeats unexpectedly");
            }
        }
        return new MarketModels.SettlementResult(
                instruction.instructionId(),
                chosen.name(),
                valueDate,
                afterCutoff,
                calendarDays,
                alternatives
        );
    }

    record Rail(
            String name,
            String currency,
            Set<String> countries,
            LocalTime cutoff,
            int businessDays,
            long maximumAmountMinor,
            int priority
    ) {
        public Rail {
            Objects.requireNonNull(name, "settlement rail name");
            Objects.requireNonNull(currency, "settlement rail currency");
            Objects.requireNonNull(countries, "settlement rail countries");
            Objects.requireNonNull(cutoff, "settlement rail cutoff");
            name = name.strip();
            currency = currency.strip().toUpperCase(Locale.ROOT);
            if (name.isEmpty() || name.length() > 100) {
                throw new IllegalArgumentException("settlement rail name is invalid");
            }
            for (int index = 0; index < name.length(); index++) {
                char character = name.charAt(index);
                boolean safe = Character.isLetterOrDigit(character)
                        || character == '-'
                        || character == '_';
                if (!safe) {
                    throw new IllegalArgumentException("settlement rail name contains unsafe syntax");
                }
            }
            if (currency.length() != 3) {
                throw new IllegalArgumentException("settlement rail currency is invalid");
            }
            LinkedHashSet<String> copiedCountries = new LinkedHashSet<>();
            for (String rawCountry : countries) {
                String country = Objects.requireNonNull(rawCountry, "settlement rail country")
                        .strip()
                        .toUpperCase(Locale.ROOT);
                if (country.length() != 2) {
                    throw new IllegalArgumentException("settlement rail country is invalid");
                }
                for (int index = 0; index < country.length(); index++) {
                    char character = country.charAt(index);
                    if (character < 'A' || character > 'Z') {
                        throw new IllegalArgumentException("settlement rail country is not normalized");
                    }
                }
                if (!copiedCountries.add(country)) {
                    throw new IllegalArgumentException("settlement rail country repeats: " + country);
                }
            }
            if (copiedCountries.isEmpty()) {
                throw new IllegalArgumentException("settlement rail must support at least one country");
            }
            countries = Collections.unmodifiableSet(copiedCountries);
            if (businessDays < 0 || businessDays > 10) {
                throw new IllegalArgumentException("settlement rail business-day delay is invalid");
            }
            if (maximumAmountMinor < 1) {
                throw new IllegalArgumentException("settlement rail amount limit must be positive");
            }
            if (priority < 0 || priority > 10_000) {
                throw new IllegalArgumentException("settlement rail priority is invalid");
            }
        }
    }
}
