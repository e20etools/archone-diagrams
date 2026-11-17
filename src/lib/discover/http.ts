import { isWorkspaceId } from "../ai/fairUse";
import { accounts, bearer, type AccountsEnv } from "../ai/signin";
import type { Inventory } from "../inventory/model";
import { DiscoverError, Remote, type DiscoverEnv } from "./remote";
import { SOURCES, sourceOf, type SourceId } from "./sources";

/**
 * /api/discover: live discovery from the sources this server has credentials for.
 *
 *   GET   which sources are connected (names only: no address, account or key).
 *   POST  { source, workspaceId }  reads that source and answers { inventory }.
 *
 * The credentials speak for the organisation, so only someone signed in who may edit the
 * workspace can use them. Without accounts the endpoint refuses, unless the host says
 * DISCOVERY_REQUIRE_SIGN_IN=false (a copy that only its owner can reach).
 */

export type DiscoverServerEnv = AccountsEnv & DiscoverEnv;

export interface DiscoverStatus {
  sources: { id: SourceId; label: string; configured: boolean }[];
  /** Whether a person must be signed in to use them. */
  signIn: boolean;
}

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export function discoverStatus(env: DiscoverServerEnv): DiscoverStatus {
  return { sources: SOURCES.map((s) => ({ id: s.id, label: s.label, configured: s.configured(env) })), signIn: (env.DISCOVERY_REQUIRE_SIGN_IN ?? "").toLowerCase() !== "false" };
}

/** The caller's role in the workspace, asked of the accounts service with the caller's own sign-in. */
async function roleOf(service: { url: string; key: string }, token: string, workspaceId: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(`${service.url}/rest/v1/rpc/member_role`, {
      method: "POST",
      headers: { apikey: service.key, authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ws: workspaceId }),
    });
    if (!response.ok) return null;
    const role: unknown = await response.json();
    return typeof role === "string" ? role : null;
  } catch {
    return null;
  }
}

export function createDiscoverHandler(getEnv: () => DiscoverServerEnv, fetchImpl: typeof fetch = fetch, budgetMs = 50_000) {
  return async function handle(request: Request): Promise<Response> {
    const env = getEnv();

    // Only this site's own pages call the endpoint: another site may not use the server's credentials through a visitor.
    const origin = request.headers.get("origin");
    if (origin) {
      let same = false;
      try {
        same = new URL(origin).host === (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host);
      } catch {
        same = false;
      }
      if (!same) return json(403, { error: "origin_not_allowed", message: "This site is not allowed to use the discovery endpoint." });
    }

    const status = discoverStatus(env);
    if (request.method === "GET") return json(200, status);
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });

    let body: { source?: unknown; workspaceId?: unknown };
    try {
      const raw = await request.text();
      if (raw.length > 2000) return json(413, { error: "too_large", message: "The request is too large." });
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch {
      return json(400, { error: "bad_request", message: "The request could not be read." });
    }
    const source = sourceOf(body.source);
    if (!source) return json(400, { error: "bad_request", message: "Choose a source: aws, azure, gcp, servicenow, bmc or device42." });
    if (!source.configured(env)) return json(501, { error: "not_configured", message: `${source.label} is not connected. Its settings (${source.settings}) are added in the hosting environment of this app.` });

    if (status.signIn) {
      const service = accounts(env);
      if (!service) return json(501, { error: "no_accounts", message: "Live discovery needs sign-in, and this app has no accounts service." });
      const token = bearer(request);
      if (!token || token.length > 4096) return json(401, { error: "sign_in_required", message: "Sign in to discover from a connected source." });
      if (!isWorkspaceId(body.workspaceId)) return json(400, { error: "bad_request", message: "Open a workspace that is kept in the cloud to discover into it." });
      const role = await roleOf(service, token, body.workspaceId, fetchImpl);
      if (role === null) return json(401, { error: "sign_in_required", message: "Sign in again: your sign-in was not accepted, or you are not a member of this workspace." });
      if (role !== "owner" && role !== "editor") return json(403, { error: "role", message: "Only the workspace's owners and editors can discover from a connected source." });
    }

    try {
      const inventory: Inventory = await source.run(env, new Remote(source.label, source.settings, fetchImpl, budgetMs));
      return json(200, { source: source.id, label: source.label, fetchedAt: new Date().toISOString(), inventory });
    } catch (error) {
      if (error instanceof DiscoverError) return json(error.status, { error: error.code, message: error.message });
      const message = error instanceof Error && error.message ? error.message : "";
      // A reader's own complaint (nothing found, a shape it does not know) is safe to pass on; anything else is not.
      return json(502, { error: "source_failed", message: /^No |was not|were found|could not be read/.test(message) ? `${source.label}: ${message}` : `Reading ${source.label} failed.` });
    }
  };
}
