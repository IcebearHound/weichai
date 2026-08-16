// Derived behaviorally from Apache Commons FileUpload 1.5.
// SPDX-License-Identifier: Apache-2.0
using System.Text;

namespace Apache.Commons.FileUpload;

public abstract class FileUploadBase
{
    public const string MULTIPART = "multipart/";
    public const string MULTIPART_FORM_DATA = "multipart/form-data";
    public const string MULTIPART_MIXED = "multipart/mixed";
    public const string CONTENT_TYPE = "Content-type";
    public const string CONTENT_DISPOSITION = "Content-disposition";
    public const string CONTENT_LENGTH = "Content-length";

    private long sizeMax = -1;
    private long fileSizeMax = -1;
    private long fileCountMax = -1;
    private string? headerEncoding;
    private ProgressListener? listener;

    public long GetSizeMax() => sizeMax;
    public void SetSizeMax(long value) => sizeMax = value;
    public long GetFileSizeMax() => fileSizeMax;
    public void SetFileSizeMax(long value) => fileSizeMax = value;
    public long GetFileCountMax() => fileCountMax;
    public void SetFileCountMax(long value) => fileCountMax = value;
    public string? GetHeaderEncoding() => headerEncoding;
    public void SetHeaderEncoding(string? value) => headerEncoding = value;
    public ProgressListener? GetProgressListener() => listener;
    public void SetProgressListener(ProgressListener? value) => listener = value;

    public abstract FileItemFactory? GetFileItemFactory();
    public abstract void SetFileItemFactory(FileItemFactory factory);

    public static bool IsMultipartContent(RequestContext? context)
        => context?.GetContentType()?.StartsWith(MULTIPART, StringComparison.OrdinalIgnoreCase) == true;

    public IReadOnlyList<FileItem> ParseRequest(RequestContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        var requestSize = context is UploadContext uploadContext ? uploadContext.ContentLength() : context.GetContentLength();
        if (sizeMax >= 0 && requestSize >= 0 && requestSize > sizeMax)
        {
            throw new SizeLimitExceededException($"the request was rejected because its size ({requestSize}) exceeds the configured maximum ({sizeMax})", requestSize, sizeMax);
        }
        var factory = GetFileItemFactory() ?? throw new NullReferenceException("No FileItemFactory has been set.");
        var contentType = context.GetContentType();
        var boundary = GetBoundary(contentType) ?? throw new InvalidContentTypeException("the request was rejected because no multipart boundary was found");
        var items = new List<FileItem>();
        try
        {
            var stream = new MultipartStream(context.GetInputStream(), boundary);
            foreach (var part in stream.ReadParts())
            {
                var headers = GetParsedHeaders(part.RawHeaders);
                var disposition = headers.GetHeader(CONTENT_DISPOSITION);
                var dispositionParameters = ParseDisposition(disposition);
                if (!dispositionParameters.TryGetValue("name", out var fieldName) || string.IsNullOrEmpty(fieldName))
                {
                    continue;
                }
                var fileName = dispositionParameters.GetValueOrDefault("filename");
                if (fileCountMax >= 0 && items.Count >= fileCountMax)
                {
                    throw new FileCountLimitExceededException("attachment", fileCountMax);
                }
                if (fileSizeMax >= 0 && part.Body.LongLength > fileSizeMax)
                {
                    throw new FileSizeLimitExceededException($"The field {fieldName} exceeds its maximum permitted size of {fileSizeMax} bytes.", part.Body.LongLength, fileSizeMax);
                }
                var item = factory.CreateItem(fieldName, headers.GetHeader(CONTENT_TYPE), fileName is null, fileName);
                using (var output = item.GetOutputStream())
                {
                    output.Write(part.Body, 0, part.Body.Length);
                }
                item.SetHeaders(headers);
                items.Add(item);
                listener?.Invoke(part.Body.LongLength, requestSize, items.Count);
            }
            return items;
        }
        catch
        {
            foreach (var item in items)
            {
                item.Delete();
            }
            throw;
        }
    }

    public Dictionary<string, List<FileItem>> ParseParameterMap(RequestContext context)
    {
        var mapped = new Dictionary<string, List<FileItem>>();
        foreach (var item in ParseRequest(context))
        {
            var name = item.GetFieldName() ?? string.Empty;
            if (!mapped.TryGetValue(name, out var values))
            {
                values = new List<FileItem>();
                mapped[name] = values;
            }
            values.Add(item);
        }
        return mapped;
    }

    protected byte[]? GetBoundary(string? contentType)
    {
        var parser = new ParameterParser();
        parser.SetLowerCaseNames(true);
        var boundary = parser.Parse(contentType, ';').GetValueOrDefault("boundary");
        return string.IsNullOrEmpty(boundary) ? null : Encoding.ASCII.GetBytes(boundary);
    }

    protected static FileItemHeadersImpl GetParsedHeaders(string rawHeaders)
    {
        var headers = new FileItemHeadersImpl();
        string? currentName = null;
        var currentValue = new StringBuilder();
        void Commit()
        {
            if (currentName is not null)
            {
                headers.AddHeader(currentName, currentValue.ToString().Trim());
            }
        }
        foreach (var line in rawHeaders.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None))
        {
            if ((line.StartsWith(' ') || line.StartsWith('\t')) && currentName is not null)
            {
                currentValue.Append(' ').Append(line.Trim());
                continue;
            }
            Commit();
            var separator = line.IndexOf(':');
            if (separator <= 0)
            {
                currentName = null;
                currentValue.Clear();
                continue;
            }
            currentName = line[..separator].Trim();
            currentValue.Clear();
            currentValue.Append(line[(separator + 1)..].Trim());
        }
        Commit();
        return headers;
    }

    private static Dictionary<string, string?> ParseDisposition(string? value)
    {
        var parser = new ParameterParser();
        parser.SetLowerCaseNames(true);
        return parser.Parse(value, ';');
    }

    public class SizeException : FileUploadException
    {
        protected SizeException(string message, long actualSize, long permittedSize) : base(message)
        {
            ActualSize = actualSize;
            PermittedSize = permittedSize;
        }
        public long ActualSize { get; }
        public long PermittedSize { get; }
    }

    public sealed class SizeLimitExceededException : SizeException
    {
        public SizeLimitExceededException(string message, long actualSize, long permittedSize) : base(message, actualSize, permittedSize) { }
    }

    public sealed class FileSizeLimitExceededException : SizeException
    {
        public FileSizeLimitExceededException(string message, long actualSize, long permittedSize) : base(message, actualSize, permittedSize) { }
    }

    public sealed class InvalidContentTypeException : FileUploadException
    {
        public InvalidContentTypeException(string message) : base(message) { }
    }

    public sealed class FileUploadIOException : IOException
    {
        public FileUploadIOException(FileUploadException cause) : base(cause.Message, cause)
        {
            Cause = cause;
        }

        public FileUploadException Cause { get; }
    }

    public sealed class IOFileUploadException : FileUploadException
    {
        public IOFileUploadException(string message, IOException cause) : base(message, cause) { }
    }

    public sealed class UnknownSizeException : SizeException
    {
        public UnknownSizeException(string message, long actualSize, long permittedSize) : base(message, actualSize, permittedSize) { }
    }
}
