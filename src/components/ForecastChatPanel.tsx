import { useEffect, useRef, useState, type FormEvent } from "react";
import { authedFetch } from "@/lib/authed-fetch";

type ChatMessage = { role: "user" | "assistant"; content: string };

type ToolTraceEntry = { name: string; input: any; took_ms: number };

const SUGGESTIONS = [
  "What's our subscriber LTV in UK vs US?",
  "If monthly growth was 5% instead of 0%, what's the 12-month P50 total?",
  "How is UK Meta pacing vs target this month?",
  "Which market has the highest LTV/CAC right now?",
];

export default function ForecastChatPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTrace, setLastTrace] = useState<ToolTraceEntry[] | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || sending) return;

    const next: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setInput("");
    setError(null);
    setSending(true);
    setLastTrace(null);

    try {
      const res = await authedFetch("/api/forecast-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        text?: string;
        toolTrace?: ToolTraceEntry[];
        error?: string;
      };
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || `Request failed (${res.status})`);
      }
      setMessages((m) => [
        ...m,
        { role: "assistant", content: json.text ?? "(empty)" },
      ]);
      setLastTrace(json.toolTrace ?? []);
    } catch (err: any) {
      setError(err?.message ?? "Chat failed");
    } finally {
      setSending(false);
    }
  }

  function handleReset() {
    if (sending) return;
    setMessages([]);
    setError(null);
    setLastTrace(null);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-medium text-primary-foreground shadow-lg hover:bg-primary/90"
      >
        <SparkleIcon />
        Ask the forecast
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-40 flex h-[min(640px,80vh)] w-[min(420px,95vw)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
      <header className="flex items-center justify-between border-b border-border bg-card/95 px-3 py-2">
        <div className="flex items-center gap-2">
          <SparkleIcon />
          <div>
            <div className="text-sm font-semibold text-foreground">
              Forecast assistant
            </div>
            <div className="text-[10px] text-muted-foreground">
              Claude · live access to TW, Loop, Shopify, cohort LTV
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleReset}
            disabled={sending || messages.length === 0}
            className="rounded-md border border-input bg-background px-2 py-1 text-[11px] font-medium text-foreground hover:bg-muted disabled:opacity-40"
          >
            New
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-md border border-input bg-background px-2 py-1 text-[11px] font-medium text-foreground hover:bg-muted"
          >
            ✕
          </button>
        </div>
      </header>

      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <EmptyState onPick={(s) => setInput(s)} />
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m, i) => (
              <Bubble key={i} message={m} />
            ))}
            {sending ? (
              <div className="flex justify-start">
                <div className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                  <span className="inline-block animate-pulse">
                    Thinking · calling tools…
                  </span>
                </div>
              </div>
            ) : null}
            {error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
                {error}
              </div>
            ) : null}
            {lastTrace && lastTrace.length > 0 ? (
              <details className="text-[10px] text-muted-foreground">
                <summary className="cursor-pointer select-none">
                  {lastTrace.length} tool call{lastTrace.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-1 space-y-0.5 pl-3">
                  {lastTrace.map((t, i) => (
                    <li key={i}>
                      <code className="font-mono">{t.name}</code> · {t.took_ms}ms
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        )}
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-border bg-card/95 p-2"
      >
        <div className="flex items-end gap-1">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e as unknown as FormEvent);
              }
            }}
            placeholder="Ask about the forecast, pacing, LTV…"
            rows={2}
            className="flex-1 resize-none rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring/40"
            disabled={sending}
          />
          <button
            type="submit"
            disabled={sending || input.trim().length === 0}
            className="h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[90%] whitespace-pre-wrap rounded-lg px-3 py-2 text-xs ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground"
        }`}
      >
        {message.content}
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (s: string) => void }) {
  return (
    <div className="mt-2 flex flex-col gap-3">
      <div className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
        Connected to <strong>Triple Whale</strong>, <strong>Loop</strong>,{" "}
        <strong>Juo</strong>, <strong>Shopify</strong>, cohort LTV, and the
        live revenue forecast. Ask me anything about the numbers on this page.
      </div>
      <div className="grid grid-cols-1 gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function SparkleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M12 2l1.7 5.1L19 8.8l-5.3 1.7L12 16l-1.7-5.5L5 8.8l5.3-1.7L12 2zM19 14l.85 2.55L22 17.4l-2.15.85L19 21l-.85-2.75L16 17.4l2.15-.85L19 14zM5 14l.85 2.55L8 17.4l-2.15.85L5 21l-.85-2.75L2 17.4l2.15-.85L5 14z" />
    </svg>
  );
}
