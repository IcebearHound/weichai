import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DiskFileItem,
  DiskFileItemFactory,
  FileCountLimitExceededException,
  FileUpload,
  InMemoryRequestContext,
  MultipartStream,
  ParameterParser,
  SizeLimitExceededException,
} from '../src/index.js';

const boundary = 'UploadBoundary';

function multipartBody(): Buffer {
  return Buffer.from(
    `--${boundary}\r\n`
      + 'Content-Disposition: form-data; name="title"\r\n\r\n'
      + 'report\r\n'
      + `--${boundary}\r\n`
      + 'Content-Disposition: form-data; name="attachment"; filename="note.txt"\r\n'
      + 'Content-Type: text/plain; charset=utf-8\r\n\r\n'
      + 'hello world\r\n'
      + `--${boundary}--\r\n`,
    'utf8',
  );
}

test('ParameterParser preserves quoted values and lower-cases names', () => {
  const parser = new ParameterParser();
  parser.setLowerCaseNames(true);
  assert.deepEqual(
    Object.fromEntries(parser.parse('form-data; NAME="file"; filename="a;b.txt"')),
    { 'form-data': undefined, name: 'file', filename: 'a;b.txt' },
  );
});

test('MultipartStream returns ordered headers and bodies', () => {
  const stream = new MultipartStream(multipartBody(), Buffer.from(boundary));
  assert.equal(stream.skipPreamble(), true);
  const parts = stream.readParts();
  assert.equal(parts.length, 2);
  assert.match(parts[0]!.rawHeaders, /name="title"/);
  assert.deepEqual(parts[0]!.body, Buffer.from('report'));
  assert.deepEqual(parts[1]!.body, Buffer.from('hello world'));
});

test('FileUpload materializes fields and spills larger files', () => {
  const repository = mkdtempSync(join(tmpdir(), 'commons-fileupload-ts-'));
  const upload = new FileUpload(new DiskFileItemFactory(8, repository));
  const items = upload.parseRequest(new InMemoryRequestContext(`multipart/form-data; boundary=${boundary}`, multipartBody()));

  assert.deepEqual(items.map((item) => item.getFieldName()), ['title', 'attachment']);
  assert.equal(items[0]!.isFormField(), true);
  assert.equal(items[0]!.getString(), 'report');
  assert.equal(items[1]!.isInMemory(), false);
  assert.equal(items[1]!.getName(), 'note.txt');
  assert.equal(items[1]!.getString(), 'hello world');
  const attachment = items[1]!;
  assert.ok(attachment instanceof DiskFileItem);
  assert.ok(attachment.getStoreLocation());
  attachment.delete();
});

test('FileUpload enforces request and item-count limits', () => {
  const context = new InMemoryRequestContext(`multipart/form-data; boundary=${boundary}`, multipartBody());
  const upload = new FileUpload(new DiskFileItemFactory());
  upload.sizeMax = 4;
  assert.throws(() => upload.parseRequest(context), SizeLimitExceededException);

  upload.sizeMax = -1;
  upload.fileCountMax = 1;
  assert.throws(() => upload.parseRequest(context), FileCountLimitExceededException);
});
