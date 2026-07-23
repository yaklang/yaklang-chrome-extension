export interface RetainedCallBudgetEntry {
  id: string;
  retainedBytes: number;
}

export interface RetainedCallBudgetOptions {
  maxCount: number;
  maxBytes: number;
  maxEntryBytes: number;
}

const DEFAULT_OPTIONS: RetainedCallBudgetOptions = {
  maxCount: 64,
  maxBytes: 8 * 1024 * 1024,
  maxEntryBytes: 2 * 1024 * 1024,
};

/**
 * Keeps document-bound replay handles inside both a count and retained-memory
 * budget. Eviction is FIFO because recent calls are the ones exposed by the
 * recording UI and are the most likely to be promoted to a saved callable.
 */
export class RetainedCallBudget<T extends RetainedCallBudgetEntry> {
  readonly #entries = new Map<string, T>();

  readonly #order: string[] = [];

  readonly #options: RetainedCallBudgetOptions;

  #retainedBytes = 0;

  constructor(options: Partial<RetainedCallBudgetOptions> = {}) {
    this.#options = { ...DEFAULT_OPTIONS, ...options };
  }

  get retainedBytes(): number {
    return this.#retainedBytes;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(id: string): T | undefined {
    return this.#entries.get(id);
  }

  add(entry: T): boolean {
    const weight = Math.max(0, Math.ceil(entry.retainedBytes));
    if (weight > this.#options.maxEntryBytes || weight > this.#options.maxBytes) return false;
    this.delete(entry.id);
    while (this.#order.length >= this.#options.maxCount
      || (this.#order.length > 0 && this.#retainedBytes + weight > this.#options.maxBytes)) {
      const oldest = this.#order[0];
      if (!oldest) break;
      this.delete(oldest);
    }
    if (this.#retainedBytes + weight > this.#options.maxBytes) return false;
    this.#entries.set(entry.id, { ...entry, retainedBytes: weight });
    this.#order.push(entry.id);
    this.#retainedBytes += weight;
    return true;
  }

  delete(id: string): boolean {
    const current = this.#entries.get(id);
    if (!current) return false;
    this.#entries.delete(id);
    const index = this.#order.indexOf(id);
    if (index >= 0) this.#order.splice(index, 1);
    this.#retainedBytes = Math.max(0, this.#retainedBytes - current.retainedBytes);
    return true;
  }

  clear(): void {
    this.#entries.clear();
    this.#order.length = 0;
    this.#retainedBytes = 0;
  }
}
