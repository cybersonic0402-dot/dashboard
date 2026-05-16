import { createFileRoute, useSearch } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Sign in — Zapply Finance Dashboard" },
      {
        name: "description",
        content: "Internal Zapply Group B.V. finance dashboard sign-in.",
      },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const { error } = useSearch({ from: "/login" });
  const allowedDomainsLabel = "@zapply.nl and @codestrokes.com";

  async function signInWithGoogle() {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        queryParams: { prompt: "select_account" },
      },
    });
  }

  return (
    <div
      className="min-h-screen bg-neutral-50 flex flex-col items-center justify-center px-4"
      style={{ fontFamily: '"Geist", ui-sans-serif, system-ui, sans-serif' }}
    >
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800;900&family=Geist:wght@400;500;600;700&display=swap');`}</style>

      <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white shadow-sm overflow-hidden">
        <div className="h-[3px] w-full bg-[#0d1d3d]" />

        <div className="px-8 py-10 flex flex-col items-center gap-6">
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#0d1d3d]">
                <span
                  className="text-[15px] font-black leading-none text-white"
                  style={{
                    fontFamily: "'Barlow Condensed', Impact, sans-serif",
                  }}
                >
                  Z
                </span>
              </div>
              <span
                className="text-[22px] font-black uppercase tracking-[0.04em] leading-none text-[#0d1d3d]"
                style={{
                  fontFamily: "'Barlow Condensed', Impact, sans-serif",
                }}
              >
                ZAPPLY
              </span>
            </div>
            <p className="text-[12px] text-neutral-400 tracking-wide uppercase font-medium">
              Finance Dashboard
            </p>
          </div>

          <div className="w-full h-px bg-neutral-100" />

          <div className="text-center">
            <h1 className="text-[16px] font-semibold text-neutral-900">
              Sign in to continue
            </h1>
            <p className="mt-1 text-[13px] text-neutral-500">
              Restricted to{" "}
              <span className="font-medium text-neutral-700">
                {allowedDomainsLabel}
              </span>{" "}
              accounts
            </p>
          </div>

          {error && (
            <div className="w-full rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
              {error === "unauthorized_domain"
                ? "Access denied. Only @zapply.nl Google accounts are allowed."
                : "Authentication failed. Please try again."}
            </div>
          )}

          <button
            onClick={signInWithGoogle}
            className="flex w-full items-center justify-center gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-[14px] font-medium text-neutral-800 shadow-sm transition hover:bg-neutral-50 hover:border-neutral-300 active:scale-[0.99]"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path
                d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z"
                fill="#4285F4"
              />
              <path
                d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z"
                fill="#34A853"
              />
              <path
                d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z"
                fill="#FBBC05"
              />
              <path
                d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z"
                fill="#EA4335"
              />
            </svg>
            Continue with Google
          </button>

          <p className="text-center text-[11px] text-neutral-400 leading-relaxed">
            By signing in you agree this tool is for internal Zapply Group B.V.
            use only.
          </p>
        </div>
      </div>

      <p className="mt-6 text-[11px] text-neutral-400">
        Zapply Group B.V. · EU data residency (Frankfurt)
      </p>
    </div>
  );
}
