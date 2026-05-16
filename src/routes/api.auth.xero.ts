import { createFileRoute } from "@tanstack/react-router";

// Initiates the Xero OAuth 2.0 Authorization Code flow.
// Visit /api/auth/xero while logged in to connect your Xero organization.

// Xero OAuth 2.0 scopes validated against the official docs:
// https://developer.xero.com/documentation/guides/oauth2/scopes/
// Keep this list to the exact read-only Accounting scopes used by fetchXero().
// Requesting unused or unassigned scopes is what causes Xero's invalid_scope screen.
const XERO_DEFAULT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "accounting.invoices.read",
  "accounting.banktransactions.read",
  "accounting.manualjournals.read",
  "accounting.contacts.read",
  "accounting.settings.read",
  "accounting.reports.profitandloss.read",
  "accounting.reports.balancesheet.read",
  "accounting.reports.banksummary.read",
];

const XERO_SCOPES = process.env.XERO_SCOPES ?? XERO_DEFAULT_SCOPES.join(" ");

export const Route = createFileRoute("/api/auth/xero")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const clientId = process.env.XERO_CLIENT_ID;
        const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? new URL(request.url).origin;
        const redirectUri = `${appUrl}/api/auth/xero/callback`;

        if (!clientId) {
          return Response.json({ error: "XERO_CLIENT_ID not set" }, { status: 500 });
        }

        const stateBytes = new Uint8Array(32);
        crypto.getRandomValues(stateBytes);
        const state = Array.from(stateBytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

        const params = new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: XERO_SCOPES,
          state,
        });

        const authUrl = `https://login.xero.com/identity/connect/authorize?${params.toString().replace(/\+/g, "%20")}`;
        console.log("[Xero OAuth] redirect_uri:", redirectUri);
        console.log("[Xero OAuth] scopes:", XERO_SCOPES);

        return new Response(null, {
          status: 302,
          headers: {
            Location: authUrl,
            "Set-Cookie": `xero_state=${state}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax`,
          },
        });
      },
    },
  },
});
