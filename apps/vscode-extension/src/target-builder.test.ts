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
    expect(symbolNameFromSignature('Quote fetch(QuoteRequest request)')).toBe('fetch');
  });

  it('falls back to null for junk', () => {
    expect(symbolNameFromSignature('{')).toBeNull();
    expect(symbolNameFromSignature('')).toBeNull();
  });
});

describe('kindFromSignature', () => {
  it('detects class vs function', () => {
    expect(kindFromSignature('public sealed class AuditPipeline')).toBe('class');
    expect(kindFromSignature('func Load(ctx context.Context) error')).toBe('function');
  });
});

describe('buildModuleTarget', () => {
  it('builds a target from a selection', () => {
    const target = buildModuleTarget({
      languageId: 'csharp',
      selectedText: 'public async Task<Quote> GetQuoteAsync(QuoteRequest request)\n{\n}',
      filePath: '/workspace/Quotes/QuoteService.cs',
      fileBaseName: 'QuoteService.cs',
      startLine: 12,
    });
    expect(target).not.toBeNull();
    expect(target!.name).toBe('GetQuoteAsync');
    expect(target!.kind).toBe('function');
    expect(target!.language).toBe('C#');
    expect(target!.line).toBe(13);
    expect(target!.path).toBe('/workspace/Quotes/QuoteService.cs');
  });

  it('falls back to the file base name', () => {
    const target = buildModuleTarget({
      languageId: 'python',
      selectedText: '    value = cache.get(key)',
      filePath: '/workspace/services/quote.py',
      fileBaseName: 'quote.py',
      startLine: 4,
    });
    expect(target!.name).toBe('quote');
    expect(target!.kind).toBe('function');
  });

  it('returns null for unsupported languages', () => {
    expect(
      buildModuleTarget({
        languageId: 'ruby',
        selectedText: 'def x; end',
        filePath: '/workspace/x.rb',
        fileBaseName: 'x.rb',
        startLine: 0,
      }),
    ).toBeNull();
  });
});
