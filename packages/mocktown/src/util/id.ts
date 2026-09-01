/** Sortable, readable ids: the corpus and the issue list are both read by humans. */
export function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function hash(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}
