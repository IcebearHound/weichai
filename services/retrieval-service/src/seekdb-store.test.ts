import { describe, expect, it } from 'vitest';
import { seekDbInternals } from './seekdb-store.js';

describe('SeekDB SQL helpers', () => {
  it('serializes vectors as little-endian float32 hex literals used by SeekDB', () => {
    expect(seekDbInternals.vectorHex([1, -2])).toBe("X'0000803f000000c0'");
  });

  it('builds parameterized repository and symbol filters', () => {
    expect(
      seekDbInternals.filterSql({
        repositories: ['demo/cache', 'demo/runtime'],
        languages: ['TypeScript', 'Java'],
        kind: 'function',
      }),
    ).toEqual({
      sql: 'WHERE repository IN (?, ?) AND language IN (?, ?) AND kind = ?',
      parameters: ['demo/cache', 'demo/runtime', 'TypeScript', 'Java', 'function'],
    });
  });
});
