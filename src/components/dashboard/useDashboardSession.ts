import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

const ALLOWED_DOMAINS = ["zapply.nl", "codestrokes.com"];

function isPreviewEnvironment() {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return (
    host.includes("id-preview--") ||
    host.includes("lovableproject.com") ||
    host === "localhost" ||
    host === "127.0.0.1"
  );
}

const PREVIEW_MOCK_SESSION = {
  user: {
    email: "preview@zapply.nl",
    user_metadata: { full_name: "Preview User", avatar_url: null },
  },
} as unknown as Session;

export interface DashboardUser {
  email: string;
  name: string;
  avatar: string | null;
}

export function useDashboardSession(): { user: DashboardUser | null; loading: boolean } {
  const navigate = useNavigate();
  const previewBypass = isPreviewEnvironment();
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    if (previewBypass) {
      const t = window.setTimeout(() => setSession(PREVIEW_MOCK_SESSION), 0);
      return () => window.clearTimeout(t);
    }

    const timeout = window.setTimeout(() => {
      setSession((current) => (current === undefined ? null : current));
    }, 4000);
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      window.clearTimeout(timeout);
      setSession(s);
    });
    supabase.auth.getSession()
      .then(({ data: { session: s } }) => setSession(s))
      .catch(() => setSession(null))
      .finally(() => window.clearTimeout(timeout));
    return () => {
      window.clearTimeout(timeout);
      sub.subscription.unsubscribe();
    };
  }, [previewBypass]);

  useEffect(() => {
    if (session === undefined) return;
    if (!session) {
      navigate({ to: "/login", search: { error: undefined } });
      return;
    }
    if (!previewBypass) {
      const email = (session.user.email ?? "").toLowerCase();
      const ok = ALLOWED_DOMAINS.some((d) => email.endsWith(`@${d}`));
      if (!ok) {
        supabase.auth.signOut().then(() =>
          navigate({ to: "/login", search: { error: "unauthorized_domain" } })
        );
      }
    }
  }, [session, navigate, previewBypass]);

  if (session === undefined || !session) {
    return { user: null, loading: true };
  }

  const meta = session.user.user_metadata as Record<string, string> | null;
  return {
    user: {
      email: session.user.email ?? "",
      name: meta?.full_name ?? session.user.email ?? "",
      avatar: meta?.avatar_url ?? meta?.picture ?? meta?.avatar ?? null,
    },
    loading: false,
  };
}
