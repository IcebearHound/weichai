import { createHash } from "node:crypto";
import { canonicalDescriptionJson, type TestDescription } from "../description.js";
import { generateJavaDriver } from "./java-driver.js";
import { generateCSharpDriver } from "./csharp-driver.js";

/**
 * 基于 canonicalDescriptionJson 的 sha256 前缀生成确定性驱动类名(Java/C# 共享)。
 * 与 driver 生成逻辑解耦:纯 sha256 计算,不依赖任何语言特定实现。
 */
export function driverClassName(description: TestDescription): string {
  const hash = createHash("sha256").update(canonicalDescriptionJson(description), "utf8").digest("hex");
  return `Driver_${hash.slice(0, 8)}`;
}

/**
 * 按 description.target.language 分派到对应语言的驱动生成器。
 * 确定性:同一描述输出与 generateJavaDriver / generateCSharpDriver 字节一致。
 * 非法语言抛错。
 */
export function generateDriverSource(description: TestDescription): string {
  switch (description.target.language) {
    case "Java":
      return generateJavaDriver(description);
    case "C#":
      return generateCSharpDriver(description);
    default:
      throw new Error(`Unsupported driver language: ${String(description.target.language)}`);
  }
}
