// Vercel Node serverless entry — wraps the TanStack Start SSR fetch handler
// produced by `vite build` at dist/server/server.js. The TanStack handler
// speaks the Web Fetch API (Request → Response); this file bridges it to
// Vercel's Node request/response objects.
//
// The static import below is required so @vercel/node's bundler traces the
// SSR bundle into the function. The dynamic asset chunks under
// dist/server/assets/ are pulled in via the `includeFiles` glob in
// vercel.json — without it the tracer misses code-split routes.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

// @ts-ignore — built artifact, no .d.ts
import server from "../dist/server/server.js";

export const config = { runtime: "nodejs" } as const;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const host = (req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost") as string;
    const proto = (req.headers["x-forwarded-proto"] ?? "https") as string;
    const url = `${proto}://${host}${req.url ?? "/"}`;

    const method = (req.method ?? "GET").toUpperCase();
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      if (Array.isArray(value)) for (const v of value) headers.append(key, v);
      else headers.set(key, String(value));
    }

    const hasBody = method !== "GET" && method !== "HEAD";
    const request = new Request(url, {
      method,
      headers,
      body: hasBody ? (Readable.toWeb(req) as unknown as BodyInit) : undefined,
      // @ts-expect-error — duplex is required for streaming bodies in Node
      duplex: "half",
    });

    const response: Response = await server.fetch(request);

    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") res.appendHeader?.(key, value) ?? res.setHeader(key, value);
      else res.setHeader(key, value);
    });

    if (!response.body) {
      res.end();
      return;
    }
    const nodeStream = Readable.fromWeb(response.body as any);
    nodeStream.pipe(res);
  } catch (err: any) {
    console.error("[vercel/api/server] handler error:", err?.stack ?? err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain; charset=utf-8");
    }
    res.end(`Internal Server Error: ${err?.message ?? "unknown"}`);
  }
}
