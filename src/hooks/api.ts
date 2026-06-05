// React Query hooks for the backend read API.
//
// Each page swaps its old `createServerFn` call for one of these hooks. They're
// cache-first (see query-client defaults): the page renders the last cached
// payload instantly and revalidates in the background.
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api-client";

type Range = { from: string; to: string; force?: boolean };
type StoreRange = Range & { storeCode: "NL" | "UK" | "US" };

export function useDashboard() {
  return useQuery({ queryKey: ["dashboard"], queryFn: () => apiGet("/api/dashboard") });
}

export type ForecastParams = {
  startMonth?: string;
  horizonMonths?: number;
  monthlyGrowthRate?: number;
  churnRateOverride?: number | null;
  subscriberRateOverride?: number | null;
};
export function useForecast(params: ForecastParams) {
  return useQuery({
    queryKey: ["forecast", params],
    queryFn: () =>
      apiGet("/api/forecast", {
        startMonth: params.startMonth,
        horizonMonths: params.horizonMonths,
        monthlyGrowthRate: params.monthlyGrowthRate,
        churnRateOverride: params.churnRateOverride,
        subscriberRateOverride: params.subscriberRateOverride,
      }),
  });
}

export function useScenarios() {
  return useQuery({ queryKey: ["scenarios"], queryFn: () => apiGet("/api/scenarios") });
}

export function useLoopStatus() {
  return useQuery({ queryKey: ["sync", "loop"], queryFn: () => apiGet("/api/sync/loop") });
}
export function useShopifyStatus() {
  return useQuery({ queryKey: ["sync", "shopify"], queryFn: () => apiGet("/api/sync/shopify") });
}

// ── Pillar detail pages ───────────────────────────────────────────────────────
export function useStoreDashboard(p: StoreRange) {
  return useQuery({ queryKey: ["pillar", "store", p], queryFn: () => apiGet("/api/pillars/store", p) });
}
export function useTripleWhaleDashboard(p: Range) {
  return useQuery({ queryKey: ["pillar", "triple-whale", p], queryFn: () => apiGet("/api/pillars/triple-whale", p) });
}
export function useSubscriptionDashboard(p: StoreRange) {
  return useQuery({ queryKey: ["pillar", "subscription", p], queryFn: () => apiGet("/api/pillars/subscription", p) });
}
export function useInvoiceDashboard(p: Range) {
  return useQuery({ queryKey: ["pillar", "invoice", p], queryFn: () => apiGet("/api/pillars/invoice", p) });
}
export function useAccountingDashboard(force?: boolean) {
  return useQuery({ queryKey: ["pillar", "accounting", { force }], queryFn: () => apiGet("/api/pillars/accounting", { force }) });
}

// ── Extra reads ───────────────────────────────────────────────────────────────
export function useTripleWhaleRange(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: ["triple-whale-range", from, to],
    queryFn: () => apiGet("/api/triple-whale-range", { from, to }),
    enabled: enabled && !!from && !!to,
  });
}
export function useGrowthYear(year: number, enabled = true) {
  return useQuery({
    queryKey: ["growth-year", year],
    queryFn: () => apiGet("/api/growth-year", { year }),
    enabled: enabled && Number.isInteger(year),
  });
}
export function useInstagramProfile() {
  return useQuery({ queryKey: ["instagram", "profile"], queryFn: () => apiGet("/api/instagram/profile") });
}
export function useInstagramFollowers() {
  return useQuery({ queryKey: ["instagram", "followers"], queryFn: () => apiGet("/api/instagram/followers") });
}
