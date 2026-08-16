# Multipart Vault (Python)

`multipart-vault` is a Python implementation with strong behavioral overlap to
Apache Commons FileUpload 1.5 without reproducing its class hierarchy. It
receives `multipart/form-data` envelopes, parses quoted header attributes,
preserves part order and duplicate field names, keeps small parts in memory,
spills larger parts to a private temporary file, and enforces request, part,
and count limits.

Its intentionally different concepts are:

- `FormReceiver` instead of `FileUploadBase`/`FileUpload`;
- `UploadPart` instead of `FileItem`;
- `SpillLedger` instead of `DiskFileItem`;
- `DelimitedEnvelope` instead of `MultipartStream`.

The project uses only the Python standard library.

```text
python run_tests.py
```
