/** Normalize a user-facing name for stable catalog and group identity. */
export function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}
