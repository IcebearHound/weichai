// Derived behaviorally from Apache Commons FileUpload 1.5.
// SPDX-License-Identifier: Apache-2.0
using System.Collections;
using System.Text;

namespace Apache.Commons.FileUpload;

public interface FileItem
{
    Stream GetInputStream();
    string? GetContentType();
    string? GetName();
    bool IsInMemory();
    long GetSize();
    byte[]? Get();
    string GetString(string charset);
    string GetString();
    void Write(string path);
    void Delete();
    string? GetFieldName();
    void SetFieldName(string? fieldName);
    bool IsFormField();
    void SetFormField(bool state);
    Stream GetOutputStream();
    FileItemHeaders? GetHeaders();
    void SetHeaders(FileItemHeaders? headers);
}

public interface FileItemFactory
{
    FileItem CreateItem(string? fieldName, string? contentType, bool isFormField, string? fileName);
}

public interface FileItemHeaders
{
    string? GetHeader(string name);
    IEnumerator<string> GetHeaders(string name);
    IEnumerator<string> GetHeaderNames();
}

public interface FileItemHeadersSupport
{
    FileItemHeaders? GetHeaders();
    void SetHeaders(FileItemHeaders? headers);
}

public interface RequestContext
{
    string? GetCharacterEncoding();
    string? GetContentType();
    int GetContentLength();
    Stream GetInputStream();
}

public interface UploadContext : RequestContext
{
    long ContentLength();
}

public delegate void ProgressListener(long bytesRead, long contentLength, int items);

public class FileUploadException : Exception
{
    public FileUploadException() { }
    public FileUploadException(string message) : base(message) { }
    public FileUploadException(string message, Exception cause) : base(message, cause) { }
}

public sealed class FileCountLimitExceededException : FileUploadException
{
    public FileCountLimitExceededException(string message, long limit) : base(message)
    {
        Limit = limit;
    }

    public long Limit { get; }
}

public sealed class InvalidFileNameException : ArgumentException
{
    public InvalidFileNameException(string? name, string message) : base(message)
    {
        Name = name;
    }

    public string? Name { get; }
}

public class FileItemHeadersImpl : FileItemHeaders
{
    private readonly Dictionary<string, List<string>> headers = new(StringComparer.OrdinalIgnoreCase);

    public void AddHeader(string name, string value)
    {
        ArgumentNullException.ThrowIfNull(name);
        lock (headers)
        {
            if (!headers.TryGetValue(name, out var values))
            {
                values = new List<string>();
                headers[name] = values;
            }
            values.Add(value);
        }
    }

    public string? GetHeader(string name)
    {
        lock (headers)
        {
            return headers.TryGetValue(name, out var values) && values.Count > 0 ? values[0] : null;
        }
    }

    public IEnumerator<string> GetHeaders(string name)
    {
        lock (headers)
        {
            return (headers.TryGetValue(name, out var values) ? values.ToArray() : Array.Empty<string>()).AsEnumerable().GetEnumerator();
        }
    }

    public IEnumerator<string> GetHeaderNames()
    {
        lock (headers)
        {
            return headers.Keys.ToArray().AsEnumerable().GetEnumerator();
        }
    }
}

public sealed class ParameterParser
{
    public bool IsLowerCaseNames { get; private set; }

    public void SetLowerCaseNames(bool value) => IsLowerCaseNames = value;

    public Dictionary<string, string?> Parse(string? value, params char[] separators)
    {
        if (separators is null || separators.Length == 0)
        {
            return new Dictionary<string, string?>();
        }
        var separator = separators[0];
        if (value is not null)
        {
            var index = value.Length;
            foreach (var candidate in separators)
            {
                var found = value.IndexOf(candidate);
                if (found >= 0 && found < index)
                {
                    index = found;
                    separator = candidate;
                }
            }
        }
        return Parse(value, separator);
    }

    public Dictionary<string, string?> Parse(string? value, char separator)
    {
        var result = new Dictionary<string, string?>();
        if (value is null)
        {
            return result;
        }

        var position = 0;
        while (position < value.Length)
        {
            var name = ReadToken(value, ref position, '=', separator, quoted: false);
            string? parameterValue = null;
            if (position < value.Length && value[position] == '=')
            {
                position++;
                parameterValue = ReadToken(value, ref position, separator, quoted: true);
            }
            if (position < value.Length && value[position] == separator)
            {
                position++;
            }
            if (!string.IsNullOrEmpty(name))
            {
                result[IsLowerCaseNames ? name.ToLowerInvariant() : name] = parameterValue;
            }
        }
        return result;
    }

    private static string? ReadToken(string value, ref int position, char terminator, bool quoted)
        => ReadToken(value, ref position, new[] { terminator }, quoted);

    private static string? ReadToken(string value, ref int position, char first, char second, bool quoted)
        => ReadToken(value, ref position, new[] { first, second }, quoted);

    private static string? ReadToken(string value, ref int position, char[] terminators, bool quoted)
    {
        var start = position;
        var inQuotes = false;
        var escaped = false;
        while (position < value.Length)
        {
            var current = value[position];
            if ((!quoted || !inQuotes) && terminators.Contains(current))
            {
                break;
            }
            if (quoted && !escaped && current == '"')
            {
                inQuotes = !inQuotes;
            }
            escaped = !escaped && current == '\\';
            position++;
        }
        var token = value[start..position].Trim();
        if (token.Length >= 2 && token[0] == '"' && token[^1] == '"')
        {
            token = token[1..^1];
        }
        return token.Length == 0 ? null : token;
    }
}

public static class Streams
{
    public const int DEFAULT_BUFFER_SIZE = 8192;

    public static long Copy(Stream input, Stream? output, bool closeOutputStream, byte[]? buffer = null)
    {
        buffer ??= new byte[DEFAULT_BUFFER_SIZE];
        long total = 0;
        try
        {
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                total += read;
                output?.Write(buffer, 0, read);
            }
            output?.Flush();
            return total;
        }
        finally
        {
            input.Dispose();
            if (closeOutputStream)
            {
                output?.Dispose();
            }
        }
    }

    public static string CheckFileName(string? fileName)
    {
        if (fileName is not null && fileName.Contains('\0'))
        {
            throw new InvalidFileNameException(fileName, $"Invalid file name: {fileName.Replace("\0", "\\0")}");
        }
        return fileName!;
    }
}
