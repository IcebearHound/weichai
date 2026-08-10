import type { AdaptationResult, ValidationRecord } from '@forexplore/contracts';

export interface ValidationGateResult {
  allowed: boolean;
  blockers: ValidationRecord[];
}

/**
 * A patch is eligible for human-confirmed write-back only when it carries
 * evidence and every required check is at least usable. This deliberately does
 * not turn a compiler pass into a business-correctness claim.
 */
export function evaluateValidationGate(
  validation: ValidationRecord[],
): ValidationGateResult {
  if (validation.length === 0) {
    return {
      allowed: false,
      blockers: [
        {
          id: 'validation-evidence',
          label: '验证证据',
          status: 'unverified',
          required: true,
          summary: '适配结果未附带任何验证记录。',
          failureReason: 'missing-validation-records',
        },
      ],
    };
  }

  const blockers = validation.filter(
    (item) => item.required && (item.status === 'fail' || item.status === 'unverified'),
  );
  return { allowed: blockers.length === 0, blockers };
}

export function canApplyAdaptation(result: AdaptationResult | null): boolean {
  return result !== null && result.files.length > 0 && evaluateValidationGate(result.validation).allowed;
}
