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
    const env = { ...configured, VITE_SUPABASE_URL: "https://proj.supabase.co/", VITE_SUPABASE_ANON_KEY: "anon" };
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
});
