import { describe, expect, it } from 'vitest';
import {
  buildModuleTarget,
  kindFromSignature,
  languageFromLanguageId,
  symbolNameFromSignature,
} from './target-builder';

describe('languageFromLanguageId', () => {
  it('maps common language ids', () => {
    expect(languageFromLanguageId('csharp')).toBe('C#');
    expect(languageFromLanguageId('typescript')).toBe('TypeScript');
    expect(languageFromLanguageId('python')).toBe('Python');
    expect(languageFromLanguageId('JAVA')).toBe('Java');
  });

  it('rejects unsupported languages', () => {
    expect(languageFromLanguageId('ruby')).toBeNull();
    expect(languageFromLanguageId('plaintext')).toBeNull();
  });
});

describe('symbolNameFromSignature', () => {
  it('extracts declared names', () => {
    expect(symbolNameFromSignature('public sealed class AuditPipeline')).toBe('AuditPipeline');
    expect(symbolNameFromSignature('interface QuoteStore')).toBe('QuoteStore');
    expect(symbolNameFromSignature('def settle_batch(instructions):')).toBe('settle_batch');
    expect(symbolNameFromSignature('async function loadQuote() {')).toBe('loadQuote');
  });

  it('extracts names before parentheses', () => {
    expect(symbolNameFromSignature('public async Task<Quote> GetQuoteAsync(QuoteRequest request)')).toBe(
      'GetQuoteAsync',
    );
  });
});

describe('kindFromSignature', () => {
  it('detects class vs function', () => {
    expect(kindFromSignature('public sealed class AuditPipeline')).toBe('class');
    expect(kindFromSignature('func Load(ctx context.Context) error')).toBe('function');
  });
});

describe('buildModuleTarget', () => {
  const workspaceRoot = '/workspace';

  it('builds a workspace-relative Java target from a saved editor selection', () => {
    const target = buildModuleTarget({
      languageId: 'java',
      selectedText: 'public List<FileItem> parseRequest(RequestContext ctx) throws FileUploadException {',
      filePath: '/workspace/src/FileUploadBase.java',
      fileBaseName: 'FileUploadBase.java',
      workspaceRoot,
      startLine: 12,
    });
    expect(target).toMatchObject({
      name: 'parseRequest',
      kind: 'function',
      language: 'Java',
      line: 13,
      path: 'src/FileUploadBase.java',
    });
    expect(target?.id).toBe('workspace://src/FileUploadBase.java#L13');
  });

  it('builds a target for every mapped editor language', () => {
    const target = buildModuleTarget({
      languageId: 'python',
      selectedText: 'def quote():\n    return None',
      filePath: '/workspace/services/quote.py',
      fileBaseName: 'quote.py',
      workspaceRoot,
      startLine: 4,
    });

    expect(target).toMatchObject({
      name: 'quote',
      language: 'Python',
      path: 'services/quote.py',
      line: 5,
    });
  });

  it('rejects an editor file outside the workspace root', () => {
    expect(
      buildModuleTarget({
        languageId: 'java',
        selectedText: 'public void run() {}',
        filePath: '/other/Service.java',
        fileBaseName: 'Service.java',
        workspaceRoot,
        startLine: 0,
      }),
    ).toBeNull();
  });
});
