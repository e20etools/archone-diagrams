import { createAiHandler, type ServerEnv } from "../src/lib/ai/http";

/**
 * Source of api/ai.js, the Vercel Function behind /api/ai.
 * Do not edit api/ai.js by hand: `npm run build:api` bundles this file into it.
 */

// Read through globalThis with string keys: a bundler replaces the literal `process.env` with an
// empty object at build time, which would hide the host's settings from the function.
const hostEnv = (): ServerEnv => {
  const host = (globalThis as Record<string, unknown>)["process"] as { env?: ServerEnv } | undefined;
  return host?.["env"] ?? {};
};

export default { fetch: createAiHandler(hostEnv) };
