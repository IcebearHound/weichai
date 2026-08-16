# Commons FileUpload Python Reference

This dependency-free Python 3.11 project mirrors the core behavior of Apache
Commons FileUpload 1.5 for cross-language retrieval. It exposes the same
central responsibilities: `FileUploadBase`, `MultipartStream`,
`ParameterParser`, `FileItem`, `DiskFileItem`, and `DiskFileItemFactory`.

`FileUpload.parse_request()` accepts a `RequestContext`, extracts ordered
multipart parts, retains small bodies in memory, spills larger bodies to a
temporary file, and enforces request, item, and item-count limits.

```bash
python3 -m compileall -q src
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

The implementation is intentionally native Python rather than a line-by-line
port: `bytes`, `pathlib`, `tempfile`, and `io.BytesIO` replace Java streams and
files while preserving the observable upload contracts used by the Java target.
