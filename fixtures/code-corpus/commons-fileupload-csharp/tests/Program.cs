using System.Text;
using Apache.Commons.FileUpload;
using Apache.Commons.FileUpload.Disk;

static class Program
{
    private static int Main()
    {
        ParameterParsingPreservesQuotedValues();
        DiskItemsCrossTheConfiguredThreshold();
        UploadParsesFieldsAndFilesInWireOrder();
        UploadRejectsConfiguredLimits();
        Console.WriteLine("commons-fileupload-csharp regression tests passed");
        return 0;
    }

    private static void ParameterParsingPreservesQuotedValues()
    {
        var parser = new ParameterParser();
        parser.SetLowerCaseNames(true);
        var values = parser.Parse("FORM-DATA; name=note; filename=\"a;b.txt\"", ';');
        Assert(values["name"] == "note", "field parameter was not parsed");
        Assert(values["filename"] == "a;b.txt", "quoted filename was split at its separator");
    }

    private static void DiskItemsCrossTheConfiguredThreshold()
    {
        var repository = Path.Combine(Path.GetTempPath(), "commons-fileupload-csharp-tests", Guid.NewGuid().ToString("N"));
        var item = new DiskFileItem("upload", "text/plain; charset=UTF-8", false, "a.txt", 3, repository);
        using (var output = item.GetOutputStream())
        {
            output.Write(Encoding.UTF8.GetBytes("hello"));
        }
        Assert(!item.IsInMemory(), "item above threshold must spill to disk");
        Assert(item.GetString() == "hello", "disk-backed item content differs");
        item.Delete();
        Directory.Delete(repository, recursive: true);
    }

    private static void UploadParsesFieldsAndFilesInWireOrder()
    {
        const string body = "--AaB03x\r\n"
            + "Content-Disposition: form-data; name=\"title\"\r\n\r\n"
            + "report\r\n"
            + "--AaB03x\r\n"
            + "Content-Disposition: form-data; name=\"upload\"; filename=\"a.txt\"\r\n"
            + "Content-Type: text/plain\r\n\r\n"
            + "hello\r\n"
            + "--AaB03x--\r\n";
        var upload = new FileUpload(new DiskFileItemFactory(1024, Path.GetTempPath()));
        var items = upload.ParseRequest(new MemoryRequestContext(body, "multipart/form-data; boundary=AaB03x"));
        Assert(items.Count == 2, "multipart parts were not preserved");
        Assert(items[0].IsFormField() && items[0].GetString() == "report", "form field differs");
        Assert(!items[1].IsFormField() && items[1].GetName() == "a.txt", "file item differs");
        Assert(items[1].GetString() == "hello", "file body differs");
    }

    private static void UploadRejectsConfiguredLimits()
    {
        const string body = "--b\r\nContent-Disposition: form-data; name=\"one\"\r\n\r\na\r\n--b--\r\n";
        var upload = new FileUpload(new DiskFileItemFactory());
        upload.SetFileCountMax(0);
        try
        {
            upload.ParseRequest(new MemoryRequestContext(body, "multipart/form-data; boundary=b"));
            throw new InvalidOperationException("expected file count rejection");
        }
        catch (FileCountLimitExceededException)
        {
            // Expected.
        }
    }

    private sealed class MemoryRequestContext : UploadContext
    {
        private readonly byte[] body;
        private readonly string contentType;

        public MemoryRequestContext(string body, string contentType)
        {
            this.body = Encoding.UTF8.GetBytes(body);
            this.contentType = contentType;
        }

        public string? GetCharacterEncoding() => "UTF-8";
        public string? GetContentType() => contentType;
        public int GetContentLength() => body.Length;
        public long ContentLength() => body.LongLength;
        public Stream GetInputStream() => new MemoryStream(body, writable: false);
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
