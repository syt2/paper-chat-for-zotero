/** Process-local LRU; bounded by both entry count and retained text size. */
export class SelectionTranslationCache {
  private entries = new Map<string, string>();
  private size = 0;
  constructor(
    private maxEntries = 50,
    private maxCharacters = 500_000,
  ) {}

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: string): void {
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.size -= key.length + previous.length;
      this.entries.delete(key);
    }
    if (key.length + value.length > this.maxCharacters) return;
    this.entries.set(key, value);
    this.size += key.length + value.length;
    while (
      this.entries.size > this.maxEntries ||
      this.size > this.maxCharacters
    ) {
      const oldest = this.entries.keys().next().value!;
      this.size -= oldest.length + this.entries.get(oldest)!.length;
      this.entries.delete(oldest);
    }
  }
}
