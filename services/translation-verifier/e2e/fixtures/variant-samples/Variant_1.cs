// 离线变体样例 Variant_1(无 key 路径):MimeUtility.DecodeText 的替代实现,
// 语义等价于源方法,但代码结构不同(Substring + string.Equals 风格,QP 解码用 StringBuilder)。
// 类名已按 VariantGeneratorAgent 的约定改写为 Variant_1(驱动按此调用)。
using System;
using System.IO;
using System.Text;

public class Variant_1
{
    public static string DecodeText(string value)
    {
        // 与源方法一致:null 无防护(null → NullReferenceException)。
        if (!value.StartsWith("=?", StringComparison.Ordinal) || !value.EndsWith("?=", StringComparison.Ordinal)) return value;
        string[] parts = value.Substring(2, value.Length - 4).Split('?', 3);
        if (parts.Length != 3) return value;
        Encoding charset = Encoding.GetEncoding(parts[0]);
        if (string.Equals(parts[1], "B", StringComparison.OrdinalIgnoreCase))
        {
            return charset.GetString(Convert.FromBase64String(parts[2]));
        }
        return charset.GetString(QuotedPrintableDecoder.Decode(parts[2].Replace('_', ' ')));
    }
}

public class QuotedPrintableDecoder
{
    public static byte[] Decode(string value)
    {
        using var output = new MemoryStream();
        for (int index = 0; index < value.Length; index++)
        {
            if (value[index] == '=' && index + 2 < value.Length
                && byte.TryParse(value.Substring(index + 1, 2), System.Globalization.NumberStyles.HexNumber, null, out byte decoded))
            {
                output.WriteByte(decoded);
                index += 2;
            }
            else
            {
                output.WriteByte((byte)value[index]);
            }
        }
        return output.ToArray();
    }
}
