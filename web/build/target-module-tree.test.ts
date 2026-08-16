// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { extractTypeScriptModuleNodes } from './target-module-tree';

describe('target module tree scanner', () => {
  it('extracts real class methods, signatures, lines and implementation status', () => {
    const symbols = extractTypeScriptModuleNodes(
      `export class Example {
  public async ready(value: string): Promise<string> {
    return value;
  }

  public async missing(request: Request): Promise<Result> {
    void request;
    throw new NotImplementedError("Example.missing");
  }
}`,
      'src/example.ts',
    );

    const example = symbols[0];
    expect(example?.name).toBe('Example');
    expect(example?.children?.map((node) => node.name)).toEqual(['ready', 'missing']);
    expect(example?.children?.[0]?.signature).toContain(
      'public async ready(value: string): Promise<string>',
    );
    expect(example?.children?.[0]?.implementationStatus).toBe('implemented');
    expect(example?.children?.[1]?.implementationStatus).toBe('unimplemented');
    expect(example?.children?.[1]?.line).toBe(6);
  });

});
