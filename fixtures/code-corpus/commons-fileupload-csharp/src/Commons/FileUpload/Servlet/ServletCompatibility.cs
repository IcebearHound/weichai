// Servlet-shaped adapters keep the FileUpload 1.5 surface portable to .NET.
// SPDX-License-Identifier: Apache-2.0
using Apache.Commons.FileUpload.Disk;

namespace Apache.Commons.FileUpload.Servlet;

public interface ServletRequest
{
    string? CharacterEncoding { get; }
    string? ContentType { get; }
    long ContentLength { get; }
    Stream OpenBody();
}

public class ServletRequestContext : UploadContext
{
    private readonly ServletRequest request;
    public ServletRequestContext(ServletRequest request) => this.request = request;
    public string? GetCharacterEncoding() => request.CharacterEncoding;
    public string? GetContentType() => request.ContentType;
    public int GetContentLength() => request.ContentLength > int.MaxValue ? -1 : (int)request.ContentLength;
    public long ContentLength() => request.ContentLength;
    public Stream GetInputStream() => request.OpenBody();
}

public class ServletFileUpload : FileUpload
{
    public ServletFileUpload() : this(new DiskFileItemFactory()) { }
    public ServletFileUpload(FileItemFactory factory) : base(factory) { }
    public static bool IsMultipartContent(ServletRequest request) => request.ContentType?.StartsWith(FileUploadBase.MULTIPART, StringComparison.OrdinalIgnoreCase) == true;
    public IReadOnlyList<FileItem> ParseRequest(ServletRequest request) => ParseRequest(new ServletRequestContext(request));
}

public sealed class FileCleanerCleanup
{
    private readonly List<WeakReference<FileItem>> tracked = new();
    public void Track(FileItem item) => tracked.Add(new WeakReference<FileItem>(item));
    public void ContextDestroyed()
    {
        foreach (var reference in tracked)
        {
            if (reference.TryGetTarget(out var item)) item.Delete();
        }
        tracked.Clear();
    }
}
