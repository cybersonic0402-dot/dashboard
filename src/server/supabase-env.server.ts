const VITE_SUPABASE_URL = (import.meta as any).env?.VITE_SUPABASE_URL as string | undefined;
const VITE_SUPABASE_PUBLISHABLE_KEY = (import.meta as any).env?.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  if (typeof Buffer !== "undefined") return Buffer.from(padded, "base64").toString("utf8");
  return atob(padded);
}

function jwtRole(key: string): string | null {
  try {
    const payload = key.split(".")[1];
    if (!payload) return null;
    return String(JSON.parse(decodeBase64Url(payload))?.role ?? "") || null;
  } catch {
    return null;
  }
}

function collectStrings(value: unknown, out: string[] = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

function packedSecretKeys() {
  const packed = process.env.SUPABASE_SECRET_KEYS;
  if (!packed) return [];
  try {
    return collectStrings(JSON.parse(packed)).filter((v) => v.length > 20);
  } catch {
    return packed.length > 20 ? [packed] : [];
  }
}

export function resolveSupabaseUrl(fallback?: string) {
  return process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || VITE_SUPABASE_URL || fallback;
}

export function resolveSupabaseServiceKey() {
  const explicitService = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (explicitService) return explicitService;

  const packed = packedSecretKeys();
  const serviceRole = packed.find((key) => jwtRole(key) === "service_role");
  if (serviceRole) return serviceRole;

  const sbSecret = packed.find((key) => key.startsWith("sb_secret_") || key.startsWith("sbp_") || key.startsWith("sb_secret"));
  if (sbSecret) return sbSecret;

  return (
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    VITE_SUPABASE_PUBLISHABLE_KEY
  );
}

export function resolveSupabasePublishableKey() {
  return (
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    VITE_SUPABASE_PUBLISHABLE_KEY
  );
}
