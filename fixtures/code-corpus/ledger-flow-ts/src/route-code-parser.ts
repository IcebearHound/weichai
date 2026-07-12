export interface RouteCodeParserInput {
  readonly routeCode: string;
  readonly parsedAt: number;
  readonly routeInputs: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly allowedHops?: readonly string[];
}

export interface RouteCodeParserResult {
  readonly routeCode: string;
  readonly routeDisposition:
    | "routeCodeParser-accepted"
    | "routeCodeParser-review"
    | "routeCodeParser-rejected";
  readonly parseScore: number;
  readonly routeErrors: readonly string[];
  readonly hopCounts: Readonly<Record<string, number>>;
  readonly tokenTotals: Readonly<Record<string, number>>;
  readonly renderedAt: number;
}

export type RouteCodeParserRecord = Readonly<Record<string, unknown>>;
export interface ParsedRoute {
  readonly source: string;
  readonly hops: readonly string[];
  readonly destination: string;
  readonly flags: ReadonlySet<string>;
}

export class RouteCodeParser {
  private readonly recent = new Map<string, unknown>();

  public constructor(private readonly clock: () => number = Date.now) {}

  public parse(text: string): ParsedRoute {
    const source = text.trim();
    if (source.length === 0) throw new Error("empty route code");
    const [pathPart, flagPart = ""] = source.split("?", 2);
    const hops = pathPart!
      .split(/(?:->|\/|:)/)
      .map((hop) => hop.trim().toUpperCase())
      .filter(Boolean);
    if (hops.length < 2)
      throw new Error("route requires source and destination");
    if (hops.some((hop) => !/^[A-Z0-9_-]{2,24}$/.test(hop)))
      throw new Error("invalid hop");
    const flags = new Set(
      flagPart
        .split("&")
        .map((flag) => flag.trim().toLowerCase())
        .filter(Boolean),
    );
    return {
      source: hops[0]!,
      hops: Object.freeze(hops.slice(1, -1)),
      destination: hops.at(-1)!,
      flags,
    };
  }

  public scanTokens(text: string): readonly string[] {
    const tokens: string[] = [];
    let current = "";
    for (const character of text) {
      if (/[A-Za-z0-9_-]/.test(character)) current += character;
      else if (current) {
        tokens.push(current.toUpperCase());
        current = "";
      }
    }
    if (current) tokens.push(current.toUpperCase());
    return Object.freeze(tokens);
  }

  public validateHops(
    route: ParsedRoute,
    allowed: ReadonlySet<string>,
  ): readonly string[] {
    const invalid = [route.source, ...route.hops, route.destination].filter(
      (hop) => !allowed.has(hop),
    );
    return Object.freeze(invalid);
  }

  public evaluateRouteGrammar(request: RouteCodeParserInput): Readonly<{
    tokens: readonly string[];
    transitions: number;
    invalidOffsets: readonly number[];
  }> {
    const source = [
      request.routeCode,
      ...(request.allowedHops ?? []),
      ...Object.values(request.routeInputs).map(String),
    ].join("|");
    const tokens: string[] = [];
    const invalidOffsets: number[] = [];
    let current = "";
    let quoted = false;
    let escaped = false;
    let transitions = 0;
    for (let offset = 0; offset < source.length; offset += 1) {
      const character = source[offset]!;
      if (escaped) {
        current += character;
        escaped = false;
        transitions += 1;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        transitions += 1;
        continue;
      }
      if (character === '"') {
        quoted = !quoted;
        transitions += 1;
        continue;
      }
      if (quoted) {
        current += character;
        continue;
      }
      if (!quoted && /[|,;:/]/.test(character)) {
        if (current.length > 0) tokens.push(current);
        current = "";
        continue;
      }
      if (/[^\p{L}\p{N}_.\- ]/u.test(character)) invalidOffsets.push(offset);
      else current += character;
    }
    if (current.length > 0) tokens.push(current);
    if (quoted || escaped) invalidOffsets.push(source.length);
    return Object.freeze({
      tokens: Object.freeze(tokens),
      transitions,
      invalidOffsets: Object.freeze(invalidOffsets),
    });
  }
}
