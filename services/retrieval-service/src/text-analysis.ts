function wordForms(value: string): string[] {
  const forms = new Set([value]);
  const singular = value.length > 4 && value.endsWith('s') ? value.slice(0, -1) : value;
  forms.add(singular);
  if (singular.length > 6 && singular.endsWith('ment')) {
    forms.add(singular.slice(0, -4));
  }
  return [...forms];
}

export function searchTokens(value: string): Set<string> {
  const withWordBoundaries = value
    .normalize('NFKC')
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, '$1 $2')
    .replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, '$1 $2');
  const rawTokens = withWordBoundaries.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return new Set(rawTokens.flatMap(wordForms));
}

export function expandedSearchText(value: string): string {
  return [...searchTokens(value)].join(' ');
}

export function overlap(left: string, right: string): number {
  const a = searchTokens(left);
  const b = searchTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return shared / Math.sqrt(a.size * b.size);
}
