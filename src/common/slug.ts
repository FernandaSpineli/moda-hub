/** "Vestido Midi Linho Pérola" -> "vestido-midi-linho-perola". */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '') // drop combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
