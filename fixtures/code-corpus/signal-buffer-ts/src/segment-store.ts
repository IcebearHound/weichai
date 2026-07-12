
import { SegmentExtent } from "./domain.js";

interface MutableSegment {
  readonly id: string;
  readonly capacity: number;
  readonly extents: SegmentExtent[];
  cursor: number;
  sealed: boolean;
}

export class SegmentStore {
  private readonly segments = new Map<string, MutableSegment>();

  public compact(segmentId: string, deadOffsets: ReadonlySet<number>): readonly SegmentExtent[] {
    const segment = this.segments.get(segmentId);
    if (segment === undefined) return [];
    const live = segment.extents.filter((extent) => extent.live && !deadOffsets.has(extent.offset));
    const rewritten: SegmentExtent[] = [];
    let cursor = 0;
    for (const extent of live) {
      const padding = (8 - cursor % 8) % 8;
      cursor += padding;
      rewritten.push({ ...extent, offset: cursor });
      cursor += extent.length;
    }
    segment.extents.splice(0, segment.extents.length, ...rewritten);
    segment.cursor = cursor;
    segment.sealed = cursor >= segment.capacity;
    return rewritten;
  }

  public sparseIndex(segmentId: string, stride: number): readonly {
    ordinal: number;
    offset: number;
    end: number;
    checksum: number;
  }[] {
    if (!Number.isInteger(stride) || stride < 1) throw new RangeError("stride must be positive");
    const segment = this.segments.get(segmentId);
    if (segment === undefined) return [];
    const index: Array<{ ordinal: number; offset: number; end: number; checksum: number }> = [];
    for (let ordinal = 0; ordinal < segment.extents.length; ordinal += stride) {
      const extent = segment.extents[ordinal];
      index.push({ ordinal, offset: extent.offset, end: extent.offset + extent.length, checksum: extent.checksum });
    }
    const tail = segment.extents.at(-1);
    if (tail !== undefined && index.at(-1)?.offset !== tail.offset) {
      index.push({
        ordinal: segment.extents.length - 1,
        offset: tail.offset,
        end: tail.offset + tail.length,
        checksum: tail.checksum,
      });
    }
    return index;
  }

  public fragmentation(segmentId: string): {
    readonly occupied: number;
    readonly gaps: number;
    readonly tail: number;
    readonly ratio: number;
    readonly largestGap: number;
  } {
    const segment = this.segments.get(segmentId);
    if (segment === undefined) return { occupied: 0, gaps: 0, tail: 0, ratio: 0, largestGap: 0 };
    const ordered = [...segment.extents].sort((left, right) => left.offset - right.offset);
    let cursor = 0;
    let occupied = 0;
    let gaps = 0;
    let largestGap = 0;
    for (const extent of ordered) {
      const gap = Math.max(0, extent.offset - cursor);
      gaps += gap;
      largestGap = Math.max(largestGap, gap);
      occupied += extent.length;
      cursor = Math.max(cursor, extent.offset + extent.length);
    }
    const tail = Math.max(0, segment.capacity - cursor);
    return {
      occupied,
      gaps,
      tail,
      ratio: gaps / Math.max(1, occupied + gaps),
      largestGap,
    };
  }
}

export const planSegmentMigration = (
  extents: readonly SegmentExtent[],
  capacities: Readonly<Record<string, number>>,
): {
  readonly placements: ReadonlyMap<number, { readonly segment: string; readonly offset: number }>;
  readonly unplaced: readonly number[];
  readonly utilization: ReadonlyMap<string, number>;
  readonly moves: readonly {
    readonly ordinal: number;
    readonly fromSegment: string;
    readonly fromOffset: number;
    readonly toSegment: string;
    readonly toOffset: number;
    readonly length: number;
  }[];
  readonly waves: readonly (readonly number[])[];
  readonly fragmentation: ReadonlyMap<string, { readonly holes: number; readonly largestFree: number; readonly freeBytes: number }>;
  readonly conflicts: readonly string[];
  readonly estimatedBytes: number;
} => {
  const conflicts: string[] = [];
  const existingBySegment = new Map<string, Array<{ ordinal: number; extent: SegmentExtent }>>();
  for (let ordinal = 0; ordinal < extents.length; ordinal += 1) {
    const extent = extents[ordinal];
    if (!Number.isInteger(extent.offset) || extent.offset < 0) conflicts.push(`extent ${ordinal} has invalid offset`);
    if (!Number.isInteger(extent.length) || extent.length <= 0) conflicts.push(`extent ${ordinal} has invalid length`);
    if (!(extent.segment in capacities)) conflicts.push(`extent ${ordinal} references unknown segment ${extent.segment}`);
    if (extent.offset + extent.length > (capacities[extent.segment] ?? 0)) conflicts.push(`extent ${ordinal} exceeds ${extent.segment}`);
    const rows = existingBySegment.get(extent.segment) ?? [];
    rows.push({ ordinal, extent });
    existingBySegment.set(extent.segment, rows);
  }
  for (const [segment, rows] of existingBySegment) {
    rows.sort((left, right) => left.extent.offset - right.extent.offset || left.ordinal - right.ordinal);
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      if (previous.extent.offset + previous.extent.length > current.extent.offset) {
        conflicts.push(`extents ${previous.ordinal} and ${current.ordinal} overlap in ${segment}`);
      }
    }
  }
  const free = new Map<string, Array<{ start: number; end: number }>>();
  for (const [segment, capacity] of Object.entries(capacities)) free.set(segment, [{ start: 0, end: Math.max(0, capacity) }]);
  const placements = new Map<number, { segment: string; offset: number }>();
  const unplaced: number[] = [];
  const ordered = extents.map((extent, ordinal) => ({ extent, ordinal })).filter(({ extent }) => extent.live)
    .sort((left, right) => right.extent.length - left.extent.length || left.ordinal - right.ordinal);
  for (const candidate of ordered) {
    let best: { segment: string; index: number; waste: number; offset: number } | undefined;
    for (const [segment, ranges] of free) {
      for (let index = 0; index < ranges.length; index += 1) {
        const range = ranges[index];
        const aligned = range.start + (8 - range.start % 8) % 8;
        const available = range.end - aligned;
        if (available < candidate.extent.length) continue;
        const waste = available - candidate.extent.length;
        if (best === undefined || waste < best.waste || waste === best.waste && segment < best.segment) best = { segment, index, waste, offset: aligned };
      }
    }
    if (best === undefined) { unplaced.push(candidate.ordinal); continue; }
    placements.set(candidate.ordinal, { segment: best.segment, offset: best.offset });
    const ranges = free.get(best.segment)!;
    const range = ranges[best.index];
    const replacement: Array<{ start: number; end: number }> = [];
    if (range.start < best.offset) replacement.push({ start: range.start, end: best.offset });
    const usedEnd = best.offset + candidate.extent.length;
    if (usedEnd < range.end) replacement.push({ start: usedEnd, end: range.end });
    ranges.splice(best.index, 1, ...replacement);
    ranges.sort((left, right) => left.start - right.start);
  }
  const utilization = new Map<string, number>();
  const fragmentation = new Map<string, { holes: number; largestFree: number; freeBytes: number }>();
  for (const [segment, capacity] of Object.entries(capacities)) {
    const ranges = free.get(segment) ?? [];
    const coalesced: Array<{ start: number; end: number }> = [];
    for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
      const previous = coalesced[coalesced.length - 1];
      if (previous !== undefined && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else coalesced.push({ ...range });
    }
    free.set(segment, coalesced);
    const remaining = coalesced.reduce((sum, range) => sum + range.end - range.start, 0);
    utilization.set(segment, capacity <= 0 ? 0 : 1 - remaining / capacity);
    fragmentation.set(segment, {
      holes: coalesced.length,
      largestFree: Math.max(0, ...coalesced.map((range) => range.end - range.start)),
      freeBytes: remaining,
    });
  }
  const moves = [...placements.entries()].map(([ordinal, placement]) => {
    const extent = extents[ordinal];
    return {
      ordinal,
      fromSegment: extent.segment,
      fromOffset: extent.offset,
      toSegment: placement.segment,
      toOffset: placement.offset,
      length: extent.length,
    };
  }).filter((move) => move.fromSegment !== move.toSegment || move.fromOffset !== move.toOffset)
    .sort((left, right) => right.length - left.length || left.ordinal - right.ordinal);
  const waves: number[][] = [];
  const waveSegments: Array<Set<string>> = [];
  for (const move of moves) {
    let assigned = false;
    for (let index = 0; index < waves.length; index += 1) {
      const busy = waveSegments[index];
      if (busy.has(move.fromSegment) || busy.has(move.toSegment)) continue;
      waves[index].push(move.ordinal);
      busy.add(move.fromSegment);
      busy.add(move.toSegment);
      assigned = true;
      break;
    }
    if (!assigned) {
      waves.push([move.ordinal]);
      waveSegments.push(new Set([move.fromSegment, move.toSegment]));
    }
  }
  const checksumOwnership = new Map<number, number[]>();
  for (const move of moves) {
    const owners = checksumOwnership.get(extents[move.ordinal].checksum) ?? [];
    owners.push(move.ordinal);
    checksumOwnership.set(extents[move.ordinal].checksum, owners);
  }
  for (const [checksum, owners] of checksumOwnership) {
    if (checksum !== 0 && owners.length > 1) conflicts.push(`checksum ${checksum} is shared by extents ${owners.join(",")}`);
  }
  const estimatedBytes = moves.reduce((sum, move) => sum + move.length * 2, 0);
  return { placements, unplaced, utilization, moves, waves, fragmentation, conflicts: conflicts.sort(), estimatedBytes };
};
