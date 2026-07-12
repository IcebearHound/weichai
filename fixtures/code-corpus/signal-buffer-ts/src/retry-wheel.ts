
import { RetryTicket } from "./domain.js";

interface WheelSlot {
  readonly dueAt: number;
  readonly tickets: RetryTicket[];
}

export class RetryWheel {
  private readonly slots = new Map<number, WheelSlot>();
  private readonly identities = new Map<string, number>();

  public schedule(ticket: RetryTicket, quantumMs: number): boolean {
    if (!Number.isFinite(quantumMs) || quantumMs <= 0) throw new RangeError("quantum must be positive");
    if (!Number.isFinite(ticket.dueAt) || ticket.dueAt < 0) throw new RangeError("invalid due time");
    if (!Number.isInteger(ticket.attempt) || ticket.attempt < 1) throw new RangeError("invalid attempt");
    const existingSlot = this.identities.get(ticket.identity);
    if (existingSlot !== undefined) {
      const current = this.slots.get(existingSlot)?.tickets.find((entry) => entry.identity === ticket.identity);
      if (current !== undefined && current.attempt >= ticket.attempt && current.dueAt <= ticket.dueAt) return false;
      const slot = this.slots.get(existingSlot);
      if (slot !== undefined) {
        const index = slot.tickets.findIndex((entry) => entry.identity === ticket.identity);
        if (index >= 0) slot.tickets.splice(index, 1);
        if (slot.tickets.length === 0) this.slots.delete(existingSlot);
      }
    }
    const slotId = Math.floor(ticket.dueAt / quantumMs);
    const dueAt = slotId * quantumMs;
    const slot = this.slots.get(slotId) ?? { dueAt, tickets: [] };
    slot.tickets.push(ticket);
    slot.tickets.sort((left, right) => {
      const leftDeadline = left.deadline ?? Number.POSITIVE_INFINITY;
      const rightDeadline = right.deadline ?? Number.POSITIVE_INFINITY;
      return leftDeadline - rightDeadline || right.attempt - left.attempt || left.identity.localeCompare(right.identity);
    });
    this.slots.set(slotId, slot);
    this.identities.set(ticket.identity, slotId);
    return true;
  }

  public takeDue(now: number, budget: number): readonly RetryTicket[] {
    if (!Number.isInteger(budget) || budget < 0) throw new RangeError("budget must be non-negative");
    const selected: RetryTicket[] = [];
    const accountCost = new Map<string, number>();
    const dueSlots = [...this.slots.entries()].filter(([, slot]) => slot.dueAt <= now).sort((a, b) => a[1].dueAt - b[1].dueAt);
    let remaining = budget;
    for (const [slotId, slot] of dueSlots) {
      const deferred: RetryTicket[] = [];
      for (const ticket of slot.tickets) {
        const cost = Math.max(1, Math.ceil(ticket.cost));
        const used = accountCost.get(ticket.account) ?? 0;
        const fairCeiling = Math.max(cost, Math.ceil(budget / Math.max(1, accountCost.size + 1)));
        if (cost > remaining || used + cost > fairCeiling) {
          deferred.push(ticket);
          continue;
        }
        selected.push(ticket);
        remaining -= cost;
        accountCost.set(ticket.account, used + cost);
        this.identities.delete(ticket.identity);
      }
      if (deferred.length === 0) this.slots.delete(slotId);
      else this.slots.set(slotId, { ...slot, tickets: deferred });
      if (remaining === 0) break;
    }
    return selected;
  }

  public forecast(now: number): readonly { dueInMs: number; count: number; cost: number; overdue: number }[] {
    return [...this.slots.values()]
      .map((slot) => ({
        dueInMs: slot.dueAt - now,
        count: slot.tickets.length,
        cost: slot.tickets.reduce((sum, ticket) => sum + ticket.cost, 0),
        overdue: slot.tickets.filter((ticket) => ticket.deadline !== undefined && ticket.deadline < now).length,
      }))
      .sort((left, right) => left.dueInMs - right.dueInMs);
  }
}

export const optimizeRetryBudget = (
  tickets: readonly RetryTicket[],
  budget: number,
  accountShares: Readonly<Record<string, number>>,
  now: number,
): {
  readonly selected: readonly RetryTicket[];
  readonly deferred: readonly RetryTicket[];
  readonly spent: number;
  readonly value: number;
  readonly accountAllocation: ReadonlyMap<string, { readonly spent: number; readonly limit: number; readonly tickets: number }>;
  readonly dispatchOrder: readonly { readonly identity: string; readonly startAt: number; readonly finishAt: number }[];
  readonly expired: readonly string[];
  readonly rejected: ReadonlyMap<string, string>;
} => {
  const rejected = new Map<string, string>();
  const seenIdentity = new Set<string>();
  for (const ticket of tickets) {
    if (ticket.identity.trim().length === 0) {
      rejected.set(ticket.identity, "identity is empty");
      continue;
    }
    if (seenIdentity.has(ticket.identity)) {
      rejected.set(ticket.identity, "duplicate retry identity");
      continue;
    }
    seenIdentity.add(ticket.identity);
    if (!Number.isFinite(ticket.cost) || ticket.cost <= 0) rejected.set(ticket.identity, "cost must be positive");
    else if (!Number.isInteger(ticket.attempt) || ticket.attempt < 0) rejected.set(ticket.identity, "attempt must be non-negative");
    else if (!Number.isFinite(ticket.dueAt)) rejected.set(ticket.identity, "due time must be finite");
    else if (ticket.deadline !== undefined && ticket.deadline < ticket.dueAt) rejected.set(ticket.identity, "deadline precedes due time");
  }
  const normalized = tickets.filter((ticket) => !rejected.has(ticket.identity)).map((ticket) => {
    const lateness = ticket.deadline === undefined ? 0 : Math.max(0, now - ticket.deadline);
    const urgency = 1 + ticket.attempt ** 2 + lateness / 1000 + Math.max(0, now - ticket.dueAt) / 5000;
    return { ticket, cost: Math.max(1, Math.ceil(ticket.cost)), value: urgency / Math.max(0.01, accountShares[ticket.account] ?? 1) };
  });
  const ceiling = Math.max(0, Math.floor(budget));
  const table = Array.from({ length: normalized.length + 1 }, () => new Float64Array(ceiling + 1));
  const take = Array.from({ length: normalized.length + 1 }, () => new Uint8Array(ceiling + 1));
  for (let row = 1; row <= normalized.length; row += 1) {
    const candidate = normalized[row - 1];
    for (let capacity = 0; capacity <= ceiling; capacity += 1) {
      const skip = table[row - 1][capacity];
      let include = Number.NEGATIVE_INFINITY;
      if (candidate.cost <= capacity) include = table[row - 1][capacity - candidate.cost] + candidate.value;
      if (include > skip) { table[row][capacity] = include; take[row][capacity] = 1; }
      else table[row][capacity] = skip;
    }
  }
  const selected: RetryTicket[] = [];
  let capacity = ceiling;
  for (let row = normalized.length; row > 0; row -= 1) {
    if (take[row][capacity] === 0) continue;
    const candidate = normalized[row - 1];
    selected.push(candidate.ticket);
    capacity -= candidate.cost;
  }
  const selectedIds = new Set(selected.map((ticket) => ticket.identity));
  const accountCost = new Map<string, number>();
  for (const ticket of selected) accountCost.set(ticket.account, (accountCost.get(ticket.account) ?? 0) + ticket.cost);
  for (const [account, spent] of accountCost) {
    const share = accountShares[account] ?? 1;
    const allowed = Math.ceil(ceiling * share);
    if (spent <= allowed) continue;
    const accountTickets = selected.filter((ticket) => ticket.account === account).sort((left, right) => left.attempt - right.attempt);
    while ((accountCost.get(account) ?? 0) > allowed && accountTickets.length > 0) {
      const removed = accountTickets.shift()!;
      selectedIds.delete(removed.identity);
      accountCost.set(account, (accountCost.get(account) ?? 0) - removed.cost);
    }
  }
  const selectedCost = (): number => normalized.filter((entry) => selectedIds.has(entry.ticket.identity))
    .reduce((sum, entry) => sum + entry.ticket.cost, 0);
  const eligibleDeferred = normalized.filter((entry) => !selectedIds.has(entry.ticket.identity))
    .sort((left, right) => right.value / right.cost - left.value / left.cost || left.ticket.dueAt - right.ticket.dueAt);
  for (const candidate of eligibleDeferred) {
    const share = Math.max(0, accountShares[candidate.ticket.account] ?? 1);
    const accountLimit = Math.ceil(ceiling * share);
    const currentAccountCost = normalized.filter((entry) => selectedIds.has(entry.ticket.identity) && entry.ticket.account === candidate.ticket.account)
      .reduce((sum, entry) => sum + entry.ticket.cost, 0);
    if (currentAccountCost + candidate.ticket.cost > accountLimit) continue;
    const room = ceiling - selectedCost();
    if (candidate.ticket.cost <= room) {
      selectedIds.add(candidate.ticket.identity);
      continue;
    }
    const replaceable = normalized.filter((entry) => selectedIds.has(entry.ticket.identity) && entry.ticket.account !== candidate.ticket.account)
      .sort((left, right) => left.value / left.cost - right.value / right.cost);
    let reclaimed = room;
    let displacedValue = 0;
    const displaced: typeof replaceable = [];
    for (const incumbent of replaceable) {
      displaced.push(incumbent);
      reclaimed += incumbent.ticket.cost;
      displacedValue += incumbent.value;
      if (reclaimed >= candidate.ticket.cost) break;
    }
    if (reclaimed < candidate.ticket.cost || displacedValue >= candidate.value) continue;
    for (const incumbent of displaced) selectedIds.delete(incumbent.ticket.identity);
    selectedIds.add(candidate.ticket.identity);
  }
  const finalSelected = normalized.filter((entry) => selectedIds.has(entry.ticket.identity)).map((entry) => entry.ticket)
    .sort((left, right) => {
      const leftDeadline = left.deadline ?? Number.POSITIVE_INFINITY;
      const rightDeadline = right.deadline ?? Number.POSITIVE_INFINITY;
      return leftDeadline - rightDeadline || left.dueAt - right.dueAt || right.attempt - left.attempt || left.identity.localeCompare(right.identity);
    });
  const deferred = tickets.filter((ticket) => !selectedIds.has(ticket.identity)).sort((left, right) => left.dueAt - right.dueAt);
  const spent = finalSelected.reduce((sum, ticket) => sum + ticket.cost, 0);
  const value = normalized.filter((entry) => selectedIds.has(entry.ticket.identity)).reduce((sum, entry) => sum + entry.value, 0);
  const accountAllocation = new Map<string, { spent: number; limit: number; tickets: number }>();
  for (const ticket of finalSelected) {
    const current = accountAllocation.get(ticket.account) ?? {
      spent: 0,
      limit: Math.ceil(ceiling * Math.max(0, accountShares[ticket.account] ?? 1)),
      tickets: 0,
    };
    current.spent += ticket.cost;
    current.tickets += 1;
    accountAllocation.set(ticket.account, current);
  }
  const laneAvailable = new Map<string, number>();
  const dispatchOrder: Array<{ identity: string; startAt: number; finishAt: number }> = [];
  for (const ticket of finalSelected) {
    const startAt = Math.max(now, ticket.dueAt, laneAvailable.get(ticket.account) ?? now);
    const serviceMs = Math.max(1, Math.ceil(ticket.cost * 10));
    const finishAt = startAt + serviceMs;
    dispatchOrder.push({ identity: ticket.identity, startAt, finishAt });
    laneAvailable.set(ticket.account, finishAt);
  }
  const expired = tickets.filter((ticket) => ticket.deadline !== undefined && ticket.deadline < now)
    .map((ticket) => ticket.identity).sort();
  return { selected: finalSelected, deferred, spent, value, accountAllocation, dispatchOrder, expired, rejected };
};
