import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serviceAccountAssertion } from "./google";
import { createDiscoverHandler, type DiscoverServerEnv } from "./http";
import { toolBase } from "./remote";
import { signAws } from "./sigv4";

const fixture = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`../inventory/fixtures/${name}`, import.meta.url)), "utf8"));
const WS = "5e6b7d00-a3d6-4dce-bbbe-20e319346f51";
const ACCOUNTS = { SUPABASE_URL: "https://accounts.example", SUPABASE_ANON_KEY: "anon" };

type Seen = { url: string; method: string; headers: Headers; body: string };
type Route = (call: Seen) => Response | undefined | Promise<Response | undefined>;
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** A stand-in for the network: the accounts service plus the routes a test gives. */
function network(routes: Route[]) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), method: init.method ?? "GET", headers: new Headers(init.headers), body: typeof init.body === "string" ? init.body : "" };
    seen.push(call);
    if (call.url === "https://accounts.example/rest/v1/rpc/member_role") {
      const token = call.headers.get("authorization");
      return token === "Bearer editor" ? ok("editor") : token === "Bearer viewer" ? ok("viewer") : new Response("{}", { status: 401 });
    }
    for (const route of routes) {
      const answer = await route(call);
      if (answer) return answer;
    }
    return new Response(JSON.stringify({ message: "no route" }), { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

async function post(env: DiscoverServerEnv, routes: Route[], body: unknown = {}, token = "editor") {
  const net = network(routes);
  const handler = createDiscoverHandler(() => ({ ...ACCOUNTS, ...env }), net.fetchImpl, 20_000);
  const response = await handler(new Request("https://app.example/api/discover", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ workspaceId: WS, ...(body as object) }) }));
  return { status: response.status, data: (await response.json()) as Record<string, any>, seen: net.seen };
}
const names = (data: Record<string, any>) => (data.inventory.items as { name: string }[]).map((i) => i.name);

describe("signing requests to AWS", () => {
  it("matches the example AWS publishes for Signature Version 4", async () => {
    const headers = await signAws(
      { method: "GET", url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08", headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }, body: "" },
      "iam",
      "us-east-1",
      { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      new Date("2015-08-30T12:36:00Z"),
    );
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });
});

describe("who may discover", () => {
  const env = { DISCOVERY_SERVICENOW_URL: "https://acme.service-now.com", DISCOVERY_SERVICENOW_TOKEN: "sn-secret-token" };

  it("lists the connected sources by name only", async () => {
    const handler = createDiscoverHandler(() => ({ ...ACCOUNTS, ...env }), network([]).fetchImpl);
    const response = await handler(new Request("https://app.example/api/discover"));
    const text = await response.text();
    expect(JSON.parse(text).sources.filter((s: { configured: boolean }) => s.configured).map((s: { id: string }) => s.id)).toEqual(["servicenow"]);
    expect(text).not.toMatch(/acme|sn-secret/);
  });

  it("refuses other sites, people not signed in, viewers and sources that are not connected", async () => {
    const handler = createDiscoverHandler(() => ({ ...ACCOUNTS, ...env }), network([]).fetchImpl);
    const foreign = await handler(new Request("https://app.example/api/discover", { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ source: "servicenow", workspaceId: WS }) }));
    expect(foreign.status).toBe(403);
    expect((await post(env, [], { source: "servicenow" }, "stolen")).status).toBe(401);
    expect((await post(env, [], { source: "servicenow" }, "viewer")).data.error).toBe("role");
    expect((await post(env, [], { source: "aws" })).status).toBe(501);
    expect((await post({ ...env, SUPABASE_URL: "", SUPABASE_ANON_KEY: "" }, [], { source: "servicenow" })).data.error).toBe("no_accounts");
  });

  it("does not send credentials anywhere a setting does not name, and refuses plain http", () => {
    expect(toolBase("http://acme.example")).toBeNull();
    expect(toolBase("https://user:pw@acme.example")).toBeNull();
    expect(toolBase("https://acme.example/sub")?.toString()).toBe("https://acme.example/sub/");
  });
});

describe("live sources", () => {
  it("reads AWS Config page by page, signed, in each region", async () => {
    const results = (fixture("aws-config.json") as { Results: string[] }).Results;
    const { status, data, seen } = await post({ DISCOVERY_AWS_ACCESS_KEY_ID: "AKIDTEST", DISCOVERY_AWS_SECRET_ACCESS_KEY: "secret", DISCOVERY_AWS_REGIONS: "eu-west-1" }, [
      (call) => {
        if (call.url !== "https://config.eu-west-1.amazonaws.com/") return;
        const body = JSON.parse(call.body) as { NextToken?: string };
        return ok(body.NextToken ? { Results: results.slice(2) } : { Results: results.slice(0, 2), NextToken: "page2" });
      },
    ], { source: "aws" });
    expect(status).toBe(200);
    expect(names(data)).toEqual(["core", "subnet-1", "app-1", "orders"]);
    const calls = seen.filter((c) => c.url.includes("amazonaws"));
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.get("x-amz-target")).toBe("StarlingDoveService.SelectResourceConfig");
    expect(calls[0].headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/eu-west-1\/config\/aws4_request/);
  });

  it("reads Azure Resource Graph with a client secret, following skip tokens", async () => {
    const rows = (fixture("azure.json") as { data: unknown[] }).data;
    const { data, seen } = await post({ DISCOVERY_AZURE_TENANT_ID: "contoso.onmicrosoft.com", DISCOVERY_AZURE_CLIENT_ID: "app", DISCOVERY_AZURE_CLIENT_SECRET: "s3cret" }, [
      (call) => (call.url.startsWith("https://login.microsoftonline.com/contoso.onmicrosoft.com/") ? ok({ access_token: "az-token" }) : undefined),
      (call) => {
        if (!call.url.startsWith("https://management.azure.com/providers/Microsoft.ResourceGraph/resources")) return;
        expect(call.headers.get("authorization")).toBe("Bearer az-token");
        const skip = (JSON.parse(call.body) as { options: { $skipToken?: string } }).options.$skipToken;
        return ok(skip ? { data: rows.slice(3) } : { data: rows.slice(0, 3), $skipToken: "more" });
      },
    ], { source: "azure" });
    expect(names(data)).toContain("vm1");
    expect(new URLSearchParams(seen.find((c) => c.url.includes("login."))!.body).get("scope")).toBe("https://management.azure.com/.default");
  });

  it("reads Google Cloud Asset Inventory with a service account's signed assertion", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
    const account = JSON.stringify({ type: "service_account", client_email: "reader@p1.iam.gserviceaccount.com", private_key: pem });
    const { data } = await post({ DISCOVERY_GCP_SERVICE_ACCOUNT: account, DISCOVERY_GCP_SCOPE: "projects/p1-prod" }, [
      async (call) => {
        if (call.url !== "https://oauth2.googleapis.com/token") return;
        const [header, claims, signature] = new URLSearchParams(call.body).get("assertion")!.split(".");
        const bytes = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
        const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, bytes, new TextEncoder().encode(`${header}.${claims}`));
        expect(valid).toBe(true);
        return ok({ access_token: "g-token" });
      },
      (call) => (call.url.startsWith("https://cloudasset.googleapis.com/v1/projects/p1-prod:searchAllResources") ? ok({ results: fixture("gcp.json") }) : undefined),
    ], { source: "gcp" });
    expect(names(data)).toContain("vm-a");
    // The assertion is for Google's token endpoint and the cloud-platform scope.
    const claims = JSON.parse(atob((await serviceAccountAssertion({ client_email: "a@b", private_key: pem }, "x", 1000)).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims).toMatchObject({ iss: "a@b", aud: "https://oauth2.googleapis.com/token", iat: 1000, exp: 1600 });
  });

  it("reads the ServiceNow CMDB and its relationships through the Table API", async () => {
    const f = fixture("servicenow.json") as { cmdb_ci: { result: unknown[] }; cmdb_rel_ci: { result: unknown[] } };
    const { data, seen } = await post({ DISCOVERY_SERVICENOW_URL: "https://acme.service-now.com", DISCOVERY_SERVICENOW_USER: "svc", DISCOVERY_SERVICENOW_PASSWORD: "pw", DISCOVERY_SERVICENOW_QUERY: "operational_status=1" }, [
      (call) => (call.url.startsWith("https://acme.service-now.com/api/now/table/cmdb_ci?") ? ok(f.cmdb_ci) : undefined),
      (call) => (call.url.startsWith("https://acme.service-now.com/api/now/table/cmdb_rel_ci?") ? ok(f.cmdb_rel_ci) : undefined),
    ], { source: "servicenow" });
    expect(names(data)).toEqual(["Online Banking", "obk-app-01", "lnx-web-01", "ORDERSDB"]);
    expect(data.inventory.links).toHaveLength(3);
    const ci = new URL(seen.find((c) => c.url.includes("cmdb_ci?"))!.url);
    expect(ci.searchParams.get("sysparm_query")).toBe("operational_status=1");
    expect(seen.find((c) => c.url.includes("cmdb_ci?"))!.headers.get("authorization")).toBe(`Basic ${btoa("svc:pw")}`);
  });

  it("runs BMC Helix Discovery searches and leaves out one that fails", async () => {
    const tables = fixture("bmc.json") as unknown[];
    const { data, seen } = await post({ DISCOVERY_BMC_URL: "https://bmc.acme.example", DISCOVERY_BMC_TOKEN: "bmc-token", DISCOVERY_BMC_QUERIES: "SEARCH Host\nSEARCH Broken\nSEARCH Rest" }, [
      (call) => {
        if (!call.url.startsWith("https://bmc.acme.example/api/v1.0/data/search")) return;
        const query = new URL(call.url).searchParams.get("query");
        if (query === "SEARCH Broken") return new Response(JSON.stringify({ message: "bad query" }), { status: 400 });
        return ok(query === "SEARCH Host" ? tables.slice(0, 1) : tables.slice(1));
      },
    ], { source: "bmc" });
    expect(names(data)).toContain("Payments");
    expect(data.inventory.skipped.join(" ")).toMatch(/1 of the 3 queries/);
    expect(seen.find((c) => c.url.includes("bmc."))!.headers.get("authorization")).toBe("Bearer bmc-token");
  });

  it("reads Device42 devices and service communications, and says when communications are missing", async () => {
    const f = fixture("device42.json") as { Devices: unknown[]; communications: unknown[] };
    const env = { DISCOVERY_DEVICE42_URL: "https://d42.acme.example", DISCOVERY_DEVICE42_USER: "u", DISCOVERY_DEVICE42_PASSWORD: "p" };
    const devices: Route = (call) => (call.url.startsWith("https://d42.acme.example/api/1.0/devices/all/") ? ok({ Devices: f.Devices, total_count: f.Devices.length }) : undefined);
    const full = await post(env, [devices, (call) => (call.url.includes("/services/data/v1.0/query/") ? ok(f.communications) : undefined)], { source: "device42" });
    expect(full.data.inventory.links.some((l: { kind: string; port?: string }) => l.kind === "calls" && l.port === "1433")).toBe(true);
    const partial = await post(env, [devices], { source: "device42" });
    expect(partial.status).toBe(200);
    expect(partial.data.inventory.skipped.join(" ")).toMatch(/service communications query did not answer/);
  });

  it("passes on why a source refused, without the rest of its answer", async () => {
    const { status, data } = await post({ DISCOVERY_BMC_URL: "https://bmc.acme.example", DISCOVERY_BMC_TOKEN: "expired" }, [() => new Response(JSON.stringify({ message: "Token expired", detail: "x".repeat(5000) }), { status: 401 })], { source: "bmc" });
    expect(status).toBe(502);
    expect(data.error).toBe("credentials_refused");
    expect(data.message).toMatch(/did not accept the credentials.*DISCOVERY_BMC_URL.*It said: Token expired$/);
  });
});
