export type CalendarConvention = "following" | "modified-following" | "preceding" | "modified-preceding";
export type CalendarDayStatus = "business" | "weekend" | "holiday" | "partial" | "unknown";

export interface CalendarHoliday {
  readonly calendarId: string;
  readonly date: string;
  readonly name: string;
  readonly fullClosure: boolean;
  readonly closingHourUtc?: number;
  readonly currencies: readonly string[];
}

export interface CalendarWeekendRule {
  readonly calendarId: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil?: string;
  readonly weekendDays: readonly number[];
}

export interface CalendarCutoffRule {
  readonly currency: string;
  readonly destinationCountry: string;
  readonly cutoffHourUtc: number;
  readonly cutoffMinuteUtc: number;
  readonly afterCutoffAdditionalDays: number;
  readonly partialHolidayHourUtc?: number;
}

export interface CalendarRollPolicy {
  readonly convention: CalendarConvention;
  readonly maximumSearchDays: number;
  readonly requiredCalendars: readonly string[];
  readonly allowUnknownCalendar: boolean;
  readonly treatPartialAsBusiness: boolean;
  readonly preserveRequestedMonth: boolean;
}

export interface CalendarRollInput {
  readonly requestedDate: string;
  readonly submittedAt: Date;
  readonly currency: string;
  readonly destinationCountry: string;
  readonly additionalBusinessDays: number;
  readonly holidays: readonly CalendarHoliday[];
  readonly weekendRules: readonly CalendarWeekendRule[];
  readonly cutoffRules: readonly CalendarCutoffRule[];
  readonly policy: CalendarRollPolicy;
}

export interface CalendarDayEvaluation {
  readonly date: string;
  readonly status: CalendarDayStatus;
  readonly calendarIds: readonly string[];
  readonly reasons: readonly string[];
  readonly counted: boolean;
  readonly monthBoundary: boolean;
}

export interface CalendarRollResult {
  readonly requestedDate: string;
  readonly valueDate: string;
  readonly appliedConvention: CalendarConvention;
  readonly appliedAdditionalDays: number;
  readonly afterCutoff: boolean;
  readonly path: readonly CalendarDayEvaluation[];
  readonly warnings: readonly string[];
  readonly searchedDays: number;
  readonly crossedMonth: boolean;
}

export interface SettlementOrderingSlot {
  readonly instructionId: string;
  readonly inputIndex: number;
  readonly idempotencyKey: string;
  readonly priorReceiptId?: string;
  readonly attemptCount: number;
  readonly retryable: boolean;
  readonly scheduledAt?: Date;
}

export interface SettlementOrderingPlan {
  readonly batchId: string;
  readonly slots: readonly SettlementOrderingSlot[];
  readonly outputOrder: readonly number[];
  readonly retryGroups: readonly (readonly number[])[];
  readonly duplicateInstructionIds: readonly string[];
  readonly receiptReservations: Readonly<Record<string, string>>;
}
