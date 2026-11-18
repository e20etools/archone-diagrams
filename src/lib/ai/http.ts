import { aiStatus, checkAiRequest, globalDailyLimit, handleAiRequest, resolveProvider, workspaceProvider, type AiEnv, type Provider } from "./server-core";
import { beginUse, finishUse, isWorkspaceId, type Ticket } from "./fairUse";

/**
 * The AI endpoint as a web-standard handler (Request in, Response out), so the same code
 * runs as a Vercel Function, as a Supabase/Lovable Edge Function, and in local development.
 *
 * Extra environment variables read here:
 *   AI_ACCESS_CODE     optional shared code; when set, drafting needs the same code from the browser
 *   AI_ALLOWED_ORIGIN  optional origin (or comma-separated origins, or *) allowed to call from another domain
 *   SUPABASE_URL and SUPABASE_ANON_KEY (or the VITE_ names the app itself uses): when the app has
 *                      accounts, only signed-in people may draft. Set AI_REQUIRE_SIGN_IN=false to switch that off.
 *   AI_FAIR_USE        with accounts, every request is checked against the workspace's limits and
 *                      counted (see fairUse.ts); "off" skips that, for a database without the tables
 *   AI_GLOBAL_DAILY_REQUESTS  requests a day for everyone together (900 for Groq's free plan unless set)
 */

import { aiProviderOf } from "../integrations/catalog";
import { accounts, bearer, signedIn } from "./signin";

export type ServerEnv = AiEnv & {
  AI_ACCESS_CODE?: string;
  AI_ALLOWED_ORIGIN?: string;
  AI_REQUIRE_SIGN_IN?: string;
  AI_FAIR_USE?: string;
  AI_GLOBAL_DAILY_REQUESTS?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
};

/** A 5 MB image is about 7 MB of base64; anything larger is refused before it is read. */
const MAX_BODY_BYTES = 7_600_000;

function sameCode(given: string, expected: string): boolean {
  // Compares every character so the time taken does not reveal how much of the code was right.
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= (given.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
  return diff === 0;
}

function allowedOrigin(request: Request, env: ServerEnv): { cross: boolean; allow: string | null } {
  const origin = request.headers.get("origin");
  if (!origin) return { cross: false, allow: null };
  let sameSite = false;
  try {
    sameSite = new URL(origin).host === (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host);
  } catch {
    sameSite = false;
  }
  if (sameSite) return { cross: false, allow: null };
  const list = (env.AI_ALLOWED_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (list.includes("*")) return { cross: true, allow: "*" };
  return { cross: true, allow: list.includes(origin) ? origin : null };
}

/** The AI provider the workspace connected itself, if any: its name and models, never its key. */
async function workspaceAi(service: { url: string; key: string }, token: string, workspaceId: string, fetchImpl: typeof fetch): Promise<{ provider: string; model: string; visionModel: string } | null> {
  try {
    const response = await fetchImpl(`${service.url}/rest/v1/rpc/ai_integration`, {
      method: "POST",
      headers: { apikey: service.key, authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ p_workspace: workspaceId }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { provider?: unknown; model?: unknown; visionModel?: unknown } | null;
    if (!data || typeof data.provider !== "string" || !data.provider) return null;
    const known = aiProviderOf(data.provider);
    const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    return { provider: data.provider, model: text(data.model) || known?.model || "", visionModel: text(data.visionModel) || known?.visionModel || "" };
  } catch {
    return null;
  }
}

export function createAiHandler(getEnv: () => ServerEnv, fetchImpl: typeof fetch = fetch) {
  return async function handle(request: Request): Promise<Response> {
    const env = getEnv();
    const { cross, allow } = allowedOrigin(request, env);
    const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
    if (allow) {
      headers["access-control-allow-origin"] = allow;
      headers["access-control-allow-headers"] = "content-type, x-access-code, authorization, apikey, x-client-info";
      headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
      headers.vary = "origin";
    }
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });

    if (request.method === "OPTIONS") return new Response(null, { status: allow ? 204 : 403, headers });
    // Another website may not spend this server's AI key from its visitors' browsers.
    if (cross && !allow) return json(403, { error: "origin_not_allowed", message: "This site is not allowed to use the AI endpoint." });

    const needsCode = !!env.AI_ACCESS_CODE;
    const service = accounts(env);
    if (request.method === "GET") return json(200, { ...aiStatus(env), needsCode, needsSignIn: !!service });
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });

    if (service && !(await signedIn(request, service, fetchImpl))) {
      return json(401, { error: "sign_in_required", message: "Sign in to draft with AI." });
    }

    if (needsCode && !sameCode(request.headers.get("x-access-code") ?? "", env.AI_ACCESS_CODE!)) {
      return json(401, { error: "access_code_required", message: "This server asks for an AI access code. Enter it in Settings." });
    }
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
      return json(413, { error: "too_large", message: "The request is too large. Use an image under 5 MB." });
    }
    let body: unknown;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return json(413, { error: "too_large", message: "The request is too large. Use an image under 5 MB." });
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "bad_request", message: "The request could not be read." });
    }
    const check = checkAiRequest(body);
    if (!check.ok) return json(check.result.status, check.result.body);

    // Fair use: the workspace's limits decide, and the request is counted, before the model is asked.
    let ticket: Ticket | null = null;
    let own: Provider | undefined;
    const governed = !!service && (env.AI_FAIR_USE ?? "").toLowerCase() !== "off";
    if (governed) {
      const workspaceId = (body as { workspaceId?: unknown }).workspaceId;
      if (!isWorkspaceId(workspaceId)) return json(400, { error: "workspace_required", message: "Open a workspace to use AI." });
      // A workspace with its own AI provider uses its own key and allowance, not the server's.
      const integration = await workspaceAi(service!, bearer(request), workspaceId, fetchImpl);
      if (!integration && !resolveProvider(env)) return json(501, { error: "not_configured", message: "No AI provider is connected. An owner connects one in Settings → Integrations." });
      const begun = await beginUse(service!, bearer(request), workspaceId, check.kind, integration ? 0 : globalDailyLimit(env), fetchImpl);
      if (!begun.ok) return json(begun.status, begun.body);
      ticket = begun.ticket;
      if (integration) own = workspaceProvider(integration, { url: service!.url, anonKey: service!.key, token: bearer(request), workspaceId, usage: ticket.usage, ticket: ticket.key });
    }
    let result;
    try {
      result = await handleAiRequest(body, env, fetchImpl, own);
    } catch {
      result = { status: 500, body: { error: "server_error", message: "The draft failed on the server. Try again." } as Record<string, unknown>, tokens: 0 };
    }
    if (ticket) {
      await finishUse(service!, bearer(request), ticket, result.tokens ?? 0, result.status === 200, fetchImpl);
      const used = result.status === 200 ? 1 : 0;
      const left = ticket.remaining;
      return json(result.status, {
        ...result.body,
        allowance: left ? { hour: left.hour + 1 - used, day: left.day + 1 - used, tokens: Math.max(0, left.tokens - (result.tokens ?? 0)) } : { unlimited: true },
      });
    }
    return json(result.status, result.body);
  };
}
