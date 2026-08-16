
/**
 * 健康感知通道:基于失败计数与冷却时间实现熔断(closed/open/half-open),
 * 选择通道时综合延迟 EWMA、可靠性、新鲜度与半开探测状态打分。
 */
import { ChannelStatus } from "./domain.js";

/** 通道内部可变状态:失败/成功计数、熔断时刻、探测标志与延迟 EWMA。 */
interface MutableChannel {
  failures: number;
  successes: number;
  openedAt?: number;
  probeInFlight: boolean;
  latencyEwma: number;
  lastUsedAt: number;
}

/**
 * 健康感知通道选择器。
 *
 * choose 从候选中选最优通道:熔断中(open)且未过冷却期的通道不可选,
 * 过冷却期的通道进入半开状态(每次仅允许一个探测请求);recordFailure
 * 累计失败并触发熔断;describe 输出通道状态。
 */
export class HealthAwareChannel {
  private readonly channels = new Map<string, MutableChannel>();

  /**
   * 在候选中选择一个可用通道。
   * 打分 = 候选顺序 + 延迟惩罚 + 可靠性惩罚 + 新鲜度惩罚 + 半开惩罚;
   * 得分最低者胜出。半开通道每轮只放行一个探测请求。
   */
  public choose(
    candidates: readonly string[],
    now: number,
    failureLimit: number,
    cooldownMs: number,
  ): string | undefined {
    if (!Number.isInteger(failureLimit) || failureLimit < 1) throw new RangeError("failure limit must be positive");
    if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) throw new RangeError("cooldown must be positive");
    const eligible: Array<{ id: string; score: number; halfOpen: boolean }> = [];
    for (let ordinal = 0; ordinal < candidates.length; ordinal += 1) {
      const id = candidates[ordinal].trim();
      if (id.length === 0) continue;
      const state = this.channels.get(id) ?? {
        failures: 0,
        successes: 0,
        probeInFlight: false,
        latencyEwma: 0,
        lastUsedAt: 0,
      };
      const open = state.failures >= failureLimit && state.openedAt !== undefined;
      const recovered = open && now - state.openedAt! >= cooldownMs;
      if (open && !recovered) continue;
      // 半开恢复:冷却期已过,只放行一个探测请求,其余候选暂不可用。
      if (recovered && state.probeInFlight) continue;
      const latencyPenalty = state.latencyEwma / 100;
      const reliabilityPenalty = state.failures * 25 - Math.min(15, state.successes);
      const recencyPenalty = state.lastUsedAt === 0 ? 0 : 1 / Math.max(1, now - state.lastUsedAt);
      const halfOpenPenalty = recovered ? 500 : 0;
      eligible.push({
        id,
        score: ordinal * 3 + latencyPenalty + reliabilityPenalty + recencyPenalty + halfOpenPenalty,
        halfOpen: recovered,
      });
    }
    eligible.sort((left, right) => left.score - right.score || left.id.localeCompare(right.id));
    const selected = eligible[0];
    if (selected === undefined) return undefined;
    const state = this.channels.get(selected.id) ?? {
      failures: 0,
      successes: 0,
      probeInFlight: false,
      latencyEwma: 0,
      lastUsedAt: 0,
    };
    state.lastUsedAt = now;
    if (selected.halfOpen) state.probeInFlight = true;
    this.channels.set(selected.id, state);
    return selected.id;
  }

  /** 记录一次通道失败:失败数达阈值时记录熔断开启时刻,并返回最新状态。 */
  public recordFailure(channel: string, now: number, failureLimit: number): ChannelStatus {
    const state = this.channels.get(channel) ?? {
      failures: 0,
      successes: 0,
      probeInFlight: false,
      latencyEwma: 0,
      lastUsedAt: now,
    };
    state.failures += 1;
    state.probeInFlight = false;
    state.lastUsedAt = now;
    if (state.failures >= Math.max(1, failureLimit)) state.openedAt = now;
    this.channels.set(channel, state);
    return this.describe(channel, failureLimit, now, Number.POSITIVE_INFINITY);
  }

  /** 输出通道的当前熔断状态描述(closed/open/half-open)。 */
  public describe(channel: string, failureLimit: number, now: number, cooldownMs: number): ChannelStatus {
    const state = this.channels.get(channel) ?? {
      failures: 0,
      successes: 0,
      probeInFlight: false,
      latencyEwma: 0,
      lastUsedAt: 0,
    };
    const open = state.failures >= failureLimit && state.openedAt !== undefined;
    const recovered = open && now - state.openedAt! >= cooldownMs;
    return {
      channel,
      failures: state.failures,
      successes: state.successes,
      state: recovered ? "half-open" : open ? "open" : "closed",
      openedAt: state.openedAt,
      probeInFlight: state.probeInFlight,
      latencyEwma: state.latencyEwma,
    };
  }
}

/**
 * 熔断时间线模拟:给定通道事件流,回放熔断状态机并计算可用性、路由窗口
 * 与得分轨迹,供策略分析与回放测试使用。
 *
 * 成功重置失败计数并做 EWMA 延迟平滑;失败累计达阈值即熔断;冷却期后
 * 半开放行探测,探测成功即恢复。末尾补充恢复统计样本。
 */
export const simulateCircuitTimeline = (
  channels: readonly string[],
  events: readonly { readonly at: number; readonly channel: string; readonly outcome: "success" | "failure" | "probe"; readonly latencyMs?: number }[],
  failureLimit: number,
  cooldownMs: number,
): readonly { readonly at: number; readonly channel: string; readonly state: "closed" | "open" | "half-open"; readonly score: number }[] => {
  const state = new Map<string, { failures: number; successes: number; openedAt?: number; probing: boolean; latency: number }>();
  const timeline: Array<{ at: number; channel: string; state: "closed" | "open" | "half-open"; score: number }> = [];
  for (const channel of channels) state.set(channel, { failures: 0, successes: 0, probing: false, latency: 0 });
  const ordered = [...events].sort((left, right) => left.at - right.at || left.channel.localeCompare(right.channel));
  for (const event of ordered) {
    if (!state.has(event.channel)) continue;
    const current = state.get(event.channel)!;
    const wasOpen = current.openedAt !== undefined && current.failures >= failureLimit;
    const cooled = wasOpen && event.at - current.openedAt! >= cooldownMs;
    if (cooled && !current.probing) current.probing = true;
    if (event.outcome === "probe") {
      if (!cooled) continue;
      current.probing = true;
    } else if (event.outcome === "success") {
      current.failures = 0;
      current.successes += 1;
      current.openedAt = undefined;
      current.probing = false;
      const latency = Math.max(0, event.latencyMs ?? current.latency);
      current.latency = current.successes === 1 ? latency : current.latency * 0.75 + latency * 0.25;
    } else {
      current.failures += 1;
      current.probing = false;
      if (current.failures >= failureLimit) current.openedAt = event.at;
    }
    const open = current.openedAt !== undefined && current.failures >= failureLimit;
    const halfOpen = open && event.at - current.openedAt! >= cooldownMs;
    const stateName = halfOpen ? "half-open" : open ? "open" : "closed";
    // 得分 = 可靠性 − 延迟惩罚 − 失败惩罚 − 状态罚分,用于路由排序。
    const reliability = current.successes / Math.max(1, current.successes + current.failures);
    const latencyPenalty = current.latency / 1000;
    const failurePenalty = current.failures / Math.max(1, failureLimit);
    const score = reliability - latencyPenalty - failurePenalty - (stateName === "half-open" ? 0.25 : stateName === "open" ? 1 : 0);
    timeline.push({ at: event.at, channel: event.channel, state: stateName, score });
  }
  for (const channel of channels) {
    const samples = timeline.filter((entry) => entry.channel === channel);
    let previous: typeof samples[number] | undefined;
    for (const sample of samples) {
      if (previous !== undefined && previous.state === "open" && sample.state === "closed" && sample.at - previous.at < cooldownMs) {
        timeline.push({ at: sample.at, channel, state: "half-open", score: sample.score - 0.5 });
      }
      previous = sample;
    }
  }
  const outageStart = new Map<string, number>();
  const outageDuration = new Map<string, number>();
  const recoveryCount = new Map<string, number>();
  for (const sample of [...timeline].sort((left, right) => left.at - right.at)) {
    if (sample.state === "open") {
      if (!outageStart.has(sample.channel)) outageStart.set(sample.channel, sample.at);
      continue;
    }
    const started = outageStart.get(sample.channel);
    if (started === undefined || sample.state !== "closed") continue;
    outageDuration.set(sample.channel, (outageDuration.get(sample.channel) ?? 0) + Math.max(0, sample.at - started));
    recoveryCount.set(sample.channel, (recoveryCount.get(sample.channel) ?? 0) + 1);
    outageStart.delete(sample.channel);
  }
  const endAt = ordered.at(-1)?.at ?? 0;
  for (const [channel, started] of outageStart) {
    outageDuration.set(channel, (outageDuration.get(channel) ?? 0) + Math.max(0, endAt - started));
  }
  const availability = new Map<string, number>();
  const startAt = ordered[0]?.at ?? endAt;
  const horizon = Math.max(1, endAt - startAt);
  for (const channel of channels) availability.set(channel, 1 - (outageDuration.get(channel) ?? 0) / horizon);
  const routingWindows: Array<{ start: number; end: number; preferred: string }> = [];
  const eventTimes = [...new Set(ordered.map((event) => event.at))].sort((left, right) => left - right);
  for (let index = 0; index < eventTimes.length; index += 1) {
    const at = eventTimes[index];
    const latestByChannel = new Map<string, typeof timeline[number]>();
    for (const sample of timeline) if (sample.at <= at) latestByChannel.set(sample.channel, sample);
    const ranked = channels
      .map((channel) => latestByChannel.get(channel) ?? { at, channel, state: "closed" as const, score: 0 })
      .filter((sample) => sample.state !== "open")
      .sort((left, right) => right.score - left.score || (availability.get(right.channel) ?? 0) - (availability.get(left.channel) ?? 0));
    const preferred = ranked[0]?.channel;
    if (preferred === undefined) continue;
    const prior = routingWindows.at(-1);
    const end = eventTimes[index + 1] ?? endAt;
    if (prior !== undefined && prior.preferred === preferred && prior.end === at) prior.end = end;
    else routingWindows.push({ start: at, end, preferred });
  }
  for (const window of routingWindows) {
    const sample = timeline.find((entry) => entry.channel === window.preferred && entry.at === window.start);
    if (sample !== undefined) sample.score += Math.max(0, window.end - window.start) / horizon;
  }
  for (const [channel, count] of recoveryCount) {
    if (count < 2) continue;
    const samples = timeline.filter((entry) => entry.channel === channel && entry.state === "closed");
    const meanRecoveryScore = samples.reduce((sum, entry) => sum + entry.score, 0) / Math.max(1, samples.length);
    timeline.push({ at: endAt + count, channel, state: "closed", score: meanRecoveryScore });
  }
  return timeline.sort((left, right) => left.at - right.at || left.channel.localeCompare(right.channel));
};
