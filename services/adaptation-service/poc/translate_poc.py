"""
ForeXplore Adaptation Service — Python 概念验证脚本
====================================================
完整流程: Java方法 → LLM翻译 → C#编译校验 → 自动修复 → 输出结果

用法:
  1. python translate_poc.py  (API key 已内置)

依赖:
  pip install openai
  .NET 8 SDK (https://dotnet.microsoft.com/download)  — 编译校验需要, 不装也能跑翻译部分
"""

import os
import sys
import json
import subprocess
import tempfile
import shutil
import re
from pathlib import Path
from datetime import datetime
from openai import OpenAI

# ============================================================
# 配置
# ============================================================
MODEL = "deepseek-chat"     # DeepSeek V3, 便宜好用
MAX_RETRIES = 3             # 编译失败最大自动修复次数
DOTNET_PATH = "dotnet"      # dotnet 命令, 如果没装 .NET SDK 则在脚本最后看到警告


# ============================================================
# 测试数据: 模拟"从检索服务拿到的 Java 候选 + C# 目标"
# ============================================================
# 这就是你不需要等别人的原因——这些数据结构完全模拟了真实输入。
# 等别人交付后, 删掉这里, 换成从 retrieval-service 拿数据即可。

TEST_CASES = [
    {
        "id": "case-1-exact-match",
        "description": "完全匹配: Java订单总价计算 → C#订单总价计算",
        "matchType": "exact",
        "javaSource": """
public double calculateTotal(List<OrderItem> items, Discount discount) {
    double total = 0.0;
    for (OrderItem item : items) {
        if (item.getPrice() > 0 && item.getQuantity() > 0) {
            total += item.getPrice() * item.getQuantity();
        }
    }
    if (discount != null && discount.isValid()) {
        total = discount.apply(total);
    }
    if (total < 0) {
        total = 0.0;
    }
    return total;
}
""".strip(),
        "csharpSignature": "public decimal CalculateTotal(List<OrderItem> items, Discount discount)",
        "csharpClassName": "OrderService",
        "requirement": "根据订单项和折扣规则计算总价，支持满减和百分比折扣叠加，结果不能为负数",
    },
    {
        "id": "case-2-partial-match",
        "description": "部分匹配: Java验证订单(含库存检查) → C#验证订单(不含库存)",
        "matchType": "partial",
        "javaSource": """
public boolean validateOrder(Order order, InventoryService inventory) throws IllegalArgumentException {
    if (order == null) {
        throw new IllegalArgumentException("Order cannot be null");
    }
    if (order.getItems() == null || order.getItems().isEmpty()) {
        throw new IllegalArgumentException("Order must contain at least one item");
    }
    // Check inventory availability
    for (OrderItem item : order.getItems()) {
        if (!inventory.hasStock(item.getProductId(), item.getQuantity())) {
            return false;
        }
    }
    if (order.getCustomer() == null) {
        throw new IllegalArgumentException("Order must have a customer");
    }
    return true;
}
""".strip(),
        "csharpSignature": "public bool ValidateOrder(Order order)",
        "csharpClassName": "OrderValidator",
        "requirement": "验证订单基本信息（客户、订单项不为空），不需要检查库存",
    },
    {
        "id": "case-3-different-signature",
        "description": "结构差异: Java静态工具方法 → C#实例方法(有状态)",
        "matchType": "partial",
        "javaSource": """
public static String formatPrice(double price, String currency, Locale locale) {
    NumberFormat formatter = NumberFormat.getCurrencyInstance(locale);
    formatter.setCurrency(Currency.getInstance(currency));
    String formatted = formatter.format(price);
    // Handle negative prices gracefully
    if (price < 0) {
        formatted = "-" + formatter.format(Math.abs(price));
    }
    return formatted;
}
""".strip(),
        "csharpSignature": "public string FormatPrice(decimal price, string currency)",
        "csharpClassName": "PriceFormatter",
        "requirement": "格式化价格显示，使用指定的货币代码，支持负值标记。使用当前线程的区域设置。",
    },
    {
        "id": "case-4-exception-mapping",
        "description": "异常映射: Java检查型异常 → C#异常体系",
        "matchType": "exact",
        "javaSource": """
public PaymentResult processPayment(PaymentRequest request) throws PaymentFailedException, InsufficientFundsException {
    if (request.getAmount() <= 0) {
        throw new IllegalArgumentException("Payment amount must be positive");
    }
    Account account = accountRepository.findById(request.getAccountId());
    if (account == null) {
        throw new IllegalArgumentException("Account not found: " + request.getAccountId());
    }
    if (account.getBalance() < request.getAmount()) {
        throw new InsufficientFundsException(
            String.format("Balance %.2f is insufficient for payment %.2f",
                account.getBalance(), request.getAmount())
        );
    }
    try {
        PaymentResult result = paymentGateway.charge(request);
        account.setBalance(account.getBalance() - request.getAmount());
        accountRepository.save(account);
        return result;
    } catch (GatewayException e) {
        throw new PaymentFailedException("Payment gateway error", e);
    }
}
""".strip(),
        "csharpSignature": "public PaymentResult ProcessPayment(PaymentRequest request)",
        "csharpClassName": "PaymentService",
        "requirement": "处理支付请求：校验金额、检查余额、调用支付网关、更新账户",
    },
    {
        "id": "case-5-collection-transform",
        "description": "集合操作: Java Stream/Map → C# LINQ/Dictionary",
        "matchType": "exact",
        "javaSource": """
public Map<String, Double> calculateCategoryTotals(List<Order> orders) {
    Map<String, Double> totals = new HashMap<>();
    for (Order order : orders) {
        for (OrderItem item : order.getItems()) {
            String category = item.getCategory();
            double amount = item.getPrice() * item.getQuantity();
            totals.merge(category, amount, Double::sum);
        }
    }
    // Sort by total descending and keep top N
    return totals.entrySet().stream()
        .sorted(Map.Entry.<String, Double>comparingByValue().reversed())
        .limit(10)
        .collect(Collectors.toMap(
            Map.Entry::getKey,
            Map.Entry::getValue,
            (a, b) -> a,
            LinkedHashMap::new
        ));
}
""".strip(),
        "csharpSignature": "public Dictionary<string, decimal> CalculateCategoryTotals(List<Order> orders)",
        "csharpClassName": "ReportService",
        "requirement": "按商品类别汇总订单金额，返回金额最高的前10个类别，按金额降序排列",
    },
]


# ============================================================
# Step 1: LLM 翻译
# ============================================================
def translate_java_to_csharp(java_source: str, csharp_signature: str,
                              requirement: str, match_type: str) -> str:
    """把 Java 方法翻译成 C#"""
    client = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com/v1")

    match_notes = {
        "exact": "功能完全对应，请保持逻辑1:1翻译。",
        "partial": "功能部分重叠，只翻译与需求描述相关的部分，不需要的功能可以省略。",
        "different": "功能差异较大，以需求描述为准，Java源码仅作参考。",
    }

    prompt = f"""你是 Java→C# 代码翻译专家。请把以下 Java 方法翻译成 C#。

【匹配类型】{match_notes.get(match_type, "")}

【Java 源码】
```java
{java_source}
```

【目标 C# 方法签名】
```csharp
{csharp_signature}
```

【需求描述】
{requirement}

【翻译规则】
1. Java double → C# decimal
2. Java List<T> → C# List<T>
3. Java Map<K,V> → C# Dictionary<K,V>
4. Java boolean → C# bool
5. Java String → C# string
6. Java getter/setter → C# 属性 (get; set;)
7. Java checked exception → C# 去掉 throws 声明, throw 直接保留
8. IllegalArgumentException → ArgumentException
9. IllegalStateException → InvalidOperationException
10. NullPointerException → ArgumentNullException
11. Java static method → C# 如果签名没有 static 关键字就改成实例方法
12. Stream API → LINQ (Where / Select / ToDictionary / OrderByDescending / Take)
13. String.format() → string.Format() 或 $"" 字符串插值
14. Map.merge() → Dictionary.TryGetValue + 赋值
15. 不要写 using 语句 (放到编译 wrapper 里统一处理)
16. 只输出方法代码（包含签名），不要 class 包裹，不要文件头，不要解释
17. 不要 markdown 代码块标记 (```)
"""

    response = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.1,
    )
    return response.choices[0].message.content.strip()


# ============================================================
# Step 2: C# 编译校验
# ============================================================
def has_dotnet() -> bool:
    """检查是否装了 .NET SDK"""
    return shutil.which("dotnet") is not None


def compile_csharp(code: str, class_name: str) -> dict:
    """
    编译 C# 方法体。
    返回 {"success": bool, "errors": [str], "output": str}
    """
    # 构造一个最小可编译的 C# 文件（含桩类型 + 静态依赖）
    full_source = f"""using System;
using System.Collections.Generic;
using System.Linq;
using System.Globalization;
using System.Text;

// ---- 编译桩：领域对象 ----
public class OrderItem {{
    public decimal Price {{ get; set; }}
    public int Quantity {{ get; set; }}
    public string Category {{ get; set; }} = "";
    public string ProductId {{ get; set; }} = "";
}}
public class Discount {{
    public bool IsValid() => true;
    public decimal Apply(decimal total) => total * 0.9m;
}}
public class Order {{
    public List<OrderItem> Items {{ get; set; }} = new();
    public string Customer {{ get; set; }} = "";
}}
public class PaymentRequest {{
    public decimal Amount {{ get; set; }}
    public string AccountId {{ get; set; }} = "";
}}
public class PaymentResult {{ public bool Success {{ get; set; }} }}
public class Account {{
    public decimal Balance {{ get; set; }}
}}
public class InsufficientFundsException : Exception {{
    public InsufficientFundsException(string msg) : base(msg) {{ }}
}}
public class PaymentFailedException : Exception {{
    public PaymentFailedException(string msg, Exception inner) : base(msg, inner) {{ }}
}}
public class GatewayException : Exception {{ }}
public class AccountRepository {{
    public Account FindById(string id) => new Account {{ Balance = 1000m }};
    public void Save(Account a) {{ }}
}}
public class PaymentGateway {{
    public PaymentResult Charge(PaymentRequest r) => new PaymentResult {{ Success = true }};
}}

public class {class_name} {{
    // 依赖桩（模拟 DI 注入的字段）
    private static readonly AccountRepository accountRepository = new();
    private static readonly PaymentGateway paymentGateway = new();
{code}
}}
"""
    tmp_dir = Path(tempfile.mkdtemp(prefix="cs_compile_"))
    cs_file = tmp_dir / f"{class_name}.cs"
    cs_file.write_text(full_source, encoding="utf-8")

    try:
        if has_dotnet():
            # 方案 A: dotnet build
            # 先建一个最小 project
            csproj = """<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
  </PropertyGroup>
</Project>"""
            (tmp_dir / "tmp.csproj").write_text(csproj, encoding="utf-8")

            result = subprocess.run(
                ["dotnet", "build", "--nologo", "-v", "q"],
                cwd=str(tmp_dir),
                capture_output=True, text=True, encoding='utf-8', timeout=30
            )
        else:
            # 方案 B: csc.exe (Windows 自带)
            dll_path = tmp_dir / "test.dll"
            result = subprocess.run(
                ["csc", "/target:library", f"/out:{dll_path}",
                 "/nologo", str(cs_file)],
                capture_output=True, text=True, encoding='utf-8', timeout=30
            )

        stderr = result.stderr or ""
        stdout = result.stdout or ""
        combined = stderr + stdout

        if result.returncode == 0:
            return {"success": True, "errors": [], "output": combined.strip() or "编译通过"}
        else:
            errors = _parse_errors(combined)
            return {"success": False, "errors": errors, "output": combined}

    except FileNotFoundError:
        return {
            "success": False,
            "errors": [".NET SDK 未安装，无法编译。请运行: winget install Microsoft.DotNet.SDK.8"],
            "output": "",
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "errors": ["编译超时"], "output": ""}
    finally:
        shutil.rmtree(str(tmp_dir), ignore_errors=True)


def _parse_errors(output: str) -> list[str]:
    """提取关键编译错误行"""
    lines = output.split("\n")
    errors = []
    for line in lines:
        # 匹配 error CSxxxx 格式
        if re.search(r"error\s+CS\d+", line, re.IGNORECASE):
            # 只保留文件名之后的部分
            parts = line.split(":", 2)
            if len(parts) >= 3:
                errors.append(parts[2].strip())
            else:
                errors.append(line.strip())
    if not errors:
        # 兜底：取后几行
        errors = [l.strip() for l in lines if l.strip()][-5:]
    return errors


# ============================================================
# Step 3: 自动修复循环
# ============================================================
def fix_compile_errors(bad_code: str, errors: list[str],
                        csharp_signature: str, requirement: str) -> str:
    """编译失败时把错误喂给 LLM 修复"""
    client = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com/v1")

    prompt = f"""以下 C# 代码编译失败，请修复所有编译错误后重新输出完整代码。

【编译错误】
{chr(10).join(f"- {e}" for e in errors)}

【当前代码】
```csharp
{bad_code}
```

【目标签名要求】
{csharp_signature}

【功能需求】
{requirement}

要求: 只输出修复后的 C# 方法代码(含签名), 不要 markdown 标记, 不要解释。"""

    response = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.1,
    )
    return response.choices[0].message.content.strip()


# ============================================================
# Step 4: 主流程 — 单个 case 跑一遍
# ============================================================
def run_translation_pipeline(case: dict) -> dict:
    """完整流水线: 翻译 → 编译 → 自动修复 → 输出"""
    print(f"\n{'='*60}")
    print(f"  [{case['id']}] {case['description']}")
    print(f"  匹配类型: {case['matchType']}")
    print(f"{'='*60}")

    # -- Step 1: 翻译 --
    print("  [1/3] LLM 翻译中...")
    csharp_code = translate_java_to_csharp(
        java_source=case["javaSource"],
        csharp_signature=case["csharpSignature"],
        requirement=case["requirement"],
        match_type=case["matchType"],
    )
    print(f"  → 翻译完成 ({len(csharp_code)} 字符)")

    # -- Step 2: 编译 + 自动修复 --
    print(f"  [2/3] 编译校验...")
    compile_result = compile_csharp(csharp_code, case["csharpClassName"])

    retries = 0
    while not compile_result["success"] and retries < MAX_RETRIES:
        retries += 1
        print(f"  → 编译失败 (第{retries}次修复)")
        for err in compile_result["errors"][:3]:
            print(f"     err: {err[:100]}")

        csharp_code = fix_compile_errors(
            bad_code=csharp_code,
            errors=compile_result["errors"],
            csharp_signature=case["csharpSignature"],
            requirement=case["requirement"],
        )
        compile_result = compile_csharp(csharp_code, case["csharpClassName"])

    if compile_result["success"]:
        print(f"  → 编译通过{' (经{}次修复)'.format(retries) if retries > 0 else ''}")
    else:
        print(f"  → 编译仍未通过，请人工检查")

    # -- Step 3: 输出 --
    print(f"  [3/3] 生成结果")

    return {
        "id": case["id"],
        "description": case["description"],
        "matchType": case["matchType"],
        "csharpCode": csharp_code,
        "compileSuccess": compile_result["success"],
        "retries": retries,
        "compileErrors": compile_result["errors"],
        "inputJavaSource": case["javaSource"],
        "inputCsharpSignature": case["csharpSignature"],
        "inputRequirement": case["requirement"],
    }


# ============================================================
# Main
# ============================================================
def main():
    if "DEEPSEEK_API_KEY" not in os.environ:
        print("[X] DEEPSEEK_API_KEY not set")
        print("   PowerShell: $env:DEEPSEEK_API_KEY = 'sk-...'")
        sys.exit(1)

    # 检查编译环境
    if has_dotnet():
        print("[OK] .NET SDK ready")
    else:
        print("[WARN] .NET SDK not found - skip compile check")
        print("   安装方法: https://dotnet.microsoft.com/download")
        print("   或: winget install Microsoft.DotNet.SDK.8")
        print()

    # 跑全部 test case
    results = []
    for case in TEST_CASES:
        result = run_translation_pipeline(case)
        results.append(result)

    # ---- 汇总报告 ----
    print(f"\n\n{'='*60}")
    print(f"  汇总报告")
    print(f"{'='*60}")

    passed = sum(1 for r in results if r["compileSuccess"])
    total = len(results)
    print(f"  编译通过: {passed}/{total}")

    for r in results:
        status = "[PASS]" if r["compileSuccess"] else "[FAIL]"
        print(f"  {status} [{r['id']}] {r['description']}")

    # 输出所有结果到文件
    out_dir = Path(__file__).parent / "output"
    out_dir.mkdir(exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_file = out_dir / f"result_{timestamp}.json"
    out_file.write_text(
        json.dumps(results, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\n  [file] 详细结果已保存到: {out_file}")

    # 同时把每个翻译结果单独输出为 .cs 文件
    for r in results:
        cs_file = out_dir / f"{r['id']}.cs"
        cs_file.write_text(r["csharpCode"], encoding="utf-8")
    print(f"  [file] C# source files saved to: {out_dir}/")


if __name__ == "__main__":
    main()
