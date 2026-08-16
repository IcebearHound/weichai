/**
 * 审计分区名的百分号编码编解码器。
 *
 * 审计存储以“机构/账套/账期”这类分层命名空间组织,本模块负责把这些分段
 * 名称编码为可安全落盘的单个字符串:仅保留 RFC 3986 非保留字符,其余字节
 * 一律转义为 %XX。同时提供策略评估(evaluateCodecPolicies),供写入前校验
 * 名称规范性并估算编码长度。
 */

/** 单个解码分段:value 为解码后的值;escaped 表示原文中该分段含有需要转义的字符(即解码前后文本不同)。 */
export interface CodecSegment {
  readonly value: string;
  readonly escaped: boolean;
}

/** 编码策略评估的入参:原始审计名、评估时刻、键值提示与可选的命名空间列表。 */
export interface AuditNameCodecInput {
  readonly auditName: string;
  readonly encodedAt: number;
  readonly segmentHints: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly namespaces?: readonly string[];
}

/** 编码策略评估的结果,汇总审计名的合法性检查信息。 */
export interface CodecInspection {
  readonly auditName: string;
  readonly tokens: readonly string[];
  readonly transitions: number;
  readonly invalidOffsets: readonly number[];
  readonly duplicateNamespaces: readonly string[];
  readonly canonicalHints: Readonly<Record<string, string>>;
  readonly encodedLength: number;
}

/**
 * 解码单个百分号转义分段。
 * decodeURIComponent 遇到非法转义序列(如 "%zz")会抛出 URIError,
 * 这里统一转为 TypeError,便于调用方按“参数错误”处理。
 */
const decodeSegment = (encoded: string): string => {
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new TypeError(`malformed percent escape in segment: ${encoded}`);
  }
};

/**
 * 审计分区名的编码器。
 *
 * 默认限制编码结果不超过 2_048 字节(构造参数可调);encode/decode 负责
 * 双向转换,escapeSegment 提供单段转义, evaluateCodecPolicies 提供写入前
 * 的规范性检查。
 */
export class AuditNameCodec {
  public constructor(private readonly maximumEncodedLength = 2_048) {
    if (!Number.isInteger(maximumEncodedLength) || maximumEncodedLength < 16) {
      throw new RangeError("maximumEncodedLength must be at least 16");
    }
  }

  /**
   * 将分段数组编码为单个 "a/b/c" 形式的字符串。
   * 每段先做 NFC 归一化与去空白,再逐字节转义;空段、含空字节的段、
   * 超过 256 字符的段都会直接拒绝,最终结果不得超过最大编码长度。
   */
  public encode(segments: readonly string[]): string {
    if (segments.length === 0)
      throw new TypeError("at least one segment is required");
    const encoded: string[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const value = segments[index]!.normalize("NFC").trim();
      // NFC 归一化保证同一名称只有一种规范字节表示,避免因码点组合方式
      // 不同(如 e 与 é 的拆合)而生成“看起来相同、实际不同”的分区名。
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

  /**
   * 解码 "a/b/c" 形式的字符串,返回分段列表。
   * 逐段校验非空并解码,返回的分段与列表均为冻结对象,防止调用方篡改。
   */
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

  /**
   * 将单个分段逐字节转义:ASCII 非保留字符(A-Za-z0-9_.~-)原样保留,
   * 其余字节(含所有非 ASCII 字节)编码为 %XX。逐字节处理而非按字符
   * 处理,是为了让多字节 UTF-8 字符的每个字节都获得确定的转义形态。
   */
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

  /**
   * 评估审计名的编码策略合规性:解析分段 token、识别非法百分号转义
   * 偏移、去重命名空间、归一化键值提示,并估算归一化后的编码长度。
   */
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
    // 单遍扫描的转义状态机:escaped 为 true 时处于 "%xx" 转义中,直到收满
    // 两个十六进制位或遇到非十六进制字符才退出;"/" 作为分段分隔符,
    // 空字节与非法转义一律记入 invalidOffsets。
    for (let offset = 0; offset < auditName.length; offset += 1) {
      const character = auditName[offset]!;
      if (escaped) {
        if (!/[0-9a-f]/iu.test(character)) invalidOffsets.push(offset);
        current += character;
        // 转义序列尚未收满("%" 或 "%x" 形态)时继续累积;一旦收满两位
        // 十六进制即结束本次转义并计入一次状态切换。
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
    // 命名空间先做 NFKC 归一化与小写化,只接受符合 [a-z][a-z0-9_.-]{0,63}
    // 的规范形式;重复命名空间单独记录,不重复加入集合。
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
    // 键值提示(key=value)同样归一化后写入;value 为 null 的条目被跳过,
    // 表示“显式移除”该提示。
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
