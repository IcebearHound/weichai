// 冒烟验证 C# 源侧 runner(离线 fixture 用):调用 MimeUtility.DecodeText 并输出统一 JSON 协议。
// 入口文件固定为 Driver.cs;executor 以 StartupObject=SmokeDriver 生成 Verifier.csproj 编译运行。
using System;
using System.Text.Json;

public class SmokeDriver
{
    public static void Main()
    {
        object[] results = new object[]
        {
            Case("plain", () => MimeUtility.DecodeText("hello world")),
            Case("encoded-b", () => MimeUtility.DecodeText("=?UTF-8?B?aGVsbG8=?=")),
            Case("encoded-q", () => MimeUtility.DecodeText("=?UTF-8?Q?hello=20world?=")),
            Case("invalid-charset", () => MimeUtility.DecodeText("=?NOT-A-CHARSET?B?aGVsbG8=?=")),
            Case("null-input", () => MimeUtility.DecodeText(null))
        };
        Console.WriteLine(JsonSerializer.Serialize(new { results }));
    }

    static object Case(string id, Func<string> invoke)
    {
        try
        {
            string value = invoke();
            return new { caseId = id, outcome = "return", returnValue = new { type = "string", value } };
        }
        catch (Exception ex)
        {
            return new { caseId = id, outcome = "exception", exceptionType = ex.GetType().Name, exceptionMessage = ex.Message };
        }
    }
}
