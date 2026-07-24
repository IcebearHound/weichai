# Adaptation Service — POC 验证脚本

## 快速开始

### 1. 安装依赖

```powershell
pip install openai
```

### 2. 安装 .NET SDK（编译校验需要）

```powershell
winget install Microsoft.DotNet.SDK.8
```

如果不装，脚本也能跑翻译部分，只是跳过编译校验。

### 3. 设置 API Key

```powershell
$env:OPENAI_API_KEY = "sk-你的key"
```

### 4. 运行

```powershell
python translate_poc.py
```

## 脚本做了什么

```
TEST_CASES (5个) → translate_java_to_csharp() → compile_csharp() → 修复循环 → 输出
```

1. **翻译**: 5 个预设的 Java 方法 → LLM → C# 方法
2. **编译**: 用 `dotnet build` 或 `csc.exe` 编译检查
3. **修复**: 编译失败 (最多 3 轮) → 错误信息 → LLM → 修复后代码 → 再编译
4. **输出**: `poc/output/result_xxx.json` + 每个 case 的 `.cs` 文件

## 5 个测试用例

| Case | 类型 | 说明 |
|------|------|------|
| case-1 | exact | 订单总价计算 — 类型映射 double→decimal |
| case-2 | partial | 订单验证 — Java 含库存检查, C# 不需要 |
| case-3 | partial | 价格格式化 — 静态方法→实例方法, Locale→CultureInfo |
| case-4 | exact | 支付处理 — 异常体系映射 |
| case-5 | exact | 分类汇总 — Stream→LINQ, Map→Dictionary |

## 后续步骤

脚本验证通过后，把它封装成 TypeScript 实现 `CodeAdaptationPort`。
