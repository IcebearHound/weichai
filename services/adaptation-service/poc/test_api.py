"""极简测试：只测 DeepSeek API 能否连通"""
import os, sys

print(">>> Step 0: Python 启动成功")

try:
    from openai import OpenAI
    print(">>> Step 1: openai 包导入成功")
except Exception as e:
    print(f">>> Step 1 失败: {e}")
    sys.exit(1)

key = os.environ.get("DEEPSEEK_API_KEY", "")
if not key:
    print(">>> Step 2 失败: DEEPSEEK_API_KEY 未设置！")
    print("    请在 PowerShell 执行: $env:DEEPSEEK_API_KEY = 'sk-...'")
    sys.exit(1)
print(f">>> Step 2: API key 已设置 (长度={len(key)})")

print(">>> Step 3: 调用 DeepSeek API...")
try:
    client = OpenAI(api_key=key, base_url="https://api.deepseek.com/v1")
    resp = client.chat.completions.create(
        model="deepseek-chat",
        messages=[{"role": "user", "content": "回复'API连通成功'这6个字"}],
        temperature=0.1,
    )
    msg = resp.choices[0].message.content
    print(f">>> Step 3: 成功! DeepSeek 返回: {msg}")
except Exception as e:
    print(f">>> Step 3 失败: {e}")
