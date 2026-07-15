import type { ModuleNode, ModuleTarget } from '@forexplore/contracts';

export const moduleTree: ModuleNode = {
  id: 'root',
  name: 'currency-platform',
  kind: 'workspace',
  path: '',
  children: [
    {
      id: 'services',
      name: 'services',
      kind: 'folder',
      path: 'services',
      children: [
        {
          id: 'quote-file',
          name: 'rate-quote.service.ts',
          kind: 'file',
          path: 'services/rate-quote.service.ts',
          language: 'TypeScript',
          children: [
            {
              id: 'quote-class',
              name: 'RateQuoteService',
              kind: 'class',
              path: 'services/rate-quote.service.ts',
              language: 'TypeScript',
              signature: 'class RateQuoteService',
              line: 18,
              children: [
                {
                  id: 'quote-function',
                  name: 'getQuote',
                  kind: 'function',
                  path: 'services/rate-quote.service.ts',
                  language: 'TypeScript',
                  signature: 'async getQuote(request: QuoteRequest): Promise<Quote>',
                  line: 42,
                },
                {
                  id: 'normalize-function',
                  name: 'normalizePair',
                  kind: 'function',
                  path: 'services/rate-quote.service.ts',
                  language: 'TypeScript',
                  signature: 'normalizePair(base: string, quote: string): CurrencyPair',
                  line: 88,
                },
              ],
            },
          ],
        },
        {
          id: 'settlement-file',
          name: 'settlement.service.ts',
          kind: 'file',
          path: 'services/settlement.service.ts',
          language: 'TypeScript',
          children: [
            {
              id: 'settlement-class',
              name: 'SettlementService',
              kind: 'class',
              path: 'services/settlement.service.ts',
              language: 'TypeScript',
              signature: 'class SettlementService',
              line: 12,
              children: [
                {
                  id: 'settle-function',
                  name: 'settleBatch',
                  kind: 'function',
                  path: 'services/settlement.service.ts',
                  language: 'TypeScript',
                  signature: 'settleBatch(batch: SettlementBatch): Promise<Receipt[]>',
                  line: 31,
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'domain',
      name: 'domain',
      kind: 'folder',
      path: 'domain',
      children: [
        {
          id: 'quote-model-file',
          name: 'quote.ts',
          kind: 'file',
          path: 'domain/quote.ts',
          language: 'TypeScript',
          children: [
            {
              id: 'quote-model-class',
              name: 'Quote',
              kind: 'class',
              path: 'domain/quote.ts',
              language: 'TypeScript',
              signature: 'class Quote',
              line: 7,
            },
          ],
        },
      ],
    },
  ],
};

export function toModuleTarget(node: ModuleNode): ModuleTarget | null {
  if (
    (node.kind !== 'class' && node.kind !== 'function') ||
    !node.language ||
    !node.signature
  ) {
    return null;
  }

  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    path: node.path,
    language: node.language,
    signature: node.signature,
    line: node.line,
  };
}
