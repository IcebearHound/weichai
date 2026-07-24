"""
端到端验证脚本：module 1 → 2 → 3 全串联
=========================================
  Search API(module2) → 拿 Java 候选 → LLM 翻译(module3) → 编译校验 → 输出

用法:
  python e2e_pipeline.py
"""
import os, sys, json, subprocess, tempfile, shutil, re, urllib.request
from pathlib import Path
from datetime import datetime
from openai import OpenAI

# ============================================================
# 配置
# ============================================================
SEARCH_API = "http://127.0.0.1:8787/v1/search"
MODEL = "deepseek-chat"
MAX_RETRIES = 3

# ============================================================
# 从 module 2 Search API 拉候选
# ============================================================
def search_candidates(query: str, top_k: int = 5) -> list[dict]:
    """调用 retrieval-service 搜索 Java 代码候选"""
    payload = {
        "target": {
            "id": "e2e-test",
            "name": "placeholder",
            "kind": "function",
            "path": "unknown",
            "language": "C#",
            "signature": "unknown",
        },
        "requirement": query,
        "topK": top_k,
        "retrievalMode": "hybrid",
        "repositoryScopes": [],
        "candidateLanguages": ["Java"],
    }
    req = urllib.request.Request(
        SEARCH_API,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("candidates", [])


# ============================================================
# LLM 翻译（同 translate_poc.py）
# ============================================================
def translate_java_to_csharp(java_source: str, csharp_signature: str,
                              requirement: str) -> str:
    client = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"],
                    base_url="https://api.deepseek.com/v1")

    prompt = f"""你是 Java→C# 代码翻译专家。请把以下 Java 方法翻译成 C#。

【Java 源码】
```java
{java_source}
```

【目标 C# 方法签名】由你根据 Java 源码推断合适的 C# 签名。

【需求描述】
{requirement}

【翻译规则】
1. Java double → C# decimal
2. Java List<T> → C# List<T>
3. Java Map<K,V> → C# Dictionary<K,V>
4. Java boolean → C# bool, String → string
5. getter/setter → C# 属性
6. checked exception → 去掉 throws 声明
7. IllegalArgumentException → ArgumentException
8. Stream API → LINQ
9. String.format() → string.Format() 或 $ 插值
10. 不要写 using 语句
11. 只输出方法代码（含签名），不要 class 包裹，不要 markdown，不要解释
"""

    response = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.1,
    )
    return response.choices[0].message.content.strip()


# ============================================================
# C# 编译校验（同 translate_poc.py）
# ============================================================
def compile_csharp(code: str, class_name: str) -> dict:
    full_source = f"""using System;
using System.Collections.Generic;
using System.Linq;
using System.Globalization;
using System.Text;

// ---- 编译桩 ----
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
public class Account {{ public decimal Balance {{ get; set; }} }}
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
    private static readonly AccountRepository accountRepository = new();
    private static readonly PaymentGateway paymentGateway = new();
{code}
}}
"""
    tmp_dir = Path(tempfile.mkdtemp(prefix="e2e_compile_"))
    cs_file = tmp_dir / f"{class_name}.cs"
    cs_file.write_text(full_source, encoding="utf-8")

    try:
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
            capture_output=True, text=True, encoding='utf-8', timeout=30,
        )
        stderr = result.stderr or ""
        if result.returncode == 0:
            return {"success": True, "errors": []}
        else:
            errors = []
            for line in (stderr + (result.stdout or "")).split("\n"):
                if re.search(r"error\s+CS\d+", line, re.IGNORECASE):
                    parts = line.split(":", 2)
                    errors.append(parts[2].strip() if len(parts) >= 3 else line.strip())
            return {"success": False, "errors": errors or [stderr.strip()]}
    finally:
        shutil.rmtree(str(tmp_dir), ignore_errors=True)


def fix_compile_errors(bad_code: str, errors: list[str], requirement: str) -> str:
    client = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"],
                    base_url="https://api.deepseek.com/v1")
    prompt = f"""以下 C# 代码编译失败，请修复所有编译错误后重新输出完整代码。

【编译错误】
{chr(10).join(f"- {e}" for e in errors)}

【当前代码】
```csharp
{bad_code}
```

【功能需求】
{requirement}

要求: 只输出修复后的 C# 方法代码(含签名), 不要 markdown, 不要解释。"""
    response = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.1,
    )
    return response.choices[0].message.content.strip()


# ============================================================
# 主流程
# ============================================================
def main():
    if "DEEPSEEK_API_KEY" not in os.environ:
        print("[X] DEEPSEEK_API_KEY not set")
        sys.exit(1)

    # ---- 搜索场景 ----
    queries = [
        "计算订单总价，double映射为C# decimal",
        "验证订单信息，检查库存",
        "格式化价格，使用货币代码",
        "处理支付请求，检查余额",
        "按类别汇总订单金额",
    ]

    results = []
    for query in queries:
        print(f"\n{'='*60}")
        print(f"  Query: {query}")
        print(f"{'='*60}")

        # Step 1: 从 module 2 搜索候选
        print("  [1/4] module2 Search API...")
        try:
            candidates = search_candidates(query, top_k=3)
        except Exception as e:
            print(f"  [SKIP] Search API 不可用: {e}")
            continue

        if not candidates:
            print("  [SKIP] 无候选")
            continue

        best = candidates[0]
        if best.get("language") != "Java":
            raise RuntimeError(
                "Search language gate failed: "
                f"expected Java candidate, received {best.get('language', 'unknown')}"
            )
        print(f"  → 最佳匹配: {best['title']} ({best['language']})")
        print(f"    path: {best['path']}")
        print(f"    score: {best['score']['overall']:.3f}")

        # Step 2: module 3 LLM 翻译
        print("  [2/4] module3 LLM 翻译...")
        java_source = best.get("preview", "")
        if not java_source:
            print("  [SKIP] 候选无代码体")
            continue

        csharp_code = translate_java_to_csharp(
            java_source=java_source,
            csharp_signature=best.get("signature", ""),
            requirement=query,
        )
        print(f"  → 翻译完成 ({len(csharp_code)} 字符)")

        # Step 3: 编译 + 修复
        print("  [3/4] 编译校验...")
        class_name = f"E2E_{best['title']}"
        compile_result = compile_csharp(csharp_code, class_name)

        retries = 0
        while not compile_result["success"] and retries < MAX_RETRIES:
            retries += 1
            print(f"  → 编译失败 (第{retries}次修复)")
            csharp_code = fix_compile_errors(
                bad_code=csharp_code,
                errors=compile_result["errors"],
                requirement=query,
            )
            compile_result = compile_csharp(csharp_code, class_name)

        if compile_result["success"]:
            print(f"  → 编译通过{' (经{}次修复)'.format(retries) if retries else ''}")
        else:
            print(f"  → 编译仍未通过: {compile_result['errors'][:2]}")

        results.append({
            "query": query,
            "candidate": {
                "id": best["id"],
                "title": best["title"],
                "language": best["language"],
                "path": best["path"],
                "score": best["score"],
            },
            "csharpCode": csharp_code,
            "compileSuccess": compile_result["success"],
            "retries": retries,
        })

    # ---- 汇总 ----
    print(f"\n\n{'='*60}")
    print(f"  端到端测试报告")
    print(f"{'='*60}")
    passed = sum(1 for r in results if r["compileSuccess"])
    print(f"  Search API 命中: {len(results)} 条")
    print(f"  编译通过: {passed}/{len(results)}")

    for r in results:
        status = "[PASS]" if r["compileSuccess"] else "[FAIL]"
        print(f"  {status} {r['candidate']['title']} ← \"{r['query']}\"")

    # 输出
    out_dir = Path(__file__).parent / "output"
    out_dir.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_file = out_dir / f"e2e_{ts}.json"
    out_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n  [file] {out_file}")


if __name__ == "__main__":
    main()
