# Commons FileUpload TypeScript Reference

This dependency-free TypeScript/Node project mirrors the core behavior of
Apache Commons FileUpload 1.5 for cross-language retrieval. It provides
`FileUploadBase`, `MultipartStream`, `ParameterParser`, `FileItem`,
`DiskFileItem`, and `DiskFileItemFactory` with corresponding roles.

`FileUpload.parseRequest()` parses ordered multipart parts, keeps small items
in a `Buffer`, spills larger items to a temporary file, and enforces request,
file, and item-count limits.

```bash
npm run build
npm test
```

The implementation uses Node `Buffer` and filesystem APIs instead of Java
streams and `File`, while retaining the observable contracts relevant to the
Java Commons FileUpload skeleton.
