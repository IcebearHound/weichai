import type { AuditBatch } from "./audit-types.js";

export interface AuditSink {
  write(batch: AuditBatch): Promise<void>;
  close(): Promise<void>;
}

export interface AuditScheduler {
  schedule(intervalMs: number, operation: () => Promise<void>): { cancel(): void };
}

export interface AuditChecksum {
  calculate(lines: readonly string[]): string;
}
