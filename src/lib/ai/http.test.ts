import { describe, expect, it } from "vitest";
import { createAiHandler, type ServerEnv } from "./http";

const URL_ = "https://app.example.com/api/ai";
const prompt = JSON.stringify({ mode: "prompt", text: "The web app calls the order service." });

const answer = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          objects: [
            { key: "a", name: "Web app", typeId: "application", description: "", technology: "", parentKey: null },
            { key: "b", name: "Order service", typeId: "service", description: "", technology: "", parentKey: null },
          ],
          relationships: [{ sourceKey: "a", targetKey: "b", kind: "calls", label: "" }],
          notes: "",
        }),
      },
    },
  ],
};
const provider = (async () => new Response(JSON.stringify(answer), { status: 200 })) as unknown as typeof fetch;
const configured: ServerEnv = { AI_PROVIDER: "openai-compatible", AI_API_KEY: "k", AI_MODEL: "m", AI_BASE_URL: "https://llm.example.com/v1" };

const post = (headers: Record<string, string> = {}, body = prompt) =>
  new Request(URL_, { method: "POST", headers: { "content-type": "application/json", host: "app.example.com", ...headers }, body });

describe("AI endpoint over HTTP", () => {
  it("reports status without revealing the key", async () => {
    const handle = createAiHandler(() => ({ ...configured, AI_ACCESS_CODE: "pilot" }), provider);
    const response = await handle(new Request(URL_));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ configured: true, engine: "openai-compatible:m", needsCode: true, needsSignIn: false });
    expect(text).not.toContain('"k"');
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("drafts through the provider and returns the draft", async () => {
    const handle = createAiHandler(() => configured, provider);
    const response = await handle(post({ origin: "https://app.example.com" }));
    const data = (await response.json()) as { draft: { objects: unknown[]; relationships: unknown[] }; engine: string };
    expect(response.status).toBe(200);
    expect(data.draft.objects).toHaveLength(2);
    expect(data.draft.relationships).toHaveLength(1);
    expect(data.engine).toBe("openai-compatible:m");
  });

  it("answers 501 without a provider so the browser can fall back to the built-in rules", async () => {
    const response = await createAiHandler(() => ({}), provider)(post());
    expect(response.status).toBe(501);
  });

  it("asks for the access code when one is set, and never calls the provider without it", async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as unknown as typeof fetch;
    const handle = createAiHandler(() => ({ ...configured, AI_ACCESS_CODE: "pilot-2026" }), counting);
    expect((await handle(post())).status).toBe(401);
    expect((await handle(post({ "x-access-code": "pilot-2025" }))).status).toBe(401);
    expect((await handle(post({ "x-access-code": "pilot-2026-and-more" }))).status).toBe(401);
    expect(calls).toBe(0);
    expect((await handle(post({ "x-access-code": "pilot-2026" }))).status).toBe(200);
    expect(calls).toBe(1);
  });

  it("refuses other websites unless their origin is allowed", async () => {
    const closed = createAiHandler(() => configured, provider);
    const refused = await closed(post({ origin: "https://elsewhere.example" }));
    expect(refused.status).toBe(403);
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();

    const open = createAiHandler(() => ({ ...configured, AI_ALLOWED_ORIGIN: "https://my-app.lovable.app/, https://other.example" }), provider);
    const allowed = await open(post({ origin: "https://my-app.lovable.app" }));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://my-app.lovable.app");
    const preflight = await open(new Request(URL_, { method: "OPTIONS", headers: { origin: "https://my-app.lovable.app", host: "fn.example.com" } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("x-access-code");
  });

  it("drafts only for signed-in people once the app has accounts", async () => {
    const seen: { url: string; auth: string | null; apikey: string | null }[] = [];
    let drafts = 0;
    const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) {
        const headers = new Headers(init?.headers);
        seen.push({ url, auth: headers.get("authorization"), apikey: headers.get("apikey") });
        return headers.get("authorization") === "Bearer good-token" ? new Response(JSON.stringify({ id: "user-1" }), { status: 200 }) : new Response("{}", { status: 401 });
      }
      drafts++;
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as unknown as typeof fetch;
    // Fair use is tested on its own below.
    const env = { ...configured, VITE_SUPABASE_URL: "https://proj.supabase.co/", VITE_SUPABASE_ANON_KEY: "anon", AI_FAIR_USE: "off" };
    const handle = createAiHandler(() => env, network);

    expect(await (await handle(new Request(URL_))).json()).toMatchObject({ needsSignIn: true });
    const anonymous = await handle(post());
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: "sign_in_required" });
    expect((await handle(post({ authorization: "Bearer forged" }))).status).toBe(401);
    expect(drafts).toBe(0);
    expect((await handle(post({ authorization: "Bearer good-token" }))).status).toBe(200);
    expect(drafts).toBe(1);
    expect(seen.at(-1)).toEqual({ url: "https://proj.supabase.co/auth/v1/user", auth: "Bearer good-token", apikey: "anon" });
    // The switch for a host that wants accounts in the app but an open AI endpoint.
    expect((await createAiHandler(() => ({ ...env, AI_REQUIRE_SIGN_IN: "false" }), network)(post())).status).toBe(200);
  });

  it("asks the database before every request, counts it, and closes it with the tokens used", async () => {
    const calls: { name: string; auth: string | null; args: Record<string, unknown> }[] = [];
    let drafts = 0;
    let refuse: Record<string, unknown> | null = null;
    let databaseDown = false;
    const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
      const rpc = /\/rest\/v1\/rpc\/(\w+)$/.exec(url)?.[1];
      if (rpc) {
        calls.push({ name: rpc, auth: headers.get("authorization"), args: JSON.parse(String(init?.body)) });
        if (databaseDown) return new Response("{}", { status: 500 });
        if (rpc === "ai_begin") return new Response(JSON.stringify(refuse ?? { allowed: true, usage: 7, key: "k-7", remaining: { hour: 4, day: 20, tokens: 9000 } }), { status: 200 });
        return new Response(null, { status: 204 });
      }
      drafts++;
      return new Response(JSON.stringify({ ...answer, usage: { total_tokens: 321 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const env = { ...configured, VITE_SUPABASE_URL: "https://proj.supabase.co", VITE_SUPABASE_ANON_KEY: "anon" };
    const handle = createAiHandler(() => env, network);
    const signed = { authorization: "Bearer good-token" };
    const workspace = "5e6b7d00-a3d6-4dce-bbbe-20e319346f51";
    const withWorkspace = JSON.stringify({ ...JSON.parse(prompt), workspaceId: workspace });

    const without = await handle(post(signed));
    expect(without.status).toBe(400);
    expect(await without.json()).toMatchObject({ error: "workspace_required" });
    // A request that would be refused anyway is not counted.
    expect((await handle(post(signed, JSON.stringify({ mode: "prompt", text: "", workspaceId: workspace })))).status).toBe(400);
    expect(calls.filter((c) => c.name !== "ai_integration")).toEqual([]);

    const ok = await handle(post(signed, withWorkspace));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ allowance: { hour: 4, day: 20, tokens: 9000 - 321 } });
    expect(calls.filter((c) => c.name !== "ai_integration")).toEqual([
      { name: "ai_begin", auth: "Bearer good-token", args: { p_workspace: workspace, p_kind: "text", p_global_day: 0 } },
      { name: "ai_finish", auth: "Bearer good-token", args: { p_usage: 7, p_key: "k-7", p_tokens: 321, p_ok: true } },
    ]);
    expect(drafts).toBe(1);

    refuse = { allowed: false, reason: "day", message: "You have used your 40 AI requests for the last 24 hours.", retryAt: "2026-11-18T09:00:00Z" };
    const limited = await handle(post(signed, withWorkspace));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "quota", reason: "day", message: "You have used your 40 AI requests for the last 24 hours.", retryAt: "2026-11-18T09:00:00Z" });
    expect(drafts).toBe(1);

    // When the limits cannot be checked, nothing is sent to the model.
    refuse = null;
    databaseDown = true;
    const down = await handle(post(signed, withWorkspace));
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ error: "limits_unavailable" });
    expect(drafts).toBe(1);

    // Groq's free plan gets a ceiling for everyone together unless the host sets one.
    databaseDown = false;
    calls.length = 0;
    await createAiHandler(() => ({ ...env, AI_PROVIDER: "groq", AI_API_KEY: "gsk" }), network)(post(signed, withWorkspace));
    expect(calls.find((c) => c.name === "ai_begin")!.args.p_global_day).toBe(900);
    calls.length = 0;
    await createAiHandler(() => ({ ...env, AI_GLOBAL_DAILY_REQUESTS: "50" }), network)(post(signed, withWorkspace));
    expect(calls.find((c) => c.name === "ai_begin")!.args.p_global_day).toBe(50);
  });

  it("rejects unreadable bodies and unsupported methods", async () => {
    const handle = createAiHandler(() => configured, provider);
    expect((await handle(post({}, "{not json"))).status).toBe(400);
    expect((await handle(post({ "content-length": "99999999" }))).status).toBe(413);
    expect((await handle(new Request(URL_, { method: "DELETE" }))).status).toBe(405);
  });
});

describe("the bundled function that the host deploys", () => {
  it("api/ai.js loads on its own and answers", async () => {
    const path = "../../../api/ai.js";
    const bundle = (await import(/* @vite-ignore */ path)) as { default: { fetch: (r: Request) => Promise<Response> } };
    const response = await bundle.default.fetch(new Request(URL_, { method: "PUT" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("api/ai.js reads the host's environment at request time", async () => {
    const path = "../../../api/ai.js";
    const bundle = (await import(/* @vite-ignore */ path)) as { default: { fetch: (r: Request) => Promise<Response> } };
    const names = ["AI_PROVIDER", "AI_API_KEY", "AI_MODEL", "AI_BASE_URL", "AI_ACCESS_CODE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LOVABLE_API_KEY", "SUPABASE_URL", "VITE_SUPABASE_URL"];
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    try {
      for (const n of names) delete process.env[n];
      expect(await (await bundle.default.fetch(new Request(URL_))).json()).toEqual({ configured: false, engine: null, needsCode: false, needsSignIn: false });
      Object.assign(process.env, { AI_PROVIDER: "anthropic", AI_API_KEY: "k", AI_ACCESS_CODE: "pilot" });
      expect(await (await bundle.default.fetch(new Request(URL_))).json()).toEqual({ configured: true, engine: "anthropic:claude-sonnet-5-5", needsCode: true, needsSignIn: false });
    } finally {
      for (const n of names) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
    }
  });

  it("uses the workspace's own AI provider through the integrations function, with a ticket for the counted request", async () => {
    const seen: { url: string; headers: Headers; body: string }[] = [];
    const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, headers, body: String(init?.body ?? "") });
      if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
      if (url.endsWith("/rpc/ai_integration")) return new Response(JSON.stringify({ provider: "gemini", model: "", visionModel: "" }), { status: 200 });
      if (url.endsWith("/rpc/ai_begin")) return new Response(JSON.stringify({ allowed: true, usage: 9, key: "6f1d9a3c-55a0-4c3e-8a77-2f4b1c9e0d11", remaining: { hour: 4, day: 20, tokens: 9000 } }), { status: 200 });
      if (url.endsWith("/rpc/ai_finish")) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ ...answer, usage: { total_tokens: 50 } }), { status: 200 });
    }) as unknown as typeof fetch;
    // No AI key on the server at all.
    const env = { VITE_SUPABASE_URL: "https://proj.supabase.co", VITE_SUPABASE_ANON_KEY: "anon" };
    const handle = createAiHandler(() => env, network);
    const res = await handle(post({ authorization: "Bearer good-token" }, JSON.stringify({ ...JSON.parse(prompt), workspaceId: "5e6b7d00-a3d6-4dce-bbbe-20e319346f51" })));
    expect(res.status).toBe(200);
    const begin = seen.find((c) => c.url.endsWith("/rpc/ai_begin"))!;
    expect(JSON.parse(begin.body).p_global_day).toBe(0);
    const call = seen.find((c) => c.url === "https://proj.supabase.co/functions/v1/integrations/v1/chat/completions")!;
    expect(call.headers.get("authorization")).toBe("Bearer good-token");
    expect(call.headers.get("x-archone-usage")).toBe("9");
    expect(call.headers.get("x-archone-ticket")).toBe("6f1d9a3c-55a0-4c3e-8a77-2f4b1c9e0d11");
    expect(JSON.parse(call.body).model).toBe("gemini-flash-latest");
  });
});
