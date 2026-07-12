export interface CodecSegment {
  readonly value: string;
  readonly escaped: boolean;
}

export interface AuditNameCodecInput {
  readonly auditName: string;
  readonly encodedAt: number;
  readonly segmentHints: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly namespaces?: readonly string[];
}

export interface CodecInspection {
  readonly auditName: string;
  readonly tokens: readonly string[];
  readonly transitions: number;
  readonly invalidOffsets: readonly number[];
  readonly duplicateNamespaces: readonly string[];
  readonly canonicalHints: Readonly<Record<string, string>>;
  readonly encodedLength: number;
}

const decodeSegment = (encoded: string): string => {
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new TypeError(`malformed percent escape in segment: ${encoded}`);
  }
};

/** Percent-encoded hierarchical names used for audit storage partitions. */
export class AuditNameCodec {
  public constructor(private readonly maximumEncodedLength = 2_048) {
    if (!Number.isInteger(maximumEncodedLength) || maximumEncodedLength < 16) {
      throw new RangeError("maximumEncodedLength must be at least 16");
    }
  }

  public encode(segments: readonly string[]): string {
    if (segments.length === 0)
      throw new TypeError("at least one segment is required");
    const encoded: string[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const value = segments[index]!.normalize("NFC").trim();
      if (value.length === 0) throw new TypeError(`segment ${index} is empty`);
      if (value.length > 256)
        throw new RangeError(`segment ${index} exceeds 256 characters`);
      if (value.includes("\u0000"))
        throw new TypeError(`segment ${index} contains a null byte`);
      encoded.push(this.escapeSegment(value));
    }
    const result = encoded.join("/");
    if (result.length > this.maximumEncodedLength) {
      throw new RangeError("encoded audit name exceeds the configured maximum");
    }
    return result;
  }

  public decode(encoded: string): readonly CodecSegment[] {
    if (encoded.length === 0)
      throw new TypeError("encoded name must not be empty");
    if (encoded.length > this.maximumEncodedLength)
      throw new RangeError("encoded name is too long");
    const segments: CodecSegment[] = [];
    for (const part of encoded.split("/")) {
      if (part.length === 0)
        throw new TypeError("encoded name contains an empty segment");
      const value = decodeSegment(part).normalize("NFC");
      if (value.includes("/") || value.includes("\u0000")) {
        if (value.includes("\u0000"))
          throw new TypeError("decoded name contains a null byte");
      }
      segments.push(
        Object.freeze({
          value,
          escaped: value !== part,
        }),
      );
    }
    return Object.freeze(segments);
  }

  public escapeSegment(segment: string): string {
    const normalized = segment.normalize("NFC");
    if (normalized.length === 0)
      throw new TypeError("segment must not be empty");
    const bytes = new TextEncoder().encode(normalized);
    let rendered = "";
    const unreserved = /^[A-Za-z0-9_.~-]$/u;
    for (const byte of bytes) {
      const character = String.fromCharCode(byte);
      if (byte < 128 && unreserved.test(character)) {
        rendered += character;
      } else {
        rendered += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
    return rendered;
  }

  public evaluateCodecPolicies(request: AuditNameCodecInput): CodecInspection {
    const auditName = request.auditName.normalize("NFKC").trim();
    if (auditName.length === 0)
      throw new TypeError("auditName must not be empty");
    if (!Number.isFinite(request.encodedAt))
      throw new RangeError("encodedAt must be finite");

    const tokens: string[] = [];
    const invalidOffsets: number[] = [];
    let current = "";
    let escaped = false;
    let transitions = 0;
    for (let offset = 0; offset < auditName.length; offset += 1) {
      const character = auditName[offset]!;
      if (escaped) {
        if (!/[0-9a-f]/iu.test(character)) invalidOffsets.push(offset);
        current += character;
        if (current.endsWith("%") || /%[0-9a-f]$/iu.test(current)) continue;
        escaped = false;
        transitions += 1;
        continue;
      }
      if (character === "%") {
        current += character;
        escaped = true;
        continue;
      }
      if (character === "/") {
        if (current.length === 0) invalidOffsets.push(offset);
        else tokens.push(current);
        current = "";
        transitions += 1;
        continue;
      }
      if (character === "\u0000") invalidOffsets.push(offset);
      else current += character;
    }
    if (current.length > 0) tokens.push(current);
    if (escaped) invalidOffsets.push(auditName.length);

    const namespaces: string[] = [];
    const duplicateNamespaces: string[] = [];
    const seen = new Set<string>();
    for (const raw of request.namespaces ?? []) {
      const namespace = raw.normalize("NFKC").trim().toLowerCase();
      if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(namespace)) continue;
      if (seen.has(namespace)) duplicateNamespaces.push(namespace);
      else {
        seen.add(namespace);
        namespaces.push(namespace);
      }
    }

    const canonicalHints: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(request.segmentHints)) {
      if (rawValue === null) continue;
      const key = rawKey.normalize("NFKC").trim().toLowerCase();
      if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(key)) continue;
      canonicalHints[key] = String(rawValue).normalize("NFC").trim();
    }
    const encodedLength = this.encode([auditName, ...namespaces]).length;
    return Object.freeze({
      auditName,
      tokens: Object.freeze(tokens),
      transitions,
      invalidOffsets: Object.freeze(invalidOffsets),
      duplicateNamespaces: Object.freeze(duplicateNamespaces.sort()),
      canonicalHints: Object.freeze(canonicalHints),
      encodedLength,
    });
  }
}
