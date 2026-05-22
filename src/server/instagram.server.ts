/**
 * Instagram profile fetcher — public web_profile_info endpoint.
 *
 * GET https://i.instagram.com/api/v1/users/web_profile_info/?username=<u>
 * with a mobile-app `user-agent`. No API key, no login.
 *
 * Session-cookie warm-up: the FIRST request needs no cookie and returns a
 * `Set-Cookie` (csrftoken + mid). Reusing those cookies on subsequent
 * requests is what keeps Instagram from rate-limiting the caller — so we
 * capture them, persist to data_cache (instagram/session), and replay them
 * on the next call. A fresh warm-up against instagram.com is done when no
 * stored cookie exists.
 *
 * Field mapping verified against a captured response
 * (instagramapiresponse.json):
 *   followers → data.user.edge_followed_by.count
 *   following → data.user.edge_follow.count
 *   posts     → data.user.edge_owner_to_timeline_media.count + .edges[]
 *
 * Env overrides: INSTAGRAM_USERNAME, INSTAGRAM_USER_AGENT,
 * INSTAGRAM_COOKIE (force a specific cookie), INSTAGRAM_PROXY_URL (route
 * through a residential proxy when the host IP is hard-blocked).
 *
 * Note: a residential IP / Postman is never rate-limited; a datacenter IP
 * (Vercel) can be. The cookie warm-up mitigates soft limits; a hard IP
 * block needs INSTAGRAM_PROXY_URL.
 */

const DEFAULT_USERNAME = "zapply_";
const DEFAULT_IG_UA =
  "Instagram 76.0.0.15.395 Android (24/7.0; 640dpi; 1440x2560; samsung; SM-G930F; herolte; samsungexynos8890; en_US; 138226743)";
// Default cookie copied from the working Postman request. Instagram serves
// web_profile_info to requests that carry a csrftoken + mid; the bare
// (cookie-less) request gets rejected from non-browser clients. Override
// with INSTAGRAM_COOKIE when this one expires (grab a fresh csrftoken/mid
// from any logged-out instagram.com page load or your Postman cookie jar).
const DEFAULT_IG_COOKIE =
  "csrftoken=ucYwY6zILQAWKQlgP4EED0nHSoktnzy0; mid=ag_-MAABAAH2-XQwWkvP187AbTh0";

function username(): string {
  return (process.env.INSTAGRAM_USERNAME || DEFAULT_USERNAME).replace(/^@/, "").trim();
}

export type InstagramPost = {
  id: string;
  shortcode: string | null;
  url: string | null;
  thumbnail: string | null;
  isVideo: boolean;
  likes: number | null;
  comments: number | null;
  views: number | null;
  caption: string | null;
  takenAt: number | null;
};

export type InstagramProfile = {
  username: string;
  fullName: string | null;
  biography: string | null;
  externalUrl: string | null;
  profilePic: string | null;
  isVerified: boolean;
  isBusiness: boolean;
  isPrivate: boolean;
  category: string | null;
  highlightReelCount: number | null;
  followers: number | null;
  following: number | null;
  postsCount: number | null;
  posts: InstagramPost[];
  avgLikes: number | null;
  avgComments: number | null;
  engagementRate: number | null;
  fetchedAt: string;
  error?: string;
};

export type InstagramResult = {
  username: string;
  followers: number | null;
  following: number | null;
  posts: number | null;
  source: "public" | null;
  fetchedAt: string;
  error?: string;
};

// Optional residential proxy (only when INSTAGRAM_PROXY_URL is set) for the
// production case where Instagram hard-blocks the datacenter IP.
async function buildDispatcher(): Promise<any | undefined> {
  const proxy = process.env.INSTAGRAM_PROXY_URL;
  if (!proxy) return undefined;
  try {
    const undici = await import("undici");
    return new (undici as any).ProxyAgent(proxy);
  } catch (err: any) {
    console.warn("[instagram] proxy agent init failed:", err?.message ?? err);
    return undefined;
  }
}

// Run the request through the system `curl` binary. This is the most
// reliable path: Instagram's anti-bot allows curl's TLS fingerprint but
// often blocks Node's undici fetch from the same IP — which is exactly the
// "works in Postman/curl, fails in the dashboard" symptom. Requires curl on
// PATH (present on Windows 10+, macOS, and most Linux/Vercel images).
// Returns the parsed user object, or throws with a precise reason. Just the
// user-agent header — matches the request that returns 200 in every API
// tester. Cookie is added only if explicitly configured.
async function fetchViaCurl(url: string, ua: string): Promise<any> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const args = ["-s", "-S", "--max-time", "20", "--compressed", url, "-H", `user-agent: ${ua}`];
  const forced = process.env.INSTAGRAM_COOKIE;
  if (forced) args.push("-H", `Cookie: ${forced}`);

  let stdout = "";
  try {
    const out = await run("curl", args, { maxBuffer: 32 * 1024 * 1024 });
    stdout = out.stdout ?? "";
  } catch (err: any) {
    // curl missing from PATH, or non-zero exit
    const code = err?.code;
    if (code === "ENOENT") throw new Error("curl binary not found on PATH");
    throw new Error(`curl error: ${(err?.stderr || err?.message || String(err)).toString().slice(0, 160)}`);
  }
  if (!stdout.trim()) throw new Error("curl returned an empty body");
  let json: any;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error(`curl returned non-JSON: ${stdout.slice(0, 120)}`);
  }
  const u = json?.data?.user;
  if (!u) throw new Error(`curl JSON had no data.user: ${stdout.slice(0, 120)}`);
  return u;
}

async function fetchRaw(): Promise<any> {
  const user = username();
  const ua = process.env.INSTAGRAM_USER_AGENT || DEFAULT_IG_UA;
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(user)}`;

  // 1. Primary: system curl (the request that returns 200 in every tester;
  // curl's TLS fingerprint is accepted where Node's undici is blocked).
  let curlError: string | null = null;
  try {
    return await fetchViaCurl(url, ua);
  } catch (err: any) {
    curlError = err?.message ?? String(err);
    console.warn("[instagram] curl path:", curlError);
  }

  // 2. Fallback: undici fetch (for hosts without curl). No manual
  // Accept-Encoding (it breaks res.json() under undici).
  const dispatcher = await buildDispatcher();
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      headers: { "user-agent": ua, Accept: "*/*" },
      ...(dispatcher ? { dispatcher } : {}),
    } as any);
  } catch (err: any) {
    throw new Error(`Both paths failed — curl: [${curlError}]; fetch: [${err?.message ?? err}]`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 120);
    throw new Error(`curl: [${curlError}]; fetch HTTP ${res.status}${body ? `: ${body}` : ""}`);
  }
  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new Error(`curl: [${curlError}]; fetch returned non-JSON body`);
  }
  const u = json?.data?.user;
  if (!u) throw new Error(`curl: [${curlError}]; fetch JSON had no data.user`);
  return u;
}

export async function fetchInstagramProfile(): Promise<InstagramProfile> {
  const user = username();
  const base: InstagramProfile = {
    username: user,
    fullName: null,
    biography: null,
    externalUrl: null,
    profilePic: null,
    isVerified: false,
    isBusiness: false,
    isPrivate: false,
    category: null,
    highlightReelCount: null,
    followers: null,
    following: null,
    postsCount: null,
    posts: [],
    avgLikes: null,
    avgComments: null,
    engagementRate: null,
    fetchedAt: new Date().toISOString(),
  };

  let u: any;
  try {
    u = await fetchRaw();
  } catch (err: any) {
    return { ...base, error: err?.message ?? "fetch failed" };
  }

  const mediaEdges: any[] = u?.edge_owner_to_timeline_media?.edges ?? [];
  const posts: InstagramPost[] = mediaEdges.map((e: any) => {
    const node = e?.node ?? {};
    return {
      id: String(node?.id ?? ""),
      shortcode: node?.shortcode ?? null,
      url: node?.shortcode ? `https://www.instagram.com/p/${node.shortcode}/` : null,
      thumbnail: node?.thumbnail_src ?? node?.display_url ?? null,
      isVideo: !!node?.is_video,
      likes:
        Number(node?.edge_liked_by?.count ?? node?.edge_media_preview_like?.count ?? NaN) || null,
      comments: Number(node?.edge_media_to_comment?.count ?? NaN) || null,
      views: Number(node?.video_view_count ?? NaN) || null,
      caption: node?.edge_media_to_caption?.edges?.[0]?.node?.text ?? null,
      takenAt: Number(node?.taken_at_timestamp ?? NaN) || null,
    };
  });

  const followers = Number(u?.edge_followed_by?.count ?? NaN) || null;
  const withLikes = posts.filter((p) => p.likes != null);
  const avgLikes = withLikes.length
    ? Math.round(withLikes.reduce((s, p) => s + (p.likes ?? 0), 0) / withLikes.length)
    : null;
  const withComments = posts.filter((p) => p.comments != null);
  const avgComments = withComments.length
    ? Math.round(withComments.reduce((s, p) => s + (p.comments ?? 0), 0) / withComments.length)
    : null;
  const engagementRate =
    followers && followers > 0 && (avgLikes != null || avgComments != null)
      ? (((avgLikes ?? 0) + (avgComments ?? 0)) / followers) * 100
      : null;

  return {
    username: u?.username ?? user,
    fullName: u?.full_name ?? null,
    biography: u?.biography ?? null,
    externalUrl: u?.external_url ?? u?.bio_links?.[0]?.url ?? null,
    profilePic: u?.profile_pic_url_hd ?? u?.profile_pic_url ?? null,
    isVerified: !!u?.is_verified,
    isBusiness: !!u?.is_business_account,
    isPrivate: !!u?.is_private,
    category: u?.category_name ?? u?.business_category_name ?? null,
    highlightReelCount: Number(u?.highlight_reel_count ?? NaN) || null,
    followers,
    following: Number(u?.edge_follow?.count ?? NaN) || null,
    postsCount: Number(u?.edge_owner_to_timeline_media?.count ?? NaN) || null,
    posts,
    avgLikes,
    avgComments,
    engagementRate,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchInstagramFollowers(): Promise<InstagramResult> {
  const p = await fetchInstagramProfile();
  return {
    username: p.username,
    followers: p.followers,
    following: p.following,
    posts: p.postsCount,
    source: p.followers != null ? "public" : null,
    fetchedAt: p.fetchedAt,
    error: p.error,
  };
}
