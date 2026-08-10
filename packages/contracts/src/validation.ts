/**
 * A verification result produced independently of the implementation text.
 * `pass` and `warn` are display states; a required `fail` or `unverified`
 * check blocks a write-back by default.
 */
export type ValidationStatus = 'pass' | 'warn' | 'fail' | 'unverified';

export interface ValidationRecord {
  /** Stable identifier so a run manifest can refer to this check. */
  id: string;
  label: string;
  status: ValidationStatus;
  /** Whether this check must be usable before the patch can be applied. */
  required: boolean;
  /** Command or verifier used to obtain this evidence, when applicable. */
  command?: string;
  /** Human-readable, bounded summary of the verifier output. */
  summary: string;
  /** Optional durable artifact containing full output. */
  artifactPath?: string;
  /** Explicit reason when a check failed or was not executed. */
  failureReason?: string;
}
