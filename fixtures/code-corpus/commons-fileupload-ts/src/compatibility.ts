import {
  DiskFileItem,
  DiskFileItemFactory,
  FileItem,
  FileItemHeaders,
  FileUpload,
  InMemoryRequestContext,
  InvalidFileNameException,
  SizeLimitExceededException,
  RequestContext,
  decodeMimeHeader,
} from './file-upload.js';

/** 该接口表明条目支持挂接和读取关联的头集合。 */
export interface FileItemHeadersSupport {
  getHeaders(): FileItemHeaders | undefined;
  setHeaders(headers: FileItemHeaders): void;
}

/** 此上下文专门补充不会截断的内容长度访问。 */
export interface UploadContext extends RequestContext {
  contentLength(): number;
}

/** 进度订阅者通过此接口获得传输统计。 */
export interface ProgressListener {
  update(bytesRead: number, contentLength: number, items: number): void;
}

/** 它为单个分段提供延迟读取的内容视图。 */
export interface FileItemStream extends FileItemHeadersSupport {
  openStream(): Buffer;
  getContentType(): string | undefined;
  getFieldName(): string | undefined;
  getName(): string | undefined;
  isFormField(): boolean;
}

/** 调用方可借此按请求顺序拉取下一份上传内容。 */
export interface FileItemIterator {
  hasNext(): boolean;
  next(): FileItemStream;
}

/** 旧版调用可以继续借由这个 DiskFileItem 外观工作。 */
export class DefaultFileItem extends DiskFileItem {}

/** 为兼容旧代码，这个工厂仍暴露传统的条目创建入口。 */
export class DefaultFileItemFactory extends DiskFileItemFactory {
  override createItem(fieldName: string | undefined, contentType: string | undefined, isFormField: boolean, fileName: string | undefined): DefaultFileItem {
    const item = new DefaultFileItem(fieldName, contentType, isFormField, fileName, this.getSizeThreshold(), this.getRepository());
    item.setDefaultCharset(this.getDefaultCharset());
    return item;
  }
}

/** 该门面保留了早期磁盘上传配置的调用形状。 */
export class DiskFileUpload extends FileUpload {
  constructor(factory: DefaultFileItemFactory = new DefaultFileItemFactory()) { super(factory); }
  getSizeThreshold(): number { return (this.getFileItemFactory() as DefaultFileItemFactory).getSizeThreshold(); }
  setSizeThreshold(value: number): void { (this.getFileItemFactory() as DefaultFileItemFactory).setSizeThreshold(value); }
}

/** 内部 Map 忽略键名大小写并保存重复的 header。 */
export class FileItemHeadersImpl extends FileItemHeaders {}

/** Servlet 风格请求会由它投影为通用的输入上下文。 */
export class ServletRequestContext extends InMemoryRequestContext implements UploadContext {
  contentLength(): number { return this.getContentLength(); }
}

/** 这是 Node 侧模拟 Servlet 上传集成的高层入口。 */
export class ServletFileUpload extends FileUpload {}

/** Portlet 风格请求会由它映射为核心解析器的输入。 */
export class PortletRequestContext extends ServletRequestContext {}

/** 这是面向 Portlet 语义的 multipart 调用门面。 */
export class PortletFileUpload extends FileUpload {}

/** 生命周期结束时，该清理器会删除已登记的上传资源。 */
export class FileCleanerCleanup {
  private readonly tracked: FileItem[] = [];
  track(item: FileItem): void { this.tracked.push(item); }
  contextDestroyed(): void { for (const item of this.tracked) item.delete(); this.tracked.length = 0; }
}

/** 该协议让流包装器能反馈自己是否已关闭。 */
export interface Closeable { isClosed(): boolean; }

/** 该读取器累计已消费的内容，并对未知大小的超额输入报错。 */
export class LimitedInputStream implements Closeable {
  private offset = 0;
  private closed = false;
  constructor(private readonly source: Buffer, private readonly sizeMax: number) {}
  read(length = this.source.length - this.offset): Buffer {
    const value = this.source.subarray(this.offset, this.offset + length);
    this.offset += value.length;
    if (this.sizeMax >= 0 && this.offset > this.sizeMax) {
      throw new SizeLimitExceededException('stream exceeds configured maximum size', this.offset, this.sizeMax);
    }
    return Buffer.from(value);
  }
  getCount(): number { return this.offset; }
  close(): void { this.closed = true; }
  isClosed(): boolean { return this.closed; }
}

/** 流复制和名称安全检查被集中到这个工具类型。 */
export class Streams {
  static copy(input: Buffer, output?: { write(chunk: Buffer): unknown }): number { output?.write(input); return input.length; }
  static checkFileName(fileName: string | undefined): string | undefined {
    if (fileName?.includes('\0')) throw new InvalidFileNameException(`Invalid file name: ${fileName}`);
    return fileName;
  }
}

/** MIME Header 里的 Base64 片段由它转为字节。 */
export class Base64Decoder {
  static decode(value: string): Buffer {
    const output: Buffer[] = [];
    let quartet = '';
    for (const character of value) {
      if (!/[A-Za-z0-9+/=]/.test(character)) continue;
      quartet += character;
      if (quartet.length !== 4) continue;
      const padding = quartet.indexOf('=');
      if (padding >= 0 && (padding < 2 || /[^=]/.test(quartet.slice(padding)))) {
        throw new Error('incorrect Base64 padding');
      }
      output.push(Buffer.from(quartet, 'base64'));
      quartet = '';
    }
    if (quartet) throw new Error('truncated Base64 input');
    return Buffer.concat(output);
  }
}

/** 它负责把 Quoted-Printable 头值解回二进制内容。 */
export class QuotedPrintableDecoder {
  static decode(value: string): Buffer {
    const output: number[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] !== '=') {
        output.push(value.charCodeAt(index));
        continue;
      }
      if (index + 1 >= value.length) throw new Error('truncated quoted-printable escape');
      if (value[index + 1] === '\r') {
        if (value[index + 2] !== '\n') throw new Error('CR must be followed by LF');
        index += 2;
        continue;
      }
      if (index + 2 >= value.length || !/^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
        throw new Error('invalid quoted-printable escape');
      }
      output.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
    }
    return Buffer.from(output);
  }
}

/** 这里处理 RFC 2047 风格的编码邮件头。 */
export class MimeUtility { static decodeText(value: string): string { return decodeMimeHeader(value, true); } }

/** MIME 编码头无法解释时会抛出该异常。 */
export class ParseException extends Error {}
