import { createFileRoute } from "@tanstack/react-router";

// Instagram CDN image proxy. The browser can't load instagram.fbcdn.net /
// cdninstagram.com URLs directly — IG's CDN drops requests whose Referer
// isn't an instagram.com origin. This route fetches the bytes server-side
// and re-streams them, so the dashboard can render post thumbnails / avatars.
//
// Usage: <img src={`/api/ig-image?url=${encodeURIComponent(remoteUrl)}`} />
//
// IMPORTANT: IG's signed CDN URLs (the ones carrying nc_sid / oh / oe params)
// expire within a few hours. When the stored snapshot is older than that —
// which happens whenever live refresh is blocked and we fall back to a stale
// snapshot — every URL is already dead and the CDN returns 403/410. There is
// no fix for an expired signed URL (expiry is server-side, IP-independent), so
// instead of surfacing a 502 + a broken-image icon we serve a neutral grey
// placeholder. The page's "live refresh was blocked" banner explains the why;
// this just keeps the UI from looking broken.

const ALLOWED_HOSTS = ["cdninstagram.com", "fbcdn.net", "instagram.com"];

function isAllowed(host: string): boolean {
  return ALLOWED_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

// 1×1-agnostic neutral tile. Matches the card background so a failed image
// blends into the grid instead of showing the browser's broken-image glyph.
const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">' +
  '<rect width="320" height="320" fill="#f4f4f5"/>' +
  '<path d="M160 132a20 20 0 1 0 0 40 20 20 0 0 0 0-40zm-72 96 36-44 26 30 38-50 44 64z" fill="#d4d4d8"/>' +
  "</svg>";

function placeholder(): Response {
  return new Response(PLACEHOLDER_SVG, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // Don't cache long — a fresh snapshot produces new URLs anyway, and we
      // want a re-fetch to pick up real images quickly once data refreshes.
      "cache-control": "public, max-age=300",
    },
  });
}

export const Route = createFileRoute("/api/ig-image")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const reqUrl = new URL(request.url);
        const raw = reqUrl.searchParams.get("url");
        if (!raw) return placeholder();

        let target: URL;
        try {
          target = new URL(raw);
        } catch {
          return placeholder();
        }
        if (target.protocol !== "https:" || !isAllowed(target.hostname)) {
          return placeholder();
        }

        try {
          const upstream = await fetch(target.toString(), {
            // IG's CDN only serves images when the request looks like it came
            // from a browser viewing instagram.com.
            headers: {
              "user-agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
              Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
              Referer: "https://www.instagram.com/",
            },
            cache: "no-store",
          });
          if (!upstream.ok || !upstream.body) {
            // Expired signed URL / blocked — degrade to a placeholder, not a 502.
            return placeholder();
          }
          const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
          return new Response(upstream.body, {
            status: 200,
            headers: {
              "content-type": contentType,
              // Valid signed URLs live a few hours; cache while valid and let
              // the browser revalidate after.
              "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
            },
          });
        } catch {
          return placeholder();
        }
      },
    },
  },
});
