export const DEFAULT_MODEL_CANDIDATES = 5;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;
export const MAX_PAGES_PER_TURN = 3;
export const MAX_RELEASE_SEARCHES_PER_TURN = 2;
export const DEFAULT_MAX_RESPONSE_BYTES = 8192; // 8 KiB

export class BudgetExhaustedError extends Error {
  constructor(
    message: string,
    public readonly code: "ERR_PAGE_LIMIT_EXCEEDED" | "ERR_RELEASE_SEARCH_LIMIT_EXCEEDED" | "ERR_QUERY_TIMEOUT" | "ERR_BYTE_LIMIT_EXCEEDED" = "ERR_PAGE_LIMIT_EXCEEDED"
  ) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

export interface BudgetTrackerOptions {
  maxPages?: number;
  maxReleaseSearches?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export class QueryBudgetTracker {
  public pagesFetched: number = 0;
  public releaseSearchesDone: number = 0;
  public bytesAccumulated: number = 0;

  private maxPages: number;
  private maxReleaseSearches: number;
  private maxBytes: number;
  private signal?: AbortSignal;

  constructor(options: BudgetTrackerOptions = {}) {
    this.maxPages = options.maxPages ?? MAX_PAGES_PER_TURN;
    this.maxReleaseSearches = options.maxReleaseSearches ?? MAX_RELEASE_SEARCHES_PER_TURN;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.signal = options.signal;
  }

  checkSignal(): void {
    if (this.signal?.aborted) {
      throw new BudgetExhaustedError("Query aborted by timeout or client cancellation", "ERR_QUERY_TIMEOUT");
    }
  }

  checkCanFetchPage(): void {
    this.checkSignal();
    if (this.pagesFetched >= this.maxPages) {
      throw new BudgetExhaustedError(
        `Maximum page count (${this.maxPages}) exceeded for query turn (QRY-06)`,
        "ERR_PAGE_LIMIT_EXCEEDED"
      );
    }
  }

  recordPageFetch(): void {
    this.checkCanFetchPage();
    this.pagesFetched += 1;
  }

  checkCanSearchReleases(): void {
    this.checkSignal();
    if (this.releaseSearchesDone >= this.maxReleaseSearches) {
      throw new BudgetExhaustedError(
        `Maximum release searches (${this.maxReleaseSearches}) exceeded for turn (QRY-06)`,
        "ERR_RELEASE_SEARCH_LIMIT_EXCEEDED"
      );
    }
  }

  recordReleaseSearch(): void {
    this.checkCanSearchReleases();
    this.releaseSearchesDone += 1;
  }

  recordBytes(bytes: number): void {
    this.bytesAccumulated += bytes;
  }
}

/**
 * Executes async tasks with strict concurrency limit to prevent upstream overload.
 */
export async function limitConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number = 4
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let currentIndex = 0;

  async function worker(): Promise<void> {
    while (currentIndex < tasks.length) {
      const idx = currentIndex++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
