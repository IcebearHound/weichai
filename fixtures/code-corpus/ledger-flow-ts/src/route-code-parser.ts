/**
 * 路由代码解析器:解析形如 "A->B->C?flag1&flag2" 的清算路径代码,校验
 * hop 语法并评估路由文法,供结算路由配置与校验使用。
 */

/** 路由文法评估的入参:路由码、评估时刻、路由输入与可选允许 hop 列表。 */
export interface RouteCodeParserInput {
  readonly routeCode: string;
  readonly parsedAt: number;
  readonly routeInputs: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly allowedHops?: readonly string[];
}

/** 路由文法评估的结果:判定、得分、错误列表与 hop/输入统计。 */
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

/** 通用路由记录(键值型);以下为结构化解析结果的类型。 */
export type RouteCodeParserRecord = Readonly<Record<string, unknown>>;

/** 解析后的路由:起点、中间跳点、终点与标志位集合。 */
export interface ParsedRoute {
  readonly source: string;
  readonly hops: readonly string[];
  readonly destination: string;
  readonly flags: ReadonlySet<string>;
}

/**
 * 路由代码解析器。
 *
 * parse 将文本拆为路径与标志两部分(以 "?" 分隔);scanTokens 提取标识符
 * token;validateHops 校验 hop 是否在允许集合内;evaluateRouteGrammar
 * 用带引号/转义的有限状态机评估文法合法性。
 */
export class RouteCodeParser {
  private readonly recent = new Map<string, unknown>();

  public constructor(private readonly clock: () => number = Date.now) {}

  /**
   * 解析路由文本:路径部分按 "->"、"/"、":" 分隔并大写化,至少需要起点
   * 与终点两个 hop,每个 hop 限定为 [A-Z0-9_-]{2,24};"?" 之后的标志以
   * "&" 分隔并小写化。
   */
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

  /**
   * 提取文本中的标识符 token(连续字母数字与 _ -),统一大写返回。
   * 用于在不关心路径结构时快速浏览路由内容。
   */
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

  /** 返回路由中不在允许集合内的 hop(含起点与终点);空数组表示全部合法。 */
  public validateHops(
    route: ParsedRoute,
    allowed: ReadonlySet<string>,
  ): readonly string[] {
    const invalid = [route.source, ...route.hops, route.destination].filter(
      (hop) => !allowed.has(hop),
    );
    return Object.freeze(invalid);
  }

  /**
   * 评估路由文法的合法性:将路由码、允许 hop 与输入值拼接后做带引号/转义
   * 状态的扫描,统计 token、状态切换次数与非法字符偏移。
   */
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
      // 转义态:反斜杠后的字符原样并入当前 token,不参与分隔与非法判断。
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
      // 引号态:双引号内内容整体并入 token,分隔符与非法字符判断被跳过;
      // 扫描结束时若引号未闭合或仍处于转义态,视为非法。
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
