// Client-safe constants — do NOT import server-only modules here.
export const STORE_OPTIONS = [
  { code: "NL", flag: "🇳🇱", name: "Netherlands" },
  { code: "UK", flag: "🇬🇧", name: "United Kingdom" },
  { code: "US", flag: "🇺🇸", name: "United States" },
] as const;

export type StoreCode = (typeof STORE_OPTIONS)[number]["code"];
