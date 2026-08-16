// Agent-curated source input for E2E (完整方法体,agent 整理)。
// 提取自 fixtures/code-corpus/commons-fileupload-csharp/src/Commons/FileUpload/Util/Utilities.cs
// 的 Base64Decoder.Decode,去掉 namespace 以便验证器 C# 驱动(默认命名空间)直接引用。
using System;

public static class Base64Decoder
{
    public static byte[] Decode(string value) => Convert.FromBase64String(value);
}
