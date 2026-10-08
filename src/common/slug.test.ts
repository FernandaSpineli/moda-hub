import { describe, expect, it } from 'vitest';
import { SLUG_PATTERN, slugify } from './slug.js';

describe('slugify', () => {
  it.each([
    ['Vestido Midi Linho Pérola', 'vestido-midi-linho-perola'],
    ['  Blusa Ombro-a-Ombro  ', 'blusa-ombro-a-ombro'],
    ['Calça Wide Leg (Alfaiataria)', 'calca-wide-leg-alfaiataria'],
    ['Saia & Cia!!', 'saia-cia'],
    ['---', ''],
  ])('%j -> %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
    if (expected) expect(SLUG_PATTERN.test(expected)).toBe(true);
  });
});
