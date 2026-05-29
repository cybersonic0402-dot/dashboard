import { createFileRoute } from "@tanstack/react-router";
import Anthropic from "@anthropic-ai/sdk";
import { fetchTripleWhale } from "@/server/fetchers.server";
import { fetchShopifyMonthlyFromDb } from "@/server/shopify-db.server";
import { fetchLoopFromDb } from "@/server/loop-db.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyAllowedUser } from "@/server/user-auth.server";
import {
  buildRevenueForecast,
  type RevenueForecast,
} from "@/server/revenue-forecast.server";
import {
  getChannelPacing,
  upsertChannelTarget,
  PACING_CHANNELS,
  PACING_MARKETS,
  type Channel,
  type Market,
} from "@/server/channel-pacing.server";
import {
  listScenarios,
  getScenario,
  getScenarioByName,
  upsertScenario,
  deleteScenario,
  type ScenarioAssumptions,
  type ScenarioEvent,
  type ScenarioSnapshot,
} from "@/server/scenarios.server";
import { loadMarketHistory } from "@/server/forecast-history.server";

type ChatMessage = { role: "user" | "assistant"; content: string };

const SYSTEM_PROMPT = `You are the Finance Forecasting Assistant for Zapply, an e-commerce brand operating in NL/BE, UK and US markets.

You are embedded inside the Revenue Forecast dashboard at /pillars/revenue-forecast. The user is looking at:
- A 12-month revenue projection per market split into three streams (new customer acquisition, one-time repeat, subscriber tail)
- P50 (central estimate) and P90 (conservative cap) totals
- Editable assumptions: monthly growth %, churn % override, subscriber % override

Data sources you have direct read access to via tools:
- Triple Whale: per-market revenue, AOV, CAC, ROAS, channel ad spend, subscription metrics (last 30 days)
- Loop Subscriptions (UK/US) + Juo (NL): active subscribers, MRR (EUR), ARPU, churn rate
- Shopify mirror: monthly order counts and revenue per market
- Cohort LTV (60/90/180/365-day windows from shopify_cohort_ltv)
- Channel pacing: MTD spend + ROAS vs target for Meta/Google/TikTok
- **Market history (up to 36 months Shopify + 24 months Loop)** — monthly orders, new customers, revenue, MRR per market, plus the regression-derived per-market growth rate and seasonal index. Call get_market_history to answer "is the forecast realistic vs the actual trajectory?" type questions.
- Revenue forecast snapshot itself (rebuild with custom assumptions)

When the user asks about numbers:
1. Use tools to fetch the live values rather than guessing.
2. Be specific — quote the number in EUR and name the market.
3. If a metric is missing (e.g. TW returns null MRR), say so clearly and explain the fallback.
4. When the user asks "what if X?", you can rebuild the forecast with new assumptions via the build_forecast tool.
5. Default currency is EUR. Convert when needed.

Keep responses concise. Lead with the answer, then the supporting context. No filler.

You CAN write to specific places via tools:
- Channel pacing targets (set_channel_target) — adjust monthly spend or ROAS targets for Meta/Google/TikTok per market.
- Forecast scenarios (save_scenario / list_scenarios / load_scenario / delete_scenario / compare_scenarios) — name a what-if forecast (e.g. "Joe Rogan partnership") so it can be recalled and compared later.

You CANNOT directly flip the assumption input fields on the page. If the user asks "set growth to 5% in the form", tell them you've previewed the recomputed numbers (via build_forecast) and they need to type 5 in the Monthly growth % input — or save the scenario so it persists.

Confirm before any destructive write (delete_scenario). Show the user the diff when overwriting a saved scenario by the same name.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_market_economics",
    description:
      "Fetches the latest Triple Whale economics for one market over the trailing 30 days: revenue, AOV, CAC, blended ROAS, COGS, ad spend per channel (Meta/Google/TikTok), subscription metrics.",
    input_schema: {
      type: "object",
      properties: {
        market: { type: "string", enum: ["NL", "UK", "US"] },
      },
      required: ["market"],
    },
  },
  {
    name: "get_cohort_ltv",
    description:
      "Returns cumulative cohort LTV at 60 / 90 / 180 / 365-day windows per market, with the number of mature customers at each window. Source: shopify_cohort_ltv RPC over the orders mirror.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_subscriber_stats",
    description:
      "Returns active subscriber count, MRR (EUR), ARPU, churn rate and new-subscribers-this-month per market. Source: Loop Subscriptions (UK/US) and Juo (NL).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_shopify_monthly",
    description:
      "Returns the trailing N months of Shopify revenue and order counts per market. Useful for trend / seasonality questions.",
    input_schema: {
      type: "object",
      properties: {
        monthsBack: {
          type: "number",
          description: "How many months back from today (1-12). Default 6.",
        },
      },
    },
  },
  {
    name: "get_market_history",
    description:
      "Returns deep historical trajectory per market: up to 36 months of Shopify orders / revenue / new customers, plus 24 months of Loop subscription state (active subs, new, churned, MRR) for UK and US. Includes the regression-derived monthly growth rate per market AND the seasonal index (calendar-month multipliers). USE THIS to answer questions about historical growth, seasonality, or to validate forecast projections.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_channel_pacing",
    description:
      "Returns channel pacing per market and channel (Meta/Google/TikTok) for the current month: target spend, MTD spend, pacing %, projected month-end, ROAS target vs actual, flag colour.",
    input_schema: {
      type: "object",
      properties: {
        monthStart: {
          type: "string",
          description: "YYYY-MM-01 month to inspect. Defaults to current month.",
        },
      },
    },
  },
  {
    name: "build_forecast",
    description:
      "Recomputes the 12-month revenue forecast with custom assumptions. Returns the full forecast object including per-market totals (P50/P90), per-month breakdowns, and the three revenue streams. Use to answer 'what if growth/churn/sub rate were X?'.",
    input_schema: {
      type: "object",
      properties: {
        monthlyGrowthRate: {
          type: "number",
          description:
            "Decimal monthly growth applied to new-customer baseline. 0.05 = +5%/month. Default 0.",
        },
        churnRateOverride: {
          type: ["number", "null"],
          description:
            "Decimal monthly churn override (0.045 = 4.5%/mo). null = use Loop/Juo/TW value.",
        },
        subscriberRateOverride: {
          type: ["number", "null"],
          description:
            "Decimal share of new customers who subscribe (0.3 = 30%). null = derive from TW.",
        },
        horizonMonths: {
          type: "number",
          description: "Forecast horizon in months. Default 12, max 24.",
        },
      },
    },
  },
  {
    name: "set_channel_target",
    description:
      "Upserts a monthly spend + ROAS target for a (market, channel, month). Writes to channel_targets and immediately changes pacing flags on /pillars/channel-pacing. Confirm with the user before calling this.",
    input_schema: {
      type: "object",
      properties: {
        market: { type: "string", enum: ["NL", "UK", "US"] },
        channel: { type: "string", enum: ["meta", "google", "tiktok"] },
        month: {
          type: "string",
          description: "First-of-month, YYYY-MM-01. e.g. '2026-06-01'.",
        },
        spend_target: { type: "number", description: "EUR per month, >= 0" },
        roas_target: { type: "number", description: ">= 0" },
        notes: { type: ["string", "null"] },
      },
      required: ["market", "channel", "month", "spend_target", "roas_target"],
    },
  },
  {
    name: "save_scenario",
    description:
      "Saves a named what-if forecast. Computes the forecast with the given assumptions and stores the totals snapshot. Overwrites if a scenario with the same name exists — warn the user first.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short label, e.g. 'Joe Rogan partnership'." },
        description: { type: ["string", "null"] },
        monthlyGrowthRate: { type: "number" },
        churnRateOverride: { type: ["number", "null"] },
        subscriberRateOverride: { type: ["number", "null"] },
        horizonMonths: { type: "number" },
        events: {
          type: "array",
          description:
            "Optional list of scenario events (partner launches etc.). Each has kind, date (YYYY-MM-DD), description, payload.",
          items: { type: "object" },
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_scenarios",
    description:
      "Lists all saved scenarios (id, name, description, assumptions, last-saved totals).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "load_scenario",
    description:
      "Loads a scenario by id OR name and rebuilds the forecast using its assumptions. Returns the full forecast plus the scenario metadata.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: ["string", "null"] },
        name: { type: ["string", "null"] },
      },
    },
  },
  {
    name: "delete_scenario",
    description:
      "Permanently deletes a saved scenario by id. Confirm with the user before calling.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "compare_scenarios",
    description:
      "Compares two scenarios side-by-side. Pass two scenario ids OR names. Returns the assumptions and the P50/P90 totals diff per market.",
    input_schema: {
      type: "object",
      properties: {
        a: { type: "string", description: "id or name of scenario A" },
        b: { type: "string", description: "id or name of scenario B" },
      },
      required: ["a", "b"],
    },
  },
];

// ── Tool runners ─────────────────────────────────────────────────────────

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function thirtyDaysAgoIso() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function firstOfThisMonthIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`;
}

async function runTool(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "get_market_economics": {
      const market = String(input.market ?? "");
      const from = thirtyDaysAgoIso();
      const to = todayIso();
      const rows = (await fetchTripleWhale(from, to)) as any[] | null;
      const row = (rows ?? []).find((r) => r?.market === market) ?? null;
      if (!row) return { market, error: "No Triple Whale data for that market." };
      return {
        market,
        windowFrom: from,
        windowTo: to,
        revenueEur: row.revenue ?? null,
        netRevenueEur: row.netRevenue ?? null,
        refundsEur: row.refunds ?? null,
        aov: row.aov ?? null,
        cac: row.ncpa ?? null,
        blendedRoas: row.roas ?? null,
        cogsEur: row.cogs ?? null,
        grossProfitEur: row.grossProfit ?? null,
        netProfitEur: row.netProfit ?? null,
        adSpend: {
          totalEur: row.adSpend ?? null,
          metaEur: row.facebookSpend ?? null,
          googleEur: row.googleSpend ?? null,
          tiktokEur: row.tiktokSpend ?? null,
        },
        roas: {
          blended: row.roas ?? null,
          meta: row.fbRoas ?? null,
          google: row.googleRoas ?? null,
          tiktok: row.tiktokRoas ?? null,
        },
        subscriptions: {
          mrrEur: row.mrr ?? null,
          activeSubscribers: row.activeSubscribers ?? null,
          newSubscribers: row.newSubscribers ?? null,
          cancelledSubs: row.cancelledSubs ?? null,
          churnRatePct: row.churnRate ?? null,
        },
        newCustomersPct: row.newCustomersPct ?? null,
        orders: row.orders ?? null,
      };
    }

    case "get_cohort_ltv": {
      const { data, error } = await (supabaseAdmin as any).rpc("shopify_cohort_ltv");
      if (error) return { error: error.message };
      return { rows: data ?? [] };
    }

    case "get_subscriber_stats": {
      const loop = (await fetchLoopFromDb()) ?? [];
      return {
        markets: loop.map((r: any) => ({
          market: r.market,
          source: "loop",
          currency: r.currency,
          mrr: r.mrr,
          activeSubs: r.activeSubs,
          arpu: r.arpu,
          churnRatePct: r.churnRate,
          newThisMonth: r.newThisMonth,
          churnedThisMonth: r.churnedThisMonth,
        })),
        note:
          "Loop covers UK + US. NL/Juo subscriber data is fetched live from the build_forecast or get_market_economics tool when needed.",
      };
    }

    case "get_market_history": {
      const result = await loadMarketHistory(["NL", "UK", "US"]);
      // Trim heavy fields for context efficiency. Keep all months but
      // compress to a flat shape per market.
      return {
        fetchedAt: result.fetchedAt,
        markets: result.series.map((s) => ({
          market: s.market,
          currency: s.currency,
          trend: s.trend,
          months: s.months.map((m) => ({
            month: m.monthIso,
            orders: m.orders,
            netRevenueEur: m.netRevenueEur,
            newCustomers: m.newCustomers,
            aov: m.aov,
            activeSubs: m.activeSubs,
            newSubs: m.newSubs,
            churnedSubs: m.churnedSubs,
            mrrEur: m.mrrEur,
            churnRate: m.churnRate,
          })),
        })),
        diagnostics: result.diagnostics,
      };
    }

    case "get_shopify_monthly": {
      const months = Math.min(12, Math.max(1, Number(input.monthsBack) || 6));
      const data = await fetchShopifyMonthlyFromDb(months);
      return { rows: data ?? [] };
    }

    case "get_channel_pacing": {
      const monthStart =
        typeof input.monthStart === "string" && /^\d{4}-\d{2}-01$/.test(input.monthStart)
          ? input.monthStart
          : firstOfThisMonthIso();
      const result = await getChannelPacing({ monthStart });
      return result;
    }

    case "set_channel_target": {
      const market = String(input.market ?? "");
      const channel = String(input.channel ?? "");
      const month = String(input.month ?? "");
      if (!PACING_MARKETS.includes(market as Market)) {
        return { ok: false, error: `Invalid market: ${market}` };
      }
      if (!PACING_CHANNELS.includes(channel as Channel)) {
        return { ok: false, error: `Invalid channel: ${channel}` };
      }
      if (!/^\d{4}-\d{2}-01$/.test(month)) {
        return { ok: false, error: `Invalid month (need YYYY-MM-01): ${month}` };
      }
      const spend = Number(input.spend_target);
      const roas = Number(input.roas_target);
      if (!isFinite(spend) || spend < 0)
        return { ok: false, error: "spend_target must be a number >= 0" };
      if (!isFinite(roas) || roas < 0)
        return { ok: false, error: "roas_target must be a number >= 0" };
      const res = await upsertChannelTarget({
        market: market as Market,
        channel: channel as Channel,
        month,
        spend_target: spend,
        roas_target: roas,
        notes: typeof input.notes === "string" ? input.notes : null,
      });
      return res;
    }

    case "save_scenario": {
      const name = String(input.name ?? "").trim();
      if (!name) return { ok: false, error: "name is required" };
      const assumptions: ScenarioAssumptions = {
        monthlyGrowthRate:
          typeof input.monthlyGrowthRate === "number" ? input.monthlyGrowthRate : 0,
        churnRateOverride:
          input.churnRateOverride === null
            ? null
            : typeof input.churnRateOverride === "number"
              ? input.churnRateOverride
              : null,
        subscriberRateOverride:
          input.subscriberRateOverride === null
            ? null
            : typeof input.subscriberRateOverride === "number"
              ? input.subscriberRateOverride
              : null,
        horizonMonths:
          typeof input.horizonMonths === "number" ? input.horizonMonths : 12,
      };
      const events = Array.isArray(input.events)
        ? (input.events as ScenarioEvent[])
        : [];
      // Compute fresh totals to store alongside.
      let snapshot: ScenarioSnapshot | null = null;
      try {
        const forecast = await buildRevenueForecast({
          horizonMonths: assumptions.horizonMonths,
          assumptions,
        });
        const totalsByMarket: ScenarioSnapshot["totalsByMarket"] = {};
        let p50 = 0;
        let p90 = 0;
        for (const m of forecast.markets) {
          totalsByMarket[m.market] = m.totals;
          p50 += m.totals.totalP50;
          p90 += m.totals.totalP90;
        }
        snapshot = {
          capturedAt: new Date().toISOString(),
          totalsByMarket,
          grand: { totalP50: +p50.toFixed(2), totalP90: +p90.toFixed(2) },
        };
      } catch (err: any) {
        console.warn("[scenarios] snapshot failed:", err?.message ?? err);
      }
      return await upsertScenario({
        name,
        description:
          typeof input.description === "string" ? input.description : null,
        assumptions,
        events,
        snapshot,
      });
    }

    case "list_scenarios": {
      const rows = await listScenarios();
      return {
        count: rows.length,
        scenarios: rows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          assumptions: r.assumptions,
          eventCount: r.events.length,
          grandTotal: r.snapshot?.grand ?? null,
          updated_at: r.updated_at,
        })),
      };
    }

    case "load_scenario": {
      const idStr = typeof input.id === "string" ? input.id : null;
      const nameStr = typeof input.name === "string" ? input.name : null;
      const scenario = idStr
        ? await getScenario(idStr)
        : nameStr
          ? await getScenarioByName(nameStr)
          : null;
      if (!scenario) return { ok: false, error: "Scenario not found" };
      const forecast = await buildRevenueForecast({
        horizonMonths: scenario.assumptions.horizonMonths,
        assumptions: scenario.assumptions,
      });
      return { ok: true, scenario, forecast: summarizeForecast(forecast) };
    }

    case "delete_scenario": {
      const id = String(input.id ?? "");
      if (!id) return { ok: false, error: "id is required" };
      return await deleteScenario(id);
    }

    case "compare_scenarios": {
      const aKey = String(input.a ?? "");
      const bKey = String(input.b ?? "");
      const looksUuid = (s: string) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
      const fetchOne = async (k: string) =>
        looksUuid(k) ? await getScenario(k) : await getScenarioByName(k);
      const [a, b] = await Promise.all([fetchOne(aKey), fetchOne(bKey)]);
      if (!a || !b) {
        return {
          ok: false,
          error: `Missing scenario(s): ${!a ? aKey : ""} ${!b ? bKey : ""}`.trim(),
        };
      }
      // Recompute both so the diff reflects current data (not stale snapshots).
      const [fa, fb] = await Promise.all([
        buildRevenueForecast({
          horizonMonths: a.assumptions.horizonMonths,
          assumptions: a.assumptions,
        }),
        buildRevenueForecast({
          horizonMonths: b.assumptions.horizonMonths,
          assumptions: b.assumptions,
        }),
      ]);
      const diff: Record<string, any> = {};
      for (const am of fa.markets) {
        const bm = fb.markets.find((x) => x.market === am.market);
        diff[am.market] = {
          a_totalP50: am.totals.totalP50,
          b_totalP50: bm?.totals.totalP50 ?? null,
          delta_P50:
            bm != null
              ? +(bm.totals.totalP50 - am.totals.totalP50).toFixed(2)
              : null,
          a_totalP90: am.totals.totalP90,
          b_totalP90: bm?.totals.totalP90 ?? null,
        };
      }
      return {
        ok: true,
        a: { name: a.name, assumptions: a.assumptions },
        b: { name: b.name, assumptions: b.assumptions },
        perMarket: diff,
      };
    }

    case "build_forecast": {
      const assumptions = {
        monthlyGrowthRate:
          typeof input.monthlyGrowthRate === "number" ? input.monthlyGrowthRate : 0,
        churnRateOverride:
          input.churnRateOverride === null
            ? null
            : typeof input.churnRateOverride === "number"
              ? input.churnRateOverride
              : null,
        subscriberRateOverride:
          input.subscriberRateOverride === null
            ? null
            : typeof input.subscriberRateOverride === "number"
              ? input.subscriberRateOverride
              : null,
      };
      const horizon =
        typeof input.horizonMonths === "number" ? input.horizonMonths : 12;
      const result = await buildRevenueForecast({
        horizonMonths: horizon,
        assumptions,
      });
      // Trim huge fields for context efficiency.
      return summarizeForecast(result);
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function summarizeForecast(f: RevenueForecast) {
  return {
    startMonth: f.startMonth,
    horizonMonths: f.horizonMonths,
    assumptions: f.assumptions,
    twWarning: f.twWarning,
    markets: f.markets.map((m) => ({
      market: m.market,
      aov: m.aov,
      baselineNewCustomersPerMonth: m.baselineNewCustomersPerMonth,
      monthlyChurnRate: m.monthlyChurnRate,
      subscriberRate: m.subscriberRate,
      startingMrr: m.startingMrr,
      arpuPerSubscriber: m.arpuPerSubscriber,
      ltvWindows: m.ltvWindows,
      matureCustomers: m.matureCustomers,
      confidenceFactor: m.confidenceFactor,
      totals: m.totals,
      warnings: m.warnings,
      firstMonth: m.months[0] ?? null,
      lastMonth: m.months[m.months.length - 1] ?? null,
    })),
  };
}

// ── Route handler ────────────────────────────────────────────────────────

export const Route = createFileRoute("/api/forecast-chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await verifyAllowedUser(request);
        if (denied) return denied;

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          return Response.json(
            { error: "ANTHROPIC_API_KEY not configured" },
            { status: 500 },
          );
        }

        let body: { messages?: ChatMessage[] };
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        const messages = Array.isArray(body.messages) ? body.messages : [];
        if (messages.length === 0) {
          return Response.json(
            { error: "messages array is required" },
            { status: 400 },
          );
        }

        const cleaned: Anthropic.MessageParam[] = messages
          .filter(
            (m) =>
              m &&
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string" &&
              m.content.trim().length > 0,
          )
          .map((m) => ({ role: m.role, content: m.content }));

        const client = new Anthropic({ apiKey });

        // Tool-use loop: Claude can call tools, we run them, feed results
        // back, until Claude emits a text-only response or we hit the cap.
        const MAX_TOOL_TURNS = 6;
        let conversation: Anthropic.MessageParam[] = [...cleaned];
        const toolTrace: Array<{ name: string; input: any; took_ms: number }> = [];

        for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
          const resp = await client.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 2048,
            system: SYSTEM_PROMPT,
            tools: TOOLS,
            messages: conversation,
          });

          // Append the assistant's message (text + tool_use blocks) to history.
          conversation.push({ role: "assistant", content: resp.content });

          if (resp.stop_reason !== "tool_use") {
            // Final answer
            const text = resp.content
              .filter((b): b is Anthropic.TextBlock => b.type === "text")
              .map((b) => b.text)
              .join("\n")
              .trim();
            return Response.json({
              ok: true,
              text: text || "(empty response)",
              toolTrace,
              stopReason: resp.stop_reason,
            });
          }

          // Run all requested tools in parallel and feed results back.
          const toolUses = resp.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
          );
          const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
            toolUses.map(async (tu) => {
              const t0 = Date.now();
              let result: unknown;
              try {
                result = await runTool(tu.name, (tu.input ?? {}) as Record<string, unknown>);
              } catch (err: any) {
                result = { error: err?.message ?? "tool failed" };
              }
              const took = Date.now() - t0;
              toolTrace.push({ name: tu.name, input: tu.input, took_ms: took });
              return {
                type: "tool_result" as const,
                tool_use_id: tu.id,
                content: JSON.stringify(result),
              };
            }),
          );

          conversation.push({ role: "user", content: toolResults });
        }

        return Response.json(
          {
            ok: false,
            error: `Tool-use loop exceeded ${MAX_TOOL_TURNS} turns without a final answer.`,
            toolTrace,
          },
          { status: 500 },
        );
      },
    },
  },
});
