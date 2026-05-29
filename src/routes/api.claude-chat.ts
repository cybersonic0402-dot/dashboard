import { createFileRoute } from "@tanstack/react-router";
import Anthropic from "@anthropic-ai/sdk";

type ChatMessage = { role: "user" | "assistant"; content: string };

const SYSTEM_PROMPT = `You are the Finance Assistant for Zapply, an internal forecasting and analytics tool used by the finance team.

You help users reason about:
- Revenue forecasting with cohort-based LTV (subscribers vs one-time, NL/BE, UK, US markets)
- Channel pacing for Meta, Google, TikTok (spend, ROAS, ±15% deviation flags)
- Supply chain pouch forecasts derived from revenue
- Scenario modeling ("what if partner X launches July 1")

You currently have READ-ONLY conversational access — no direct data lookups or write-backs yet. If a user asks for live numbers, say plainly that this view is conversational and point them to the relevant dashboard route. Be concise, numerate, and avoid hedging.`;

export const Route = createFileRoute("/api/claude-chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
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

        const cleaned = messages
          .filter(
            (m) =>
              m &&
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string" &&
              m.content.trim().length > 0,
          )
          .map((m) => ({ role: m.role, content: m.content }));

        const client = new Anthropic({ apiKey });

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            try {
              const response = await client.messages.stream({
                model: "claude-sonnet-4-6",
                max_tokens: 1024,
                system: SYSTEM_PROMPT,
                messages: cleaned,
              });

              for await (const event of response) {
                if (
                  event.type === "content_block_delta" &&
                  event.delta.type === "text_delta"
                ) {
                  controller.enqueue(encoder.encode(event.delta.text));
                }
              }
              controller.close();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              controller.enqueue(encoder.encode(`\n[error: ${msg}]`));
              controller.close();
            }
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "x-accel-buffering": "no",
          },
        });
      },
    },
  },
});
