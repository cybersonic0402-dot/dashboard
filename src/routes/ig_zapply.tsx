import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getInstagramProfile } from "@/server/dashboard.functions";
import {
  RefreshCw, BadgeCheck, ExternalLink, Heart, MessageCircle,
  Play, Grid3x3, TrendingUp, AlertCircle,
} from "lucide-react";

// URL-only page — intentionally NOT added to the dashboard sidebar.
// Reachable at /ig_zapply.
export const Route = createFileRoute("/ig_zapply")({
  head: () => ({ meta: [{ title: "@zapply_ · Instagram" }] }),
  component: IgZapplyPage,
});

const fmt = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
};
const fmtFull = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : n.toLocaleString();

function IgZapplyPage() {
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      const p = await getInstagramProfile();
      setProfile(p);
    } catch (err: any) {
      // Server fn itself failed (network / 500). Surface the real reason
      // instead of leaving profile null (which read as a generic block).
      setProfile({ username: "zapply_", followers: null, error: err?.message ?? "request failed" });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const igGradient = "linear-gradient(45deg,#f09433 0%,#e6683c 25%,#dc2743 50%,#cc2366 75%,#bc1888 100%)";

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center">
        <div className="flex items-center gap-3 text-neutral-500">
          <RefreshCw className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading @zapply_…</span>
        </div>
      </div>
    );
  }

  const blocked = !profile || (profile.followers == null && profile.error);

  return (
    <div className="min-h-screen bg-gradient-to-b from-neutral-50 to-neutral-100 py-8 px-4">
      <div className="mx-auto max-w-4xl">
        {/* ── Profile card ── */}
        <div className="overflow-hidden rounded-3xl bg-white shadow-xl ring-1 ring-black/5">
          {/* Gradient banner */}
          <div className="h-28 w-full" style={{ background: igGradient }} />

          <div className="px-6 pb-6 sm:px-10">
            {/* Avatar overlapping banner */}
            <div className="-mt-14 flex items-end justify-between">
              <div className="rounded-full p-1" style={{ background: igGradient }}>
                <div className="rounded-full bg-white p-1">
                  {profile?.profilePic ? (
                    <img
                      src={profile.profilePic}
                      alt={profile.username}
                      referrerPolicy="no-referrer"
                      className="h-24 w-24 rounded-full object-cover"
                    />
                  ) : (
                    <div className="grid h-24 w-24 place-items-center rounded-full bg-neutral-100 text-2xl font-bold text-neutral-400">
                      {(profile?.username ?? "z")[0]?.toUpperCase()}
                    </div>
                  )}
                </div>
              </div>
              <button
                onClick={() => {
                  setRefreshing(true);
                  load();
                }}
                disabled={refreshing}
                className="mb-2 inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-4 py-2 text-[13px] font-medium text-neutral-700 shadow-sm hover:bg-neutral-50 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>

            {/* Name + handle */}
            <div className="mt-4">
              <div className="flex items-center gap-2">
                <h1 className="text-[22px] font-bold tracking-tight text-neutral-900">
                  {profile?.fullName ?? profile?.username ?? "@zapply_"}
                </h1>
                {profile?.isVerified && <BadgeCheck className="h-5 w-5 text-sky-500" fill="currentColor" stroke="white" />}
              </div>
              <a
                href={`https://www.instagram.com/${profile?.username ?? "zapply_"}/`}
                target="_blank"
                rel="noreferrer"
                className="text-[14px] font-medium text-neutral-500 hover:text-neutral-700"
              >
                @{profile?.username ?? "zapply_"}
              </a>
              {profile?.category && (
                <div className="mt-1 inline-flex items-center gap-1.5">
                  <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600">
                    {profile.category}
                  </span>
                  {profile?.isBusiness && (
                    <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700">
                      Business
                    </span>
                  )}
                  {profile?.highlightReelCount != null && profile.highlightReelCount > 0 && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                      {profile.highlightReelCount} highlights
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Stats row */}
            <div className="mt-6 grid grid-cols-3 divide-x divide-neutral-100 rounded-2xl border border-neutral-100 bg-neutral-50/60">
              <Stat label="Posts" value={fmt(profile?.postsCount)} full={fmtFull(profile?.postsCount)} />
              <Stat label="Followers" value={fmt(profile?.followers)} full={fmtFull(profile?.followers)} highlight />
              <Stat label="Following" value={fmt(profile?.following)} full={fmtFull(profile?.following)} />
            </div>

            {/* Bio */}
            {profile?.biography && (
              <p className="mt-5 whitespace-pre-line text-[14px] leading-relaxed text-neutral-700">
                {profile.biography}
              </p>
            )}
            {profile?.externalUrl && (
              <a
                href={profile.externalUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-semibold text-violet-600 hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {profile.externalUrl.replace(/^https?:\/\//, "")}
              </a>
            )}

            {/* Stale / blocked notice */}
            {(profile?.stale || blocked) && (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                <AlertCircle className="h-4 w-4 mt-px shrink-0" />
                <div>
                  {blocked ? (
                    <>
                      Live fetch blocked: {profile?.error ?? profile?.liveError ?? "rate-limited"}. The
                      public endpoint works fine from a residential IP, but Instagram rate-limits
                      datacenter IPs (e.g. Vercel). The session-cookie warm-up retries automatically; if
                      it keeps failing in production, set <code>INSTAGRAM_PROXY_URL</code> to route through
                      a residential proxy.
                    </>
                  ) : (
                    <>Showing last cached snapshot{profile?.fetchedAt ? ` from ${new Date(profile.fetchedAt).toLocaleString("en-GB")}` : ""} — live refresh was blocked.</>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Engagement summary ── */}
        {!blocked && (profile?.avgLikes != null || profile?.engagementRate != null) && (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <EngagementCard
              icon={<Heart className="h-4 w-4 text-rose-500" />}
              label="Avg likes / post"
              value={fmt(profile?.avgLikes)}
              tint="rose"
            />
            <EngagementCard
              icon={<MessageCircle className="h-4 w-4 text-sky-500" />}
              label="Avg comments / post"
              value={fmt(profile?.avgComments)}
              tint="sky"
            />
            <EngagementCard
              icon={<TrendingUp className="h-4 w-4 text-emerald-500" />}
              label="Engagement rate"
              value={profile?.engagementRate != null ? `${profile.engagementRate.toFixed(2)}%` : "—"}
              tint="emerald"
            />
          </div>
        )}

        {/* ── Recent posts grid ── */}
        {!blocked && Array.isArray(profile?.posts) && profile.posts.length > 0 && (
          <div className="mt-6">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-neutral-600">
              <Grid3x3 className="h-4 w-4" /> Recent posts
            </div>
            <div className="grid grid-cols-3 gap-1.5 sm:gap-3 md:grid-cols-4">
              {profile.posts.map((p: any) => (
                <a
                  key={p.id}
                  href={p.url ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  className="group relative aspect-square overflow-hidden rounded-xl bg-neutral-100"
                >
                  {p.thumbnail ? (
                    <img
                      src={p.thumbnail}
                      alt=""
                      referrerPolicy="no-referrer"
                      loading="lazy"
                      className="h-full w-full object-cover transition group-hover:scale-105"
                    />
                  ) : (
                    <div className="h-full w-full bg-neutral-200" />
                  )}
                  {p.isVideo && (
                    <div className="absolute right-2 top-2 rounded-full bg-black/50 p-1">
                      <Play className="h-3 w-3 text-white" fill="white" />
                    </div>
                  )}
                  {/* Hover overlay with engagement */}
                  <div className="absolute inset-0 flex items-center justify-center gap-4 bg-black/55 opacity-0 transition group-hover:opacity-100">
                    <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-white">
                      <Heart className="h-4 w-4" fill="white" /> {fmt(p.likes)}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-white">
                      <MessageCircle className="h-4 w-4" fill="white" /> {fmt(p.comments)}
                    </span>
                  </div>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="mt-6 text-center text-[11px] text-neutral-400">
          {profile?.fetchedAt && !blocked
            ? `Synced ${new Date(profile.fetchedAt).toLocaleString("en-GB")} · live from Instagram`
            : "Instagram profile viewer"}
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  full,
  highlight,
}: {
  label: string;
  value: string;
  full: string;
  highlight?: boolean;
}) {
  return (
    <div className="px-2 py-4 text-center" title={full}>
      <div className={`text-[22px] font-bold tabular-nums leading-none ${highlight ? "text-violet-700" : "text-neutral-900"}`}>
        {value}
      </div>
      <div className="mt-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">{label}</div>
    </div>
  );
}

function EngagementCard({
  icon,
  label,
  value,
  tint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tint: "rose" | "sky" | "emerald";
}) {
  const bg = { rose: "bg-rose-50", sky: "bg-sky-50", emerald: "bg-emerald-50" }[tint];
  return (
    <div className="rounded-2xl border border-neutral-100 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <span className={`grid h-7 w-7 place-items-center rounded-lg ${bg}`}>{icon}</span>
        <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">{label}</span>
      </div>
      <div className="mt-2 text-[24px] font-bold tabular-nums text-neutral-900">{value}</div>
    </div>
  );
}
