
/**
 * 取证回放:对一个事故窗口做多维度回放(通道历史、观测状态、依赖割、
 * 数据包修复、存储迁移),输出相关性、时间线与可读叙事报告。
 */
import { type DependencyNode, type PacketFrame, type SegmentExtent, type TradeSignal, type WindowObservation } from "./domain.js";
import { reconstructLaneHistory } from "./partition-runner.js";
import { compareObservationRegimes } from "./window-ledger.js";
import { minimumDependencyCut } from "./dependency-map.js";
import { repairFrameSequence } from "./packet-journal.js";
import { planSegmentMigration } from "./segment-store.js";
import { composeOperationsNarrative } from "./presentation.js";

/** 事故回放输入:观测、信号、检查点、依赖图、数据包与段布局等全量证据。 */
export interface IncidentReplayInput {
  readonly incidentId: string;
  readonly boundary: number;
  readonly observations: readonly WindowObservation[];
  readonly signals: readonly TradeSignal[];
  readonly checkpoints: Readonly<Record<string, number>>;
  readonly dependencies: readonly DependencyNode[];
  readonly dependencyRoots: readonly string[];
  readonly dependencyTerminals: ReadonlySet<string>;
  readonly frames: readonly PacketFrame[];
  readonly expectedParity: number;
  readonly extents: readonly SegmentExtent[];
  readonly segmentCapacities: Readonly<Record<string, number>>;
}

/** 单账户相关性:信号/观测数、活动区间、缺失序号、变化传感器与严重度。 */
export interface IncidentCorrelation {
  readonly account: string;
  readonly signalCount: number;
  readonly observationCount: number;
  readonly firstActivity: number;
  readonly lastActivity: number;
  readonly missingSignals: readonly number[];
  readonly changedSensors: readonly string[];
  readonly blockedObservations: number;
  readonly estimatedSeverity: number;
}

/** 回放报告:相关性、回放顺序、依赖割/环、数据包状态、迁移波次与叙事。 */
export interface IncidentReplayReport {
  readonly incidentId: string;
  readonly correlations: readonly IncidentCorrelation[];
  readonly replayOrder: readonly string[];
  readonly dependencyCut: readonly string[];
  readonly dependencyCycles: readonly (readonly string[])[];
  readonly packetComplete: boolean;
  readonly packetMissing: readonly number[];
  readonly packetDigest: string;
  readonly migrationWaves: readonly (readonly number[])[];
  readonly storageConflicts: readonly string[];
  readonly chronologyFindings: readonly string[];
  readonly timeline: readonly { readonly at: number; readonly kind: string; readonly subject: string; readonly detail: string }[];
  readonly narrative: readonly string[];
}

/**
 * 取证回放器。
 *
 * replay 编排各子模块(通道历史、观测状态对比、最小依赖割、帧修复、
 * 段迁移),构建统一时间线并输出叙事;assessTimelineConsistency 检查时间
 * 线一致性;correlateAccounts 按账户聚合严重度;renderNarrative 渲染报告。
 */
export class ForensicReplay {
  /**
   * 回放一个事故:并行重放各证据源,汇总时间线(交易、观测、缺口、变点、
   * 丢弃帧、迁移),并产出相关性分析与叙事报告。
   */
  public replay(input: IncidentReplayInput): IncidentReplayReport {
    if (input.incidentId.trim().length === 0) throw new Error("incident identity is required");
    if (!Number.isFinite(input.boundary)) throw new RangeError("incident boundary must be finite");
    const laneHistory = reconstructLaneHistory(input.signals, input.checkpoints);
    const regimes = compareObservationRegimes(input.observations, input.boundary);
    const dependency = minimumDependencyCut(input.dependencies, input.dependencyRoots, input.dependencyTerminals);
    const packets = repairFrameSequence(input.frames, input.expectedParity);
    const migration = planSegmentMigration(input.extents, input.segmentCapacities);
    const correlations = this.correlateAccounts(
      input.signals,
      input.observations,
      laneHistory.missing,
      regimes.changedSensors,
    );
    const timeline: Array<{ at: number; kind: string; subject: string; detail: string }> = [];
    for (const signal of input.signals) {
      timeline.push({
        at: signal.occurredAt,
        kind: "trade-signal",
        subject: signal.account,
        detail: `${signal.messageId}:${signal.sequence}:${signal.side}:${signal.quantity}`,
      });
    }
    for (const observation of input.observations) {
      timeline.push({
        at: observation.observedAt,
        kind: "observation",
        subject: observation.account,
        detail: `${observation.sensor}:${observation.value}:${observation.status}`,
      });
    }
    for (const [account, missing] of laneHistory.missing) {
      for (const sequence of missing) {
        timeline.push({ at: input.boundary, kind: "sequence-gap", subject: account, detail: String(sequence) });
      }
    }
    for (const point of regimes.changePoints) {
      timeline.push({
        at: point.observedAt,
        kind: "regime-change",
        subject: point.sensor,
        detail: `${point.direction}:${point.magnitude.toFixed(6)}`,
      });
    }
    for (const ordinal of packets.discarded) {
      const frame = input.frames.find((candidate) => candidate.ordinal === ordinal);
      timeline.push({
        at: input.boundary,
        kind: "discarded-frame",
        subject: frame?.stream ?? packets.stream,
        detail: String(ordinal),
      });
    }
    for (let wave = 0; wave < migration.waves.length; wave += 1) {
      for (const ordinal of migration.waves[wave]) {
        const move = migration.moves.find((candidate) => candidate.ordinal === ordinal);
        timeline.push({
          at: input.boundary + wave,
          kind: "storage-move",
          subject: String(ordinal),
          detail: move === undefined ? "missing move" : `${move.fromSegment}:${move.fromOffset}->${move.toSegment}:${move.toOffset}`,
        });
      }
    }
    timeline.sort((left, right) => left.at - right.at || left.kind.localeCompare(right.kind) || left.subject.localeCompare(right.subject));
    const chronologyFindings = this.assessTimelineConsistency(input, timeline, migration.moves);
    const narrative = this.renderNarrative(
      input.incidentId,
      input.boundary,
      correlations,
      dependency,
      packets,
      migration,
    );
    return {
      incidentId: input.incidentId,
      correlations,
      replayOrder: laneHistory.replay.map((signal) => signal.messageId),
      dependencyCut: dependency.cut,
      dependencyCycles: dependency.cycles,
      packetComplete: packets.complete,
      packetMissing: packets.missing,
      packetDigest: packets.digest,
      migrationWaves: migration.waves,
      storageConflicts: migration.conflicts,
      chronologyFindings,
      timeline,
      narrative,
    };
  }

  /**
   * 评估时间线一致性:检查时间戳单调性、重复消息、序号回退、传感器静默、
   * 跨流同序号、迁移重叠、依赖缺失与边界事件突增等异常模式。
   */
  public assessTimelineConsistency(
    input: IncidentReplayInput,
    timeline: readonly { readonly at: number; readonly kind: string; readonly subject: string; readonly detail: string }[],
    moves: readonly {
      readonly ordinal: number;
      readonly fromSegment: string;
      readonly fromOffset: number;
      readonly toSegment: string;
      readonly toOffset: number;
      readonly length: number;
    }[],
  ): readonly string[] {
    const findings: string[] = [];
    let previousAt = Number.NEGATIVE_INFINITY;
    for (const entry of timeline) {
      if (!Number.isFinite(entry.at)) findings.push(`non-finite-timestamp:${entry.kind}:${entry.subject}`);
      if (entry.at < previousAt) findings.push(`timeline-regression:${entry.kind}:${entry.subject}`);
      previousAt = Math.max(previousAt, entry.at);
    }
    const signalsByAccount = new Map<string, TradeSignal[]>();
    for (const signal of input.signals) {
      const rows = signalsByAccount.get(signal.account) ?? [];
      rows.push(signal);
      signalsByAccount.set(signal.account, rows);
    }
    for (const [account, rows] of signalsByAccount) {
      rows.sort((left, right) => left.occurredAt - right.occurredAt || left.sequence - right.sequence);
      const seenMessages = new Set<string>();
      let highestSequence = input.checkpoints[account] ?? -1;
      let lastEventAt = Number.NEGATIVE_INFINITY;
      for (const row of rows) {
        if (seenMessages.has(row.messageId)) findings.push(`duplicate-message:${account}:${row.messageId}`);
        seenMessages.add(row.messageId);
        if (row.sequence <= highestSequence) findings.push(`sequence-rewind:${account}:${row.sequence}`);
        if (row.occurredAt < lastEventAt) findings.push(`event-time-rewind:${account}:${row.messageId}`);
        highestSequence = Math.max(highestSequence, row.sequence);
        lastEventAt = Math.max(lastEventAt, row.occurredAt);
      }
    }
    const observationsBySensor = new Map<string, WindowObservation[]>();
    for (const observation of input.observations) {
      const rows = observationsBySensor.get(observation.sensor) ?? [];
      rows.push(observation);
      observationsBySensor.set(observation.sensor, rows);
    }
    for (const [sensor, rows] of observationsBySensor) {
      rows.sort((left, right) => left.observedAt - right.observedAt || left.sequence - right.sequence);
      let priorSequence: number | undefined;
      let priorAt: number | undefined;
      for (const row of rows) {
        if (priorSequence !== undefined && row.sequence <= priorSequence) findings.push(`sensor-sequence:${sensor}:${row.sequence}`);
        if (priorAt !== undefined && row.observedAt - priorAt > 60_000) findings.push(`sensor-silence:${sensor}:${row.observedAt - priorAt}`);
        if (!Number.isFinite(row.value)) findings.push(`sensor-value:${sensor}:${row.sequence}`);
        if (!Number.isFinite(row.weight) || row.weight <= 0) findings.push(`sensor-weight:${sensor}:${row.sequence}`);
        priorSequence = Math.max(priorSequence ?? -1, row.sequence);
        priorAt = row.observedAt;
      }
    }
    const frameByOrdinal = new Map<number, PacketFrame[]>();
    for (const frame of input.frames) {
      const rows = frameByOrdinal.get(frame.ordinal) ?? [];
      rows.push(frame);
      frameByOrdinal.set(frame.ordinal, rows);
    }
    for (const [ordinal, rows] of frameByOrdinal) {
      const streams = new Set(rows.map((row) => row.stream));
      if (streams.size > 1) findings.push(`cross-stream-ordinal:${ordinal}:${[...streams].sort().join(",")}`);
      const finalCount = rows.filter((row) => row.final).length;
      if (finalCount > 1) findings.push(`duplicate-final:${ordinal}:${finalCount}`);
      const payloadLengths = new Set(rows.map((row) => row.payload.byteLength));
      if (payloadLengths.size > 1) findings.push(`payload-size-conflict:${ordinal}`);
    }
    const writesBySegment = new Map<string, typeof moves>();
    for (const move of moves) {
      const rows = writesBySegment.get(move.toSegment) ?? [];
      writesBySegment.set(move.toSegment, [...rows, move]);
      if (move.length <= 0) findings.push(`empty-move:${move.ordinal}`);
      if (move.toOffset < 0 || move.fromOffset < 0) findings.push(`negative-move-offset:${move.ordinal}`);
    }
    for (const [segment, segmentMoves] of writesBySegment) {
      const ordered = [...segmentMoves].sort((left, right) => left.toOffset - right.toOffset || left.ordinal - right.ordinal);
      for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1];
        const current = ordered[index];
        if (previous.toOffset + previous.length > current.toOffset) {
          findings.push(`migration-overlap:${segment}:${previous.ordinal}:${current.ordinal}`);
        }
      }
    }
    const dependencyIds = new Set(input.dependencies.map((node) => node.id));
    for (const node of input.dependencies) {
      if (node.prerequisites.includes(node.id)) findings.push(`self-dependency:${node.id}`);
      for (const prerequisite of node.prerequisites) {
        if (!dependencyIds.has(prerequisite)) findings.push(`missing-dependency:${node.id}:${prerequisite}`);
      }
    }
    for (const root of input.dependencyRoots) if (!dependencyIds.has(root)) findings.push(`missing-root:${root}`);
    for (const terminal of input.dependencyTerminals) if (!dependencyIds.has(terminal)) findings.push(`missing-terminal:${terminal}`);
    const boundaryEvents = timeline.filter((entry) => entry.at === input.boundary);
    const boundaryKinds = new Map<string, number>();
    for (const event of boundaryEvents) boundaryKinds.set(event.kind, (boundaryKinds.get(event.kind) ?? 0) + 1);
    if ((boundaryKinds.get("sequence-gap") ?? 0) > 20) findings.push(`gap-burst:${boundaryKinds.get("sequence-gap")}`);
    if ((boundaryKinds.get("discarded-frame") ?? 0) > 5) findings.push(`frame-loss-burst:${boundaryKinds.get("discarded-frame")}`);
    return [...new Set(findings)].sort();
  }

  /**
   * 按账户聚合相关性:综合缺失信号、阻断观测、变化传感器与活动能量计算
   * 严重度,按严重度降序返回,供事故定级与责任定位。
   */
  public correlateAccounts(
    signals: readonly TradeSignal[],
    observations: readonly WindowObservation[],
    missing: ReadonlyMap<string, readonly number[]>,
    changedSensors: readonly string[],
  ): readonly IncidentCorrelation[] {
    const accounts = new Set([...signals.map((signal) => signal.account), ...observations.map((observation) => observation.account)]);
    const changed = new Set(changedSensors);
    const output: IncidentCorrelation[] = [];
    for (const account of accounts) {
      const accountSignals = signals.filter((signal) => signal.account === account);
      const accountObservations = observations.filter((observation) => observation.account === account);
      const activity = [
        ...accountSignals.map((signal) => signal.occurredAt),
        ...accountObservations.map((observation) => observation.observedAt),
      ].sort((left, right) => left - right);
      const sensors = [...new Set(accountObservations.filter((observation) => changed.has(observation.sensor)).map((observation) => observation.sensor))].sort();
      const missingSignals = [...(missing.get(account) ?? [])].sort((left, right) => left - right);
      const blockedObservations = accountObservations.filter((observation) => observation.status === "blocked").length;
      const quantity = accountSignals.reduce((sum, signal) => sum + Math.abs(signal.quantity), 0);
      const measurementEnergy = accountObservations.reduce((sum, observation) => sum + Math.abs(observation.value * observation.weight), 0);
      const severity = missingSignals.length * 4 + blockedObservations * 3 + sensors.length * 5
        + Math.log10(Math.max(1, quantity)) + Math.log10(Math.max(1, measurementEnergy));
      output.push({
        account,
        signalCount: accountSignals.length,
        observationCount: accountObservations.length,
        firstActivity: activity[0] ?? 0,
        lastActivity: activity.at(-1) ?? 0,
        missingSignals,
        changedSensors: sensors,
        blockedObservations,
        estimatedSeverity: severity,
      });
    }
    return output.sort((left, right) => right.estimatedSeverity - left.estimatedSeverity || left.account.localeCompare(right.account));
  }

  /**
   * 渲染事故叙事:把相关性、依赖割、数据包与迁移结果组织为分段报告,
   * 严重度映射到 critical/warning/info。
   */
  public renderNarrative(
    incidentId: string,
    boundary: number,
    correlations: readonly IncidentCorrelation[],
    dependency: ReturnType<typeof minimumDependencyCut>,
    packets: ReturnType<typeof repairFrameSequence>,
    migration: ReturnType<typeof planSegmentMigration>,
  ): readonly string[] {
    const sections: Array<{
      heading: string;
      facts: Readonly<Record<string, string | number | boolean>>;
      severity: "info" | "warning" | "critical";
    }> = [];
    sections.push({
      heading: "Replay envelope",
      severity: "info",
      facts: {
        incident: incidentId,
        boundary,
        accounts: correlations.length,
        packetStream: packets.stream,
        packetDigest: packets.digest,
      },
    });
    for (const correlation of correlations.slice(0, 12)) {
      const critical = correlation.missingSignals.length > 0 && correlation.blockedObservations > 0;
      const warning = correlation.estimatedSeverity >= 5;
      sections.push({
        heading: `Account ${correlation.account}`,
        severity: critical ? "critical" : warning ? "warning" : "info",
        facts: {
          signals: correlation.signalCount,
          observations: correlation.observationCount,
          missingSequences: correlation.missingSignals.join(",") || "none",
          changedSensors: correlation.changedSensors.join(",") || "none",
          blocked: correlation.blockedObservations,
          severity: correlation.estimatedSeverity,
        },
      });
    }
    sections.push({
      heading: "Dependency containment",
      severity: dependency.cycles.length > 0 || dependency.unreachable.length > 0 ? "critical" : dependency.cut.length > 0 ? "warning" : "info",
      facts: {
        minimumCut: dependency.cut.join(",") || "none",
        cutCost: dependency.cost,
        cycles: dependency.cycles.map((cycle) => cycle.join("->")).join(" | ") || "none",
        unreachable: dependency.unreachable.join(",") || "none",
      },
    });
    sections.push({
      heading: "Packet reconstruction",
      severity: packets.complete ? "info" : "critical",
      facts: {
        complete: packets.complete,
        repairedFrames: packets.repaired.length,
        missingFrames: packets.missing.join(",") || "none",
        discardedFrames: packets.discarded.length,
        conflicts: packets.conflicts.size,
      },
    });
    sections.push({
      heading: "Storage migration",
      severity: migration.unplaced.length > 0 || migration.conflicts.length > 0 ? "warning" : "info",
      facts: {
        moves: migration.moves.length,
        waves: migration.waves.length,
        unplaced: migration.unplaced.join(",") || "none",
        estimatedBytes: migration.estimatedBytes,
        conflicts: migration.conflicts.join(" | ") || "none",
      },
    });
    return composeOperationsNarrative(`Incident ${incidentId}`, sections, 100);
  }
}
