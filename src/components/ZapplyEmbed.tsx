import { useEffect, useState, type CSSProperties } from "react";

/**
 * Embeds the Zapply chat widget hosted at zapply-chat-widget.vercel.app.
 *
 * Renders as an 80×80 button anchored bottom-right by default. The widget
 * itself posts `zapply:open` / `zapply:close` messages to switch between
 * collapsed and fullscreen overlay modes — we react to those by swapping
 * the iframe's positioning style.
 *
 * Token is fetched server-side via /api/zapply-token which exchanges the
 * EMBED_SECRET for a short-lived widget token.
 */
const WIDGET_ORIGIN = "https://zapply-chat-widget.vercel.app";

const COLLAPSED_STYLE: CSSProperties = {
  position: "fixed",
  bottom: 20,
  right: 20,
  width: 80,
  height: 80,
  border: "none",
  zIndex: 9999,
};

const EXPANDED_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  width: "100%",
  height: "100%",
  border: "none",
  zIndex: 9999,
};

export default function ZapplyEmbed() {
  const [src, setSrc] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/zapply-token", { cache: "no-store" })
      .then((r) => r.json())
      .then(({ token }: { token?: string }) => {
        if (!cancelled && token) {
          setSrc(`${WIDGET_ORIGIN}?token=${encodeURIComponent(token)}`);
        }
      })
      .catch(() => {
        /* widget just won't render */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handle(e: MessageEvent) {
      // Only trust messages from the widget origin — otherwise any page
      // could toggle the overlay on top of the dashboard.
      if (e.origin !== WIDGET_ORIGIN) return;
      const data = e.data as { type?: string } | undefined;
      if (!data || typeof data.type !== "string") return;
      if (data.type === "zapply:open") setExpanded(true);
      else if (data.type === "zapply:close") setExpanded(false);
    }
    window.addEventListener("message", handle);
    return () => window.removeEventListener("message", handle);
  }, []);

  if (!src) return null;

  return (
    <iframe
      id="zapply-widget"
      title="Zapply chat"
      src={src}
      style={expanded ? EXPANDED_STYLE : COLLAPSED_STYLE}
      allowTransparency
    />
  );
}
