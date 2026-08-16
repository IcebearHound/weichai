// MIME namespace counterparts for Apache Commons FileUpload 1.5.
// SPDX-License-Identifier: Apache-2.0
namespace Apache.Commons.FileUpload.Util.Mime;

public static class MimeUtility
{
    public static string DecodeText(string value) => global::Apache.Commons.FileUpload.Util.MimeUtility.DecodeText(value);
}

public static class Base64Decoder
{
    public static byte[] Decode(string value) => global::Apache.Commons.FileUpload.Util.Base64Decoder.Decode(value);
}

public static class QuotedPrintableDecoder
{
    public static byte[] Decode(string value) => global::Apache.Commons.FileUpload.Util.QuotedPrintableDecoder.Decode(value);
}

public sealed class ParseException : global::Apache.Commons.FileUpload.Util.ParseException
{
    public ParseException(string message) : base(message) { }
}
