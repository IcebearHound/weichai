import type {
  RetentionAction,
  RetentionPlan,
  RetentionPlanItem,
  RetentionRecord,
  RetentionRule,
} from "../runtime/operations-runtime-contracts.js";

export interface RetentionCapacityPolicy {
  readonly archiveTier: string;
  readonly maximumArchiveBytes: number;
  readonly maximumDeleteRecords: number;
  readonly maximumAnonymizeRecords: number;
  readonly minimumLastAccessDays: number;
  readonly legalHoldIds: readonly string[];
  readonly dryRun: boolean;
  readonly requireRuleForDeletion: boolean;
  readonly allowImmutableArchive: boolean;
}

export interface RetentionPlanInput {
  readonly records: readonly RetentionRecord[];
  readonly rules: readonly RetentionRule[];
  readonly evaluatedAt: Date;
  readonly capacity: RetentionCapacityPolicy;
  readonly previouslyProcessedRecordIds: readonly string[];
  readonly protectedStorageTiers: readonly string[];
}

export function compileRetentionPlan(input: RetentionPlanInput): RetentionPlan {
  const warnings: string[] = [];
  const items: RetentionPlanItem[] = [];
  const evaluatedTime = input.evaluatedAt.getTime();
  if (!Number.isFinite(evaluatedTime)) throw new Error("retention evaluation time is invalid");
  const capacity = input.capacity;
  if (capacity.archiveTier.trim().length === 0) throw new Error("archive tier cannot be blank");
  if (!Number.isSafeInteger(capacity.maximumArchiveBytes) || capacity.maximumArchiveBytes < 0) {
    throw new Error("maximum archive bytes must be a non-negative safe integer");
  }
  if (!Number.isInteger(capacity.maximumDeleteRecords) || capacity.maximumDeleteRecords < 0) {
    throw new Error("maximum delete records cannot be negative");
  }
  if (!Number.isInteger(capacity.maximumAnonymizeRecords) || capacity.maximumAnonymizeRecords < 0) {
    throw new Error("maximum anonymize records cannot be negative");
  }
  if (!Number.isInteger(capacity.minimumLastAccessDays) || capacity.minimumLastAccessDays < 0) {
    throw new Error("minimum last-access days cannot be negative");
  }
  const globalHolds = new Set(capacity.legalHoldIds);
  if (globalHolds.size !== capacity.legalHoldIds.length) warnings.push("duplicate global legal holds were collapsed");
  if ([...globalHolds].some((holdId) => holdId.trim().length === 0)) {
    throw new Error("global legal hold id cannot be blank");
  }
  const protectedTiers = new Set(input.protectedStorageTiers);
  if (protectedTiers.has(capacity.archiveTier)) {
    warnings.push("archive destination is also protected from retention mutations");
  }
  const processed = new Set(input.previouslyProcessedRecordIds);
  if (processed.size !== input.previouslyProcessedRecordIds.length) {
    warnings.push("duplicate processed record identifiers were collapsed");
  }
  const ruleById = new Map<string, RetentionRule>();
  const rulesByCategory = new Map<string, RetentionRule[]>();
  for (const rule of input.rules) {
    if (rule.ruleId.trim().length === 0) throw new Error("retention rule id cannot be blank");
    if (ruleById.has(rule.ruleId)) throw new Error(`duplicate retention rule: ${rule.ruleId}`);
    if (rule.category.trim().length === 0) throw new Error(`rule category is blank: ${rule.ruleId}`);
    if (rule.jurisdiction.trim().length === 0) throw new Error(`rule jurisdiction is blank: ${rule.ruleId}`);
    if (!Number.isInteger(rule.retainDays) || rule.retainDays < 0) {
      throw new Error(`rule retain days are invalid: ${rule.ruleId}`);
    }
    if (rule.archiveAfterDays !== undefined) {
      if (!Number.isInteger(rule.archiveAfterDays) || rule.archiveAfterDays < 0) {
        throw new Error(`rule archive age is invalid: ${rule.ruleId}`);
      }
      if (rule.archiveAfterDays > rule.retainDays) {
        warnings.push(`archive age exceeds retain age: ${rule.ruleId}`);
      }
    }
    if (rule.anonymizeAfterDays !== undefined) {
      if (!Number.isInteger(rule.anonymizeAfterDays) || rule.anonymizeAfterDays < 0) {
        throw new Error(`rule anonymize age is invalid: ${rule.ruleId}`);
      }
      if (rule.anonymizeAfterDays > rule.retainDays) {
        warnings.push(`anonymize age exceeds retain age: ${rule.ruleId}`);
      }
    }
    if (!Number.isInteger(rule.priority)) throw new Error(`rule priority is invalid: ${rule.ruleId}`);
    ruleById.set(rule.ruleId, rule);
    const group = rulesByCategory.get(rule.category) ?? [];
    group.push(rule);
    group.sort((left, right) => {
      if (left.priority !== right.priority) return right.priority - left.priority;
      if (left.jurisdiction === "GLOBAL" && right.jurisdiction !== "GLOBAL") return 1;
      if (right.jurisdiction === "GLOBAL" && left.jurisdiction !== "GLOBAL") return -1;
      if (left.retainDays !== right.retainDays) return right.retainDays - left.retainDays;
      return left.ruleId.localeCompare(right.ruleId);
    });
    rulesByCategory.set(rule.category, group);
  }
  const recordsById = new Map<string, RetentionRecord>();
  for (const record of input.records) {
    if (record.recordId.trim().length === 0) throw new Error("retention record id cannot be blank");
    if (recordsById.has(record.recordId)) throw new Error(`duplicate retention record: ${record.recordId}`);
    if (record.category.trim().length === 0) throw new Error(`record category is blank: ${record.recordId}`);
    if (record.jurisdiction.trim().length === 0) {
      throw new Error(`record jurisdiction is blank: ${record.recordId}`);
    }
    if (!Number.isFinite(record.createdAt.getTime())) {
      throw new Error(`record creation time is invalid: ${record.recordId}`);
    }
    if (record.createdAt.getTime() > evaluatedTime) {
      warnings.push(`future record will be retained: ${record.recordId}`);
    }
    if (record.lastAccessedAt !== undefined) {
      if (!Number.isFinite(record.lastAccessedAt.getTime())) {
        throw new Error(`record access time is invalid: ${record.recordId}`);
      }
      if (record.lastAccessedAt < record.createdAt) {
        warnings.push(`record access predates creation: ${record.recordId}`);
      }
    }
    if (!Number.isSafeInteger(record.byteCount) || record.byteCount < 0) {
      throw new Error(`record byte count is invalid: ${record.recordId}`);
    }
    if (record.storageTier.trim().length === 0) {
      throw new Error(`record storage tier is blank: ${record.recordId}`);
    }
    recordsById.set(record.recordId, record);
  }
  const sortedRecords = [...recordsById.values()].sort((left, right) => {
    const ageOrder = left.createdAt.getTime() - right.createdAt.getTime();
    if (ageOrder !== 0) return ageOrder;
    if (left.category !== right.category) return left.category.localeCompare(right.category);
    return left.recordId.localeCompare(right.recordId);
  });
  let archiveBytes = 0;
  let deleteRecords = 0;
  let anonymizeRecords = 0;
  for (const record of sortedRecords) {
    const reasons: string[] = [];
    const ageMs = Math.max(0, evaluatedTime - record.createdAt.getTime());
    const ageDays = Math.floor(ageMs / 86_400_000);
    const accessReference = record.lastAccessedAt ?? record.createdAt;
    const accessAgeDays = Math.floor(Math.max(0, evaluatedTime - accessReference.getTime()) / 86_400_000);
    const rules = rulesByCategory.get(record.category) ?? [];
    const applicable = rules.filter((rule) =>
      rule.jurisdiction === "GLOBAL" || rule.jurisdiction === record.jurisdiction,
    );
    const selectedRule = applicable[0];
    if (applicable.length > 1 && applicable[0]?.priority === applicable[1]?.priority) {
      warnings.push(`multiple equal-priority rules matched record: ${record.recordId}`);
    }
    const recordHolds = record.legalHoldIds.filter((holdId) => holdId.trim().length > 0);
    const hasLegalHold = recordHolds.length > 0 || [...globalHolds].some((holdId) => recordHolds.includes(holdId));
    const protectedTier = protectedTiers.has(record.storageTier);
    const alreadyProcessed = processed.has(record.recordId);
    let action: RetentionAction = "retain";
    let effectiveAt = input.evaluatedAt;
    let destinationTier: string | undefined;
    if (alreadyProcessed) {
      reasons.push("previously-processed");
    } else if (hasLegalHold) {
      action = "hold";
      reasons.push("legal-hold-active");
      if (recordHolds.length > 0) reasons.push(`record-holds:${recordHolds.sort().join(",")}`);
    } else if (protectedTier) {
      reasons.push(`protected-storage-tier:${record.storageTier}`);
    } else if (selectedRule === undefined) {
      reasons.push("no-applicable-retention-rule");
      if (capacity.requireRuleForDeletion) reasons.push("rule-required-for-deletion");
    } else {
      reasons.push(`selected-rule:${selectedRule.ruleId}`);
      reasons.push(`record-age-days:${ageDays}`);
      reasons.push(`last-access-age-days:${accessAgeDays}`);
      const immutable = record.immutable || selectedRule.immutable;
      const retainDeadline = new Date(record.createdAt.getTime() + selectedRule.retainDays * 86_400_000);
      effectiveAt = retainDeadline;
      if (ageDays >= selectedRule.retainDays) {
        if (immutable) {
          if (capacity.allowImmutableArchive && record.storageTier !== capacity.archiveTier) {
            if (archiveBytes + record.byteCount <= capacity.maximumArchiveBytes) {
              action = "archive";
              destinationTier = capacity.archiveTier;
              archiveBytes += record.byteCount;
              reasons.push("immutable-record-archived-after-retention");
            } else {
              reasons.push("archive-byte-capacity-exhausted");
            }
          } else {
            reasons.push("immutable-record-cannot-be-deleted");
          }
        } else if (!selectedRule.deleteAllowed) {
          reasons.push("selected-rule-forbids-deletion");
        } else if (record.containsPersonalData && selectedRule.anonymizeAfterDays !== undefined) {
          if (ageDays >= selectedRule.anonymizeAfterDays) {
            if (anonymizeRecords < capacity.maximumAnonymizeRecords) {
              action = "anonymize";
              anonymizeRecords += 1;
              reasons.push("personal-data-anonymization-due");
            } else {
              reasons.push("anonymization-capacity-exhausted");
            }
          }
        } else if (accessAgeDays < capacity.minimumLastAccessDays) {
          reasons.push("record-accessed-too-recently");
        } else if (deleteRecords < capacity.maximumDeleteRecords) {
          action = "delete";
          deleteRecords += 1;
          reasons.push("retention-period-elapsed");
        } else {
          reasons.push("deletion-capacity-exhausted");
        }
      } else if (
        selectedRule.archiveAfterDays !== undefined
        && ageDays >= selectedRule.archiveAfterDays
        && record.storageTier !== capacity.archiveTier
      ) {
        if (archiveBytes + record.byteCount <= capacity.maximumArchiveBytes) {
          action = "archive";
          destinationTier = capacity.archiveTier;
          archiveBytes += record.byteCount;
          effectiveAt = new Date(record.createdAt.getTime() + selectedRule.archiveAfterDays * 86_400_000);
          reasons.push("archive-age-reached");
        } else {
          reasons.push("archive-byte-capacity-exhausted");
        }
      } else if (
        record.containsPersonalData
        && selectedRule.anonymizeAfterDays !== undefined
        && ageDays >= selectedRule.anonymizeAfterDays
      ) {
        if (anonymizeRecords < capacity.maximumAnonymizeRecords) {
          action = "anonymize";
          anonymizeRecords += 1;
          effectiveAt = new Date(record.createdAt.getTime() + selectedRule.anonymizeAfterDays * 86_400_000);
          reasons.push("personal-data-anonymization-age-reached");
        } else {
          reasons.push("anonymization-capacity-exhausted");
        }
      } else {
        reasons.push(`retention-days-remaining:${Math.max(0, selectedRule.retainDays - ageDays)}`);
      }
    }
    if (capacity.dryRun && action !== "retain" && action !== "hold") reasons.push("dry-run-only");
    const baseItem = {
      recordId: record.recordId,
      action,
      effectiveAt,
      reasons,
      estimatedBytes: record.byteCount,
    };
    let item: RetentionPlanItem;
    if (selectedRule !== undefined && destinationTier !== undefined) {
      item = { ...baseItem, ruleId: selectedRule.ruleId, destinationTier };
    } else if (selectedRule !== undefined) {
      item = { ...baseItem, ruleId: selectedRule.ruleId };
    } else if (destinationTier !== undefined) {
      item = { ...baseItem, destinationTier };
    } else {
      item = baseItem;
    }
    items.push(item);
  }
  const counts: Record<RetentionAction, number> = {
    retain: 0,
    archive: 0,
    delete: 0,
    hold: 0,
    anonymize: 0,
  };
  const bytesByAction: Record<RetentionAction, number> = {
    retain: 0,
    archive: 0,
    delete: 0,
    hold: 0,
    anonymize: 0,
  };
  for (const item of items) {
    counts[item.action] += 1;
    bytesByAction[item.action] += item.estimatedBytes;
  }
  if (counts.delete >= capacity.maximumDeleteRecords && capacity.maximumDeleteRecords > 0) {
    warnings.push("deletion capacity was fully allocated");
  }
  if (counts.anonymize >= capacity.maximumAnonymizeRecords && capacity.maximumAnonymizeRecords > 0) {
    warnings.push("anonymization capacity was fully allocated");
  }
  if (archiveBytes >= capacity.maximumArchiveBytes && capacity.maximumArchiveBytes > 0) {
    warnings.push("archive byte capacity was fully allocated");
  }
  if (capacity.dryRun) warnings.push("retention plan is a dry run and must not be executed");
  const plannedRecordIds = new Set(items.map((item) => item.recordId));
  if (plannedRecordIds.size !== items.length) throw new Error("retention plan contains duplicate record items");
  if (items.length !== recordsById.size) throw new Error("retention plan does not cover every input record");
  const destructiveItems = items.filter((item) => item.action === "delete" || item.action === "anonymize");
  if (destructiveItems.some((item) => item.reasons.includes("legal-hold-active"))) {
    throw new Error("retention plan contains a destructive action under legal hold");
  }
  if (items.some((item) => item.action === "archive" && item.destinationTier === undefined)) {
    throw new Error("retention archive action lacks a destination tier");
  }
  if (items.some((item) => item.effectiveAt.getTime() > evaluatedTime && item.action !== "retain")) {
    warnings.push("one or more retention actions are scheduled for a future effective time");
  }
  items.sort((left, right) => {
    const actionOrder: Readonly<Record<RetentionAction, number>> = {
      hold: 0,
      delete: 1,
      anonymize: 2,
      archive: 3,
      retain: 4,
    };
    if (actionOrder[left.action] !== actionOrder[right.action]) {
      return actionOrder[left.action] - actionOrder[right.action];
    }
    const timeOrder = left.effectiveAt.getTime() - right.effectiveAt.getTime();
    if (timeOrder !== 0) return timeOrder;
    return left.recordId.localeCompare(right.recordId);
  });
  const selectedRuleCounts = new Map<string, number>();
  for (const item of items) {
    if (item.ruleId !== undefined) {
      selectedRuleCounts.set(item.ruleId, (selectedRuleCounts.get(item.ruleId) ?? 0) + 1);
    }
  }
  for (const rule of ruleById.values()) {
    const selectedCount = selectedRuleCounts.get(rule.ruleId) ?? 0;
    if (selectedCount === 0) warnings.push(`retention rule matched no record: ${rule.ruleId}`);
    if (selectedCount > 10_000) throw new Error(`retention rule selection count is implausible: ${rule.ruleId}`);
  }
  const unexplainedItems = items.filter((item) => item.reasons.length === 0);
  if (unexplainedItems.length > 0) throw new Error("retention plan contains unexplained actions");
  const scheduledBytes = items.reduce((sum, item) => sum + item.estimatedBytes, 0);
  const sourceBytes = [...recordsById.values()].reduce((sum, record) => sum + record.byteCount, 0);
  if (scheduledBytes !== sourceBytes) throw new Error("retention plan byte total differs from source records");
  return {
    evaluatedAt: input.evaluatedAt,
    items,
    retainedCount: counts.retain,
    archivedCount: counts.archive,
    deletedCount: counts.delete,
    heldCount: counts.hold,
    anonymizedCount: counts.anonymize,
    bytesByAction,
    warnings,
  };
}
