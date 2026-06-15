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
  // Direct literal `import.meta.env.VITE_*` reads — Vite statically inlines
  // these in BOTH the browser bundle and the SSR transform. A captured
  // reference (`const e = import.meta.env; e[key]`) is NOT reliably replaced,
  // which made the value read as undefined under local `vite dev` SSR even with
  // the variable correctly set in .env (production worked because Vercel also
  // exposes it via process.env at build time).
  const fromProcess = typeof process !== "undefined" ? process.env ?? {} : {};
  return (
    import.meta.env.VITE_BACKEND_HOST ||
    import.meta.env.VITE_API_URL ||
    import.meta.env.VITE_BACKEND_SYNC_URL ||
    // server-side (Vercel / Node) real env vars
    fromProcess.VITE_BACKEND_HOST ||
    fromProcess.BACKEND_HOST ||
    fromProcess.VITE_API_URL ||
    fromProcess.BACKEND_SYNC_URL ||
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
