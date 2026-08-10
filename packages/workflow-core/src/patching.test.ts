import { describe, expect, it } from 'vitest';
import { applyHunksStrict, newFileContent } from './patching';

describe('applyHunksStrict', () => {
  it('preserves unrelated content while replacing a matched old-side sequence', () => {
    expect(
      applyHunksStrict('before\nold\nafter', [
        {
          header: '@@ -2,1 +2,1 @@',
          lines: [
            { type: 'remove', content: 'old' },
            { type: 'add', content: 'new' },
          ],
        },
      ]),
    ).toBe('before\nnew\nafter');
  });

  it('rejects a hunk whose old-side content no longer matches', () => {
    expect(() =>
      applyHunksStrict('before\nchanged\nafter', [
        {
          header: '@@ -2,1 +2,1 @@',
          lines: [
            { type: 'remove', content: 'old' },
            { type: 'add', content: 'new' },
          ],
        },
      ]),
    ).toThrow('no longer matches');
  });

  it('rejects an add-only modification hunk without a source precondition', () => {
    expect(() =>
      applyHunksStrict('before', [
        {
          header: '@@ -1,0 +1,1 @@',
          lines: [{ type: 'add', content: 'new' }],
        },
      ]),
    ).toThrow('no source precondition');
  });
});

describe('newFileContent', () => {
  it('accepts only add lines', () => {
    expect(
      newFileContent([
        {
          header: '@@ -0,0 +1,2 @@',
          lines: [
            { type: 'add', content: 'first' },
            { type: 'add', content: 'second' },
          ],
        },
      ]),
    ).toBe('first\nsecond');
  });
});
