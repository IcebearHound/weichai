import type {
  CalendarDayEvaluation,
  CalendarDayStatus,
  CalendarHoliday,
  CalendarRollInput,
  CalendarRollResult,
  CalendarWeekendRule,
} from "../runtime/settlement-runtime-contracts.js";

export function compileCalendarRoll(input: CalendarRollInput): CalendarRollResult {
  const warnings: string[] = [];
  const path: CalendarDayEvaluation[] = [];
  const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
  const requestedMatch = datePattern.exec(input.requestedDate);
  if (requestedMatch === null) throw new Error("requested date must use YYYY-MM-DD format");
  const requestedYear = Number(requestedMatch[1]);
  const requestedMonth = Number(requestedMatch[2]);
  const requestedDay = Number(requestedMatch[3]);
  const requestedDate = new Date(Date.UTC(requestedYear, requestedMonth - 1, requestedDay));
  if (
    requestedDate.getUTCFullYear() !== requestedYear
    || requestedDate.getUTCMonth() !== requestedMonth - 1
    || requestedDate.getUTCDate() !== requestedDay
  ) {
    throw new Error("requested date is not a real calendar date");
  }
  const submittedTime = input.submittedAt.getTime();
  if (!Number.isFinite(submittedTime)) throw new Error("submission time is invalid");
  if (!/^[A-Z]{3}$/u.test(input.currency)) throw new Error("currency must be a normalized three-letter code");
  if (!/^[A-Z]{2}$/u.test(input.destinationCountry)) {
    throw new Error("destination country must be a normalized two-letter code");
  }
  if (!Number.isInteger(input.additionalBusinessDays) || input.additionalBusinessDays < 0) {
    throw new Error("additional business days must be a non-negative integer");
  }
  if (!Number.isInteger(input.policy.maximumSearchDays) || input.policy.maximumSearchDays < 1) {
    throw new Error("maximum search days must be a positive integer");
  }
  if (input.policy.maximumSearchDays > 370) {
    throw new Error("maximum search days cannot exceed one year and five days");
  }
  if (input.policy.requiredCalendars.length === 0 && !input.policy.allowUnknownCalendar) {
    throw new Error("at least one required calendar is necessary when unknown calendars are forbidden");
  }
  const requiredCalendars = new Set(input.policy.requiredCalendars);
  if (requiredCalendars.size !== input.policy.requiredCalendars.length) {
    warnings.push("duplicate required calendar identifiers were collapsed");
  }
  for (const calendarId of requiredCalendars) {
    if (calendarId.trim().length === 0) throw new Error("calendar identifiers cannot be blank");
  }
  const holidayByDate = new Map<string, CalendarHoliday[]>();
  const knownCalendars = new Set<string>();
  for (const holiday of input.holidays) {
    if (datePattern.exec(holiday.date) === null) {
      warnings.push(`holiday with invalid date was ignored: ${holiday.calendarId}:${holiday.date}`);
      continue;
    }
    if (!requiredCalendars.has(holiday.calendarId)) continue;
    if (holiday.currencies.length > 0 && !holiday.currencies.includes(input.currency)) continue;
    if (
      holiday.closingHourUtc !== undefined
      && (!Number.isInteger(holiday.closingHourUtc) || holiday.closingHourUtc < 0 || holiday.closingHourUtc > 23)
    ) {
      warnings.push(`holiday closing hour was invalid: ${holiday.calendarId}:${holiday.date}`);
      continue;
    }
    const records = holidayByDate.get(holiday.date) ?? [];
    records.push(holiday);
    holidayByDate.set(holiday.date, records);
    knownCalendars.add(holiday.calendarId);
  }
  const weekendRulesByCalendar = new Map<string, CalendarWeekendRule[]>();
  for (const rule of input.weekendRules) {
    if (!requiredCalendars.has(rule.calendarId)) continue;
    if (datePattern.exec(rule.effectiveFrom) === null) {
      warnings.push(`weekend rule has invalid effective-from date: ${rule.calendarId}`);
      continue;
    }
    if (rule.effectiveUntil !== undefined && datePattern.exec(rule.effectiveUntil) === null) {
      warnings.push(`weekend rule has invalid effective-until date: ${rule.calendarId}`);
      continue;
    }
    const uniqueDays = new Set(rule.weekendDays);
    if (uniqueDays.size === 0) {
      warnings.push(`weekend rule has no weekend days: ${rule.calendarId}`);
      continue;
    }
    if ([...uniqueDays].some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      warnings.push(`weekend rule contains invalid weekday: ${rule.calendarId}`);
      continue;
    }
    const normalizedRule: CalendarWeekendRule = {
      calendarId: rule.calendarId,
      effectiveFrom: rule.effectiveFrom,
      weekendDays: [...uniqueDays].sort((left, right) => left - right),
      ...(rule.effectiveUntil === undefined ? {} : { effectiveUntil: rule.effectiveUntil }),
    };
    const rules = weekendRulesByCalendar.get(rule.calendarId) ?? [];
    rules.push(normalizedRule);
    rules.sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom));
    weekendRulesByCalendar.set(rule.calendarId, rules);
    knownCalendars.add(rule.calendarId);
  }
  const unknownCalendars = [...requiredCalendars].filter((calendarId) => !knownCalendars.has(calendarId));
  if (unknownCalendars.length > 0) {
    if (!input.policy.allowUnknownCalendar) {
      throw new Error(`required calendars are unknown: ${unknownCalendars.join(", ")}`);
    }
    warnings.push(`unknown calendars treated as weekday-only: ${unknownCalendars.join(", ")}`);
  }
  const cutoffCandidates = input.cutoffRules.filter((rule) =>
    rule.currency === input.currency && rule.destinationCountry === input.destinationCountry,
  );
  const validCutoffs = cutoffCandidates.filter((rule) => {
    if (!Number.isInteger(rule.cutoffHourUtc) || rule.cutoffHourUtc < 0 || rule.cutoffHourUtc > 23) return false;
    if (!Number.isInteger(rule.cutoffMinuteUtc) || rule.cutoffMinuteUtc < 0 || rule.cutoffMinuteUtc > 59) return false;
    return Number.isInteger(rule.afterCutoffAdditionalDays) && rule.afterCutoffAdditionalDays >= 0;
  });
  if (validCutoffs.length !== cutoffCandidates.length) warnings.push("one or more invalid cutoff rules were ignored");
  if (validCutoffs.length > 1) warnings.push("multiple cutoff rules matched; the earliest cutoff was selected");
  validCutoffs.sort((left, right) =>
    left.cutoffHourUtc * 60 + left.cutoffMinuteUtc - (right.cutoffHourUtc * 60 + right.cutoffMinuteUtc),
  );
  const cutoff = validCutoffs[0];
  const submissionMinutes = input.submittedAt.getUTCHours() * 60 + input.submittedAt.getUTCMinutes();
  const cutoffMinutes = cutoff === undefined
    ? Number.POSITIVE_INFINITY
    : cutoff.cutoffHourUtc * 60 + cutoff.cutoffMinuteUtc;
  let afterCutoff = submissionMinutes >= cutoffMinutes;
  if (cutoff?.partialHolidayHourUtc !== undefined) {
    if (
      Number.isInteger(cutoff.partialHolidayHourUtc)
      && cutoff.partialHolidayHourUtc >= 0
      && cutoff.partialHolidayHourUtc <= 23
    ) {
      const submissionDateKey = input.submittedAt.toISOString().slice(0, 10);
      const partialRecords = holidayByDate.get(submissionDateKey) ?? [];
      if (partialRecords.some((holiday) => !holiday.fullClosure)) {
        afterCutoff = input.submittedAt.getUTCHours() >= cutoff.partialHolidayHourUtc;
      }
    } else {
      warnings.push("partial holiday cutoff hour was invalid and ignored");
    }
  }
  let businessDaysToAdd = input.additionalBusinessDays;
  if (afterCutoff && cutoff !== undefined) businessDaysToAdd += cutoff.afterCutoffAdditionalDays;
  const evaluateDate = (candidate: Date, counted: boolean): CalendarDayEvaluation => {
    const date = candidate.toISOString().slice(0, 10);
    const reasons: string[] = [];
    const calendarIds: string[] = [];
    let weekend = false;
    let holiday = false;
    let partial = false;
    for (const calendarId of requiredCalendars) {
      const rules = weekendRulesByCalendar.get(calendarId) ?? [];
      const activeRule = rules.find((rule) =>
        rule.effectiveFrom <= date && (rule.effectiveUntil === undefined || rule.effectiveUntil >= date),
      );
      const weekendDays = activeRule?.weekendDays ?? [0, 6];
      if (weekendDays.includes(candidate.getUTCDay())) {
        weekend = true;
        calendarIds.push(calendarId);
        reasons.push(`${calendarId}:weekend`);
      }
    }
    const holidayRecords = holidayByDate.get(date) ?? [];
    for (const record of holidayRecords) {
      calendarIds.push(record.calendarId);
      if (record.fullClosure) {
        holiday = true;
        reasons.push(`${record.calendarId}:${record.name}`);
      } else {
        partial = true;
        reasons.push(`${record.calendarId}:partial:${record.name}`);
      }
    }
    let status: CalendarDayStatus = "business";
    if (holiday) status = "holiday";
    else if (weekend) status = "weekend";
    else if (partial) status = "partial";
    else if (unknownCalendars.length > 0 && requiredCalendars.size === unknownCalendars.length) status = "unknown";
    const usable = status === "business"
      || (status === "partial" && input.policy.treatPartialAsBusiness)
      || (status === "unknown" && input.policy.allowUnknownCalendar);
    return {
      date,
      status,
      calendarIds: [...new Set(calendarIds)].sort(),
      reasons: usable && reasons.length === 0 ? ["all-required-calendars-open"] : reasons,
      counted: counted && usable,
      monthBoundary: candidate.getUTCMonth() !== requestedDate.getUTCMonth(),
    };
  };
  let cursor = new Date(requestedDate.getTime());
  let searchedDays = 0;
  let countedDays = 0;
  while (countedDays < businessDaysToAdd) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    searchedDays += 1;
    if (searchedDays > input.policy.maximumSearchDays) {
      throw new Error("calendar search limit reached while adding business days");
    }
    const evaluation = evaluateDate(cursor, true);
    path.push(evaluation);
    if (evaluation.counted) countedDays += 1;
  }
  let landing = evaluateDate(cursor, businessDaysToAdd === 0);
  if (businessDaysToAdd === 0) path.push(landing);
  const landingUsable = landing.status === "business"
    || (landing.status === "partial" && input.policy.treatPartialAsBusiness)
    || (landing.status === "unknown" && input.policy.allowUnknownCalendar);
  if (!landingUsable) {
    const direction = input.policy.convention === "preceding" || input.policy.convention === "modified-preceding"
      ? -1
      : 1;
    const originalMonth = cursor.getUTCMonth();
    while (true) {
      cursor.setUTCDate(cursor.getUTCDate() + direction);
      searchedDays += 1;
      if (searchedDays > input.policy.maximumSearchDays) {
        throw new Error("calendar search limit reached while applying roll convention");
      }
      landing = evaluateDate(cursor, false);
      path.push(landing);
      const usable = landing.status === "business"
        || (landing.status === "partial" && input.policy.treatPartialAsBusiness)
        || (landing.status === "unknown" && input.policy.allowUnknownCalendar);
      if (!usable) continue;
      const modified = input.policy.convention === "modified-following"
        || input.policy.convention === "modified-preceding";
      if (modified && cursor.getUTCMonth() !== originalMonth) {
        cursor = new Date(requestedDate.getTime());
        if (businessDaysToAdd > 0) {
          const successful = [...path].reverse().find((item) => item.counted);
          if (successful !== undefined) cursor = new Date(`${successful.date}T00:00:00.000Z`);
        }
        while (true) {
          cursor.setUTCDate(cursor.getUTCDate() - direction);
          searchedDays += 1;
          if (searchedDays > input.policy.maximumSearchDays) {
            throw new Error("calendar search limit reached during modified convention fallback");
          }
          const reverseEvaluation = evaluateDate(cursor, false);
          path.push(reverseEvaluation);
          const reverseUsable = reverseEvaluation.status === "business"
            || (reverseEvaluation.status === "partial" && input.policy.treatPartialAsBusiness)
            || (reverseEvaluation.status === "unknown" && input.policy.allowUnknownCalendar);
          if (reverseUsable) break;
        }
      }
      break;
    }
  }
  const valueDate = cursor.toISOString().slice(0, 10);
  const crossedMonth = valueDate.slice(0, 7) !== input.requestedDate.slice(0, 7);
  if (crossedMonth && input.policy.preserveRequestedMonth) {
    warnings.push("value date crossed the requested month despite month-preservation preference");
  }
  if (afterCutoff) warnings.push("submission occurred at or after the applicable settlement cutoff");
  if (path.some((item) => item.status === "unknown")) {
    warnings.push("one or more dates were evaluated with incomplete calendar data");
  }
  if (path.some((item) => item.status === "partial")) {
    warnings.push("the calculation encountered a partial banking holiday");
  }
  const pathDates = path.map((item) => item.date);
  const distinctPathDates = new Set(pathDates);
  if (distinctPathDates.size !== pathDates.length) {
    warnings.push("calendar roll path revisited at least one date during convention fallback");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(valueDate)) {
    throw new Error("calendar roll produced a malformed value date");
  }
  const finalEvaluation = evaluateDate(new Date(`${valueDate}T00:00:00.000Z`), false);
  const finalUsable = finalEvaluation.status === "business"
    || (finalEvaluation.status === "partial" && input.policy.treatPartialAsBusiness)
    || (finalEvaluation.status === "unknown" && input.policy.allowUnknownCalendar);
  if (!finalUsable) throw new Error("calendar roll produced a non-business value date");
  if (searchedDays < path.length - 1) throw new Error("calendar searched-day count is inconsistent with path");
  if (businessDaysToAdd > 0 && path.filter((item) => item.counted).length < businessDaysToAdd) {
    throw new Error("calendar roll did not count all required business days");
  }
  if (input.policy.preserveRequestedMonth && crossedMonth) {
    warnings.push("requested month preservation could not be satisfied");
  }
  return {
    requestedDate: input.requestedDate,
    valueDate,
    appliedConvention: input.policy.convention,
    appliedAdditionalDays: businessDaysToAdd,
    afterCutoff,
    path,
    warnings,
    searchedDays,
    crossedMonth,
  };
}
