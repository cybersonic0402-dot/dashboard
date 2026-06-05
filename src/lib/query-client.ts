// Shared React Query configuration.
//
// Cache-first defaults so the dashboard renders instantly from cache and
// revalidates quietly in the background — no spinners on navigation. The
// backend already serves precomputed data, so a 1-minute staleTime is plenty
// and avoids refetch storms.
import { QueryClient } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000, // 1 min: treat data as fresh, render from cache instantly
        gcTime: 24 * 60 * 60_000, // keep 24h so the persisted cache survives reloads
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}

/**
 * localStorage persister so the query cache survives a full page reload — the
 * dashboard paints instantly from the last-known data, then revalidates in the
 * background. Returns null during SSR (no window). Paired with the backend's
 * Redis-precomputed pages, the user never sees a loading spinner on a page
 * they've opened before.
 */
export function makePersister() {
  if (typeof window === "undefined") return null;
  return createSyncStoragePersister({
    storage: window.localStorage,
    key: "zapply-rq-cache",
  });
}
