import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/zapply-token")({
  server: {
    handlers: {
      GET: async () => {
        const secret = process.env.EMBED_SECRET;
        if (!secret) {
          return new Response("EMBED_SECRET not configured", { status: 500 });
        }

        const upstream = await fetch(
          "https://zapply-chat-widget.vercel.app/api/auth/embed-token",
          {
            headers: { Authorization: `Bearer ${secret}` },
            cache: "no-store",
          },
        );
        if (!upstream.ok) {
          return new Response("Failed to fetch token", { status: 502 });
        }
        const body = await upstream.json();
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        });
      },
    },
  },
});
