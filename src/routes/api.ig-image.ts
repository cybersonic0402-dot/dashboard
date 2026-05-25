import { createFileRoute } from "@tanstack/react-router";

// Instagram CDN image proxy. The browser can't load instagram.fbcdn.net /
// cdninstagram.com URLs directly — IG's CDN drops requests whose Referer
// isn't an instagram.com origin (and signed URLs additionally expire).
// This route fetches the bytes server-side and re-streams them, so the
// dashboard can render post thumbnails and avatars.
//
// Usage: <img src={`/api/ig-image?url=${encodeURIComponent(remoteUrl)}`} />

const ALLOWED_HOSTS = [
  "cdninstagram.com",
  "fbcdn.net",
  "instagram.com",
];

function isAllowed(host: string): boolean {
  return ALLOWED_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export const Route = createFileRoute("/api/ig-image")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const reqUrl = new URL(request.url);
        const raw = reqUrl.searchParams.get("url");
        if (!raw) return new Response("missing url", { status: 400 });

        let target: URL;
        try {
          target = new URL(raw);
        } catch {
          return new Response("invalid url", { status: 400 });
        }
        if (target.protocol !== "https:" || !isAllowed(target.hostname)) {
          return new Response("host not allowed", { status: 400 });
        }

        try {
          const upstream = await fetch(target.toString(), {
            // Instagram's CDN only serves images when the request looks
            // like it came from a browser viewing instagram.com.
            headers: {
              "user-agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
              Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
              Referer: "https://www.instagram.com/",
            },
            cache: "no-store",
          });
          if (!upstream.ok || !upstream.body) {
            return new Response(`upstream ${upstream.status}`, { status: 502 });
          }
          const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
          return new Response(upstream.body, {
            status: 200,
            headers: {
              "content-type": contentType,
              // IG signed URLs expire after a few hours; cache aggressively
              // while they're valid but let the browser revalidate.
              "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
            },
          });
        } catch (err: any) {
          return new Response(`proxy error: ${err?.message ?? String(err)}`, { status: 502 });
        }
      },
    },
  },
});
