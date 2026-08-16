// Utility counterparts for Apache Commons FileUpload 1.5.
// SPDX-License-Identifier: Apache-2.0
using System.Text;

namespace Apache.Commons.FileUpload.Util;

/// 资源实现此约定后可以向调用方报告是否已经关闭。
public interface Closeable
{
    bool IsClosed();
}

/// 读取包装器会累计字节数，并在未知长度的请求超额时中止。
public abstract class LimitedInputStream : Stream, Closeable
{
    private readonly Stream input;
    private readonly long sizeMax;
    private long count;
    private bool closed;

    protected LimitedInputStream(Stream input, long sizeMax)
    {
        this.input = input;
        this.sizeMax = sizeMax;
    }

    protected abstract void RaiseError(long sizeMax, long count);
    public bool IsClosed() => closed;
    public long GetCount() => count;

    public override int Read(byte[] buffer, int offset, int length)
    {
        var read = input.Read(buffer, offset, length);
        if (read > 0)
        {
            count += read;
            if (count > sizeMax) RaiseError(sizeMax, count);
        }
        return read;
    }

    public override bool CanRead => input.CanRead;
    public override bool CanSeek => input.CanSeek;
    public override bool CanWrite => false;
    public override long Length => input.Length;
    public override long Position { get => input.Position; set => input.Position = value; }
    public override void Flush() => input.Flush();
    public override long Seek(long offset, SeekOrigin origin) => input.Seek(offset, origin);
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            input.Dispose();
            closed = true;
        }
        base.Dispose(disposing);
    }
}

/// 该帮助类负责还原 RFC 2047 格式的邮件头文本。
public static class MimeUtility
{
    public static string DecodeText(string value)
    {
        if (!value.StartsWith("=?", StringComparison.Ordinal) || !value.EndsWith("?=", StringComparison.Ordinal)) return value;
        var parts = value[2..^2].Split('?', 3);
        if (parts.Length != 3) return value;
        var charset = Encoding.GetEncoding(parts[0]);
        return parts[1].Equals("B", StringComparison.OrdinalIgnoreCase)
            ? charset.GetString(Convert.FromBase64String(parts[2]))
            : charset.GetString(QuotedPrintableDecoder.Decode(parts[2].Replace('_', ' ')));
    }
}

/// 该解码器处理 MIME 头里的 Base64 载荷。
public static class Base64Decoder
{
    public static byte[] Decode(string value) => Convert.FromBase64String(value);
}

/// 该解码器将 Quoted-Printable 头值还原为字节。
public static class QuotedPrintableDecoder
{
    public static byte[] Decode(string value)
    {
        using var output = new MemoryStream();
        for (var index = 0; index < value.Length; index++)
        {
            if (value[index] == '=' && index + 2 < value.Length && byte.TryParse(value.Substring(index + 1, 2), System.Globalization.NumberStyles.HexNumber, null, out var decoded))
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

/// MIME 编码字段无法读取时会抛出这一异常。
public class ParseException : Exception
{
    public ParseException(string message) : base(message) { }
}
