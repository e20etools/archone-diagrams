import { ProcessRequestError, processRequestBody } from "../bpm/api";
import { openApiDocument } from "./openapi";

/**
 * The public REST API as a web-standard request handler. It is deliberately thin: it reads
 * the key, the path and the body, hands them to the database function api_request(), and
 * passes the reply on. Every rule of the API is in the database (see the phase2_api
 * migration), so this file holds no access logic to get wrong. The one thing it adds is laying
 * out a process sent as a list of steps as a BPMN file, which the database then checks.
 */

export type ApiEnv = Record<string, string | undefined>;
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, x-api-key",
  "Access-Control-Max-Age": "86400",
};
const MAX_BODY = 1024 * 1024;

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { ...CORS, ...(status === 204 ? {} : { "Content-Type": "application/json; charset=utf-8" }), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
const problem = (status: number, code: string, message: string) => json(status, { error: { code, message } });

export function createApiHandler(getEnv: () => ApiEnv, fetchImpl: Fetch = (input, init) => fetch(input, init)) {
  return async function handle(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    // The function is called "api" and the API starts at its version: .../api/v1/objects.
    const match = /\/api\/v1(\/.*)?$/.exec(url.pathname) ?? /^\/v1(\/.*)?$/.exec(url.pathname);
    if (!match) return problem(404, "not_found", "The API lives under /v1, for example /v1/objects.");
    const path = match[1] ?? "";

    const env = getEnv();
    const base = (env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? "").replace(/\/$/, "");
    const anon = env.SUPABASE_ANON_KEY ?? env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
    // The function sees its own internal address, so the public one is built from the project's.
    if (path === "/openapi.json" && request.method === "GET") return json(200, openApiDocument(base ? `${base}/functions/v1/api/v1` : `${url.origin}${url.pathname.slice(0, -"/openapi.json".length)}`));
    if (!base || !anon) return problem(501, "not_configured", "The API is not connected to a database. Set SUPABASE_URL and SUPABASE_ANON_KEY for this function.");

    const header = request.headers.get("authorization") ?? "";
    const key = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : (request.headers.get("x-api-key") ?? "").trim();

    let body: unknown = null;
    if (request.method === "POST" || request.method === "PATCH") {
      const text = await request.text();
      if (text.length > MAX_BODY) return problem(413, "too_large", "The request body is larger than 1 MB.");
      if (text.trim()) {
        try {
          body = JSON.parse(text);
        } catch {
          return problem(400, "invalid", "The request body is not valid JSON.");
        }
      }
    }
    // A process may be sent as a list of steps: laid out here as BPMN, then checked by the database like any other.
    if ((request.method === "POST" || request.method === "PATCH") && /^\/processes(\/[^/]+)?\/?$/.test(path)) {
      try {
        body = processRequestBody(body, request.method === "POST");
      } catch (error) {
        if (error instanceof ProcessRequestError) return problem(422, "invalid", error.message);
        throw error;
      }
    }
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, name) => {
      if (!(name in query)) query[name] = value;
    });

    let reply: Response;
    try {
      reply = await fetchImpl(`${base}/rest/v1/rpc/api_request`, {
        method: "POST",
        headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_key: key, p_method: request.method, p_path: path, p_query: query, p_body: body }),
      });
    } catch {
      return problem(502, "unavailable", "The database could not be reached. Try again shortly.");
    }
    if (!reply.ok) return problem(502, "unavailable", "The database refused the request. Check that the API migration has been applied.");
    const result = (await reply.json().catch(() => null)) as { status?: number; body?: unknown } | null;
    if (!result || typeof result.status !== "number") return problem(502, "unavailable", "The database sent a reply this API could not read.");
    return json(result.status, result.body ?? null);
  };
}
