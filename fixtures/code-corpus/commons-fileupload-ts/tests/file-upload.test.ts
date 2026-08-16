import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DiskFileItem,
  DiskFileItemFactory,
  FileCountLimitExceededException,
  FileSizeLimitExceededException,
  FileUpload,
  FileUploadException,
  InMemoryRequestContext,
  InvalidContentTypeException,
  MalformedStreamException,
  MimeUtility,
  Base64Decoder,
  MultipartStream,
  ParameterParser,
  QuotedPrintableDecoder,
  SizeLimitExceededException,
} from '../src/index.js';

const boundary = 'UploadBoundary';
const encodedFilename = '=?ISO-8859-1?B?SWYgeW91IGNhbiByZWFkIHRoaXMgeW8=?= =?ISO-8859-2?B?dSB1bmRlcnN0YW5kIHRoZSBleGFtcGxlLg==?=';

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

function mixedMultipartBody(): Buffer {
  return Buffer.from(
    '--AaB03x\r\n'
      + 'content-disposition: form-data; name="field1"\r\n\r\n'
      + 'Joe Blow\r\n'
      + '--AaB03x\r\n'
      + 'content-disposition: form-data; name="pics"\r\n'
      + 'Content-type: multipart/mixed; boundary=BbC04y\r\n\r\n'
      + '--BbC04y\r\n'
      + 'Content-disposition: attachment; filename="file1.txt"\r\n'
      + 'Content-Type: text/plain\r\n\r\n'
      + '... contents of file1.txt ...\r\n'
      + '--BbC04y\r\n'
      + 'Content-disposition: attachment; filename="file2.gif"\r\n'
      + 'Content-type: image/gif\r\n'
      + 'Content-Transfer-Encoding: binary\r\n\r\n'
      + '...contents of file2.gif...\r\n'
      + '--BbC04y--\r\n'
      + '--AaB03x--',
    'ascii',
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

test('ParameterParser matches Apache escaped, separator, and RFC 2047 cases', () => {
  const parser = new ParameterParser();
  assert.equal(parser.parse('param = "stuff\\"; more stuff"').get('param'), 'stuff\\"; more stuff');
  assert.equal(parser.parse('Content-type: multipart/mixed, boundary=BbC04y', [',', ';']).get('boundary'), 'BbC04y');
  assert.equal(parser.parse(`form-data; filename="${encodedFilename}"`).get('filename'), 'If you can read this you understand the example.');
  assert.equal(MimeUtility.decodeText('=?UTF-8?Q?_h=C3=A9!_=C3=A0=C3=A8=C3=B4u_!!!?='), ' hé! àèôu !!!');
});

test('MIME decoders match Apache vectors', () => {
  assert.deepEqual(Base64Decoder.decode('S?G!V%sbG 8g\rV\t\n29ybGQ*='), Buffer.from('Hello World'));
  assert.deepEqual(Base64Decoder.decode('SGVsbG8gV29ybGQ=SGVsbG8gV29ybGQ='), Buffer.from('Hello WorldHello World'));
  assert.deepEqual(QuotedPrintableDecoder.decode('=3D Hello there =3D=0D=0A'), Buffer.from('= Hello there =\r\n'));
  assert.deepEqual(QuotedPrintableDecoder.decode('abc=\r\ndef'), Buffer.from('abcdef'));
  assert.throws(() => Base64Decoder.decode('n'));
  assert.throws(() => QuotedPrintableDecoder.decode('=XD'));
  assert.throws(() => MimeUtility.decodeText('=?invalid?B?xyz-?='));
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

test('FileUpload unfolds headers and reports progress', () => {
  const body = Buffer.from(
    `--${boundary}\r\n`
      + 'Content-Disposition: form-data;\r\n'
      + ' name="note"\r\n'
      + 'X-Trace: first\r\n'
      + 'X-Trace: second\r\n\r\n'
      + 'value\r\n'
      + `--${boundary}--\r\n`,
    'ascii',
  );
  const events: [number, number, number][] = [];
  const upload = new FileUpload(new DiskFileItemFactory());
  upload.progressListener = (read, total, count) => events.push([read, total, count]);
  const items = upload.parseRequest(new InMemoryRequestContext(`multipart/form-data; boundary=${boundary}`, body));

  assert.equal(items[0]!.getFieldName(), 'note');
  assert.ok(items[0] instanceof DiskFileItem);
  assert.deepEqual(items[0].getHeaders()!.getHeaders('x-trace'), ['first', 'second']);
  assert.deepEqual(events, [[5, body.length, 1]]);
});

test('FileUpload flattens nested multipart/mixed like FILEUPLOAD-62', () => {
  const upload = new FileUpload(new DiskFileItemFactory());
  const items = upload.parseRequest(new InMemoryRequestContext('multipart/form-data; boundary=AaB03x', mixedMultipartBody()));

  assert.deepEqual(items.map((item) => item.getFieldName()), ['field1', 'pics', 'pics']);
  assert.deepEqual(items.map((item) => item.getName()), [undefined, 'file1.txt', 'file2.gif']);
  assert.deepEqual(items.map((item) => item.getString()), ['Joe Blow', '... contents of file1.txt ...', '...contents of file2.gif...']);
});

test('FileUpload item iterator preserves order and rejects exhaustion', () => {
  const upload = new FileUpload(new DiskFileItemFactory());
  const iterator = upload.getItemIterator(new InMemoryRequestContext(`multipart/form-data; boundary=${boundary}`, multipartBody()));
  assert.equal(iterator.hasNext(), true);
  assert.equal(iterator.hasNext(), true);
  const first = iterator.next();
  assert.equal(first.getFieldName(), 'title');
  assert.deepEqual(first.openStream(), Buffer.from('report'));
  assert.equal(iterator.hasNext(), true);
  assert.equal(iterator.next().getName(), 'note.txt');
  assert.equal(iterator.hasNext(), false);
  assert.throws(() => iterator.next(), FileUploadException);
});

test('FileUpload preserves variable-sized binary parts', () => {
  const sizes = [0, 1, 15, 16, 31, 1024];
  const chunks: Buffer[] = [];
  sizes.forEach((size, index) => {
    chunks.push(Buffer.from(`--sizes\r\nContent-Disposition: form-data; name="field${index}"\r\n\r\n`, 'ascii'));
    chunks.push(Buffer.alloc(size, index % 251));
    chunks.push(Buffer.from('\r\n', 'ascii'));
  });
  chunks.push(Buffer.from('--sizes--\r\n', 'ascii'));
  const items = new FileUpload(new DiskFileItemFactory()).parseRequest(
    new InMemoryRequestContext('multipart/form-data; boundary=sizes', Buffer.concat(chunks)),
  );
  assert.deepEqual(items.map((item) => item.getSize()), sizes);
  assert.deepEqual(items.map((item) => item.get()), sizes.map((size, index) => Buffer.alloc(size, index % 251)));
});

test('FileUpload enforces request and item-count limits', () => {
  const context = new InMemoryRequestContext(`multipart/form-data; boundary=${boundary}`, multipartBody());
  const upload = new FileUpload(new DiskFileItemFactory());
  upload.sizeMax = 4;
  assert.throws(() => upload.parseRequest(context), SizeLimitExceededException);

  upload.sizeMax = -1;
  upload.fileCountMax = 1;
  assert.throws(() => upload.parseRequest(context), FileCountLimitExceededException);

  upload.fileCountMax = -1;
  upload.fileSizeMax = 5;
  assert.throws(() => upload.parseRequest(context), FileSizeLimitExceededException);
});

test('FileUpload rejects missing boundaries and truncated streams', () => {
  const upload = new FileUpload(new DiskFileItemFactory());
  assert.throws(() => upload.parseRequest(new InMemoryRequestContext('multipart/form-data', Buffer.from('unused'))), InvalidContentTypeException);
  assert.throws(
    () => upload.parseRequest(new InMemoryRequestContext('multipart/form-data; boundary=b', Buffer.from('--b\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue', 'ascii'))),
    MalformedStreamException,
  );
});
