import { describe, it, expect } from 'vitest';
import { SvgCache } from '../src/cache.js';

describe('SvgCache.keyFor', () => {
  it('produces the same key for identical syntax', () => {
    const s = 'infographic foo\ndata\n  items\n    - label A';
    expect(SvgCache.keyFor(s)).toBe(SvgCache.keyFor(s));
  });

  it('is whitespace-insensitive at edges', () => {
    const a = 'infographic foo\ndata';
    const b = '   infographic foo\ndata   \n';
    expect(SvgCache.keyFor(a)).toBe(SvgCache.keyFor(b));
  });

  it('produces different keys for different syntax', () => {
    expect(SvgCache.keyFor('foo')).not.toBe(SvgCache.keyFor('bar'));
  });

  it('uses sha256 (64 hex chars) in the key suffix', () => {
    const key = SvgCache.keyFor('hello');
    expect(key).toMatch(/^infographic:svg:[a-f0-9]{64}$/);
  });
});
