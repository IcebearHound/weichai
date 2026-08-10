import { describe, expect, it } from 'vitest';
import type { AdaptationResult, ValidationRecord } from '@forexplore/contracts';
import { canApplyAdaptation, evaluateValidationGate } from './validation-gate';

function record(
  status: ValidationRecord['status'],
  required = true,
): ValidationRecord {
  return {
    id: `check-${status}`,
    label: '编译验证',
    status,
    required,
    summary: status,
  };
}

function adaptation(validation: ValidationRecord[]): AdaptationResult {
  return {
    strategy: 'translate',
    targetLanguage: 'C#',
    generatedCode: 'public void Run() {}',
    interfaceMappings: [],
    validation,
    files: [
      {
        path: 'Service.cs',
        status: 'modified',
        expectedOriginalSha256: 'a'.repeat(64),
        additions: 1,
        deletions: 1,
        hunks: [
          {
            header: '@@ -1,1 +1,1 @@',
            lines: [
              { type: 'remove', content: 'old' },
              { type: 'add', content: 'new' },
            ],
          },
        ],
      },
    ],
  };
}

describe('evaluateValidationGate', () => {
  it('allows passed and warned required checks', () => {
    expect(evaluateValidationGate([record('pass'), record('warn')])).toEqual({
      allowed: true,
      blockers: [],
    });
  });

  it.each(['fail', 'unverified'] as const)('blocks required %s checks', (status) => {
    const result = evaluateValidationGate([record(status)]);
    expect(result.allowed).toBe(false);
    expect(result.blockers).toHaveLength(1);
  });

  it('does not allow an adaptation without evidence', () => {
    expect(canApplyAdaptation(adaptation([]))).toBe(false);
  });

  it('allows a reviewed patch only after required evidence passes', () => {
    expect(
      canApplyAdaptation(adaptation([record('pass'), record('unverified', false)])),
    ).toBe(true);
  });
});
