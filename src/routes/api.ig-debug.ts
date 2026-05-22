import { createFileRoute } from "@tanstack/react-router";

// Diagnostic endpoint — open /api/ig-debug in the browser. Runs the curl
// path and the undici-fetch path independently and reports exactly what
// each one returns, so we can see WHY the Instagram fetch fails in this
// environment instead of guessing. Safe to delete once IG fetch works.
export const Route = createFileRoute("/api/ig-debug")({
  server: {
    handlers: {
      GET: async () => {
        const ua =
          process.env.INSTAGRAM_USER_AGENT ||
          "Instagram 76.0.0.15.395 Android (24/7.0; 640dpi; 1440x2560; samsung; SM-G930F; herolte; samsungexynos8890; en_US; 138226743)";
        const url =
          "https://i.instagram.com/api/v1/users/web_profile_info/?username=zapply_";

        const report: any = { url, ua, curl: {}, fetch: {}, node: {} };

        // Runtime info
        report.node.version = (globalThis as any).process?.version ?? "unknown";
        report.node.hasProcess = typeof (globalThis as any).process !== "undefined";

        // ── curl path ──
        try {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const run = promisify(execFile);
          report.curl.childProcessAvailable = true;
          try {
            const { stdout, stderr } = await run(
              "curl",
              ["-s", "-S", "--max-time", "20", "--compressed", url, "-H", `user-agent: ${ua}`],
              { maxBuffer: 32 * 1024 * 1024 },
            );
            report.curl.ran = true;
            report.curl.stderr = (stderr || "").slice(0, 300);
            report.curl.bodyLength = (stdout || "").length;
            try {
              const j = JSON.parse(stdout);
              report.curl.followers = j?.data?.user?.edge_followed_by?.count ?? null;
              report.curl.username = j?.data?.user?.username ?? null;
              report.curl.ok = report.curl.followers != null;
            } catch {
              report.curl.parseError = true;
              report.curl.bodySample = (stdout || "").slice(0, 200);
            }
          } catch (err: any) {
            report.curl.ran = false;
            report.curl.errorCode = err?.code ?? null;
            report.curl.error = (err?.stderr || err?.message || String(err)).toString().slice(0, 300);
          }
        } catch (err: any) {
          report.curl.childProcessAvailable = false;
          report.curl.importError = err?.message ?? String(err);
        }

        // ── undici fetch path ──
        try {
          const res = await fetch(url, {
            cache: "no-store",
            headers: { "user-agent": ua, Accept: "*/*" },
          });
          report.fetch.status = res.status;
          const text = await res.text().catch(() => "");
          report.fetch.bodyLength = text.length;
          try {
            const j = JSON.parse(text);
            report.fetch.followers = j?.data?.user?.edge_followed_by?.count ?? null;
            report.fetch.ok = report.fetch.followers != null;
          } catch {
            report.fetch.bodySample = text.slice(0, 200);
          }
        } catch (err: any) {
          report.fetch.error = err?.message ?? String(err);
        }

        return new Response(JSON.stringify(report, null, 2), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
