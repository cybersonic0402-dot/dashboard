// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// The preset adds an aggressive `client.files: ["**/server/**"]` rule on top of TanStack
// Start's default `**/*.server.*`. This project keeps `createServerFn` exports under
// `src/server/*.functions.ts`, so the rule fires in dev and either (a) errors before the
// Start compiler can rewrite the handlers into RPC stubs, or (b) under `behavior: "mock"`
// replaces the whole file with a Proxy — so client calls never reach the server and every
// derived metric becomes NaN. Excluding `**/server/**` from the file check lets the file
// load normally; the Start compiler still strips handler bodies on the client and routes
// calls through `/_serverFn`. Specifier checks (`server-only`, etc.) remain in effect.
export default defineConfig({
  tanstackStart: {
    importProtection: {
      client: {
        excludeFiles: ["**/server/**"],
      },
    },
  },
});
