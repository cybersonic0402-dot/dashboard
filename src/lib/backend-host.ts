// Single source of truth for the backend (Railway) base URL.
//
// Set ONE env var — `VITE_BACKEND_HOST` — e.g.
//   VITE_BACKEND_HOST=zapply-backend.up.railway.app
//
// Why the VITE_ prefix: Vite only exposes VITE_-prefixed vars to the browser
// bundle, so client code (api-client) can't read a bare `BACKEND_HOST`. The
// same VITE_BACKEND_HOST is also readable server-side via process.env, so one
// variable covers both the browser and the api.* server routes. A bare host
// (no scheme) is auto-upgraded to https://. Legacy names are still accepted.
function rawHost(): string | undefined {
  const fromImportMeta = (import.meta as any)?.env ?? {};
  const fromProcess = typeof process !== "undefined" ? process.env ?? {} : {};
  return (
    fromImportMeta.VITE_BACKEND_HOST ||
    fromProcess.VITE_BACKEND_HOST ||
    fromProcess.BACKEND_HOST ||
    // legacy / fallbacks
    fromImportMeta.VITE_API_URL ||
    fromProcess.VITE_API_URL ||
    fromProcess.BACKEND_SYNC_URL ||
    fromImportMeta.VITE_BACKEND_SYNC_URL ||
    fromProcess.VITE_BACKEND_SYNC_URL ||
    undefined
  );
}

/** Normalized backend base URL (e.g. https://zapply-backend.up.railway.app), or null. */
export function resolveBackendHost(): string | null {
  const raw = rawHost();
  if (!raw) return null;
  let s = String(raw).trim().replace(/\/+$/, "");
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s;
}
