export type AccessEffect = "allow" | "deny";
export type AccessDecisionKind = "allowed" | "denied" | "challenge" | "expired";

export interface AccessPrincipal {
  readonly principalId: string;
  readonly kind: "user" | "service" | "operator";
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly disabledAt?: Date;
  readonly homeRegion: string;
  readonly riskScore: number;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface AccessCredential {
  readonly credentialId: string;
  readonly principalId: string;
  readonly kind: "password" | "certificate" | "token" | "mfa";
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly authenticatedAt: Date;
  readonly assuranceLevel: number;
  readonly revokedAt?: Date;
  readonly scopes: readonly string[];
  readonly sourceIp: string;
}

export interface AccessRoleMembership {
  readonly membershipId: string;
  readonly principalId: string;
  readonly roleId: string;
  readonly effectiveFrom: Date;
  readonly effectiveUntil?: Date;
  readonly grantedBy: string;
  readonly regions: readonly string[];
  readonly accountIds: readonly string[];
}

export interface AccessGrant {
  readonly grantId: string;
  readonly subject: string;
  readonly subjectKind: "principal" | "role" | "kind";
  readonly resourcePattern: string;
  readonly actions: readonly string[];
  readonly effect: AccessEffect;
  readonly priority: number;
  readonly requiredAssuranceLevel: number;
  readonly requiredScopes: readonly string[];
  readonly allowedRegions: readonly string[];
  readonly allowedHoursUtc?: readonly [number, number];
  readonly requireMfa: boolean;
  readonly sensitive: boolean;
}

export interface AccessRequest {
  readonly requestId: string;
  readonly principal: AccessPrincipal;
  readonly credentials: readonly AccessCredential[];
  readonly memberships: readonly AccessRoleMembership[];
  readonly grants: readonly AccessGrant[];
  readonly resource: string;
  readonly action: string;
  readonly accountId?: string;
  readonly region: string;
  readonly sourceIp: string;
  readonly requestedAt: Date;
  readonly emergencyAccess: boolean;
}

export interface AccessEvaluationPolicy {
  readonly maximumCredentialAgeMs: number;
  readonly maximumRiskScore: number;
  readonly challengeRiskScore: number;
  readonly minimumSensitiveAssurance: number;
  readonly emergencyRoleId: string;
  readonly trustedCidrs: readonly string[];
  readonly blockedCidrs: readonly string[];
  readonly defaultDeny: boolean;
  readonly requireRegionalMatch: boolean;
  readonly maximumDecisionCacheMs: number;
}

export interface EvaluatedAccessGrant {
  readonly grantId: string;
  readonly matched: boolean;
  readonly effect: AccessEffect;
  readonly priority: number;
  readonly reasons: readonly string[];
}

export interface AccessEvaluationResult {
  readonly requestId: string;
  readonly decision: AccessDecisionKind;
  readonly principalId: string;
  readonly matchedGrantIds: readonly string[];
  readonly deniedByGrantIds: readonly string[];
  readonly activeRoleIds: readonly string[];
  readonly credentialIds: readonly string[];
  readonly assuranceLevel: number;
  readonly effectiveRiskScore: number;
  readonly obligations: readonly string[];
  readonly grantEvaluations: readonly EvaluatedAccessGrant[];
  readonly expiresAt: Date;
  readonly reasons: readonly string[];
}

export function evaluateIdentityAccess(
  request: AccessRequest,
  policy: AccessEvaluationPolicy,
): AccessEvaluationResult {
  const reasons: string[] = [];
  const obligations = new Set<string>();
  const grantEvaluations: EvaluatedAccessGrant[] = [];
  const requestedTime = request.requestedAt.getTime();
  if (!Number.isFinite(requestedTime)) throw new Error("access request time is invalid");
  if (request.requestId.trim().length === 0) throw new Error("access request id is required");
  if (request.resource.trim().length === 0) throw new Error("access resource is required");
  if (request.action.trim().length === 0) throw new Error("access action is required");
  if (request.region.trim().length === 0) throw new Error("access region is required");
  if (request.sourceIp.trim().length === 0) throw new Error("access source ip is required");
  if (!Number.isFinite(policy.maximumCredentialAgeMs) || policy.maximumCredentialAgeMs < 1) {
    throw new Error("maximum credential age must be positive");
  }
  if (!Number.isFinite(policy.maximumRiskScore) || policy.maximumRiskScore < 0 || policy.maximumRiskScore > 100) {
    throw new Error("maximum risk score must be between zero and one hundred");
  }
  if (
    !Number.isFinite(policy.challengeRiskScore)
    || policy.challengeRiskScore < 0
    || policy.challengeRiskScore > policy.maximumRiskScore
  ) {
    throw new Error("challenge risk score must not exceed maximum risk score");
  }
  if (!Number.isInteger(policy.minimumSensitiveAssurance) || policy.minimumSensitiveAssurance < 0) {
    throw new Error("minimum sensitive assurance cannot be negative");
  }
  if (!Number.isFinite(policy.maximumDecisionCacheMs) || policy.maximumDecisionCacheMs < 0) {
    throw new Error("maximum decision cache duration cannot be negative");
  }
  const principal = request.principal;
  if (principal.principalId.trim().length === 0) throw new Error("principal id is required");
  if (!Number.isFinite(principal.createdAt.getTime())) throw new Error("principal creation time is invalid");
  if (principal.createdAt.getTime() > requestedTime) reasons.push("principal-created-after-request-time");
  if (!Number.isFinite(principal.riskScore) || principal.riskScore < 0 || principal.riskScore > 100) {
    throw new Error("principal risk score must be between zero and one hundred");
  }
  if (principal.disabledAt !== undefined && !Number.isFinite(principal.disabledAt.getTime())) {
    throw new Error("principal disabled time is invalid");
  }
  if (!principal.enabled) reasons.push("principal-disabled");
  if (principal.disabledAt !== undefined && principal.disabledAt.getTime() <= requestedTime) {
    reasons.push("principal-disabled-at-request-time");
  }
  if (policy.requireRegionalMatch && principal.homeRegion !== request.region) {
    reasons.push("principal-region-mismatch");
  }
  const parseIpv4 = (value: string): number | undefined => {
    const pieces = value.split(".");
    if (pieces.length !== 4) return undefined;
    let encoded = 0;
    for (const piece of pieces) {
      if (!/^\d{1,3}$/u.test(piece)) return undefined;
      const octet = Number(piece);
      if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
      encoded = (encoded << 8) | octet;
    }
    return encoded >>> 0;
  };
  const cidrContains = (cidr: string, address: string): boolean => {
    const [networkText, prefixText] = cidr.split("/");
    if (networkText === undefined || prefixText === undefined) return false;
    const network = parseIpv4(networkText);
    const candidate = parseIpv4(address);
    const prefix = Number(prefixText);
    if (network === undefined || candidate === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      return false;
    }
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (network & mask) === (candidate & mask);
  };
  const validSourceIp = parseIpv4(request.sourceIp);
  if (validSourceIp === undefined) reasons.push("source-ip-is-not-ipv4");
  const blockedNetwork = policy.blockedCidrs.find((cidr) => cidrContains(cidr, request.sourceIp));
  const trustedNetwork = policy.trustedCidrs.find((cidr) => cidrContains(cidr, request.sourceIp));
  if (blockedNetwork !== undefined) reasons.push(`source-ip-blocked:${blockedNetwork}`);
  if (trustedNetwork === undefined) obligations.add("record-untrusted-network-access");
  const credentialById = new Map<string, AccessCredential>();
  for (const credential of request.credentials) {
    if (credential.credentialId.trim().length === 0) throw new Error("credential id cannot be blank");
    if (credentialById.has(credential.credentialId)) {
      throw new Error(`duplicate credential: ${credential.credentialId}`);
    }
    if (credential.principalId !== principal.principalId) {
      reasons.push(`credential-principal-mismatch:${credential.credentialId}`);
      continue;
    }
    if (!Number.isFinite(credential.issuedAt.getTime())) {
      reasons.push(`credential-invalid-issue-time:${credential.credentialId}`);
      continue;
    }
    if (!Number.isFinite(credential.expiresAt.getTime())) {
      reasons.push(`credential-invalid-expiry-time:${credential.credentialId}`);
      continue;
    }
    if (!Number.isFinite(credential.authenticatedAt.getTime())) {
      reasons.push(`credential-invalid-authentication-time:${credential.credentialId}`);
      continue;
    }
    if (credential.issuedAt > credential.expiresAt) {
      reasons.push(`credential-reversed-validity:${credential.credentialId}`);
      continue;
    }
    if (credential.authenticatedAt < credential.issuedAt || credential.authenticatedAt > request.requestedAt) {
      reasons.push(`credential-authentication-outside-validity:${credential.credentialId}`);
      continue;
    }
    if (credential.expiresAt.getTime() <= requestedTime) {
      reasons.push(`credential-expired:${credential.credentialId}`);
      continue;
    }
    if (credential.revokedAt !== undefined) {
      if (!Number.isFinite(credential.revokedAt.getTime())) {
        reasons.push(`credential-invalid-revocation-time:${credential.credentialId}`);
        continue;
      }
      if (credential.revokedAt.getTime() <= requestedTime) {
        reasons.push(`credential-revoked:${credential.credentialId}`);
        continue;
      }
    }
    if (requestedTime - credential.authenticatedAt.getTime() > policy.maximumCredentialAgeMs) {
      reasons.push(`credential-authentication-stale:${credential.credentialId}`);
      continue;
    }
    if (!Number.isInteger(credential.assuranceLevel) || credential.assuranceLevel < 0) {
      reasons.push(`credential-invalid-assurance:${credential.credentialId}`);
      continue;
    }
    if (credential.sourceIp !== request.sourceIp) {
      reasons.push(`credential-source-ip-mismatch:${credential.credentialId}`);
      obligations.add("verify-session-continuity");
    }
    credentialById.set(credential.credentialId, credential);
  }
  const activeCredentials = [...credentialById.values()];
  const assuranceLevel = activeCredentials.reduce(
    (maximum, credential) => Math.max(maximum, credential.assuranceLevel),
    0,
  );
  const credentialScopes = new Set(activeCredentials.flatMap((credential) => credential.scopes));
  const hasMfa = activeCredentials.some((credential) => credential.kind === "mfa");
  if (activeCredentials.length === 0) reasons.push("no-active-credential");
  const membershipById = new Map<string, AccessRoleMembership>();
  const activeRoles = new Set<string>();
  for (const membership of request.memberships) {
    if (membership.membershipId.trim().length === 0) throw new Error("membership id cannot be blank");
    if (membershipById.has(membership.membershipId)) {
      throw new Error(`duplicate role membership: ${membership.membershipId}`);
    }
    membershipById.set(membership.membershipId, membership);
    if (membership.principalId !== principal.principalId) {
      reasons.push(`membership-principal-mismatch:${membership.membershipId}`);
      continue;
    }
    if (!Number.isFinite(membership.effectiveFrom.getTime())) {
      reasons.push(`membership-invalid-start:${membership.membershipId}`);
      continue;
    }
    if (membership.effectiveUntil !== undefined && !Number.isFinite(membership.effectiveUntil.getTime())) {
      reasons.push(`membership-invalid-end:${membership.membershipId}`);
      continue;
    }
    if (membership.effectiveUntil !== undefined && membership.effectiveUntil < membership.effectiveFrom) {
      reasons.push(`membership-reversed-validity:${membership.membershipId}`);
      continue;
    }
    if (membership.effectiveFrom.getTime() > requestedTime) continue;
    if (membership.effectiveUntil !== undefined && membership.effectiveUntil.getTime() <= requestedTime) continue;
    if (membership.regions.length > 0 && !membership.regions.includes(request.region)) continue;
    if (request.accountId !== undefined && membership.accountIds.length > 0) {
      if (!membership.accountIds.includes(request.accountId)) continue;
    }
    activeRoles.add(membership.roleId);
  }
  if (activeRoles.size === 0 && principal.kind === "user") reasons.push("principal-has-no-active-role");
  let effectiveRiskScore = principal.riskScore;
  if (trustedNetwork === undefined) effectiveRiskScore += 10;
  if (blockedNetwork !== undefined) effectiveRiskScore = 100;
  if (principal.homeRegion !== request.region) effectiveRiskScore += 10;
  if (activeCredentials.length === 0) effectiveRiskScore = 100;
  if (!hasMfa && principal.kind === "user") effectiveRiskScore += 15;
  if (request.emergencyAccess) effectiveRiskScore += 20;
  effectiveRiskScore = Math.max(0, Math.min(100, effectiveRiskScore));
  const grantById = new Map<string, AccessGrant>();
  const matchingGrants: AccessGrant[] = [];
  const patternMatches = (pattern: string, resource: string): boolean => {
    if (pattern === "*") return true;
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
      .replace(/\*/gu, ".*");
    return new RegExp(`^${escaped}$`, "u").test(resource);
  };
  for (const grant of request.grants) {
    if (grant.grantId.trim().length === 0) throw new Error("access grant id cannot be blank");
    if (grantById.has(grant.grantId)) throw new Error(`duplicate access grant: ${grant.grantId}`);
    grantById.set(grant.grantId, grant);
    if (!Number.isInteger(grant.priority)) throw new Error(`grant priority is invalid: ${grant.grantId}`);
    if (!Number.isInteger(grant.requiredAssuranceLevel) || grant.requiredAssuranceLevel < 0) {
      throw new Error(`grant assurance requirement is invalid: ${grant.grantId}`);
    }
    if (grant.resourcePattern.trim().length === 0) {
      throw new Error(`grant resource pattern is blank: ${grant.grantId}`);
    }
    let subjectMatches = false;
    if (grant.subjectKind === "principal") subjectMatches = grant.subject === principal.principalId;
    else if (grant.subjectKind === "role") subjectMatches = activeRoles.has(grant.subject);
    else subjectMatches = grant.subject === principal.kind;
    const grantReasons: string[] = [];
    if (!subjectMatches) grantReasons.push("subject-not-matched");
    if (!patternMatches(grant.resourcePattern, request.resource)) grantReasons.push("resource-not-matched");
    if (!grant.actions.includes("*") && !grant.actions.includes(request.action)) {
      grantReasons.push("action-not-matched");
    }
    if (grant.allowedRegions.length > 0 && !grant.allowedRegions.includes(request.region)) {
      grantReasons.push("region-not-allowed");
    }
    if (grant.allowedHoursUtc !== undefined) {
      const [startHour, endHour] = grant.allowedHoursUtc;
      if (
        !Number.isInteger(startHour)
        || !Number.isInteger(endHour)
        || startHour < 0
        || startHour > 23
        || endHour < 0
        || endHour > 24
      ) {
        grantReasons.push("invalid-hour-window");
      } else {
        const hour = request.requestedAt.getUTCHours();
        const within = startHour <= endHour
          ? hour >= startHour && hour < endHour
          : hour >= startHour || hour < endHour;
        if (!within) grantReasons.push("outside-allowed-hours");
      }
    }
    if (assuranceLevel < grant.requiredAssuranceLevel) grantReasons.push("assurance-too-low");
    const missingScopes = grant.requiredScopes.filter((scope) => !credentialScopes.has(scope));
    if (missingScopes.length > 0) grantReasons.push(`missing-scopes:${missingScopes.join(",")}`);
    if (grant.requireMfa && !hasMfa) grantReasons.push("mfa-required");
    if (grant.sensitive && assuranceLevel < policy.minimumSensitiveAssurance) {
      grantReasons.push("sensitive-assurance-too-low");
    }
    const matched = grantReasons.length === 0;
    if (matched) matchingGrants.push(grant);
    grantEvaluations.push({
      grantId: grant.grantId,
      matched,
      effect: grant.effect,
      priority: grant.priority,
      reasons: grantReasons,
    });
  }
  matchingGrants.sort((left, right) => {
    if (left.priority !== right.priority) return right.priority - left.priority;
    if (left.effect !== right.effect) return left.effect === "deny" ? -1 : 1;
    if (left.sensitive !== right.sensitive) return left.sensitive ? -1 : 1;
    return left.grantId.localeCompare(right.grantId);
  });
  const highestPriority = matchingGrants[0]?.priority;
  const decisiveGrants = highestPriority === undefined
    ? []
    : matchingGrants.filter((grant) => grant.priority === highestPriority);
  const deniedByGrantIds = decisiveGrants.filter((grant) => grant.effect === "deny").map((grant) => grant.grantId);
  const allowedByGrantIds = decisiveGrants.filter((grant) => grant.effect === "allow").map((grant) => grant.grantId);
  let decision: AccessDecisionKind = "denied";
  if (
    !principal.enabled
    || principal.disabledAt?.getTime() !== undefined && principal.disabledAt <= request.requestedAt
  ) {
    decision = "expired";
  } else if (blockedNetwork !== undefined || effectiveRiskScore >= policy.maximumRiskScore) {
    decision = "denied";
  } else if (deniedByGrantIds.length > 0) {
    decision = "denied";
  } else if (effectiveRiskScore >= policy.challengeRiskScore || activeCredentials.length === 0) {
    decision = "challenge";
  } else if (allowedByGrantIds.length > 0) {
    decision = "allowed";
  } else if (!policy.defaultDeny && matchingGrants.length === 0) {
    decision = "allowed";
    obligations.add("record-default-allow");
  }
  if (request.emergencyAccess) {
    if (activeRoles.has(policy.emergencyRoleId) && decision !== "expired" && blockedNetwork === undefined) {
      if (decision === "denied" && deniedByGrantIds.length === 0) decision = "challenge";
      obligations.add("notify-security-on-call");
      obligations.add("record-break-glass-reason");
      obligations.add("expire-emergency-session-after-fifteen-minutes");
    } else {
      reasons.push("emergency-access-role-missing");
      decision = "denied";
    }
  }
  if (decision === "allowed") {
    obligations.add("emit-access-audit-record");
    if (request.accountId !== undefined) obligations.add("attach-account-scope");
    if (matchingGrants.some((grant) => grant.sensitive)) obligations.add("redact-sensitive-response-fields");
  } else if (decision === "challenge") {
    obligations.add("require-fresh-mfa-challenge");
    obligations.add("do-not-cache-challenge-decision");
  } else {
    obligations.add("emit-denied-access-audit-record");
  }
  const credentialExpiry = activeCredentials.reduce(
    (minimum, credential) => Math.min(minimum, credential.expiresAt.getTime()),
    requestedTime + policy.maximumDecisionCacheMs,
  );
  const membershipExpiry = request.memberships.reduce((minimum, membership) => {
    if (!activeRoles.has(membership.roleId) || membership.effectiveUntil === undefined) return minimum;
    return Math.min(minimum, membership.effectiveUntil.getTime());
  }, requestedTime + policy.maximumDecisionCacheMs);
  const maximumExpiry = requestedTime + policy.maximumDecisionCacheMs;
  const expiresAt = new Date(
    decision === "allowed"
      ? Math.min(maximumExpiry, credentialExpiry, membershipExpiry)
      : requestedTime,
  );
  if (decision === "allowed" && expiresAt.getTime() <= requestedTime) {
    decision = "expired";
    reasons.push("computed-access-decision-expired-immediately");
  }
  if (matchingGrants.length === 0) reasons.push("no-access-grant-matched");
  if (deniedByGrantIds.length > 0) reasons.push(`explicit-deny:${deniedByGrantIds.join(",")}`);
  if (allowedByGrantIds.length > 0) reasons.push(`explicit-allow:${allowedByGrantIds.join(",")}`);
  reasons.push(`effective-risk-score:${effectiveRiskScore}`);
  reasons.push(`assurance-level:${assuranceLevel}`);
  grantEvaluations.sort((left, right) => {
    if (left.matched !== right.matched) return left.matched ? -1 : 1;
    if (left.priority !== right.priority) return right.priority - left.priority;
    return left.grantId.localeCompare(right.grantId);
  });
  const matchedEvaluationIds = grantEvaluations.filter((evaluation) => evaluation.matched).map((item) => item.grantId);
  if (new Set(matchedEvaluationIds).size !== matchedEvaluationIds.length) {
    throw new Error("identity access evaluation contains duplicate matched grants");
  }
  if (matchedEvaluationIds.length !== matchingGrants.length) {
    throw new Error("identity access matched-grant counts are inconsistent");
  }
  if (decision === "allowed" && deniedByGrantIds.length > 0) {
    throw new Error("identity access allowed a request with a decisive deny grant");
  }
  if (decision === "allowed" && activeCredentials.length === 0) {
    throw new Error("identity access allowed a request without an active credential");
  }
  if (decision === "challenge" && obligations.has("require-fresh-mfa-challenge") === false) {
    throw new Error("identity challenge decision lacks an MFA obligation");
  }
  if (decision === "expired" && expiresAt.getTime() > requestedTime) {
    throw new Error("expired identity decision has a future cache expiry");
  }
  if (expiresAt.getTime() > requestedTime + policy.maximumDecisionCacheMs) {
    throw new Error("identity decision cache expiry exceeds policy");
  }
  return {
    requestId: request.requestId,
    decision,
    principalId: principal.principalId,
    matchedGrantIds: matchingGrants.map((grant) => grant.grantId),
    deniedByGrantIds,
    activeRoleIds: [...activeRoles].sort(),
    credentialIds: activeCredentials.map((credential) => credential.credentialId).sort(),
    assuranceLevel,
    effectiveRiskScore,
    obligations: [...obligations].sort(),
    grantEvaluations,
    expiresAt,
    reasons,
  };
}
