import { accounts, signedIn, type AccountsEnv } from "../ai/signin";

/**
 * Brings the application portfolio from APM & Landscape to the browser, through this server.
 *
 * APM publishes read-only feeds (Connections, Power BI or Excel feed) behind a token:
 *   GET <APM>/api/public/feeds/<dataset>.json   Authorization: Bearer apmf_...
 * A browser on another site cannot read them, and the token should not live in a browser, so
 * the app asks this endpoint instead.
 *
 *   APM_FEED_URL     the address of APM, for example https://apm.e20e.tools. Required: this
 *                    endpoint fetches from that address and from no other.
 *   APM_FEED_TOKEN   optional. A feed token kept on the server; it is used only for a signed-in
 *                    person. Without it, the person pastes a token for each import.
 */

export type ApmEnv = AccountsEnv & { APM_FEED_URL?: string; APM_FEED_TOKEN?: string };

export const APM_DATASETS = ["applications", "classifications", "lifecycle", "integrations"] as const;
export type ApmDataset = (typeof APM_DATASETS)[number];
export type ApmData = Record<ApmDataset, Record<string, unknown>[]> & { host: string; fetchedAt: string };

export const APM_TOKEN = /^apmf_[a-f0-9]{64}$/;
const MAX_BYTES = 5_000_000;
const TIMEOUT_MS = 15_000;
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS });

/** The configured APM address, or null when it is missing or is not a plain https address. */
export function apmBase(env: ApmEnv): URL | null {
  try {
    const url = new URL((env.APM_FEED_URL ?? "").trim());
    // Plain http is for trying the import against a stand-in on the same machine, and for nothing else.
    const local = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if ((url.protocol !== "https:" && !local) || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

const REFUSALS: Record<number, [string, string]> = {
  401: ["token_refused", "APM did not accept the feed token. Create a new Power BI or Excel feed token in APM under Connections."],
  403: ["token_refused", "APM refused the feed. The token may be expired or revoked, may not cover this dataset, or the feed service may be switched off in APM."],
  404: ["not_found", "APM has no feed at this address. Check APM_FEED_URL."],
  429: ["rate_limited", "APM allows 60 feed requests an hour for one token, and that limit is reached. Try again in an hour."],
};

export function createApmHandler(getEnv: () => ApmEnv, fetchImpl: typeof fetch = fetch) {
  return async function handle(request: Request): Promise<Response> {
    const env = getEnv();
    const base = apmBase(env);
    const kept = APM_TOKEN.test((env.APM_FEED_TOKEN ?? "").trim()) ? (env.APM_FEED_TOKEN ?? "").trim() : "";

    // Only this site's own pages call the endpoint: another site may not use the server's token through a visitor.
    const origin = request.headers.get("origin");
    if (origin) {
      let same = false;
      try {
        same = new URL(origin).host === (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host);
      } catch {
        same = false;
      }
      if (!same) return json(403, { error: "origin_not_allowed", message: "This site is not allowed to use the APM endpoint." });
    }

    if (request.method === "GET") return json(200, { configured: !!base, host: base?.host ?? null, hasToken: !!base && !!kept });
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    if (!base) return json(501, { error: "not_configured", message: "The server has no APM address. Set APM_FEED_URL to the address of APM, for example https://apm.e20e.tools." });

    let given = "";
    try {
      const raw = await request.text();
      if (raw.length > 2000) return json(413, { error: "too_large", message: "The request is too large." });
      const body = raw ? (JSON.parse(raw) as { token?: unknown }) : {};
      given = typeof body.token === "string" ? body.token.trim() : "";
    } catch {
      return json(400, { error: "bad_request", message: "The request could not be read." });
    }
    if (given && !APM_TOKEN.test(given)) return json(400, { error: "bad_token", message: "That does not look like an APM feed token. It starts with apmf_ and is shown once, when the token is created." });

    let token = given;
    if (!token) {
      // The server's own token speaks for whoever asks, so it is only used for someone who is signed in.
      const service = accounts(env);
      if (!kept) return json(400, { error: "token_needed", message: "Paste an APM feed token. Create one in APM under Connections, as a Power BI or Excel feed with the applications, classifications, lifecycle and integrations datasets." });
      if (!service || !(await signedIn(request, service, fetchImpl))) return json(401, { error: "sign_in_required", message: "Sign in to import from APM." });
      token = kept;
    }

    const answer = await readApmFeeds(base, token, fetchImpl);
    return json(answer.status, answer.body);
  };
}

const reply = (status: number, body: Record<string, unknown>) => ({ status, body });

/** Reads the four feeds from APM with a feed token: the answer to send on, and its status. */
export async function readApmFeeds(base: URL, token: string, fetchImpl: typeof fetch = fetch): Promise<{ status: number; body: Record<string, unknown> }> {
  const data: Partial<ApmData> = { host: base.host, fetchedAt: new Date().toISOString() };
  for (const dataset of APM_DATASETS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      // Redirects are refused: the token must not follow APM's address to somewhere else.
      const response = await fetchImpl(new URL(`/api/public/feeds/${dataset}.json`, base).toString(), { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, redirect: "error", signal: controller.signal });
      if (!response.ok) {
        const [error, message] = REFUSALS[response.status] ?? ["apm_failed", `APM answered with status ${response.status} for the ${dataset} feed.`];
        return reply(response.status === 429 ? 429 : 502, { error, message, dataset });
      }
      const text = await response.text();
      if (text.length > MAX_BYTES) return reply(502, { error: "too_large", message: `The ${dataset} feed is larger than 5 MB.`, dataset });
      const rows: unknown = JSON.parse(text);
      if (!Array.isArray(rows)) return reply(502, { error: "apm_failed", message: `The ${dataset} feed did not return a list.`, dataset });
      data[dataset] = rows.filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row));
    } catch {
      return reply(502, { error: "apm_unreachable", message: `APM could not be reached for the ${dataset} feed, or its answer could not be read.`, dataset });
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: 200, body: data as Record<string, unknown> };
}
