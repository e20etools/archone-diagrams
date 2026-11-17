import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDiscovery } from "../discover/parse";
import { INTEGRATIONS, missingFields, splitFields } from "./catalog";
import { createIntegrationsHandler } from "./server";

const WS = "5e6b7d00-a3d6-4dce-bbbe-20e319346f51";
const REVIEW = "0b8c2b6e-3d41-4a59-9a43-0f1f6f2c1a77";
const TICKET = "6f1d9a3c-55a0-4c3e-8a77-2f4b1c9e0d11";
const ENV = { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service" };
const fixture = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`../inventory/fixtures/${name}`, import.meta.url)), "utf8"));
const ok = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { url: string; method: string; headers: Headers; body: string; form?: FormData };
type Route = (c: Call) => Response | undefined | Promise<Response | undefined>;

/** The database and the outside services, as the function sees them. */
function world(kept: Record<string, { settings: Record<string, string>; secrets: Record<string, string>; enabled?: boolean }>, routes: Route[] = [], roles: Record<string, string> = { editor: "editor", viewer: "viewer", owner: "owner" }) {
  const calls: Call[] = [];
  const marks: { provider: string; ok: boolean; message: string }[] = [];
  let ticketUsed = false;
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = { url: String(input), method: init.method ?? "GET", headers: new Headers(init.headers), body: typeof init.body === "string" ? init.body : "", form: init.body instanceof FormData ? init.body : undefined };
    calls.push(call);
    const person = call.headers.get("authorization")?.replace("Bearer ", "") ?? "";
    if (call.url.startsWith("https://db.example/rest/v1/rpc/")) {
      const fn = call.url.split("/").pop();
      const args = JSON.parse(call.body || "{}");
      if (fn === "member_role") return roles[person] ? ok(JSON.stringify(roles[person])) : ok("null");
      if (fn === "integration_credentials") {
        if (person !== "service") return ok({ message: "permission denied" }, 403);
        const k = kept[args.p_provider];
        return ok(k ? JSON.stringify({ enabled: k.enabled ?? true, settings: k.settings, secrets: k.secrets }) : "null");
      }
      if (fn === "integration_mark") {
        marks.push({ provider: args.p_provider, ok: args.p_ok, message: args.p_message });
        return ok("");
      }
      if (fn === "ai_ticket_use") {
        const fine = person === "editor" && args.p_key === TICKET && !ticketUsed;
        ticketUsed ||= fine;
        return ok(JSON.stringify(fine));
      }
    }
    if (call.url.startsWith("https://db.example/rest/v1/workspaces")) return ok([{ name: "HQ" }]);
    if (call.url.startsWith("https://db.example/rest/v1/reviews")) return ok([{ title: "Move payments to the cloud", note: "Phase 1", status: "open" }]);
    if (call.url.startsWith("https://db.example/rest/v1/diagrams")) return ok([{ name: "Payments landscape", description: "" }]);
    for (const route of routes) {
      const answer = await route(call);
      if (answer) return answer;
    }
    return ok({ message: "no route" }, 404);
  }) as typeof fetch;
  const handler = createIntegrationsHandler(() => ENV, fetchImpl, 20_000);
  const post = async (body: Record<string, unknown>, who = "editor") => {
    const response = await handler(new Request("https://db.example/functions/v1/integrations", { method: "POST", headers: { authorization: `Bearer ${who}` }, body: JSON.stringify({ workspaceId: WS, ...body }) }));
    return { status: response.status, data: (await response.json()) as Record<string, any> };
  };
  return { calls, marks, handler, post };
}

describe("the catalog", () => {
  it("names every setting once, and keeps keys and passwords as secrets", () => {
    for (const def of INTEGRATIONS) {
      expect(new Set(def.fields.map((f) => f.key)).size).toBe(def.fields.length);
      for (const f of def.fields) if (/key|secret|password|token|webhook/i.test(f.key) && !/Id$/.test(f.key)) expect(f.secret, `${def.id}.${f.key}`).toBe(true);
    }
    expect(splitFields("ai", { provider: "groq", apiKey: " gsk ", accountId: "x" })).toEqual({ settings: { provider: "groq" }, secrets: { apiKey: "gsk" } });
    expect(missingFields("ai", { provider: "cloudflare" }, ["apiKey"]).map((f) => f.key)).toEqual(["accountId"]);
    expect(missingFields("servicenow", { url: "https://a.service-now.com" }, ["token"])).toEqual([]);
    expect(missingFields("email", { service: "mailgun", from: "a@b.co", to: "c@d.co" }, ["apiKey"]).map((f) => f.key)).toEqual(["domain"]);
  });
});

describe("the integrations function", () => {
  it("answers the browser's preflight, and only members who sign in", async () => {
    const w = world({});
    expect((await w.handler(new Request("https://db.example/functions/v1/integrations", { method: "OPTIONS" }))).status).toBe(204);
    expect((await w.handler(new Request("https://db.example/functions/v1/integrations", { method: "POST", body: "{}" }))).status).toBe(401);
    expect((await w.post({ action: "test", provider: "jira" }, "stranger")).data.error).toBe("not_member");
    expect((await w.post({ action: "test", provider: "jira" }, "viewer")).data.error).toBe("role");
    expect((await w.post({ action: "test", provider: "jira" })).data.error).toBe("not_connected");
  });

  it("tests and discovers with a workspace's ServiceNow credentials, and records how it went", async () => {
    const f = fixture("servicenow.json") as { cmdb_ci: unknown; cmdb_rel_ci: unknown };
    const w = world({ servicenow: { settings: { url: "https://acme.service-now.com", user: "svc" }, secrets: { password: "pw" } } }, [
      (c) => (c.url.includes("/table/cmdb_ci?") ? ok(f.cmdb_ci) : c.url.includes("/table/cmdb_rel_ci?") ? ok(f.cmdb_rel_ci) : undefined),
    ]);
    const test = await w.post({ action: "test", provider: "servicenow" });
    expect(test.data).toEqual({ ok: true, message: "Connected. Read 4 records from ServiceNow acme.service-now.com." });
    expect(w.calls.find((c) => c.url.includes("cmdb_ci?"))!.headers.get("authorization")).toBe(`Basic ${btoa("svc:pw")}`);
    const found = await w.post({ action: "discover", provider: "servicenow" });
    expect(parseDiscovery(found.data.raw).items.map((i) => i.name)).toEqual(["Online Banking", "obk-app-01", "lnx-web-01", "ORDERSDB"]);
    expect(w.marks.every((m) => m.ok)).toBe(true);
  });

  it("says what is wrong in the words of the settings form, not the server's", async () => {
    const w = world({ bmc: { settings: { url: "https://bmc.example" }, secrets: { token: "old" } } }, [() => ok({ message: "Token expired" }, 401)]);
    const { status, data } = await w.post({ action: "test", provider: "bmc" });
    expect(status).toBe(502);
    expect(data.message).toBe("BMC Helix Discovery did not accept the credentials, or they may not read this. Check the BMC Helix Discovery settings. It said: Token expired");
    expect(data.message).not.toMatch(/DISCOVERY_/);
    expect(w.marks.at(-1)).toMatchObject({ provider: "bmc", ok: false });
  });

  it("calls the AI provider with the workspace's key once per counted request, and only the chosen model", async () => {
    const w = world({ ai: { settings: { provider: "groq", model: "llama-3.3-70b-versatile" }, secrets: { apiKey: "gsk-1" } } }, [
      (c) => (c.url === "https://api.groq.com/openai/v1/chat/completions" ? ok({ choices: [{ message: { content: "{}" } }], usage: { total_tokens: 12 } }) : undefined),
    ]);
    const ask = (ticket: string) =>
      w.handler(
        new Request("https://db.example/functions/v1/integrations/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer editor", "x-archone-workspace": WS, "x-archone-usage": "41", "x-archone-ticket": ticket },
          body: JSON.stringify({ model: "gpt-5-expensive", messages: [{ role: "user", content: "hi" }] }),
        }),
      );
    expect((await ask("00000000-0000-0000-0000-000000000000")).status).toBe(403);
    const first = await ask(TICKET);
    expect(first.status).toBe(200);
    const sent = w.calls.find((c) => c.url.includes("api.groq.com"))!;
    expect(sent.headers.get("authorization")).toBe("Bearer gsk-1");
    expect(JSON.parse(sent.body).model).toBe("llama-3.3-70b-versatile");
    expect((await ask(TICKET)).status).toBe(403);
  });

  it("lists the AI models a key can use, and tests it with a short question", async () => {
    const w = world({ ai: { settings: { provider: "gemini" }, secrets: { apiKey: "g-1" } } }, [
      (c) => (c.url.endsWith("/v1beta/openai/models") ? ok({ data: [{ id: "models/gemini-flash-latest" }, { id: "gemini-pro" }] }) : undefined),
      (c) => (c.url.endsWith("/v1beta/openai/chat/completions") ? ok({ choices: [{ message: { content: "OK" } }] }) : undefined),
    ]);
    expect((await w.post({ action: "models", provider: "ai" })).data.models).toEqual(["gemini-pro", "models/gemini-flash-latest"]);
    expect((await w.post({ action: "test", provider: "ai" })).data.message).toBe("Connected to Google Gemini (AI Studio): gemini-flash-latest answered.");
  });

  it("sends a review to Teams, Slack and email with text from the workspace's own records", async () => {
    const w = world(
      {
        teams: { settings: {}, secrets: { webhookUrl: "https://prod.powerplatform.example/hook" } },
        slack: { settings: {}, secrets: { webhookUrl: "https://hooks.slack.com/services/T/B/X" } },
        email: { settings: { service: "resend", from: "ArchONE <arch@example.com>", to: "a@example.com, b@example.com" }, secrets: { apiKey: "re_1" } },
      },
      [(c) => (c.url.includes("powerplatform") ? new Response("", { status: 202 }) : c.url.includes("hooks.slack.com") ? new Response("ok") : c.url === "https://api.resend.com/emails" ? ok({ id: "e1" }) : undefined)],
    );
    const { data } = await w.post({ action: "notify", event: "review.submitted", reviewId: REVIEW, appUrl: "https://archone.example" }, "viewer");
    expect(data.sent.map((s: { provider: string; ok: boolean }) => `${s.provider}:${s.ok}`)).toEqual(["teams:true", "slack:true", "email:true"]);
    const teams = JSON.parse(w.calls.find((c) => c.url.includes("powerplatform"))!.body);
    expect(teams.attachments[0].content.body[0].text).toBe("Review asked for: Move payments to the cloud");
    expect(JSON.parse(w.calls.find((c) => c.url.includes("slack"))!.body).text).toContain("<https://archone.example/reviews|Open the review>");
    expect(JSON.parse(w.calls.find((c) => c.url.includes("resend"))!.body)).toMatchObject({ to: ["a@example.com", "b@example.com"], subject: "Review asked for: Move payments to the cloud" });
    expect((await w.post({ action: "notify", event: "diagram.shared", diagramId: "dia_1" }, "viewer")).status).toBe(403);
    expect((await w.post({ action: "notify", event: "anything", text: "click evil.example" })).status).toBe(400);
  });

  it("creates a Jira issue and an Azure DevOps work item", async () => {
    const w = world(
      { jira: { settings: { url: "https://acme.atlassian.net", email: "me@acme.com", project: "ARCH" }, secrets: { token: "jt" } }, "azure-devops": { settings: { organization: "acme", project: "Platform" }, secrets: { token: "pat" } } },
      [
        (c) => (c.url === "https://acme.atlassian.net/rest/api/3/issue" ? ok({ key: "ARCH-12" }, 201) : undefined),
        (c) => (c.url.startsWith("https://dev.azure.com/acme/Platform/_apis/wit/workitems/$Task") ? ok({ id: 77, _links: { html: { href: "https://dev.azure.com/acme/Platform/_workitems/edit/77" } } }) : undefined),
      ],
    );
    expect((await w.post({ action: "issue", provider: "jira", title: "ADR-4: Add a cache", description: "Context\n\nDecision", link: "https://archone.example/adrs" })).data).toEqual({ key: "ARCH-12", url: "https://acme.atlassian.net/browse/ARCH-12" });
    const issue = JSON.parse(w.calls.find((c) => c.url.endsWith("/rest/api/3/issue"))!.body);
    expect(issue.fields).toMatchObject({ project: { key: "ARCH" }, summary: "ADR-4: Add a cache", issuetype: { name: "Task" } });
    expect((await w.post({ action: "issue", provider: "azure-devops", title: "ADR-4" })).data.key).toBe("#77");
    expect(w.calls.find((c) => c.url.includes("dev.azure.com"))!.headers.get("content-type")).toBe("application/json-patch+json");
  });

  it("reads the infrastructure files under a folder of a GitHub repository", async () => {
    const w = world({ github: { settings: { repository: "acme/infra" }, secrets: { token: "ghp" } } }, [
      (c) => (c.url === "https://api.github.com/repos/acme/infra" ? ok({ default_branch: "main", full_name: "acme/infra" }) : undefined),
      (c) =>
        c.url.startsWith("https://api.github.com/repos/acme/infra/git/trees/main")
          ? ok({ tree: [{ path: "prod/main.tf", type: "blob", size: 10 }, { path: "prod/README.md", type: "blob" }, { path: "prod/k8s/app.yaml", type: "blob" }, { path: "dev/main.tf", type: "blob" }, { path: "prod/.terraform/x.tf", type: "blob" }] })
          : undefined,
      (c) => (c.url.includes("/contents/") ? new Response(`# ${c.url.split("/contents/")[1]}`) : undefined),
    ]);
    const { data } = await w.post({ action: "repository", provider: "github", path: "prod" });
    expect(data.files.map((f: { path: string }) => f.path)).toEqual(["prod/main.tf", "prod/k8s/app.yaml"]);
    expect(w.calls.find((c) => c.url.includes("/contents/"))!.headers.get("accept")).toBe("application/vnd.github.raw");
    expect((await w.post({ action: "repository", provider: "github", path: "../secrets" })).status).toBe(400);
  });

  it("reads people and groups from Microsoft Entra ID", async () => {
    const w = world({ entra: { settings: { tenantId: "contoso.onmicrosoft.com", clientId: "app", groupFilter: "IT-" }, secrets: { clientSecret: "s" } } }, [
      (c) => (c.url.startsWith("https://login.microsoftonline.com/") ? ok({ access_token: "graph" }) : undefined),
      (c) => (c.url.startsWith("https://graph.microsoft.com/v1.0/users") ? ok({ value: [{ id: "u1", displayName: "Sara Ahmed", mail: "sara@contoso.com", jobTitle: "Architect", department: "IT" }, { id: "u2", displayName: "Old", accountEnabled: false }] }) : undefined),
      (c) => (c.url.startsWith("https://graph.microsoft.com/v1.0/groups?") ? ok({ value: [{ id: "g1", displayName: "IT-Architecture", description: "Architects" }] }) : undefined),
      (c) => (c.url.startsWith("https://graph.microsoft.com/v1.0/groups/g1/members") ? ok({ value: [{ id: "u1" }] }) : undefined),
    ]);
    const { data } = await w.post({ action: "directory", provider: "entra" });
    expect(data.people).toEqual([{ id: "u1", name: "Sara Ahmed", email: "sara@contoso.com", title: "Architect", department: "IT" }]);
    expect(data.groups).toEqual([{ id: "g1", name: "IT-Architecture", description: "Architects", members: ["u1"] }]);
    expect(decodeURIComponent(w.calls.find((c) => c.url.includes("/groups?"))!.url)).toContain("startswith(displayName,'IT-')");
  });

  it("publishes a diagram to Confluence with its picture", async () => {
    const w = world({ confluence: { settings: { url: "https://acme.atlassian.net/wiki", email: "me@acme.com", space: "ARCH" }, secrets: { token: "ct" } } }, [
      (c) => (c.url === "https://acme.atlassian.net/wiki/rest/api/content" ? ok({ id: "991", _links: { base: "https://acme.atlassian.net/wiki", webui: "/spaces/ARCH/pages/991" } }) : undefined),
      (c) => (c.url.endsWith("/content/991/child/attachment") ? ok({ results: [] }) : undefined),
    ]);
    const { data } = await w.post({ action: "publish", provider: "confluence", title: "Payments", summary: "Two systems", rows: [["Name", "Type"], ["Ledger", "Application"]], png: btoa("png-bytes") });
    expect(data.url).toBe("https://acme.atlassian.net/wiki/spaces/ARCH/pages/991");
    const page = JSON.parse(w.calls.find((c) => c.url.endsWith("/rest/api/content"))!.body);
    expect(page.body.storage.value).toContain('<ri:attachment ri:filename="diagram.png" />');
    expect(page.body.storage.value).toContain("<td>Ledger</td>");
    expect(w.calls.find((c) => c.url.endsWith("/attachment"))!.form?.get("file")).toBeInstanceOf(Blob);
  });
});
