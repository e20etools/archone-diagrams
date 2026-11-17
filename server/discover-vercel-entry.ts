import { createDiscoverHandler, type DiscoverServerEnv } from "../src/lib/discover/http";

/**
 * Source of api/discover.js, the Vercel Function behind /api/discover.
 * Do not edit api/discover.js by hand: `npm run build:api` bundles this file into it.
 */

// Read through globalThis with string keys, as in vercel-entry.ts: a bundler would otherwise empty `process.env`.
const hostEnv = (): DiscoverServerEnv => {
  const host = (globalThis as Record<string, unknown>)["process"] as { env?: DiscoverServerEnv } | undefined;
  return host?.["env"] ?? {};
};

export default { fetch: createDiscoverHandler(hostEnv) };
