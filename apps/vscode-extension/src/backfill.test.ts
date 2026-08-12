import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { applyHunks, canonicalWorkspacePath, parseHunkHeader, resolvePatchPath } from './diff-apply';

describe('parseHunkHeader', () => {
  it('parses old start line', () => {
    expect(parseHunkHeader('@@ -42,3 +42,5 @@')).toEqual({ oldStart: 42 });
    expect(parseHunkHeader('@@ -0,0 +1,3 @@')).toEqual({ oldStart: 0 });
    expect(parseHunkHeader('junk')).toBeNull();
  });
});

describe('applyHunks', () => {
  it('replaces source only when its exact old-side precondition matches', () => {
    const content = ['line1', 'throw new NotImplementedException();', 'line3'].join('\n');
    expect(
      applyHunks(content, [
        {
          header: '@@ -2,2 +2,2 @@',
          lines: [
            { type: 'remove', content: 'throw new NotImplementedException();' },
            { type: 'add', content: 'return value;' },
            { type: 'context', content: 'line3' },
          ],
        },
      ]),
    ).toBe(['line1', 'return value;', 'line3'].join('\n'));
  });

  it('refuses a hunk whose source content is no longer present', () => {
    expect(() =>
      applyHunks('user-edited', [
        {
          header: '@@ -1,1 +1,1 @@',
          lines: [
            { type: 'remove', content: 'old' },
            { type: 'add', content: 'new' },
          ],
        },
      ]),
    ).toThrow('no longer matches');
  });

  it('refuses blind add-only modification hunks', () => {
    expect(() =>
      applyHunks('existing', [
        {
          header: '@@ -1,0 +1,1 @@',
          lines: [{ type: 'add', content: 'new' }],
        },
      ]),
    ).toThrow('no source precondition');
  });
});

describe('resolvePatchPath', () => {
  const root = '/Users/origin/projects/workspace';

  it('anchors a relative path to the workspace root', () => {
    expect(resolvePatchPath(root, 'src/service.cs')).toBe(path.join(path.resolve(root), 'src/service.cs'));
    expect(canonicalWorkspacePath(root, 'src/service.cs')).toBe('src/service.cs');
  });

  it('rejects absolute paths and traversal', () => {
    expect(() => resolvePatchPath(root, '/tmp/service.cs')).toThrow('相对路径');
    expect(() => resolvePatchPath(root, '../service.cs')).toThrow('超出当前工作区');
  });

  it('requires a workspace root', () => {
    expect(() => resolvePatchPath(undefined, 'src/service.cs')).toThrow('工作区文件夹');
  });
});
