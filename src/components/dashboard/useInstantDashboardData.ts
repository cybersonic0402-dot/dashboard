import { useCallback, useEffect, useState } from "react";

const PREFIX = "zapply.dashboard.";

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function readInstantDashboardCache<T>(key: string): T | null {
  if (!canUseStorage()) return null;
  try {
    const raw = window.localStorage.getItem(`${PREFIX}${key}`);
    if (!raw) return null;
    return JSON.parse(raw).data as T;
  } catch {
    return null;
  }
}

function writeInstantDashboardCache<T>(key: string, data: T) {
  if (!canUseStorage()) return;
  const source = (data as any)?.source;
  if (source === "none") return;
  try {
    window.localStorage.setItem(`${PREFIX}${key}`, JSON.stringify({ data, savedAt: new Date().toISOString() }));
  } catch {}
}

export function useInstantDashboardData<T>(
  cacheKey: string,
  fetcher: (force: boolean) => Promise<T>,
  enabled: boolean
) {
  const [data, setData] = useState<T | null>(() => readInstantDashboardCache<T>(cacheKey));
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    setData(readInstantDashboardCache<T>(cacheKey));
  }, [cacheKey]);

  const load = useCallback(
    async (force = false) => {
      if (!enabled) return null;
      const cached = force ? null : readInstantDashboardCache<T>(cacheKey);
      if (cached) setData(cached);
      setIsLoading(force || !cached);
      try {
        let next = await fetcher(force);
        if (!force && !cached && (next as any)?.source === "none") {
          void fetcher(true)
            .then((fresh) => {
              if ((fresh as any)?.source !== "none") {
                setData(fresh);
                writeInstantDashboardCache(cacheKey, fresh);
              }
            })
            .catch(() => null);
        }
        if ((next as any)?.source !== "none") {
          setData(next);
          writeInstantDashboardCache(cacheKey, next);
        } else if (!cached) {
          setData(next);
        }
        return next;
      } finally {
        setIsLoading(false);
      }
    },
    [cacheKey, enabled, fetcher]
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  return { data, isLoading, load };
}