import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auth/callback")({
  component: AuthCallback,
});

const ALLOWED_DOMAINS = ["zapply.nl", "codestrokes.com"];

function AuthCallback() {
  const navigate = useNavigate();
  const [message, setMessage] = useState("Signing you in…");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Supabase JS auto-detects the OAuth code in the URL and exchanges it
      // when detectSessionInUrl is true (default). Wait briefly and read user.
      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;

      if (!session?.user) {
        navigate({ to: "/login", search: { error: "auth_error" } });
        return;
      }

      const email = (session.user.email ?? "").toLowerCase();
      const allowed = ALLOWED_DOMAINS.some((d) => email.endsWith(`@${d}`));

      if (!allowed) {
        setMessage("Access denied. Signing out…");
        await supabase.auth.signOut();
        navigate({ to: "/login", search: { error: "unauthorized_domain" } });
        return;
      }

      navigate({ to: "/" });
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50">
      <div className="text-sm text-neutral-600">{message}</div>
    </div>
  );
}
