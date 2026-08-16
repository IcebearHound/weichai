// Portlet-shaped adapters keep the FileUpload 1.5 surface portable to .NET.
// SPDX-License-Identifier: Apache-2.0
using Apache.Commons.FileUpload.Disk;

namespace Apache.Commons.FileUpload.Portlet;

public interface PortletRequest
{
    string? CharacterEncoding { get; }
    string? ContentType { get; }
    long ContentLength { get; }
    Stream OpenBody();
}

public class PortletRequestContext : UploadContext
{
    private readonly PortletRequest request;
    public PortletRequestContext(PortletRequest request) => this.request = request;
    public string? GetCharacterEncoding() => request.CharacterEncoding;
    public string? GetContentType() => request.ContentType;
    public int GetContentLength() => request.ContentLength > int.MaxValue ? -1 : (int)request.ContentLength;
    public long ContentLength() => request.ContentLength;
    public Stream GetInputStream() => request.OpenBody();
}

public class PortletFileUpload : FileUpload
{
    public PortletFileUpload() : this(new DiskFileItemFactory()) { }
    public PortletFileUpload(FileItemFactory factory) : base(factory) { }
    public static bool IsMultipartContent(PortletRequest request) => request.ContentType?.StartsWith(FileUploadBase.MULTIPART, StringComparison.OrdinalIgnoreCase) == true;
    public IReadOnlyList<FileItem> ParseRequest(PortletRequest request) => ParseRequest(new PortletRequestContext(request));
}
