// Derived behaviorally from Apache Commons FileUpload 1.5.
// SPDX-License-Identifier: Apache-2.0
namespace Apache.Commons.FileUpload;

public class FileUpload : FileUploadBase
{
    private FileItemFactory? fileItemFactory;

    public FileUpload() { }

    public FileUpload(FileItemFactory fileItemFactory)
    {
        this.fileItemFactory = fileItemFactory;
    }

    public override FileItemFactory? GetFileItemFactory() => fileItemFactory;

    public override void SetFileItemFactory(FileItemFactory factory)
    {
        fileItemFactory = factory;
    }
}
