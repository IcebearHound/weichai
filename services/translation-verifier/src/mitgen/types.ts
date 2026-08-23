/**
 * MitGen(微观测试生成)模块类型定义。
 *
 * 对应设计文档「方向4:MitGen 微观测试生成」第 2.6 节接口草案;
 * 与现有 TestDescription / TestCase(schema v1.0)保持兼容,description 直接喂 verify()。
 */
import type { TestCase, TestDescription } from "../description.js";

/** 片段种类(轻量词法分解可识别的控制结构/语句形态)。 */
export type FragmentKind =
  | "guard" // 早退守卫(if 条件为 true 时 return/throw 离开方法)
  | "if-branch" // if 真分支体
  | "else-branch" // else / else-if 分支体
  | "loop-header" // 循环头(for/while 的边界表达式)
  | "loop-body" // 循环体(至少执行一次迭代)
  | "switch-case" // switch 的单个 case 分支体
  | "return-expression" // return 返回值表达式
  | "assignment" // 赋值语句
  | "expression"; // 其他表达式语句

/** 方法内片段:字节区间 + 源码文本 + 路径条件 + 启发式特征。 */
export interface CodeFragment {
  id: string; // frag-01, frag-02, ...
  kind: FragmentKind;
  /** 片段在源方法文本中的起始字节位置(供插桩回射)。 */
  start: number;
  /** 片段在源方法文本中的结束字节位置(不含)。 */
  end: number;
  /** 片段源码文本。 */
  code: string;
  /**
   * 通往该片段的路径条件文本(如「外层 guard 为 false 且该 if 条件为 true」)。
   * 片段级生成的关键载体:把 LLM 的推理负担从「整个方法的输入→输出映射」降到「解单个条件」。
   */
  pathCondition: string;
  /** 启发式特征标签(boundary/empty/string/container/arithmetic/loop/guard/nested)。 */
  features: string[];
  /** 启发式优先分(0..1,由 fragment-prioritizer.heuristicScore 计算)。 */
  heuristicScore: number;
  /**
   * 单语句分支标记(无花括号的 if/循环单语句体):插桩时需要包成块 `{ marker; stmt; }`,
   * 否则 marker 会改变控制流语义,导致录制 expected 失真。true 时 splicer 做块包裹。
   */
  wrap?: boolean;
}

/** LLM 批量打分的单片段结果(CamPri 简化版)。 */
export interface FragmentScore {
  fragmentId: string;
  /** 翻译出错风险(0..1)。 */
  llmRiskScore: number;
  /** 替代实现易生成性(0..1,CamPri 的 fixability 简化)。 */
  llmFixabilityScore: number;
  /** 一句话理由。 */
  rationale: string;
}

/** 目标侧片段对应性:equivalent/missing/divergent/unknown(只进报告,不进 verdict)。 */
export type Correspondence = "equivalent" | "missing" | "divergent" | "unknown";

/** 片段可达性验证结果(插桩 marker 实测)。 */
export type Reachability = "verified" | "failed" | "skipped";

/** 单片段报告:对应性 + 片段级生成的整方法用例 + 可达性。 */
export interface FragmentReport {
  fragmentId: string;
  /** 片段源码文本(报告用)。 */
  sourceCode: string;
  correspondence: Correspondence;
  correspondenceNote: string;
  /** 该片段生成的整方法用例(与 description.cases 中对应 id 相同)。 */
  cases: TestCase[];
  reachability: Reachability;
}

/** MitGen 生成结果:schema 兼容描述(直接喂 verify)+ 片段级报告。 */
export interface MitGenResult {
  description: TestDescription;
  fragments: FragmentReport[];
}

/** 排序权重:w1·llmRisk + w2·llmFixability + w3·heuristic(默认 0.5/0.3/0.2)。 */
export interface RankWeights {
  risk: number;
  fixability: number;
  heuristic: number;
}
