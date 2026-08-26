// 离线变体样例 Variant_2(无 key 路径):MimeUtility.DecodeText 的替代实现,
// 语义等价于源方法,但采用「逐字符手工解析」状态机风格(不同算法族)。
// 类名已按 VariantGeneratorAgent 的约定改写为 Variant_2(驱动按此调用)。
using System;
using System.IO;
using System.Text;

public class Variant_2
{
    public static string DecodeText(string value)
    {
        // 与源方法一致:null 无防护(null → NullReferenceException)。
        // 手工状态机:定位 "=?" 前缀、charset、mode、payload、"?=" 后缀。
        if (value.Length < 6 || value[0] != '=' || value[1] != '?') return value;
        if (value[value.Length - 2] != '?' || value[value.Length - 1] != '=') return value;
        int firstQ = value.IndexOf('?', 2);
        if (firstQ < 0) return value;
        int secondQ = value.IndexOf('?', firstQ + 1);
        if (secondQ < 0) return value;
        Encoding charset = Encoding.GetEncoding(value.Substring(2, firstQ - 2));
        string mode = value.Substring(firstQ + 1, secondQ - firstQ - 1);
        string payload = value.Substring(secondQ + 1, value.Length - secondQ - 3);
        if (string.Equals(mode, "B", StringComparison.OrdinalIgnoreCase))
        {
            return charset.GetString(Convert.FromBase64String(payload));
        }
        return charset.GetString(QuotedPrintableDecoder.Decode(payload.Replace('_', ' ')));
    }
}

public class QuotedPrintableDecoder
{
    public static byte[] Decode(string value)
    {
        var output = new MemoryStream();
        int i = 0;
        while (i < value.Length)
        {
            if (value[i] == '=' && i + 2 < value.Length
                && byte.TryParse(value.Substring(i + 1, 2), System.Globalization.NumberStyles.HexNumber, null, out byte decoded))
            {
                output.WriteByte(decoded);
                i += 3;
            }
            else
            {
                output.WriteByte((byte)value[i]);
                i += 1;
            }
        }
        return output.ToArray();
    }
}
