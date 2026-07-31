import { describe, expect, it } from 'vitest';
import { applyHunks, parseHunkHeader, resolvePatchPath } from './diff-apply';

describe('parseHunkHeader', () => {
  it('parses old start line', () => {
    expect(parseHunkHeader('@@ -42,3 +42,5 @@')).toEqual({ oldStart: 42 });
    expect(parseHunkHeader('@@ -0,0 +1,3 @@')).toEqual({ oldStart: 0 });
    expect(parseHunkHeader('junk')).toBeNull();
  });
});

describe('applyHunks', () => {
  it('replaces a removed line with added lines', () => {
    const content = ['line1', '        throw new NotImplementedException();', 'line3'].join('\n');
    const next = applyHunks(content, [
      {
        header: '@@ -2,3 +2,4 @@',
        lines: [
          { type: 'remove', content: '        throw new NotImplementedException();' },
          { type: 'add', content: '        return await cache.GetOrLoadAsync(request);' },
          { type: 'context', content: 'line3' },
        ],
      },
    ]);
    expect(next.split('\n')).toEqual([
      'line1',
      '        return await cache.GetOrLoadAsync(request);',
      'line3',
    ]);
  });

  it('handles multiple hunks anchored to the original file', () => {
    const content = ['a', 'b', 'c', 'd'].join('\n');
    const next = applyHunks(content, [
      { header: '@@ -1,2 +1,2 @@', lines: [{ type: 'remove', content: 'a' }] },
      { header: '@@ -4,1 +3,1 @@', lines: [{ type: 'add', content: 'x' }] },
    ]);
    expect(next.split('\n')).toEqual(['b', 'c', 'x', 'd']);
  });

  it('keeps content unchanged when hunks do not match', () => {
    const content = 'original';
    expect(applyHunks(content, [])).toBe('original');
  });
});

describe('resolvePatchPath', () => {
  it('uses absolute paths verbatim', () => {
    const absolute = '/Users/origin/projects/app/src/service.ts';
    expect(resolvePatchPath('/Users/origin/projects/workspace', absolute)).toBe(absolute);
  });

  it('anchors relative paths to the workspace root', () => {
    expect(resolvePatchPath('/Users/origin/projects/workspace', 'src/service.ts')).toBe(
      '/Users/origin/projects/workspace/src/service.ts',
    );
  });

  it('requires a workspace root for relative paths', () => {
    expect(() => resolvePatchPath(undefined, 'src/service.ts')).toThrow('工作区文件夹');
  });
});
