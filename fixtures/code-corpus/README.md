# Code Corpus

Each direct child with a `manifest.json` is an independently indexable source
repository. The corpus includes four Commons FileUpload-related references for
the Java target workspace:

- `commons-fileupload-csharp` is a C# implementation with corresponding class
  responsibilities and API contracts.
- `commons-fileupload-python` is a Python implementation of the same core
  upload contracts, including boundary parsing, limits, and threshold spilling.
- `commons-fileupload-ts` is a TypeScript/Node implementation of the same
  core upload contracts using Buffers and temporary files.
- `multipart-vault-py` is a Python project with similar multipart parsing and
  threshold-spill behavior but a different object model.

All repositories are discovered automatically by the code indexer.
