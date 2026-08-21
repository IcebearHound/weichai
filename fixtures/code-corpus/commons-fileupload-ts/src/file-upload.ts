/** 在 TypeScript 里该类型基于 Commons FileUpload 1.5 行为构建的 multipart 核心类型。 */

import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** RFC 2047 头文本在参数解析和 MIME 兼容层之间共用此解码器。 */
export function decodeMimeHeader(value: string, strict = false): string {
  if (!value.includes('=?')) return value;
  const compact = value.replace(/\?=\s+=\?/g, '?==?');
  return compact.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (encoded, charset: string, encoding: string, payload: string) => {
    try {
      const bytes = encoding.toUpperCase() === 'B'
        ? Buffer.from(payload, 'base64')
        : Buffer.from(payload.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), 'latin1');
      const normalized = charset.toLowerCase().replace(/[_ ]/g, '-');
      if (normalized === 'utf-8' || normalized === 'utf8') return bytes.toString('utf8');
      if (normalized === 'iso-8859-1' || normalized === 'latin1') return bytes.toString('latin1');
      return new TextDecoder(charset).decode(bytes);
    } catch (error) {
      if (strict) throw error;
      return encoded;
    }
  });
}

/** 上传工作流的解析或存储失败由这个基础错误表示。 */
export class FileUploadException extends Error {}
/** 缺少可解析的 boundary 参数会导致这个错误。 */
export class InvalidContentTypeException extends FileUploadException {}
/** 带有 NUL 等非法字符的文件名会在这里被拦下。 */
export class InvalidFileNameException extends Error {}

/** 该错误额外携带观测到的大小与配置阈值。 */
export class SizeException extends FileUploadException {
  constructor(message: string, readonly actualSize: number, readonly permittedSize: number) {
    super(message);
  }
}

/** 请求整体超过限制时会返回这一大小错误。 */
export class SizeLimitExceededException extends SizeException {}
/** 单个分段太大时用此错误中断处理。 */
export class FileSizeLimitExceededException extends SizeException {}

/** 达到附件数量上限时会抛出这一限制错误。 */
export class FileCountLimitExceededException extends FileUploadException {
  constructor(message: string, readonly limit: number) {
    super(message);
  }
}

/** 边界或分段格式损坏时，该错误会终止读取。 */
export class MalformedStreamException extends FileUploadException {}
/** 读取期间禁止改变 boundary 的长度。 */
export class IllegalBoundaryException extends Error {}

/** 上传解析器通过它读取请求元数据与原始 Buffer。 */
export interface RequestContext {
  getContentType(): string | undefined;
  getContentLength(): number;
  getInputStream(): Buffer;
  getCharacterEncoding(): string | undefined;
}

/** 它用 Buffer 构造一个无需网络层的请求替身。 */
export class InMemoryRequestContext implements RequestContext {
  constructor(
    private readonly contentType: string | undefined,
    private readonly body: Buffer,
    private readonly characterEncoding?: string,
  ) {}

  getContentType(): string | undefined { return this.contentType; }
  getContentLength(): number { return this.body.length; }
  getInputStream(): Buffer { return Buffer.from(this.body); }
  getCharacterEncoding(): string | undefined { return this.characterEncoding; }
}

/** Header 容器规范化键名，同时保存同名字段的全部取值。 */
export class FileItemHeaders {
  private readonly values = new Map<string, string[]>();

  addHeader(name: string, value: string): void {
    const normalized = name.toLowerCase();
    const values = this.values.get(normalized) ?? [];
    values.push(value);
    this.values.set(normalized, values);
  }

  getHeader(name: string): string | undefined {
    return this.values.get(name.toLowerCase())?.[0];
  }

  getHeaders(name: string): readonly string[] {
    return [...(this.values.get(name.toLowerCase()) ?? [])];
  }

  getHeaderNames(): readonly string[] {
    return [...this.values.keys()];
  }
}

/** 它读取媒体头参数，不会把引号里的分号误当作分隔符。 */
export class ParameterParser {
  private lowerCaseNames = false;

  setLowerCaseNames(value: boolean): void { this.lowerCaseNames = value; }

  parse(value: string | undefined, separator: string | readonly string[] = ';'): Map<string, string | undefined> {
    const parsed = new Map<string, string | undefined>();
    if (value === undefined) return parsed;
    const separators = typeof separator === 'string' ? [separator] : [...separator];
    if (separators.length === 0) return parsed;
    const selected = separators.reduce((earliest, item) => {
      const found = value.indexOf(item);
      const earliestFound = value.indexOf(earliest);
      return found >= 0 && (earliestFound < 0 || found < earliestFound) ? item : earliest;
    }, separators[0]!);

    for (const fragment of ParameterParser.split(value, selected)) {
      const equals = fragment.indexOf('=');
      const rawName = (equals < 0 ? fragment : fragment.slice(0, equals)).trim();
      if (!rawName) continue;
      const name = this.lowerCaseNames ? rawName.toLowerCase() : rawName;
      const rawValue = equals < 0 ? undefined : fragment.slice(equals + 1).trim();
      parsed.set(name, ParameterParser.unquote(rawValue));
    }
    return parsed;
  }

  private static split(value: string, separator: string): string[] {
    const parts: string[] = [];
    let current = '';
    let quoted = false;
    let escaped = false;
    for (const character of value) {
      if (character === '"' && !escaped) quoted = !quoted;
      if (character === separator && !quoted) {
        parts.push(current.trim());
        current = '';
      } else {
        current += character;
      }
      escaped = character === '\\' && !escaped;
    }
    parts.push(current.trim());
    return parts;
  }

  private static unquote(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const unquoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"')
      ? value.slice(1, -1)
      : value;
    return unquoted ? decodeMimeHeader(unquoted) : undefined;
  }
}

/** 该类型承载单段的原始头行和正文 Buffer。 */
export interface MultipartPart {
  rawHeaders: string;
  body: Buffer;
}

/** 它围绕 boundary 扫描 Buffer，并按出现顺序给出各个分段。 */
export class MultipartStream {
  private boundary: Buffer;
  private parts: MultipartPart[] | undefined;
  private partIndex = 0;

  constructor(private readonly data: Buffer, boundary: Buffer) {
    if (boundary.length === 0) throw new Error('Multipart boundary must not be empty.');
    this.boundary = Buffer.from(boundary);
  }

  setBoundary(boundary: Buffer): void {
    if (boundary.length !== this.boundary.length) {
      throw new IllegalBoundaryException('The length of a boundary token cannot change within a multipart stream.');
    }
    this.boundary = Buffer.from(boundary);
    this.parts = undefined;
    this.partIndex = 0;
  }

  skipPreamble(): boolean { return this.readParts().length > 0; }
  readBoundary(): boolean { return this.partIndex < this.readParts().length; }

  readHeaders(): string {
    const part = this.readParts()[this.partIndex];
    if (!part) throw new MalformedStreamException('No multipart item is available.');
    return part.rawHeaders;
  }

  readBodyData(): Buffer {
    const part = this.readParts()[this.partIndex++];
    if (!part) throw new MalformedStreamException('No multipart item is available.');
    return Buffer.from(part.body);
  }

  discardBodyData(): number { return this.readBodyData().length; }

  readParts(): MultipartPart[] {
    this.parts ??= MultipartStream.parseParts(this.data, this.boundary);
    return this.parts;
  }

  private static parseParts(source: Buffer, boundary: Buffer): MultipartPart[] {
    const marker = Buffer.concat([Buffer.from('--'), boundary]);
    let cursor = source.indexOf(marker);
    if (cursor < 0) return [];
    cursor += marker.length;
    if (source.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) return [];
    cursor = MultipartStream.consumeLineBreak(source, cursor);
    const crlfDelimiter = Buffer.concat([Buffer.from('\r\n'), marker]);
    const lfDelimiter = Buffer.concat([Buffer.from('\n'), marker]);
    const parts: MultipartPart[] = [];

    while (cursor < source.length) {
      const headers = MultipartStream.headerEnd(source, cursor);
      if (!headers) throw new MalformedStreamException('Multipart headers were not terminated by an empty line.');
      const bodyStart = headers.index + headers.length;
      let boundaryAt = source.indexOf(crlfDelimiter, bodyStart);
      let delimiter = crlfDelimiter;
      if (boundaryAt < 0) {
        boundaryAt = source.indexOf(lfDelimiter, bodyStart);
        delimiter = lfDelimiter;
      }
      if (boundaryAt < 0) throw new MalformedStreamException('Multipart body ended before its terminating boundary.');
      parts.push({
        rawHeaders: source.subarray(cursor, headers.index).toString('latin1'),
        body: Buffer.from(source.subarray(bodyStart, boundaryAt)),
      });
      cursor = boundaryAt + delimiter.length;
      if (source.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) return parts;
      cursor = MultipartStream.consumeLineBreak(source, cursor);
    }
    return parts;
  }

  private static headerEnd(source: Buffer, cursor: number): { index: number; length: number } | undefined {
    const crlf = source.indexOf(Buffer.from('\r\n\r\n'), cursor);
    const lf = source.indexOf(Buffer.from('\n\n'), cursor);
    if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { index: crlf, length: 4 };
    return lf >= 0 ? { index: lf, length: 2 } : undefined;
  }

  private static consumeLineBreak(source: Buffer, cursor: number): number {
    if (source.subarray(cursor, cursor + 2).equals(Buffer.from('\r\n'))) return cursor + 2;
    if (source.subarray(cursor, cursor + 1).equals(Buffer.from('\n'))) return cursor + 1;
    throw new MalformedStreamException('Multipart boundary must be followed by a line break.');
  }
}

/** 这个类型定义上传字段暴露给调用方的内容和元数据 API。 */
export interface FileItem {
  getInputStream(): Buffer;
  getContentType(): string | undefined;
  getName(): string | undefined;
  isInMemory(): boolean;
  getSize(): number;
  get(): Buffer;
  getString(encoding?: BufferEncoding): string;
  write(destination: string): void;
  delete(): void;
  getFieldName(): string | undefined;
  setFieldName(name: string | undefined): void;
  isFormField(): boolean;
  setFormField(value: boolean): void;
  setHeaders(headers: FileItemHeaders): void;
}

/** 条目会先缓存较小正文，超过门限后再迁移到私有临时文件。 */
export class DiskFileItem implements FileItem {
  static readonly DEFAULT_CHARSET: BufferEncoding = 'latin1';
  private memory: Buffer | undefined = Buffer.alloc(0);
  private temporaryPath: string | undefined;
  private headers: FileItemHeaders | undefined;
  private defaultCharset: BufferEncoding = DiskFileItem.DEFAULT_CHARSET;
  private movedSize: number | undefined;

  constructor(
    private fieldName: string | undefined,
    private readonly contentType: string | undefined,
    private formField: boolean,
    private readonly fileName: string | undefined,
    private readonly sizeThreshold: number,
    private readonly repository = tmpdir(),
  ) {}

  getInputStream(): Buffer { return this.get(); }
  getContentType(): string | undefined { return this.contentType; }

  getCharSet(): string | undefined {
    const parser = new ParameterParser();
    parser.setLowerCaseNames(true);
    return parser.parse(this.contentType).get('charset');
  }

  getName(): string | undefined {
    if (this.fileName?.includes('\0')) throw new InvalidFileNameException(`Invalid file name: ${this.fileName}`);
    return this.fileName;
  }

  isInMemory(): boolean { return this.memory !== undefined; }
  getSize(): number { return this.movedSize ?? (this.memory?.length ?? (this.temporaryPath ? statSync(this.temporaryPath).size : 0)); }
  get(): Buffer { return this.memory ? Buffer.from(this.memory) : this.temporaryPath ? readFileSync(this.temporaryPath) : Buffer.alloc(0); }
  getString(encoding: BufferEncoding = (this.getCharSet() as BufferEncoding | undefined) ?? this.defaultCharset): string { return this.get().toString(encoding); }

  write(destination: string): void {
    if (this.memory) {
      writeFileSync(destination, this.memory);
      return;
    }
    if (!this.temporaryPath) {
      writeFileSync(destination, Buffer.alloc(0));
      return;
    }
    this.movedSize = statSync(this.temporaryPath).size;
    renameSync(this.temporaryPath, destination);
    this.temporaryPath = undefined;
  }

  delete(): void {
    this.memory = undefined;
    if (this.temporaryPath) rmSync(this.temporaryPath, { force: true });
    this.temporaryPath = undefined;
  }

  getFieldName(): string | undefined { return this.fieldName; }
  setFieldName(name: string | undefined): void { this.fieldName = name; }
  isFormField(): boolean { return this.formField; }
  setFormField(value: boolean): void { this.formField = value; }
  getHeaders(): FileItemHeaders | undefined { return this.headers; }
  setHeaders(headers: FileItemHeaders): void { this.headers = headers; }
  getStoreLocation(): string | undefined { return this.temporaryPath; }
  setDefaultCharset(charset: BufferEncoding): void { this.defaultCharset = charset; }

  store(body: Buffer): void {
    this.delete();
    if (body.length <= this.sizeThreshold) {
      this.memory = Buffer.from(body);
      return;
    }
    const directory = mkdtempSync(join(this.repository, 'fileupload-'));
    this.temporaryPath = join(directory, 'upload.tmp');
    writeFileSync(this.temporaryPath, body);
  }
}

/** 该接口约定如何根据表单描述创建一个上传对象。 */
export interface FileItemFactory {
  createItem(fieldName: string | undefined, contentType: string | undefined, isFormField: boolean, fileName: string | undefined): FileItem;
}

/** 构造器复用门限、目录和字符集选项来生成磁盘条目。 */
export class DiskFileItemFactory implements FileItemFactory {
  static readonly DEFAULT_SIZE_THRESHOLD = 10240;
  private defaultCharset: BufferEncoding = DiskFileItem.DEFAULT_CHARSET;

  constructor(private sizeThreshold = DiskFileItemFactory.DEFAULT_SIZE_THRESHOLD, private repository?: string) {}

  createItem(fieldName: string | undefined, contentType: string | undefined, isFormField: boolean, fileName: string | undefined): DiskFileItem {
    const item = new DiskFileItem(fieldName, contentType, isFormField, fileName, this.sizeThreshold, this.repository ?? tmpdir());
    item.setDefaultCharset(this.defaultCharset);
    return item;
  }

  getSizeThreshold(): number { return this.sizeThreshold; }
  setSizeThreshold(value: number): void { this.sizeThreshold = value; }
  getRepository(): string | undefined { return this.repository; }
  setRepository(repository: string | undefined): void { this.repository = repository; }
  getDefaultCharset(): BufferEncoding { return this.defaultCharset; }
  setDefaultCharset(charset: BufferEncoding): void { this.defaultCharset = charset; }
}

/** 该基类把大小检查、边界读取、头字段解析和对象构造连成一次流程。 */
export abstract class FileUploadBase {
  static readonly MULTIPART = 'multipart/';
  static readonly MULTIPART_FORM_DATA = 'multipart/form-data';
  static readonly MULTIPART_MIXED = 'multipart/mixed';
  static readonly CONTENT_TYPE = 'content-type';
  static readonly CONTENT_DISPOSITION = 'content-disposition';
  sizeMax = -1;
  fileSizeMax = -1;
  fileCountMax = -1;
  headerEncoding: string | undefined;
  progressListener: ((bytesRead: number, contentLength: number, items: number) => void) | undefined;

  static isMultipartContent(context: RequestContext | undefined): boolean {
    return (context?.getContentType() ?? '').toLowerCase().startsWith(FileUploadBase.MULTIPART);
  }

  abstract getFileItemFactory(): FileItemFactory | undefined;
  abstract setFileItemFactory(factory: FileItemFactory): void;

  parseRequest(context: RequestContext): FileItem[] {
    const requestSize = context.getContentLength();
    if (this.sizeMax >= 0 && requestSize >= 0 && requestSize > this.sizeMax) {
      throw new SizeLimitExceededException('Request exceeds configured maximum size.', requestSize, this.sizeMax);
    }
    const factory = this.getFileItemFactory();
    if (!factory) throw new FileUploadException('No FileItemFactory has been set.');
    const boundary = FileUploadBase.getBoundary(context.getContentType());
    if (!boundary) throw new InvalidContentTypeException('No multipart boundary was found.');

    const items: FileItem[] = [];
    try {
      const addItem = (fieldName: string, headers: FileItemHeaders, body: Buffer, fileName: string | undefined): void => {
        if (this.fileCountMax >= 0 && items.length >= this.fileCountMax) {
          throw new FileCountLimitExceededException('Attachment count exceeds configured maximum.', this.fileCountMax);
        }
        if (this.fileSizeMax >= 0 && body.length > this.fileSizeMax) {
          throw new FileSizeLimitExceededException(`The field ${fieldName} exceeds its maximum permitted size.`, body.length, this.fileSizeMax);
        }
        const item = factory.createItem(fieldName, headers.getHeader(FileUploadBase.CONTENT_TYPE), fileName === undefined, fileName);
        if (item instanceof DiskFileItem) item.store(body);
        else throw new FileUploadException('This reference requires a writable DiskFileItemFactory.');
        item.setHeaders(headers);
        items.push(item);
        this.progressListener?.(body.length, requestSize, items.length);
      };

      for (const part of new MultipartStream(context.getInputStream(), boundary).readParts()) {
        const headers = FileUploadBase.getParsedHeaders(part.rawHeaders);
        const disposition = FileUploadBase.parseDisposition(headers.getHeader(FileUploadBase.CONTENT_DISPOSITION));
        const fieldName = disposition.get('name');
        if (!fieldName) continue;
        const contentType = headers.getHeader(FileUploadBase.CONTENT_TYPE) ?? '';
        const nestedBoundary = contentType.toLowerCase().startsWith(FileUploadBase.MULTIPART_MIXED)
          ? FileUploadBase.getBoundary(contentType)
          : undefined;
        if (nestedBoundary) {
          for (const nestedPart of new MultipartStream(part.body, nestedBoundary).readParts()) {
            const nestedHeaders = FileUploadBase.getParsedHeaders(nestedPart.rawHeaders);
            const nestedDisposition = FileUploadBase.parseDisposition(nestedHeaders.getHeader(FileUploadBase.CONTENT_DISPOSITION));
            const nestedFileName = nestedDisposition.get('filename');
            if (nestedFileName !== undefined) addItem(fieldName, nestedHeaders, nestedPart.body, nestedFileName);
          }
          continue;
        }
        addItem(fieldName, headers, part.body, disposition.get('filename'));
      }
      return items;
    } catch (error) {
      for (const item of items) item.delete();
      throw error;
    }
  }

  parseParameterMap(context: RequestContext): Map<string, FileItem[]> {
    const result = new Map<string, FileItem[]>();
    for (const item of this.parseRequest(context)) {
      const name = item.getFieldName() ?? '';
      result.set(name, [...(result.get(name) ?? []), item]);
    }
    return result;
  }

  getItemIterator(context: RequestContext): MaterializedFileItemIterator {
    return new MaterializedFileItemIterator(this.parseRequest(context));
  }

  static getBoundary(contentType: string | undefined): Buffer | undefined {
    const parser = new ParameterParser();
    parser.setLowerCaseNames(true);
    const boundary = parser.parse(contentType, [';', ',']).get('boundary');
    return boundary ? Buffer.from(boundary, 'ascii') : undefined;
  }

  static getParsedHeaders(rawHeaders: string): FileItemHeaders {
    const headers = new FileItemHeaders();
    let name: string | undefined;
    let values: string[] = [];
    const commit = (): void => { if (name) headers.addHeader(name, values.join(' ').trim()); };
    for (const line of rawHeaders.replaceAll('\r\n', '\n').split('\n')) {
      if (/^[ \t]/.test(line) && name) {
        values.push(line.trim());
        continue;
      }
      commit();
      const separator = line.indexOf(':');
      name = separator > 0 ? line.slice(0, separator).trim() : undefined;
      values = name ? [line.slice(separator + 1).trim()] : [];
    }
    commit();
    return headers;
  }

  private static parseDisposition(value: string | undefined): Map<string, string | undefined> {
    const parser = new ParameterParser();
    parser.setLowerCaseNames(true);
    return parser.parse(value);
  }
}

/** 它把已经物化的 FileItem 映射成流式条目视图。 */
export class MaterializedFileItemStream {
  constructor(private readonly item: FileItem) {}
  openStream(): Buffer { return this.item.getInputStream(); }
  getContentType(): string | undefined { return this.item.getContentType(); }
  getFieldName(): string | undefined { return this.item.getFieldName(); }
  getName(): string | undefined { return this.item.getName(); }
  isFormField(): boolean { return this.item.isFormField(); }
  getHeaders(): FileItemHeaders | undefined {
    return this.item instanceof DiskFileItem ? this.item.getHeaders() : undefined;
  }
  setHeaders(headers: FileItemHeaders): void { this.item.setHeaders(headers); }
}

/** 这个适配器实现单向 hasNext/next 迭代并在耗尽时报告错误。 */
export class MaterializedFileItemIterator {
  private readonly items: Iterator<FileItem>;
  private nextItem: FileItem | undefined;
  private checked = false;

  constructor(items: Iterable<FileItem>) { this.items = items[Symbol.iterator](); }

  hasNext(): boolean {
    if (this.checked) return this.nextItem !== undefined;
    this.checked = true;
    this.nextItem = this.items.next().value as FileItem | undefined;
    return this.nextItem !== undefined;
  }

  next(): MaterializedFileItemStream {
    if (!this.hasNext()) throw new FileUploadException('No more file items are available.');
    const item = this.nextItem!;
    this.nextItem = undefined;
    this.checked = false;
    return new MaterializedFileItemStream(item);
  }
}

/** 此入口串起请求分段和工厂化上传条目构建。 */
export class FileUpload extends FileUploadBase {
  constructor(private fileItemFactory?: FileItemFactory) { super(); }
  getFileItemFactory(): FileItemFactory | undefined { return this.fileItemFactory; }
  setFileItemFactory(factory: FileItemFactory): void { this.fileItemFactory = factory; }
}
