import { createApmHandler, type ApmEnv } from "../src/lib/apm/http";

/**
 * Source of api/apm.js, the Vercel Function behind /api/apm.
 * Do not edit api/apm.js by hand: `npm run build:api` bundles this file into it.
 */

// Read through globalThis with string keys, as in vercel-entry.ts: a bundler would otherwise empty `process.env`.
const hostEnv = (): ApmEnv => {
  const host = (globalThis as Record<string, unknown>)["process"] as { env?: ApmEnv } | undefined;
  return host?.["env"] ?? {};
};

export default { fetch: createApmHandler(hostEnv) };
