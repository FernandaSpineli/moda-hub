/**
 * Sizes sold by the shop and the order shoppers expect them in. Letter
 * sizes come before numeric (trouser/dress) sizes; "U" (tamanho único)
 * comes first.
 */
const LETTER_SIZES = ['U', 'PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG'] as const;
const NUMERIC_MIN = 32;
const NUMERIC_MAX = 56;

/** The rank used to sort a size, or undefined if the size is not sold. */
export function sizeRank(size: string): number | undefined {
  const letter = LETTER_SIZES.indexOf(size as (typeof LETTER_SIZES)[number]);
  if (letter >= 0) return letter * 10;
  if (/^\d{2}$/.test(size)) {
    const n = Number(size);
    if (n >= NUMERIC_MIN && n <= NUMERIC_MAX && n % 2 === 0) return 100 + n;
  }
  return undefined;
}

export const SIZE_HINT = `one of ${LETTER_SIZES.join(', ')} or an even number from ${NUMERIC_MIN} to ${NUMERIC_MAX}`;
