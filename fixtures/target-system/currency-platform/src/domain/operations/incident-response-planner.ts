import type {
  IncidentResponsePlan,
  IncidentResponseStep,
  IncidentSeverity,
  IncidentSignal,
} from "../runtime/operations-runtime-contracts.js";

export interface IncidentDependency {
  readonly componentId: string;
  readonly dependsOn: readonly string[];
  readonly ownerTeam: string;
  readonly criticality: "critical" | "high" | "normal" | "low";
  readonly regulated: boolean;
  readonly recoveryRunbook: string;
}

export interface IncidentResponsePolicy {
  readonly sev1SignalCount: number;
  readonly sev2SignalCount: number;
  readonly sev1FinancialImpact: string;
  readonly sev2FinancialImpact: string;
  readonly customerImpactEscalates: boolean;
  readonly containmentDeadlineMs: number;
  readonly recoveryDeadlineMs: number;
  readonly verificationDeadlineMs: number;
  readonly communicationCadenceMs: Readonly<Record<IncidentSeverity, number>>;
  readonly executiveEscalationSeverities: readonly IncidentSeverity[];
  readonly notificationRegions: readonly string[];
  readonly maximumAffectedComponents: number;
}

export interface IncidentResponseInput {
  readonly incidentId: string;
  readonly signals: readonly IncidentSignal[];
  readonly dependencies: readonly IncidentDependency[];
  readonly policy: IncidentResponsePolicy;
  readonly plannedAt: Date;
  readonly acknowledgedSignalIds: readonly string[];
  readonly unavailableTeams: readonly string[];
}

export function planIncidentResponse(input: IncidentResponseInput): IncidentResponsePlan {
  const diagnostics: string[] = [];
  const plannedTime = input.plannedAt.getTime();
  if (!Number.isFinite(plannedTime)) throw new Error("incident planning time is invalid");
  if (input.incidentId.trim().length === 0) throw new Error("incident id is required");
  const policy = input.policy;
  if (!Number.isInteger(policy.sev1SignalCount) || policy.sev1SignalCount < 1) {
    throw new Error("sev1 signal count must be positive");
  }
  if (!Number.isInteger(policy.sev2SignalCount) || policy.sev2SignalCount < 1) {
    throw new Error("sev2 signal count must be positive");
  }
  if (policy.sev1SignalCount < policy.sev2SignalCount) {
    throw new Error("sev1 signal count cannot be below sev2 signal count");
  }
  const sev1FinancialImpact = Number(policy.sev1FinancialImpact);
  const sev2FinancialImpact = Number(policy.sev2FinancialImpact);
  if (!Number.isFinite(sev1FinancialImpact) || sev1FinancialImpact < 0) {
    throw new Error("sev1 financial impact is invalid");
  }
  if (!Number.isFinite(sev2FinancialImpact) || sev2FinancialImpact < 0) {
    throw new Error("sev2 financial impact is invalid");
  }
  if (sev1FinancialImpact < sev2FinancialImpact) {
    throw new Error("sev1 financial threshold cannot be below sev2 threshold");
  }
  const deadlines = [
    policy.containmentDeadlineMs,
    policy.recoveryDeadlineMs,
    policy.verificationDeadlineMs,
  ];
  if (deadlines.some((deadline) => !Number.isFinite(deadline) || deadline < 1)) {
    throw new Error("incident deadlines must be positive");
  }
  if (policy.recoveryDeadlineMs < policy.containmentDeadlineMs) {
    throw new Error("recovery deadline cannot precede containment deadline");
  }
  if (policy.verificationDeadlineMs < policy.recoveryDeadlineMs) {
    throw new Error("verification deadline cannot precede recovery deadline");
  }
  if (!Number.isInteger(policy.maximumAffectedComponents) || policy.maximumAffectedComponents < 1) {
    throw new Error("maximum affected component count must be positive");
  }
  for (const severity of ["sev1", "sev2", "sev3", "sev4"] as const) {
    const cadence = policy.communicationCadenceMs[severity];
    if (!Number.isFinite(cadence) || cadence < 1) {
      throw new Error(`communication cadence is invalid for ${severity}`);
    }
  }
  const dependencyByComponent = new Map<string, IncidentDependency>();
  for (const dependency of input.dependencies) {
    if (dependency.componentId.trim().length === 0) throw new Error("dependency component id cannot be blank");
    if (dependencyByComponent.has(dependency.componentId)) {
      throw new Error(`duplicate incident dependency: ${dependency.componentId}`);
    }
    if (dependency.ownerTeam.trim().length === 0) {
      throw new Error(`dependency owner team is blank: ${dependency.componentId}`);
    }
    if (dependency.recoveryRunbook.trim().length === 0) {
      diagnostics.push(`component has no recovery runbook: ${dependency.componentId}`);
    }
    dependencyByComponent.set(dependency.componentId, dependency);
  }
  for (const dependency of dependencyByComponent.values()) {
    for (const parent of dependency.dependsOn) {
      if (!dependencyByComponent.has(parent)) {
        diagnostics.push(`dependency graph references unknown component: ${dependency.componentId}->${parent}`);
      }
      if (parent === dependency.componentId) {
        throw new Error(`component depends on itself: ${dependency.componentId}`);
      }
    }
  }
  const acknowledged = new Set(input.acknowledgedSignalIds);
  const signalById = new Map<string, IncidentSignal>();
  const validSignals: IncidentSignal[] = [];
  for (const signal of input.signals) {
    if (signal.signalId.trim().length === 0) throw new Error("incident signal id cannot be blank");
    if (signalById.has(signal.signalId)) throw new Error(`duplicate incident signal: ${signal.signalId}`);
    signalById.set(signal.signalId, signal);
    if (signal.componentId.trim().length === 0) {
      diagnostics.push(`signal has blank component id: ${signal.signalId}`);
      continue;
    }
    if (!Number.isFinite(signal.detectedAt.getTime())) {
      diagnostics.push(`signal has invalid detection time: ${signal.signalId}`);
      continue;
    }
    if (signal.detectedAt.getTime() > plannedTime) {
      diagnostics.push(`future signal ignored: ${signal.signalId}`);
      continue;
    }
    if (!Number.isFinite(signal.value) || !Number.isFinite(signal.threshold)) {
      diagnostics.push(`signal has non-finite value or threshold: ${signal.signalId}`);
      continue;
    }
    if (signal.threshold < 0) {
      diagnostics.push(`signal has negative threshold: ${signal.signalId}`);
      continue;
    }
    const financialImpact = Number(signal.financialImpact);
    if (!Number.isFinite(financialImpact) || financialImpact < 0) {
      diagnostics.push(`signal has invalid financial impact: ${signal.signalId}`);
      continue;
    }
    if (acknowledged.has(signal.signalId)) diagnostics.push(`signal was already acknowledged: ${signal.signalId}`);
    validSignals.push(signal);
  }
  validSignals.sort((left, right) => {
    if (left.customerImpact !== right.customerImpact) return left.customerImpact ? -1 : 1;
    const leftRatio = left.threshold === 0 ? left.value : left.value / left.threshold;
    const rightRatio = right.threshold === 0 ? right.value : right.value / right.threshold;
    if (leftRatio !== rightRatio) return rightRatio - leftRatio;
    return left.detectedAt.getTime() - right.detectedAt.getTime();
  });
  const affected = new Set(validSignals.map((signal) => signal.componentId));
  const directAffected = [...affected];
  let changed = true;
  while (changed) {
    changed = false;
    for (const dependency of dependencyByComponent.values()) {
      if (affected.has(dependency.componentId)) continue;
      if (dependency.dependsOn.some((componentId) => affected.has(componentId))) {
        affected.add(dependency.componentId);
        diagnostics.push(`dependent component considered affected: ${dependency.componentId}`);
        changed = true;
      }
    }
    if (affected.size > policy.maximumAffectedComponents) {
      diagnostics.push("affected component expansion reached configured maximum");
      break;
    }
  }
  const affectedComponents = [...affected].slice(0, policy.maximumAffectedComponents).sort();
  const affectedRegions = [...new Set(validSignals.map((signal) => signal.region))].sort();
  const customerImpactSignals = validSignals.filter((signal) => signal.customerImpact);
  const totalFinancialImpact = validSignals.reduce((sum, signal) => sum + Number(signal.financialImpact), 0);
  const thresholdBreaches = validSignals.filter((signal) => signal.value >= signal.threshold);
  const severeRatios = validSignals.filter((signal) =>
    signal.threshold === 0 ? signal.value > 0 : signal.value / signal.threshold >= 2,
  );
  const criticalComponents = affectedComponents.filter((componentId) =>
    dependencyByComponent.get(componentId)?.criticality === "critical",
  );
  let severity: IncidentSeverity = "sev4";
  if (thresholdBreaches.length >= policy.sev2SignalCount || totalFinancialImpact >= sev2FinancialImpact) {
    severity = "sev2";
  } else if (thresholdBreaches.length > 0 || affectedComponents.length > 1) {
    severity = "sev3";
  }
  if (
    thresholdBreaches.length >= policy.sev1SignalCount
    || totalFinancialImpact >= sev1FinancialImpact
    || criticalComponents.length > 1
  ) {
    severity = "sev1";
  }
  if (policy.customerImpactEscalates && customerImpactSignals.length > 0) {
    if (severity === "sev4") severity = "sev3";
    else if (severity === "sev3") severity = "sev2";
    else if (severity === "sev2" && customerImpactSignals.length > 2) severity = "sev1";
  }
  if (severeRatios.length >= 3 && severity !== "sev1") severity = severity === "sev3" ? "sev2" : severity;
  const unavailableTeams = new Set(input.unavailableTeams);
  const ownerFor = (componentId: string, fallback: string): string => {
    const configured = dependencyByComponent.get(componentId)?.ownerTeam ?? fallback;
    if (!unavailableTeams.has(configured)) return configured;
    diagnostics.push(`configured owner team unavailable: ${configured}`);
    return unavailableTeams.has("platform-on-call") ? "incident-command" : "platform-on-call";
  };
  const steps: IncidentResponseStep[] = [];
  const oldestSignalTime = validSignals.reduce(
    (minimum, signal) => Math.min(minimum, signal.detectedAt.getTime()),
    plannedTime,
  );
  const detectionStart = new Date(oldestSignalTime);
  steps.push({
    stepId: `${input.incidentId}:detect:confirm`,
    phase: "detect",
    ownerTeam: "platform-on-call",
    action: "Confirm signal validity, scope, and common failure signature.",
    startsAt: detectionStart,
    deadline: new Date(plannedTime + Math.min(300_000, policy.containmentDeadlineMs / 4)),
    dependencies: [],
    automated: false,
    evidenceRequired: ["signal-snapshot", "request-trace-sample"],
  });
  for (const componentId of directAffected.sort()) {
    const dependency = dependencyByComponent.get(componentId);
    const ownerTeam = ownerFor(componentId, "platform-on-call");
    const isolateId = `${input.incidentId}:contain:${componentId}`;
    steps.push({
      stepId: isolateId,
      phase: "contain",
      ownerTeam,
      action: dependency?.recoveryRunbook.trim().length
        ? `Apply containment section of runbook ${dependency.recoveryRunbook}.`
        : `Isolate unhealthy traffic for ${componentId} and preserve diagnostics.`,
      startsAt: input.plannedAt,
      deadline: new Date(plannedTime + policy.containmentDeadlineMs),
      dependencies: [`${input.incidentId}:detect:confirm`],
      automated: dependency?.criticality === "low",
      evidenceRequired: ["before-health-snapshot", "traffic-routing-change"],
    });
    const recoverId = `${input.incidentId}:recover:${componentId}`;
    steps.push({
      stepId: recoverId,
      phase: "recover",
      ownerTeam,
      action: dependency?.recoveryRunbook.trim().length
        ? `Execute recovery runbook ${dependency.recoveryRunbook}.`
        : `Restore ${componentId} with the safest known rollback or restart procedure.`,
      startsAt: new Date(plannedTime + policy.containmentDeadlineMs),
      deadline: new Date(plannedTime + policy.recoveryDeadlineMs),
      dependencies: [isolateId],
      automated: false,
      evidenceRequired: ["deployment-version", "recovery-command-output"],
    });
    steps.push({
      stepId: `${input.incidentId}:verify:${componentId}`,
      phase: "verify",
      ownerTeam,
      action: `Verify health, data integrity, and transaction continuity for ${componentId}.`,
      startsAt: new Date(plannedTime + policy.recoveryDeadlineMs),
      deadline: new Date(plannedTime + policy.verificationDeadlineMs),
      dependencies: [recoverId],
      automated: true,
      evidenceRequired: ["after-health-snapshot", "synthetic-transaction", "reconciliation-summary"],
    });
  }
  const regulatedComponents = affectedComponents.filter((componentId) =>
    dependencyByComponent.get(componentId)?.regulated === true,
  );
  const regulatoryNotification = regulatedComponents.length > 0
    && affectedRegions.some((region) => policy.notificationRegions.includes(region));
  const executiveEscalation = policy.executiveEscalationSeverities.includes(severity);
  const communicationDependencies = steps
    .filter((step) => step.phase === "detect")
    .map((step) => step.stepId);
  steps.push({
    stepId: `${input.incidentId}:communicate:initial`,
    phase: "communicate",
    ownerTeam: "incident-command",
    action: `Publish initial ${severity.toUpperCase()} incident status and known customer impact.`,
    startsAt: input.plannedAt,
    deadline: new Date(plannedTime + Math.min(policy.communicationCadenceMs[severity], 900_000)),
    dependencies: communicationDependencies,
    automated: false,
    evidenceRequired: ["approved-status-message"],
  });
  if (regulatoryNotification) {
    steps.push({
      stepId: `${input.incidentId}:communicate:regulator`,
      phase: "communicate",
      ownerTeam: "compliance-on-call",
      action: `Assess notification duties for ${regulatedComponents.join(", ")} in ${affectedRegions.join(", ")}.`,
      startsAt: input.plannedAt,
      deadline: new Date(plannedTime + policy.recoveryDeadlineMs),
      dependencies: [`${input.incidentId}:communicate:initial`],
      automated: false,
      evidenceRequired: ["impact-assessment", "notification-decision"],
    });
  }
  if (executiveEscalation) {
    steps.push({
      stepId: `${input.incidentId}:communicate:executive`,
      phase: "communicate",
      ownerTeam: "incident-command",
      action: "Brief executive response lead with scope, financial exposure, and recovery estimate.",
      startsAt: input.plannedAt,
      deadline: new Date(plannedTime + 600_000),
      dependencies: [`${input.incidentId}:communicate:initial`],
      automated: false,
      evidenceRequired: ["executive-briefing-record"],
    });
  }
  const stepIds = new Set(steps.map((step) => step.stepId));
  if (stepIds.size !== steps.length) throw new Error("incident plan generated duplicate step ids");
  for (const step of steps) {
    for (const dependencyId of step.dependencies) {
      if (!stepIds.has(dependencyId)) throw new Error(`incident step dependency is missing: ${dependencyId}`);
      if (dependencyId === step.stepId) throw new Error(`incident step depends on itself: ${step.stepId}`);
    }
    if (step.deadline < step.startsAt) diagnostics.push(`step deadline precedes start: ${step.stepId}`);
  }
  steps.sort((left, right) => {
    const startOrder = left.startsAt.getTime() - right.startsAt.getTime();
    if (startOrder !== 0) return startOrder;
    const phaseOrder = ["detect", "contain", "recover", "verify", "communicate"];
    const order = phaseOrder.indexOf(left.phase) - phaseOrder.indexOf(right.phase);
    if (order !== 0) return order;
    return left.stepId.localeCompare(right.stepId);
  });
  if (validSignals.length === 0) diagnostics.push("incident plan was generated without a valid signal");
  if (affectedComponents.length >= policy.maximumAffectedComponents) {
    diagnostics.push("affected component list may be truncated");
  }
  diagnostics.push(`valid-signal-count:${validSignals.length}`);
  diagnostics.push(`threshold-breach-count:${thresholdBreaches.length}`);
  diagnostics.push(`customer-impact-signal-count:${customerImpactSignals.length}`);
  diagnostics.push(`estimated-financial-impact:${totalFinancialImpact.toFixed(2)}`);
  diagnostics.push(`critical-component-count:${criticalComponents.length}`);
  const signalsByKind = new Map<string, number>();
  const signalsByComponent = new Map<string, number>();
  const signalsByRegion = new Map<string, number>();
  for (const signal of validSignals) {
    signalsByKind.set(signal.kind, (signalsByKind.get(signal.kind) ?? 0) + 1);
    signalsByComponent.set(signal.componentId, (signalsByComponent.get(signal.componentId) ?? 0) + 1);
    signalsByRegion.set(signal.region, (signalsByRegion.get(signal.region) ?? 0) + 1);
  }
  for (const [kind, count] of [...signalsByKind].sort(([left], [right]) => left.localeCompare(right))) {
    diagnostics.push(`signal-kind-count:${kind}:${count}`);
  }
  for (const [componentId, count] of [...signalsByComponent].sort(([left], [right]) => left.localeCompare(right))) {
    diagnostics.push(`signal-component-count:${componentId}:${count}`);
  }
  for (const [region, count] of [...signalsByRegion].sort(([left], [right]) => left.localeCompare(right))) {
    diagnostics.push(`signal-region-count:${region}:${count}`);
  }
  const stepsByPhase = new Map<IncidentResponseStep["phase"], number>();
  for (const step of steps) stepsByPhase.set(step.phase, (stepsByPhase.get(step.phase) ?? 0) + 1);
  for (const phase of ["detect", "contain", "recover", "verify", "communicate"] as const) {
    diagnostics.push(`step-count-${phase}:${stepsByPhase.get(phase) ?? 0}`);
  }
  if ((stepsByPhase.get("detect") ?? 0) === 0) throw new Error("incident plan lacks a detection step");
  if (directAffected.length > 0 && (stepsByPhase.get("contain") ?? 0) === 0) {
    throw new Error("incident plan lacks containment for affected components");
  }
  if ((stepsByPhase.get("communicate") ?? 0) === 0) throw new Error("incident plan lacks a communication step");
  const dependenciesByStep = new Map(steps.map((step) => [step.stepId, step.dependencies]));
  for (const step of steps) {
    const visited = new Set<string>();
    const pending = [...step.dependencies];
    while (pending.length > 0) {
      const dependencyId = pending.pop();
      if (dependencyId === undefined) continue;
      if (dependencyId === step.stepId) throw new Error(`incident plan has a dependency cycle: ${step.stepId}`);
      if (visited.has(dependencyId)) continue;
      visited.add(dependencyId);
      pending.push(...(dependenciesByStep.get(dependencyId) ?? []));
    }
  }
  const stepsByOwner = new Map<string, number>();
  let earliestDeadline = Number.POSITIVE_INFINITY;
  let latestDeadline = Number.NEGATIVE_INFINITY;
  for (const step of steps) {
    stepsByOwner.set(step.ownerTeam, (stepsByOwner.get(step.ownerTeam) ?? 0) + 1);
    earliestDeadline = Math.min(earliestDeadline, step.deadline.getTime());
    latestDeadline = Math.max(latestDeadline, step.deadline.getTime());
    if (unavailableTeams.has(step.ownerTeam)) {
      diagnostics.push(`step-assigned-to-unavailable-team:${step.stepId}:${step.ownerTeam}`);
    }
  }
  for (const [owner, count] of [...stepsByOwner].sort(([left], [right]) => left.localeCompare(right))) {
    diagnostics.push(`step-owner-count:${owner}:${count}`);
    if (count > 20) diagnostics.push(`step-owner-workload-high:${owner}`);
  }
  if (Number.isFinite(earliestDeadline)) {
    diagnostics.push(`earliest-step-deadline:${new Date(earliestDeadline).toISOString()}`);
  }
  if (Number.isFinite(latestDeadline)) {
    diagnostics.push(`latest-step-deadline:${new Date(latestDeadline).toISOString()}`);
  }
  if (severity === "sev1" && !executiveEscalation) {
    diagnostics.push("sev1 incident policy does not request executive escalation");
  }
  if (regulatoryNotification && regulatedComponents.length === 0) {
    throw new Error("regulatory notification was selected without a regulated component");
  }
  const titleComponent = directAffected.length === 0
    ? "unknown component"
    : directAffected.length === 1
      ? directAffected[0]
      : `${directAffected.length} platform components`;
  return {
    incidentId: input.incidentId,
    severity,
    title: `${severity.toUpperCase()} currency platform incident affecting ${titleComponent}`,
    affectedComponents,
    affectedRegions,
    steps,
    communicationCadenceMs: policy.communicationCadenceMs[severity],
    executiveEscalation,
    regulatoryNotification,
    diagnostics,
  };
}
