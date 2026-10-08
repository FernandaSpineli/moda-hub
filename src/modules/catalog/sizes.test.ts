import { describe, expect, it } from 'vitest';
import { sizeRank } from './sizes.js';

describe('sizeRank', () => {
  it('orders sizes the way shoppers expect', () => {
    const sizes = ['GG', '38', 'P', 'U', '36', 'M', 'PP', 'G', '40'];
    const sorted = [...sizes].sort((a, b) => (sizeRank(a) ?? 0) - (sizeRank(b) ?? 0));
    expect(sorted).toEqual(['U', 'PP', 'P', 'M', 'G', 'GG', '36', '38', '40']);
  });

  it.each(['', 'XS', 'm', '35', '30', '58', '100', 'GGG'])('rejects %j', (size) => {
    expect(sizeRank(size)).toBeUndefined();
  });
});
