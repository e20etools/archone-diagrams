import { isWorkspaceId } from "../ai/fairUse";
import { APM_TOKEN, apmBase, readApmFeeds } from "../apm/http";
import { sourceOf } from "../discover/fetchers";
import { DiscoverError, Remote } from "../discover/remote";
import { integrationEnv, integrationOf, type IntegrationDef, type IntegrationId } from "./catalog";
import {
  adoTest,
  adoWorkItem,
  aiModels,
  aiTarget,
  chatBody,
  refusesEffort,
  aiTest,
  confluencePublish,
  confluenceTest,
  entraDirectory,
  githubFiles,
  githubTest,
  jiraIssue,
  jiraTest,
  oktaDirectory,
  sendEmail,
  sendSlack,
  sendTeams,
  type Notice,
} from "./connectors";

/**
 * The integrations Edge Function. Everything a workspace connects to in Settings → Integrations
 * is reached from here, with the credentials kept in the database's vault, which only this
 * function reads (with the service role, provided by the platform). Every call carries the
 * person's own sign-in; the function checks their role in the workspace before it connects.
 *
 *   POST /integrations                       { action, workspaceId, provider, ... }
 *   POST /integrations/v1/chat/completions   AI with the workspace's key, for the AI server, with a
 *                                            ticket from ai_begin (x-archone-usage, x-archone-ticket)
 */

export interface IntegrationsEnv {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  [name: string]: string | undefined;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-archone-workspace, x-archone-usage, x-archone-ticket",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });

type Role = "owner" | "editor" | "commenter" | "viewer";
const EDITORS: Role[] = ["owner", "editor"];

interface Kept {
  enabled: boolean;
  settings: Record<string, string>;
  secrets: Record<string, string>;
}

/** Turns setting names in a message into the field labels a person sees in Settings. */
function friendly(message: string, def: IntegrationDef): string {
  let out = message;
  for (const f of def.fields) out = out.split(f.env).join(`"${f.label}"`);
  return out.replace(/DISCOVERY_[A-Z0-9_]+/g, "the integration's settings");
}

export function createIntegrationsHandler(getEnv: () => IntegrationsEnv, fetchImpl: typeof fetch = fetch, budgetMs = 50_000) {
  return async function handle(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    const env = getEnv();
    const url = (env.SUPABASE_URL ?? "").replace(/\/$/, "");
    const anon = env.SUPABASE_ANON_KEY ?? "";
    const service = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    if (!url || !anon || !service) return json(500, { error: "not_configured", message: "The integrations function is missing its platform settings." });

    const header = request.headers.get("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token || token.length > 4096 || token === anon) return json(401, { error: "sign_in_required", message: "Sign in to use integrations." });

    const rest = (path: string, init: RequestInit, as: "person" | "service") =>
      fetchImpl(`${url}/rest/v1/${path}`, {
        ...init,
        headers: { apikey: as === "service" ? service : anon, authorization: `Bearer ${as === "service" ? service : token}`, "content-type": "application/json", ...(init.headers as Record<string, string>) },
      });
    const rpc = async (fn: string, args: unknown, as: "person" | "service"): Promise<unknown> => {
      const response = await rest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, as);
      if (!response.ok) throw new DiscoverError(response.status === 401 ? 401 : 502, response.status === 401 ? "sign_in_required" : "database", response.status === 401 ? "Sign in again." : "The workspace could not be read.");
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    };
    const roleIn = async (workspaceId: string) => (await rpc("member_role", { ws: workspaceId }, "person").catch(() => null)) as Role | null;
    const kept = async (workspaceId: string, provider: IntegrationId) => (await rpc("integration_credentials", { p_workspace: workspaceId, p_provider: provider }, "service")) as Kept | null;
    const mark = (workspaceId: string, provider: IntegrationId, ok: boolean, message: string) =>
      rpc("integration_mark", { p_workspace: workspaceId, p_provider: provider, p_ok: ok, p_message: message }, "service").catch(() => undefined);

    try {
      // The AI server's call to the provider, with the workspace's key.
      if (new URL(request.url).pathname.endsWith("/v1/chat/completions")) {
        const workspaceId = request.headers.get("x-archone-workspace") ?? "";
        const usage = Number(request.headers.get("x-archone-usage"));
        const ticket = request.headers.get("x-archone-ticket") ?? "";
        if (!isWorkspaceId(workspaceId) || !Number.isSafeInteger(usage) || !isWorkspaceId(ticket)) return json(400, { error: "bad_request", message: "The request has no valid ticket." });
        if ((await rpc("ai_ticket_use", { p_workspace: workspaceId, p_usage: usage, p_key: ticket }, "person")) !== true) return json(403, { error: "ticket", message: "This AI request was not counted, or was already used." });
        const ai = await kept(workspaceId, "ai");
        if (!ai?.enabled) return json(404, { error: "not_connected", message: "This workspace has no AI provider connected." });
        const target = aiTarget(ai.settings, ai.secrets);
        const raw = await request.text();
        if (raw.length > 8_000_000) return json(413, { error: "too_large", message: "The request is too large." });
        const body = JSON.parse(raw) as Record<string, unknown>;
        // Only the models the owner chose, whatever the caller asks for.
        const model = body.model === target.visionModel && target.visionModel ? target.visionModel : target.model;
        const send = (payload: Record<string, unknown>) =>
          fetchImpl(`${target.base}/chat/completions`, {
            method: "POST",
            redirect: "error",
            headers: { "content-type": "application/json", authorization: `Bearer ${target.key}` },
            body: JSON.stringify(payload),
          });
        const payload = chatBody(target, body, model);
        let answer = await send(payload);
        let text = await answer.text();
        // A model that takes no reasoning effort is asked again without it.
        if ("reasoning_effort" in payload && refusesEffort(answer.status, text)) {
          const { reasoning_effort: _effort, ...plain } = payload;
          answer = await send(plain);
          text = await answer.text();
        }
        return new Response(text, { status: answer.status, headers: { ...CORS, "content-type": "application/json" } });
      }

      let body: Record<string, unknown>;
      try {
        const raw = await request.text();
        if (raw.length > 12_000_000) return json(413, { error: "too_large", message: "The request is too large." });
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return json(400, { error: "bad_request", message: "The request could not be read." });
      }
      const action = String(body.action ?? "");
      const workspaceId = body.workspaceId;
      const def = integrationOf(body.provider);
      if (!isWorkspaceId(workspaceId)) return json(400, { error: "bad_request", message: "Open a workspace kept in the cloud." });
      const role = await roleIn(workspaceId);
      if (!role) return json(403, { error: "not_member", message: "You are not a member of this workspace, or your sign-in has expired." });

      // Notifications go to every connected channel at once, with text this function writes.
      if (action === "notify") {
        const notice = await composeNotice(body, workspaceId, role, (path) => rest(path, {}, "service"));
        const targets = def ? [def] : ([integrationOf("teams"), integrationOf("slack"), integrationOf("email")] as IntegrationDef[]);
        const sent: { provider: string; ok: boolean; message: string }[] = [];
        for (const target of targets) {
          const k = await kept(workspaceId, target.id);
          if (!k?.enabled) continue;
          const remote = new Remote(target.label, "its settings", fetchImpl, 15_000);
          try {
            if (target.id === "teams") await sendTeams(k.secrets, notice, remote);
            else if (target.id === "slack") await sendSlack(k.secrets, notice, remote);
            else await sendEmail(k.settings, k.secrets, notice, remote);
            sent.push({ provider: target.id, ok: true, message: "Sent." });
            if (body.event === "test") await mark(workspaceId, target.id, true, "A test message was sent.");
          } catch (error) {
            const message = friendly(error instanceof Error ? error.message : "Sending failed.", target);
            sent.push({ provider: target.id, ok: false, message });
            await mark(workspaceId, target.id, false, message);
          }
        }
        return json(200, { sent });
      }

      if (!def) return json(400, { error: "bad_request", message: "Unknown integration." });
      if (!EDITORS.includes(role)) return json(403, { error: "role", message: "Only the workspace's owners and editors can use this integration." });
      const k = await kept(workspaceId, def.id);
      if (!k) return json(404, { error: "not_connected", message: `${def.label} is not connected. An owner connects it in Settings → Integrations.` });
      if (!k.enabled && action !== "test") return json(409, { error: "turned_off", message: `${def.label} is turned off in Settings → Integrations.` });
      const remote = new Remote(def.label, `the ${def.label} settings`, fetchImpl, budgetMs);

      try {
        const answer = await run(def, action, k, body, remote);
        if (action === "test" || action === "discover" || action === "apm" || action === "directory" || action === "repository") await mark(workspaceId, def.id, true, answer.message);
        return json(200, answer.body);
      } catch (error) {
        const message = friendly(error instanceof DiscoverError || (error instanceof Error && /^(No |Give |Choose |The |Only )/.test(error.message)) ? error.message : `Connecting to ${def.label} failed.`, def);
        await mark(workspaceId, def.id, false, message);
        const status = error instanceof DiscoverError ? error.status : 502;
        return json(status, { error: error instanceof DiscoverError ? error.code : "source_failed", message });
      }
    } catch (error) {
      if (error instanceof DiscoverError) return json(error.status, { error: error.code, message: error.message });
      return json(500, { error: "failed", message: "The integration could not be used." });
    }
  };
}

/** What each action does with an integration's settings, and the line kept as its status. */
async function run(def: IntegrationDef, action: string, k: Kept, body: Record<string, unknown>, remote: Remote): Promise<{ body: unknown; message: string }> {
  const s = k.settings;
  const x = k.secrets;
  if (def.use === "discover") {
    const source = sourceOf(def.id)!;
    const env = integrationEnv(def.id, s, x);
    if (!source.configured(env)) throw new DiscoverError(400, "bad_settings", `Fill in the required settings of ${def.label}.`);
    const raw = await source.fetch(env, remote);
    const message = `Connected. Read ${raw.count.toLocaleString("en")} records from ${raw.label}.`;
    if (action === "test") return { body: { ok: true, message }, message };
    if (action === "discover") return { body: { raw }, message };
  }
  if (def.use === "apm") {
    const base = apmBase({ APM_FEED_URL: s.url });
    if (!base) throw new DiscoverError(400, "bad_settings", "The APM address is not a plain https address.");
    if (!APM_TOKEN.test(x.token ?? "")) throw new DiscoverError(400, "bad_settings", "The feed token should start with apmf_. Create one in APM under Connections.");
    const answer = await readApmFeeds(base, x.token, remote.fetchImpl);
    if (answer.status !== 200) throw new DiscoverError(answer.status === 429 ? 429 : 502, String(answer.body.error ?? "apm_failed"), String(answer.body.message ?? "APM refused the feed."));
    const count = Array.isArray(answer.body.applications) ? answer.body.applications.length : 0;
    const message = `Connected to ${base.host}: ${count.toLocaleString("en")} applications.`;
    if (action === "test") return { body: { ok: true, message }, message };
    if (action === "apm") return { body: answer.body, message };
  }
  if (def.use === "ai") {
    if (action === "test") {
      const message = await aiTest(s, x, remote);
      return { body: { ok: true, message }, message };
    }
    if (action === "models") {
      const models = await aiModels(s, x, remote);
      return { body: { models }, message: `${models.length} models.` };
    }
  }
  if (def.use === "repository") {
    if (action === "test") {
      const message = await githubTest(s, x, remote);
      return { body: { ok: true, message }, message };
    }
    if (action === "repository") {
      const files = await githubFiles(s, x, remote, { repository: body.repository, path: body.path, ref: body.ref });
      return { body: files, message: `Read ${files.files.length} files from ${files.repository}.` };
    }
  }
  if (def.use === "directory") {
    const read = def.id === "entra" ? entraDirectory : oktaDirectory;
    if (action === "test") {
      await read(s, x, remote, true);
      const message = "Connected: the directory can be read.";
      return { body: { ok: true, message }, message };
    }
    if (action === "directory") {
      const directory = await read(s, x, remote);
      return { body: directory, message: `Read ${directory.people.length} people and ${directory.groups.length} groups.` };
    }
  }
  if (def.use === "issues") {
    if (action === "test") {
      const message = def.id === "jira" ? await jiraTest(s, x, remote) : await adoTest(s, x, remote);
      return { body: { ok: true, message }, message };
    }
    if (action === "issue") {
      const input = { title: String(body.title ?? "").trim().slice(0, 250), description: String(body.description ?? "").slice(0, 20000), link: safeLink(body.link) };
      if (!input.title) throw new DiscoverError(400, "bad_request", "Give the issue a title.");
      const issue = def.id === "jira" ? await jiraIssue(s, x, input, remote) : await adoWorkItem(s, x, input, remote);
      return { body: issue, message: `Created ${issue.key}.` };
    }
  }
  if (def.use === "publish") {
    if (action === "test") {
      const message = await confluenceTest(s, x, remote);
      return { body: { ok: true, message }, message };
    }
    if (action === "publish") {
      const rows = Array.isArray(body.rows) ? (body.rows as unknown[]).slice(0, 1001).map((r) => (Array.isArray(r) ? r.slice(0, 8).map((c) => String(c ?? "").slice(0, 500)) : [])) : [];
      const png = typeof body.png === "string" && /^[A-Za-z0-9+/=]+$/.test(body.png) && body.png.length < 11_000_000 ? body.png : undefined;
      const page = await confluencePublish(s, x, { title: String(body.title ?? "Diagram").slice(0, 250), summary: String(body.summary ?? "").slice(0, 4000), rows, png, link: safeLink(body.link) }, remote);
      return { body: page, message: "Published a page." };
    }
  }
  throw new DiscoverError(400, "bad_request", `${def.label} cannot do "${action}".`);
}

/** A link back to the app: an https address, or nothing. */
function safeLink(value: unknown): string | undefined {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The message for an event, from the workspace's own records: the caller chooses only which. */
async function composeNotice(body: Record<string, unknown>, workspaceId: string, role: Role, read: (path: string) => Promise<Response>): Promise<Notice> {
  const event = String(body.event ?? "");
  const app = safeLink(body.appUrl)?.replace(/\/+$/, "");
  const row = async (path: string) => {
    const response = await read(path);
    const rows = response.ok ? ((await response.json()) as Record<string, unknown>[]) : [];
    return rows[0] ?? null;
  };
  const workspace = await row(`workspaces?id=eq.${workspaceId}&select=name`);
  const where = String(workspace?.name ?? "the workspace");
  if (event === "test") {
    if (!EDITORS.includes(role)) throw new DiscoverError(403, "role", "Only owners and editors can send a test.");
    return { title: "ArchONE Diagrams is connected", text: `Notifications from ${where} will arrive here.` };
  }
  if (event === "review.submitted" || event === "review.decided") {
    if (!isWorkspaceId(body.reviewId)) throw new DiscoverError(400, "bad_request", "Which review?");
    const review = await row(`reviews?id=eq.${body.reviewId}&workspace_id=eq.${workspaceId}&select=title,note,status`);
    if (!review) throw new DiscoverError(404, "not_found", "The review was not found.");
    const link = app ? `${app}/reviews` : undefined;
    if (event === "review.submitted") return { title: `Review asked for: ${String(review.title)}`, text: `${where}${review.note ? `\n${String(review.note).slice(0, 500)}` : ""}`, link, linkText: "Open the review" };
    const status = String(review.status);
    return { title: `Review ${status === "approved" ? "approved" : status === "rejected" ? "rejected" : "updated"}: ${String(review.title)}`, text: where, link, linkText: "Open the review" };
  }
  if (event === "diagram.shared") {
    if (!EDITORS.includes(role)) throw new DiscoverError(403, "role", "Only owners and editors can share to channels.");
    if (typeof body.diagramId !== "string" || !/^[\w-]{1,64}$/.test(body.diagramId)) throw new DiscoverError(400, "bad_request", "Which diagram?");
    const diagram = await row(`diagrams?workspace_id=eq.${workspaceId}&id=eq.${encodeURIComponent(body.diagramId)}&select=name,description`);
    if (!diagram) throw new DiscoverError(404, "not_found", "The diagram was not found.");
    const note = String(body.note ?? "").trim().slice(0, 500);
    return { title: `Diagram shared: ${String(diagram.name)}`, text: `${where}${note ? `\n${note}` : diagram.description ? `\n${String(diagram.description).slice(0, 300)}` : ""}`, link: app ? `${app}/diagram/${body.diagramId}` : undefined, linkText: "Open the diagram" };
  }
  throw new DiscoverError(400, "bad_request", "Unknown notification.");
}
