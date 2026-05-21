/**
 * Retention (cohort LTV) + unit economics (break-even ROAS) per market.
 *
 * LTV comes from the shopify_orders mirror via the shopify_cohort_ltv()
 * RPC — true cohort LTV (revenue within N days of each customer's FIRST
 * order, averaged over cohorts old enough to be mature). Windows that
 * don't have mature cohorts yet return null and the UI shows "maturing".
 *
 * Unit economics come from Triple Whale per-market (revenue, COGS,
 * shipping, ad spend, CAC, AOV) + Xero monthly OpEx. Three break-even
 * ROAS levels are produced so the user can pick the right target:
 *
 *   1. Product margin     — covers COGS only.            1 / (1 − cogs%)
 *   2. Incl. delivery     — + shipping, fulfilment, fees. 1 / (1 − varCost%)
 *   3. Incl. fixed OpEx   — + OpEx-per-order.            1 / (margin% − opexPerOrder/AOV)
 *
 * Break-even ROAS is "revenue per €1 ad spend needed to not lose money at
 * that cost level". A current blended ROAS comfortably above level 3 means
 * there's room to lower targets and scale acquisition harder.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Default cost ratios for components Triple Whale doesn't expose directly.
// Kept conservative and explicit so they're easy to tune later.
const DEFAULT_PAYMENT_FEE_PCT = 2.9; // Shopify Payments / card processing
const DEFAULT_FULFILMENT_PCT = 8.0; // pick/pack/3PL handling as % of revenue

type CohortLtvRow = {
  store_code: string;
  mature_customers_60: number;
  mature_customers_90: number;
  mature_customers_180: number;
  mature_customers_365: number;
  ltv_60: number | null;
  ltv_90: number | null;
  ltv_180: number | null;
  ltv_365: number | null;
  total_customers: number;
  avg_orders_per_customer: number | null;
};

export type MarketEconomics = {
  market: string;
  currency: string;
  // Retention
  ltv60: number | null;
  ltv90: number | null;
  ltv180: number | null;
  ltv365: number | null;
  matureCustomers60: number;
  matureCustomers90: number;
  matureCustomers180: number;
  matureCustomers365: number;
  totalCustomers: number;
  avgOrdersPerCustomer: number | null;
  // Cost structure (% of revenue)
  aov: number | null;
  cogsPct: number | null;
  shippingPct: number | null;
  paymentFeePct: number;
  fulfilmentPct: number;
  opexPerOrder: number | null;
  // Acquisition
  cac: number | null;
  blendedRoas: number | null;
  // LTV / CAC at the longest mature window available
  ltvCac: number | null;
  ltvCacWindow: string | null;
  // Break-even ROAS, three levels
  breakEvenRoasProduct: number | null;
  breakEvenRoasDelivery: number | null;
  breakEvenRoasOpex: number | null;
};

export async function fetchRetentionEconomics(
  twData: any[] | null,
  xeroData: any | null,
  shopifyMonthly: any[] | null,
): Promise<{ markets: MarketEconomics[]; fetchedAt: string } | null> {
  // 1. Cohort LTV from the mirror
  let cohortRows: CohortLtvRow[] = [];
  try {
    const { data, error } = await (supabaseAdmin as any).rpc("shopify_cohort_ltv");
    if (error) {
      console.warn("[retention] cohort_ltv rpc:", error.message);
    } else {
      cohortRows = (data ?? []) as CohortLtvRow[];
    }
  } catch (err: any) {
    console.warn("[retention] cohort_ltv rpc threw:", err?.message ?? err);
  }
  const cohortByMarket = new Map<string, CohortLtvRow>();
  for (const r of cohortRows) cohortByMarket.set(r.store_code, r);

  // 2. Monthly OpEx (latest non-empty month) + monthly orders for OpEx/order
  const opexRows: any[] = Array.isArray(xeroData?.opexByMonth) ? xeroData.opexByMonth : [];
  const opexCats = ["team", "agencies", "content", "software", "rent", "other"];
  const latestOpexMonth =
    [...opexRows].reverse().find((m) => opexCats.some((k) => Number(m?.[k] ?? 0) > 0)) ?? null;
  const monthlyOpex = latestOpexMonth
    ? opexCats.reduce((s, k) => s + Number(latestOpexMonth[k] ?? 0), 0)
    : 0;
  // Total orders across markets in the most recent Shopify month
  const monthly = Array.isArray(shopifyMonthly) ? shopifyMonthly : [];
  const latestShopMonth = monthly.length ? monthly[monthly.length - 1] : null;
  const totalMonthlyOrders = latestShopMonth
    ? Number(latestShopMonth.orders ?? 0)
    : 0;
  const opexPerOrderBlended =
    totalMonthlyOrders > 0 && monthlyOpex > 0 ? monthlyOpex / totalMonthlyOrders : null;

  // 3. Per-market unit economics from Triple Whale
  const tw = Array.isArray(twData) ? twData.filter((m: any) => m?.live !== false) : [];
  const markets: MarketEconomics[] = [];

  for (const m of tw) {
    const code = String(m?.market ?? "");
    const revenue = Number(m?.revenue ?? 0);
    const cogs = Number(m?.cogs ?? 0);
    const shippingCost = Number(m?.shippingCost ?? 0);
    const aov = Number(m?.aov ?? 0) || null;
    const cac = Number(m?.ncpa ?? 0) || null;
    const blendedRoas = Number(m?.roas ?? 0) || null;

    const cogsPct = revenue > 0 ? (cogs / revenue) * 100 : null;
    const shippingPct = revenue > 0 ? (shippingCost / revenue) * 100 : null;
    const paymentFeePct = DEFAULT_PAYMENT_FEE_PCT;
    const fulfilmentPct = DEFAULT_FULFILMENT_PCT;

    // Variable cost % of revenue = COGS + shipping + fees + fulfilment
    const variablePct =
      (cogsPct ?? 45) + (shippingPct ?? 0) + paymentFeePct + fulfilmentPct;
    const productMarginFrac = cogsPct != null ? 1 - cogsPct / 100 : null;
    const deliveryMarginFrac = 1 - variablePct / 100;

    // OpEx per order — allocate the blended OpEx/order to each market
    // (Xero OpEx is org-level, not per market).
    const opexPerOrder = opexPerOrderBlended;
    const opexFracOfAov =
      opexPerOrder != null && aov && aov > 0 ? opexPerOrder / aov : 0;

    const breakEvenRoasProduct =
      productMarginFrac != null && productMarginFrac > 0 ? 1 / productMarginFrac : null;
    const breakEvenRoasDelivery =
      deliveryMarginFrac > 0 ? 1 / deliveryMarginFrac : null;
    const opexAdjustedMargin = deliveryMarginFrac - opexFracOfAov;
    const breakEvenRoasOpex = opexAdjustedMargin > 0 ? 1 / opexAdjustedMargin : null;

    // Cohort LTV
    const cohort = cohortByMarket.get(code);
    const ltv60 = cohort?.ltv_60 != null ? Number(cohort.ltv_60) : null;
    const ltv90 = cohort?.ltv_90 != null ? Number(cohort.ltv_90) : null;
    const ltv180 = cohort?.ltv_180 != null ? Number(cohort.ltv_180) : null;
    const ltv365 = cohort?.ltv_365 != null ? Number(cohort.ltv_365) : null;

    // LTV/CAC at the longest available mature window
    const ltvWindows: Array<[number | null, string]> = [
      [ltv365, "365d"],
      [ltv180, "180d"],
      [ltv90, "90d"],
      [ltv60, "60d"],
    ];
    const bestLtv = ltvWindows.find(([v]) => v != null) ?? [null, null];
    const ltvCac =
      bestLtv[0] != null && cac && cac > 0 ? (bestLtv[0] as number) / cac : null;

    markets.push({
      market: code,
      currency: String(m?.currency ?? "EUR"),
      ltv60,
      ltv90,
      ltv180,
      ltv365,
      matureCustomers60: Number(cohort?.mature_customers_60 ?? 0),
      matureCustomers90: Number(cohort?.mature_customers_90 ?? 0),
      matureCustomers180: Number(cohort?.mature_customers_180 ?? 0),
      matureCustomers365: Number(cohort?.mature_customers_365 ?? 0),
      totalCustomers: Number(cohort?.total_customers ?? 0),
      avgOrdersPerCustomer:
        cohort?.avg_orders_per_customer != null ? Number(cohort.avg_orders_per_customer) : null,
      aov,
      cogsPct,
      shippingPct,
      paymentFeePct,
      fulfilmentPct,
      opexPerOrder,
      cac,
      blendedRoas,
      ltvCac,
      ltvCacWindow: bestLtv[1] ?? null,
      breakEvenRoasProduct,
      breakEvenRoasDelivery,
      breakEvenRoasOpex,
    });
  }

  if (markets.length === 0) return null;
  return { markets, fetchedAt: new Date().toISOString() };
}
