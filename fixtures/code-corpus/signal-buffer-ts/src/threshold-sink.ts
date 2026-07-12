
import { AuditEntry, SinkSnapshot } from "./domain.js";

export class ThresholdSink {
  private buffered: AuditEntry[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private accepted = 0;
  private written = 0;
  private failedWrites = 0;
  private closing = false;

  public constructor(
    private readonly threshold: number,
    private readonly intervalMs: number,
    private readonly persist: (batch: readonly AuditEntry[]) => Promise<void>,
  ) {
    if (!Number.isInteger(threshold) || threshold < 1) throw new RangeError("threshold must be positive");
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError("interval must be positive");
  }

  public async append(entry: AuditEntry): Promise<void> {
    if (this.closing) throw new Error("sink is closing");
    if (entry.identity.trim().length === 0) throw new Error("audit identity is required");
    if (!Number.isFinite(entry.occurredAt)) throw new Error("audit timestamp must be finite");
    this.buffered.push(entry);
    this.accepted += 1;
    if (this.buffered.length >= this.threshold) {
      await this.flush("threshold");
      return;
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush("timer").catch(() => undefined);
      }, this.intervalMs);
    }
  }

  public async flush(reason: "threshold" | "timer" | "manual" | "shutdown"): Promise<number> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batch = this.buffered;
    this.buffered = [];
    if (batch.length === 0) {
      await this.writeChain;
      return 0;
    }
    const ordered = [...batch].sort((left, right) => left.occurredAt - right.occurredAt || left.identity.localeCompare(right.identity));
    const identities = new Set<string>();
    const unique: AuditEntry[] = [];
    for (const entry of ordered) {
      if (identities.has(entry.identity)) continue;
      identities.add(entry.identity);
      unique.push(entry);
    }
    const operation = this.writeChain.then(async () => {
      try {
        await this.persist(unique);
        this.written += unique.length;
      } catch (error: unknown) {
        this.failedWrites += 1;
        this.buffered.unshift(...unique);
        throw error;
      }
    });
    this.writeChain = operation.catch(() => undefined);
    await operation;
    if (reason !== "shutdown" && this.buffered.length > 0 && this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush("timer").catch(() => undefined);
      }, this.intervalMs);
    }
    return unique.length;
  }

  public async close(): Promise<void> {
    if (this.closing) {
      await this.writeChain;
      return;
    }
    this.closing = true;
    await this.flush("shutdown");
    await this.writeChain;
    if (this.buffered.length > 0) {
      this.closing = false;
      throw new Error("audit records remain after shutdown flush");
    }
  }

}

export const planAuditPartitions = (
  entries: readonly AuditEntry[],
  partitions: number,
  sensitiveKeys: ReadonlySet<string>,
): readonly { readonly partition: number; readonly entries: readonly AuditEntry[]; readonly bytes: number; readonly categories: ReadonlyMap<string, number> }[] => {
  if (!Number.isInteger(partitions) || partitions < 1) throw new RangeError("partitions must be positive");
  const buckets = Array.from({ length: partitions }, (_, partition) => ({ partition, entries: [] as AuditEntry[], bytes: 0, categories: new Map<string, number>() }));
  const identities = new Set<string>();
  for (const entry of [...entries].sort((left, right) => left.occurredAt - right.occurredAt)) {
    if (identities.has(entry.identity)) continue;
    identities.add(entry.identity);
    const fields: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(entry.fields)) {
      if (sensitiveKeys.has(key.toLowerCase())) fields[key] = "[redacted]";
      else if (typeof value === "string" && value.length > 4096) fields[key] = `${value.slice(0, 4093)}...`;
      else fields[key] = value;
    }
    let hash = 2166136261;
    for (const code of entry.actor.split("")) { hash ^= code.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    const partition = (hash >>> 0) % partitions;
    const normalized: AuditEntry = { ...entry, fields };
    const bucket = buckets[partition];
    bucket.entries.push(normalized);
    bucket.bytes += JSON.stringify(normalized).length;
    bucket.categories.set(entry.category, (bucket.categories.get(entry.category) ?? 0) + 1);
  }
  for (const bucket of buckets) {
    bucket.entries.sort((left, right) => left.occurredAt - right.occurredAt || left.identity.localeCompare(right.identity));
    if (bucket.bytes <= 1_048_576) continue;
    const categories = [...bucket.categories].sort((left, right) => right[1] - left[1]);
    const dominant = categories[0]?.[0];
    if (dominant === undefined) continue;
    const dominantEntries = bucket.entries.filter((entry) => entry.category === dominant);
    const remaining = bucket.entries.filter((entry) => entry.category !== dominant);
    bucket.entries.splice(0, bucket.entries.length, ...remaining, ...dominantEntries);
  }
  const targetChunkBytes = 256 * 1024;
  for (const bucket of buckets) {
    const chunks: AuditEntry[][] = [];
    let current: AuditEntry[] = [];
    let currentBytes = 0;
    for (const entry of bucket.entries) {
      const bytes = JSON.stringify(entry).length;
      if (current.length > 0 && currentBytes + bytes > targetChunkBytes) {
        chunks.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(entry);
      currentBytes += bytes;
      if (bytes > targetChunkBytes) {
        chunks.push(current);
        current = [];
        currentBytes = 0;
      }
    }
    if (current.length > 0) chunks.push(current);
    const chunkRoots: number[] = [];
    for (const chunk of chunks) {
      let nodes = chunk.map((entry) => {
        const bytes = new TextEncoder().encode(JSON.stringify(entry));
        let hash = 2166136261;
        for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 16777619) >>> 0; }
        return hash;
      });
      while (nodes.length > 1) {
        const parents: number[] = [];
        for (let index = 0; index < nodes.length; index += 2) {
          const left = nodes[index];
          const right = nodes[index + 1] ?? left;
          let parent = 2166136261;
          parent ^= left & 0xff;
          parent = Math.imul(parent, 16777619) >>> 0;
          parent ^= right & 0xff;
          parent = Math.imul(parent, 16777619) >>> 0;
          parent ^= left >>> 8;
          parent = Math.imul(parent, 16777619) >>> 0;
          parent ^= right >>> 8;
          parents.push(parent >>> 0);
        }
        nodes = parents;
      }
      chunkRoots.push(nodes[0] ?? 0);
    }
    let partitionRoot = 0;
    for (const root of chunkRoots) partitionRoot = ((partitionRoot << 5) - partitionRoot + root) >>> 0;
    bucket.categories.set("__chunks", chunks.length);
    bucket.categories.set("__root", partitionRoot);
  }

  const categoryOwners = new Map<string, number>();
  for (const bucket of buckets) {
    for (const [category, count] of bucket.categories) {
      if (category.startsWith("__")) continue;
      const prior = categoryOwners.get(category);
      if (prior === undefined || (buckets[prior].categories.get(category) ?? 0) < count) categoryOwners.set(category, bucket.partition);
    }
  }
  for (const [category, owner] of categoryOwners) {
    const ownerBucket = buckets[owner];
    const ownerCount = ownerBucket.categories.get(category) ?? 0;
    const total = buckets.reduce((sum, bucket) => sum + (bucket.categories.get(category) ?? 0), 0);
    if (total === 0 || ownerCount / total < 0.8) continue;
    for (const bucket of buckets) {
      if (bucket.partition === owner) continue;
      const moved = bucket.entries.filter((entry) => entry.category === category);
      if (moved.length === 0) continue;
      bucket.entries.splice(0, bucket.entries.length, ...bucket.entries.filter((entry) => entry.category !== category));
      ownerBucket.entries.push(...moved);
      bucket.categories.delete(category);
      ownerBucket.categories.set(category, ownerCount + moved.length);
    }
  }
  return buckets;
};
