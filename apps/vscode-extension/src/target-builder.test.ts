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

  it('builds a workspace-relative C# target from a saved editor selection', () => {
    const target = buildModuleTarget({
      languageId: 'csharp',
      selectedText: 'public async Task<Quote> GetQuoteAsync(QuoteRequest request)\n{\n}',
      filePath: '/workspace/Quotes/QuoteService.cs',
      fileBaseName: 'QuoteService.cs',
      workspaceRoot,
      startLine: 12,
    });
    expect(target).toMatchObject({
      name: 'GetQuoteAsync',
      kind: 'function',
      language: 'C#',
      line: 13,
      path: 'Quotes/QuoteService.cs',
    });
    expect(target?.id).toBe('workspace://Quotes/QuoteService.cs#L13');
  });

  it('rejects source languages outside the Java-to-C# MVP target boundary', () => {
    expect(
      buildModuleTarget({
        languageId: 'python',
        selectedText: 'def quote(): pass',
        filePath: '/workspace/services/quote.py',
        fileBaseName: 'quote.py',
        workspaceRoot,
        startLine: 4,
      }),
    ).toBeNull();
  });

  it('rejects an editor file outside the workspace root', () => {
    expect(
      buildModuleTarget({
        languageId: 'csharp',
        selectedText: 'public void Run() {}',
        filePath: '/other/Service.cs',
        fileBaseName: 'Service.cs',
        workspaceRoot,
        startLine: 0,
      }),
    ).toBeNull();
  });
});
