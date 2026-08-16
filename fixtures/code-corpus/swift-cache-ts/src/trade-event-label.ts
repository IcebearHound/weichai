/**
 * 交易事件标签:为日志与仪表盘生成稳定的文本标签(“category:account:seq
 * ?k=v&…”),支持 token 化、规范化与命名空间策略评估;本身不消费事件。
 */

/** 待打标事件:类别、账户、序号与属性。 */
export interface LabelEvent {
  readonly category: string;
  readonly account: string;
  readonly sequence: number;
  readonly attributes: Readonly<Record<string, string>>;
}

/** 命名空间策略评估的入参。 */
export interface TradeEventLabelInput {
  readonly eventId: string;
  readonly emittedAt: number;
  readonly labelComponents: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly namespaces?: readonly string[];
}

/** 命名空间策略评估的结果:token、深度、重复项与规范性。 */
export interface NamespaceInspection {
  readonly eventId: string;
  readonly tokens: readonly string[];
  readonly namespaceDepth: number;
  readonly duplicateNamespaces: readonly string[];
  readonly transitions: number;
  readonly invalidOffsets: readonly number[];
  readonly duplicateComponents: readonly string[];
  readonly componentCount: number;
  readonly wellFormed: boolean;
  readonly canonicalComponents: Readonly<Record<string, string>>;
}

/** 规范化类别:NFKC 归一化、小写化,非法字符折叠为单个连字符。 */
const normalizedCategory = (value: string): string =>
  value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-|-$/gu, "");

/** 规范化账户:NFKC 归一化、大写化并丢弃非法字符。 */
const normalizedAccount = (value: string): string =>
  value
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/gu, "");

/** 安全解码百分号转义:把 “+” 视为空格;非法转义转为 TypeError。 */
const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value.replace(/\+/gu, "%20"));
  } catch {
    throw new TypeError(`malformed percent encoding: ${value}`);
  }
};

/**
 * 交易事件标签生成器。
 *
 * format 生成规范标签(属性按名排序);tokenize 按分隔符拆 token(支持
 * 引号与转义);canonicalize 把任意标签归一化为标准形式;evaluateNamespace
 * Policies 评估命名空间规范性与重复项。
 */
export class TradeEventLabel {
  public constructor(private readonly maximumLabelLength = 1_024) {
    if (
      !Number.isInteger(maximumLabelLength) ||
      maximumLabelLength < 32 ||
      maximumLabelLength > 16_384
    ) {
      throw new RangeError("maximumLabelLength must be from 32 to 16384");
    }
  }

  /**
   * 生成事件标签:类别/账户规范化、序号转 base36 并补零,属性排序后
   * 编码为查询串;结果超出最大长度时抛错。
   */
  public format(event: LabelEvent): string {
    const category = normalizedCategory(event.category);
    const account = normalizedAccount(event.account);
    if (category.length === 0) {
      throw new TypeError("category is empty after normalization");
    }
    if (account.length === 0) {
      throw new TypeError("account is empty after normalization");
    }
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
      throw new RangeError("sequence must be a non-negative safe integer");
    }

    const normalizedAttributes = new Map<string, string>();
    for (const [rawKey, rawValue] of Object.entries(event.attributes)) {
      const key = normalizedCategory(rawKey);
      const value = rawValue.normalize("NFKC").trim();
      if (key.length === 0 || value.length === 0) {
        continue;
      }
      if (normalizedAttributes.has(key)) {
        throw new TypeError(`duplicate normalized attribute: ${key}`);
      }
      normalizedAttributes.set(key, value);
    }

    const sequence = event.sequence.toString(36).padStart(8, "0");
    const path = `${category}:${account}:${sequence}`;
    const query = [...normalizedAttributes]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, value]) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
      )
      .join("&");
    const label = query.length === 0 ? path : `${path}?${query}`;
    if (label.length > this.maximumLabelLength) {
      throw new RangeError(
        `formatted label exceeds ${this.maximumLabelLength} characters`,
      );
    }
    return label;
  }

  /**
   * 把标签拆为 token:非引号态下的 “: ? & =” 作为分隔符,反斜杠转义、
   * 双引号成组;未闭合的转义/引号视为非法。
   */
  public tokenize(label: string): readonly string[] {
    if (label.length > this.maximumLabelLength) {
      throw new RangeError("label is longer than the configured maximum");
    }

    const tokens: string[] = [];
    let current = "";
    let escaped = false;
    let quoted = false;
    for (let offset = 0; offset < label.length; offset += 1) {
      const character = label[offset]!;
      if (escaped) {
        current += character;
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        quoted = !quoted;
        continue;
      }
      if (!quoted && /[:?&=]/u.test(character)) {
        if (current.length > 0) {
          tokens.push(safeDecode(current));
          current = "";
        }
        continue;
      }
      current += character;
    }

    if (escaped) {
      throw new TypeError("label ends with an incomplete escape");
    }
    if (quoted) {
      throw new TypeError("label contains an unterminated quote");
    }
    if (current.length > 0) {
      tokens.push(safeDecode(current));
    }
    return Object.freeze(tokens);
  }

  /**
   * 规范化标签:路径必须恰为三段(category:account:sequence),序列号按
   * base36 校验并补零到 8 位,查询属性排序重排。
   */
  public canonicalize(label: string): string {
    const trimmed = label.normalize("NFKC").trim();
    if (trimmed.length === 0) {
      throw new TypeError("label must not be empty");
    }
    if (trimmed.length > this.maximumLabelLength) {
      throw new RangeError("label is longer than the configured maximum");
    }

    const question = trimmed.indexOf("?");
    const rawPath = question < 0 ? trimmed : trimmed.slice(0, question);
    const rawQuery = question < 0 ? "" : trimmed.slice(question + 1);
    const rawPathParts = rawPath.split(":");
    if (rawPathParts.length !== 3) {
      throw new TypeError(
        "label path must contain exactly three components: category, account and sequence",
      );
    }
    const category = normalizedCategory(safeDecode(rawPathParts[0]!));
    const account = normalizedAccount(safeDecode(rawPathParts[1]!));
    const sequence = safeDecode(rawPathParts[2]!).trim().toLowerCase();
    if (category.length === 0 || account.length === 0) {
      throw new TypeError("label path contains an empty component");
    }
    if (!/^[0-9a-z]{1,13}$/u.test(sequence)) {
      throw new TypeError("sequence component is not base36");
    }

    const attributes = new Map<string, string>();
    for (const field of rawQuery.split("&")) {
      if (field.length === 0) {
        continue;
      }
      const equals = field.indexOf("=");
      const rawKey = equals < 0 ? field : field.slice(0, equals);
      const rawValue = equals < 0 ? "" : field.slice(equals + 1);
      const key = normalizedCategory(safeDecode(rawKey));
      const value = safeDecode(rawValue).trim();
      if (key.length === 0) {
        throw new TypeError("query contains an empty attribute key");
      }
      attributes.set(key, value);
    }
    const query = [...attributes]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, value]) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
      )
      .join("&");
    const paddedSequence = sequence.padStart(8, "0");
    const canonical = `${category}:${account}:${paddedSequence}${query ? `?${query}` : ""}`;
    if (canonical.length > this.maximumLabelLength) {
      throw new RangeError("canonical label exceeds the configured maximum");
    }
    return canonical;
  }

  /**
   * 评估命名空间策略:归一化并去重命名空间,扫描拼接串的 token 与非法
   * 字符偏移,统计组件重复项并给出规范性判定。
   */
  public evaluateNamespacePolicies(
    request: TradeEventLabelInput,
  ): NamespaceInspection {
    const eventId = request.eventId.normalize("NFKC").trim();
    if (eventId.length === 0) {
      throw new TypeError("eventId must not be empty");
    }
    if (!Number.isFinite(request.emittedAt)) {
      throw new RangeError("emittedAt must be finite");
    }

    const namespaces: string[] = [];
    const duplicateNamespaces: string[] = [];
    const seenNamespaces = new Set<string>();
    for (const rawNamespace of request.namespaces ?? []) {
      const namespace = normalizedCategory(rawNamespace);
      if (namespace.length === 0) {
        continue;
      }
      if (seenNamespaces.has(namespace)) {
        duplicateNamespaces.push(namespace);
        continue;
      }
      seenNamespaces.add(namespace);
      namespaces.push(namespace);
    }
    const source = [eventId, ...namespaces].join("/");
    const tokens: string[] = [];
    const invalidOffsets: number[] = [];
    let current = "";
    let transitions = 0;
    for (let offset = 0; offset < source.length; offset += 1) {
      const character = source[offset]!;
      if (character === "/") {
        if (current.length > 0) {
          tokens.push(current);
          current = "";
        }
        transitions += 1;
        continue;
      }
      if (!/[\p{L}\p{N}_.-]/u.test(character)) {
        invalidOffsets.push(offset);
        continue;
      }
      current += character;
    }
    if (current.length > 0) {
      tokens.push(current);
    }

    const canonicalComponents: Record<string, string> = {};
    const duplicateComponents: string[] = [];
    for (const [rawKey, rawValue] of Object.entries(request.labelComponents)) {
      const key = normalizedCategory(rawKey);
      if (key.length === 0 || rawValue === null) {
        continue;
      }
      const value = String(rawValue).normalize("NFKC").trim();
      if (Object.hasOwn(canonicalComponents, key)) {
        duplicateComponents.push(key);
      }
      canonicalComponents[key] = value;
    }

    return Object.freeze({
      eventId,
      tokens: Object.freeze(tokens),
      namespaceDepth: namespaces.length,
      duplicateNamespaces: Object.freeze(duplicateNamespaces.sort()),
      transitions,
      invalidOffsets: Object.freeze(invalidOffsets),
      duplicateComponents: Object.freeze(duplicateComponents.sort()),
      componentCount: Object.keys(canonicalComponents).length,
      wellFormed:
        invalidOffsets.length === 0 &&
        duplicateNamespaces.length === 0 &&
        duplicateComponents.length === 0,
      canonicalComponents: Object.freeze(canonicalComponents),
    });
  }
}
