/**
 * In-memory progress tracker for multi-store fetches (per Worker instance).
 * Keyed by an arbitrary string (e.g. `${from}|${to}` for Triple Whale ranges).
 *
 * The dashboard polls `getTripleWhaleProgress` while a fetch is in flight to
 * show "Fetched X / Y stores".
 */

export type FetchProgress = {
  total: number;          // total number of stores to fetch
  fetched: number;        // completed (success or failure)
  remaining: number;      // total - fetched
  stores: Array<{ market: string; flag: string; status: "pending" | "done" | "error" }>;
  startedAt: number;
  updatedAt: number;
  done: boolean;
};

const progressMap = new Map<string, FetchProgress>();

// Auto-evict entries older than 10 minutes to avoid unbounded growth
const TTL_MS = 10 * 60 * 1000;

function gc() {
  const now = Date.now();
  for (const [k, v] of progressMap.entries()) {
    if (now - v.updatedAt > TTL_MS) progressMap.delete(k);
  }
}

export function startProgress(
  key: string,
  stores: Array<{ market: string; flag: string }>
): FetchProgress {
  gc();
  const p: FetchProgress = {
    total: stores.length,
    fetched: 0,
    remaining: stores.length,
    stores: stores.map((s) => ({ ...s, status: "pending" })),
    startedAt: Date.now(),
    updatedAt: Date.now(),
    done: false,
  };
  progressMap.set(key, p);
  return p;
}

export function markStore(
  key: string,
  market: string,
  status: "done" | "error"
) {
  const p = progressMap.get(key);
  if (!p) return;
  const s = p.stores.find((x) => x.market === market);
  if (s && s.status === "pending") {
    s.status = status;
    p.fetched += 1;
    p.remaining = Math.max(0, p.total - p.fetched);
  }
  p.updatedAt = Date.now();
  if (p.fetched >= p.total) p.done = true;
}

export function finishProgress(key: string) {
  const p = progressMap.get(key);
  if (!p) return;
  p.done = true;
  p.updatedAt = Date.now();
}

export function getProgress(key: string): FetchProgress | null {
  return progressMap.get(key) ?? null;
}
