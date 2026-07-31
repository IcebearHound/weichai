import { describe, expect, it } from 'vitest';
import { errorEvent } from './errors';

describe('errorEvent', () => {
  it('maps pending operations to failure events', () => {
    expect(errorEvent('search', 'x')).toEqual({ type: 'SEARCH_FAILURE', message: 'x' });
    expect(errorEvent('adapt', 'x')).toEqual({ type: 'ADAPT_FAILURE', message: 'x' });
    expect(errorEvent('apply', 'x')).toEqual({ type: 'APPLY_FAILURE', message: 'x' });
  });

  it('returns null when nothing is pending', () => {
    expect(errorEvent(null, 'x')).toBeNull();
  });
});
