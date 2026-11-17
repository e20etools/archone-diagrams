import { readAws, readAzure, readGcp, readDiscoveryRows, readServiceNow } from "../inventory/discovery";
import type { Inventory } from "../inventory/model";
import { googleAccessToken, parseServiceAccount } from "./google";
import { DiscoverError, Remote, toolBase, type DiscoverEnv } from "./remote";
import { signAws } from "./sigv4";

/**
 * Live discovery: this server asks a cloud provider or a discovery tool what is running, with
 * credentials kept in the host's settings (never in the browser), and answers an inventory the
 * app turns into a draft. Each source reads its own settings, all starting with DISCOVERY_:
 *
 *   AWS          DISCOVERY_AWS_ACCESS_KEY_ID, DISCOVERY_AWS_SECRET_ACCESS_KEY, DISCOVERY_AWS_REGIONS
 *                (comma separated, default us-east-1); optional DISCOVERY_AWS_SESSION_TOKEN and
 *                DISCOVERY_AWS_AGGREGATOR (an AWS Config aggregator, for many accounts and regions).
 *                Reads AWS Config with SelectResourceConfig, so AWS Config must be recording.
 *   Azure        DISCOVERY_AZURE_TENANT_ID, DISCOVERY_AZURE_CLIENT_ID, DISCOVERY_AZURE_CLIENT_SECRET;
 *                optional DISCOVERY_AZURE_SUBSCRIPTIONS. Reads Azure Resource Graph (Reader role).
 *   Google Cloud DISCOVERY_GCP_SERVICE_ACCOUNT (the service account's JSON key) and DISCOVERY_GCP_SCOPE
 *                (projects/ID, folders/NUMBER or organizations/NUMBER). Reads Cloud Asset Inventory
 *                (Cloud Asset Viewer role).
 *   ServiceNow   DISCOVERY_SERVICENOW_URL and DISCOVERY_SERVICENOW_TOKEN, or DISCOVERY_SERVICENOW_USER
 *                and DISCOVERY_SERVICENOW_PASSWORD; optional DISCOVERY_SERVICENOW_QUERY (an encoded
 *                query on cmdb_ci). Reads cmdb_ci and cmdb_rel_ci through the Table API.
 *   BMC Helix    DISCOVERY_BMC_URL and DISCOVERY_BMC_TOKEN; optional DISCOVERY_BMC_API_VERSION (1.0)
 *   Discovery    and DISCOVERY_BMC_QUERIES (queries, one per line, to replace the built-in ones).
 *   Device42     DISCOVERY_DEVICE42_URL, DISCOVERY_DEVICE42_USER, DISCOVERY_DEVICE42_PASSWORD;
 *                optional DISCOVERY_DEVICE42_DOQL (the query for service communications).
 */

/** At most this many resources are read from one source, so the answer stays small enough to send. */
export const MAX_RESOURCES = 5000;

const value = (env: DiscoverEnv, name: string) => (env[name] ?? "").trim();

export const SOURCE_IDS = ["aws", "azure", "gcp", "servicenow", "bmc", "device42"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

interface Source {
  id: SourceId;
  label: string;
  /** The settings it reads, named in messages. */
  settings: string;
  configured(env: DiscoverEnv): boolean;
  run(env: DiscoverEnv, remote: Remote): Promise<Inventory>;
}

const noteCap = (inventory: Inventory, read: number, unit: string, stopped: boolean): Inventory =>
  stopped ? { ...inventory, skipped: [...inventory.skipped, `Stopped after ${read.toLocaleString("en")} ${unit}: narrow what is read to see the rest`] } : inventory;

/* ---------- AWS Config ---------- */

const AWS_REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const AWS_QUERY = "SELECT resourceId, resourceName, resourceType, awsRegion, availabilityZone, tags, relationships";

const aws: Source = {
  id: "aws",
  label: "AWS",
  settings: "DISCOVERY_AWS_ACCESS_KEY_ID, DISCOVERY_AWS_SECRET_ACCESS_KEY and DISCOVERY_AWS_REGIONS",
  configured: (env) => !!value(env, "DISCOVERY_AWS_ACCESS_KEY_ID") && !!value(env, "DISCOVERY_AWS_SECRET_ACCESS_KEY"),
  async run(env, remote) {
    const regions = (value(env, "DISCOVERY_AWS_REGIONS") || "us-east-1").split(/[\s,]+/).filter((r) => AWS_REGION.test(r));
    if (!regions.length) throw new DiscoverError(400, "bad_settings", "DISCOVERY_AWS_REGIONS names no AWS region, such as eu-west-1.");
    const credentials = { accessKeyId: value(env, "DISCOVERY_AWS_ACCESS_KEY_ID"), secretAccessKey: value(env, "DISCOVERY_AWS_SECRET_ACCESS_KEY"), sessionToken: value(env, "DISCOVERY_AWS_SESSION_TOKEN") || undefined };
    const aggregator = value(env, "DISCOVERY_AWS_AGGREGATOR");
    const results: unknown[] = [];
    let stopped = false;
    // With an aggregator, one query in its region covers every account and region it collects.
    for (const region of aggregator ? regions.slice(0, 1) : regions) {
      let next: string | undefined;
      do {
        if (results.length >= MAX_RESOURCES || !remote.hasTime) {
          stopped = true;
          break;
        }
        const url = `https://config.${region}.amazonaws.com/`;
        const body = JSON.stringify({ Expression: AWS_QUERY, Limit: 100, ...(aggregator ? { ConfigurationAggregatorName: aggregator } : {}), ...(next ? { NextToken: next } : {}) });
        const headers = await signAws(
          { method: "POST", url, body, headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `StarlingDoveService.${aggregator ? "SelectAggregateResourceConfig" : "SelectResourceConfig"}` } },
          "config",
          region,
          credentials,
        );
        const page = (await remote.json(url, { method: "POST", headers, body })) as { Results?: unknown[]; NextToken?: string };
        results.push(...(page?.Results ?? []));
        next = page?.NextToken || undefined;
      } while (next);
    }
    return noteCap(readAws({ Results: results.slice(0, MAX_RESOURCES) }, aggregator ? `AWS Config aggregator ${aggregator}` : `AWS ${regions.join(", ")}`), results.length, "resources", stopped);
  },
};

/* ---------- Azure Resource Graph ---------- */

const azure: Source = {
  id: "azure",
  label: "Azure",
  settings: "DISCOVERY_AZURE_TENANT_ID, DISCOVERY_AZURE_CLIENT_ID and DISCOVERY_AZURE_CLIENT_SECRET",
  configured: (env) => ["DISCOVERY_AZURE_TENANT_ID", "DISCOVERY_AZURE_CLIENT_ID", "DISCOVERY_AZURE_CLIENT_SECRET"].every((n) => !!value(env, n)),
  async run(env, remote) {
    const tenant = value(env, "DISCOVERY_AZURE_TENANT_ID");
    if (!/^[A-Za-z0-9.-]{3,100}$/.test(tenant)) throw new DiscoverError(400, "bad_settings", "DISCOVERY_AZURE_TENANT_ID is not a tenant id or domain.");
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: value(env, "DISCOVERY_AZURE_CLIENT_ID"), client_secret: value(env, "DISCOVERY_AZURE_CLIENT_SECRET"), scope: "https://management.azure.com/.default" });
    const token = (await remote.json(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() })) as { access_token?: string };
    if (!token?.access_token) throw new DiscoverError(502, "credentials_refused", "Azure gave no access token. Check DISCOVERY_AZURE_CLIENT_ID and DISCOVERY_AZURE_CLIENT_SECRET.");
    const subscriptions = value(env, "DISCOVERY_AZURE_SUBSCRIPTIONS").split(/[\s,]+/).filter(Boolean);
    const data: unknown[] = [];
    let skip: string | undefined;
    let stopped = false;
    do {
      if (data.length >= MAX_RESOURCES || !remote.hasTime) {
        stopped = true;
        break;
      }
      const body = JSON.stringify({
        ...(subscriptions.length ? { subscriptions } : {}),
        query: "Resources | project id, name, type, kind, location, resourceGroup, subscriptionId, tags, properties",
        options: { $top: 1000, resultFormat: "objectArray", ...(skip ? { $skipToken: skip } : {}) },
      });
      const page = (await remote.json("https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token.access_token}` },
        body,
      })) as { data?: unknown[]; $skipToken?: string };
      data.push(...(Array.isArray(page?.data) ? page.data : []));
      skip = page?.$skipToken || undefined;
    } while (skip);
    return noteCap(readAzure({ data: data.slice(0, MAX_RESOURCES) }, subscriptions.length ? `Azure ${subscriptions.length === 1 ? "subscription" : "subscriptions"} ${subscriptions.join(", ")}` : "Azure"), data.length, "resources", stopped);
  },
};

/* ---------- Google Cloud Asset Inventory ---------- */

const GCP_SCOPE = /^(projects\/[a-z][a-z0-9-]{4,61}[a-z0-9]|projects\/\d+|folders\/\d+|organizations\/\d+)$/;

const gcp: Source = {
  id: "gcp",
  label: "Google Cloud",
  settings: "DISCOVERY_GCP_SERVICE_ACCOUNT and DISCOVERY_GCP_SCOPE",
  configured: (env) => !!value(env, "DISCOVERY_GCP_SERVICE_ACCOUNT") && !!value(env, "DISCOVERY_GCP_SCOPE"),
  async run(env, remote) {
    const scope = value(env, "DISCOVERY_GCP_SCOPE");
    if (!GCP_SCOPE.test(scope)) throw new DiscoverError(400, "bad_settings", "DISCOVERY_GCP_SCOPE should be projects/ID, folders/NUMBER or organizations/NUMBER.");
    const account = parseServiceAccount(value(env, "DISCOVERY_GCP_SERVICE_ACCOUNT"));
    if (!account) throw new DiscoverError(400, "bad_settings", "DISCOVERY_GCP_SERVICE_ACCOUNT is not a service account's JSON key.");
    const token = await googleAccessToken(account, "https://www.googleapis.com/auth/cloud-platform", remote);
    const results: unknown[] = [];
    let next: string | undefined;
    let stopped = false;
    do {
      if (results.length >= MAX_RESOURCES || !remote.hasTime) {
        stopped = true;
        break;
      }
      const url = new URL(`https://cloudasset.googleapis.com/v1/${scope}:searchAllResources`);
      url.searchParams.set("pageSize", "500");
      if (next) url.searchParams.set("pageToken", next);
      const page = (await remote.json(url.toString(), { headers: { authorization: `Bearer ${token}` } })) as { results?: unknown[]; nextPageToken?: string };
      results.push(...(Array.isArray(page?.results) ? page.results : []));
      next = page?.nextPageToken || undefined;
    } while (next);
    if (!results.length) throw new DiscoverError(404, "nothing_found", `Cloud Asset Inventory found no resources in ${scope}. Check that the Cloud Asset API is on and the service account may view assets there.`);
    return noteCap(readGcp(results.slice(0, MAX_RESOURCES), `Google Cloud ${scope}`), results.length, "resources", stopped);
  },
};

/* ---------- ServiceNow CMDB ---------- */

const basic = (user: string, password: string) => `Basic ${btoa(unescape(encodeURIComponent(`${user}:${password}`)))}`;

const servicenow: Source = {
  id: "servicenow",
  label: "ServiceNow",
  settings: "DISCOVERY_SERVICENOW_URL and DISCOVERY_SERVICENOW_TOKEN, or DISCOVERY_SERVICENOW_USER and DISCOVERY_SERVICENOW_PASSWORD",
  configured: (env) => !!value(env, "DISCOVERY_SERVICENOW_URL") && (!!value(env, "DISCOVERY_SERVICENOW_TOKEN") || (!!value(env, "DISCOVERY_SERVICENOW_USER") && !!value(env, "DISCOVERY_SERVICENOW_PASSWORD"))),
  async run(env, remote) {
    const base = toolBase(value(env, "DISCOVERY_SERVICENOW_URL"));
    if (!base) throw new DiscoverError(400, "bad_settings", "DISCOVERY_SERVICENOW_URL is not a plain https address, such as https://yourcompany.service-now.com.");
    const authorization = value(env, "DISCOVERY_SERVICENOW_TOKEN") ? `Bearer ${value(env, "DISCOVERY_SERVICENOW_TOKEN")}` : basic(value(env, "DISCOVERY_SERVICENOW_USER"), value(env, "DISCOVERY_SERVICENOW_PASSWORD"));
    const table = async (name: string, params: Record<string, string>, cap: number) => {
      const rows: unknown[] = [];
      let stopped = false;
      for (let offset = 0; ; offset += 1000) {
        if (rows.length >= cap || !remote.hasTime) {
          stopped = true;
          break;
        }
        const url = new URL(`api/now/table/${name}`, base);
        for (const [k, v] of Object.entries({ ...params, sysparm_limit: "1000", sysparm_offset: String(offset), sysparm_exclude_reference_link: "true" })) if (v) url.searchParams.set(k, v);
        const page = (await remote.json(url.toString(), { headers: { authorization } })) as { result?: unknown[] };
        const got = Array.isArray(page?.result) ? page.result : [];
        rows.push(...got);
        if (got.length < 1000) break;
      }
      return { rows: rows.slice(0, cap), stopped };
    };
    const cis = await table("cmdb_ci", { sysparm_fields: "sys_id,name,sys_class_name,ip_address,os,short_description,operational_status,environment", sysparm_query: value(env, "DISCOVERY_SERVICENOW_QUERY") }, MAX_RESOURCES);
    const rels = await table("cmdb_rel_ci", { sysparm_fields: "parent,child,type", sysparm_display_value: "all" }, MAX_RESOURCES * 4);
    return noteCap(readServiceNow({ cmdb_ci: { result: cis.rows }, cmdb_rel_ci: { result: rels.rows } }, `ServiceNow ${base.host}`), cis.rows.length, "configuration items", cis.stopped || rels.stopped);
  },
};

/* ---------- BMC Helix Discovery ---------- */

/** Hosts, the software running on them with what it depends on, and the applications that group it. */
export const BMC_QUERIES = [
  "SEARCH Host SHOW key AS 'id', name, kind(#) AS 'kind', os",
  "SEARCH SoftwareInstance SHOW key AS 'id', name, kind(#) AS 'kind', type AS 'product', #RunningSoftware:HostedSoftware:Host:Host.key AS 'host_id', #Dependant:Dependency:DependedUpon:SoftwareInstance.key AS 'depends_on'",
  "SEARCH BusinessApplicationInstance SHOW key AS 'id', name, kind(#) AS 'kind', #Collection:Collection:Member:SoftwareInstance.key AS 'members'",
];

const bmc: Source = {
  id: "bmc",
  label: "BMC Helix Discovery",
  settings: "DISCOVERY_BMC_URL and DISCOVERY_BMC_TOKEN",
  configured: (env) => !!value(env, "DISCOVERY_BMC_URL") && !!value(env, "DISCOVERY_BMC_TOKEN"),
  async run(env, remote) {
    const base = toolBase(value(env, "DISCOVERY_BMC_URL"));
    if (!base) throw new DiscoverError(400, "bad_settings", "DISCOVERY_BMC_URL is not a plain https address of the appliance or instance.");
    const version = /^\d+\.\d+$/.test(value(env, "DISCOVERY_BMC_API_VERSION")) ? value(env, "DISCOVERY_BMC_API_VERSION") : "1.0";
    const queries = value(env, "DISCOVERY_BMC_QUERIES") ? value(env, "DISCOVERY_BMC_QUERIES").split(/\r?\n/).map((q) => q.trim()).filter(Boolean) : BMC_QUERIES;
    const authorization = `Bearer ${value(env, "DISCOVERY_BMC_TOKEN")}`;
    const tables: unknown[] = [];
    let rows = 0;
    let stopped = false;
    let failed = 0;
    for (const [i, query] of queries.entries()) {
      let url: string | undefined = new URL(`api/v${version}/data/search?${new URLSearchParams({ query, limit: "1000" })}`, base).toString();
      while (url) {
        if (rows >= MAX_RESOURCES || !remote.hasTime) {
          stopped = true;
          break;
        }
        // The first query must answer, so wrong settings are reported; a later one that fails is left out.
        const answer = await remote.json(url, { headers: { authorization } }, i > 0);
        if (answer === undefined) {
          failed++;
          break;
        }
        const pages = (Array.isArray(answer) ? answer : [answer]) as { results?: unknown[]; next?: string }[];
        tables.push(...pages);
        rows += pages.reduce((n, p) => n + (Array.isArray(p.results) ? p.results.length : 0), 0);
        // Only follow a next page on the same server.
        const next = pages.find((p) => typeof p.next === "string")?.next;
        url = next && new URL(next, base).host === base.host ? new URL(next, base).toString() : undefined;
      }
    }
    const inventory = noteCap(readDiscoveryRows(tables, `BMC Helix Discovery ${base.host}`, "BMC Helix Discovery"), rows, "rows", stopped);
    return failed ? { ...inventory, skipped: [...inventory.skipped, `${failed} of the ${queries.length} queries did not answer and were left out`] } : inventory;
  },
};

/* ---------- Device42 ---------- */

export const DEVICE42_DOQL =
  "SELECT DISTINCT c.name AS client, l.name AS listener, sc.port, sc.protocol FROM view_servicecommunication_v2 sc JOIN view_device_v2 c ON c.device_pk = sc.client_device_fk JOIN view_device_v2 l ON l.device_pk = sc.listener_device_fk WHERE sc.client_device_fk <> sc.listener_device_fk LIMIT 20000";

const device42: Source = {
  id: "device42",
  label: "Device42",
  settings: "DISCOVERY_DEVICE42_URL, DISCOVERY_DEVICE42_USER and DISCOVERY_DEVICE42_PASSWORD",
  configured: (env) => ["DISCOVERY_DEVICE42_URL", "DISCOVERY_DEVICE42_USER", "DISCOVERY_DEVICE42_PASSWORD"].every((n) => !!value(env, n)),
  async run(env, remote) {
    const base = toolBase(value(env, "DISCOVERY_DEVICE42_URL"));
    if (!base) throw new DiscoverError(400, "bad_settings", "DISCOVERY_DEVICE42_URL is not a plain https address of the Device42 appliance.");
    const authorization = basic(value(env, "DISCOVERY_DEVICE42_USER"), value(env, "DISCOVERY_DEVICE42_PASSWORD"));
    const devices: unknown[] = [];
    let stopped = false;
    for (let offset = 0; ; offset += 1000) {
      if (devices.length >= MAX_RESOURCES || !remote.hasTime) {
        stopped = true;
        break;
      }
      const page = (await remote.json(new URL(`api/1.0/devices/all/?limit=1000&offset=${offset}`, base).toString(), { headers: { authorization } })) as { Devices?: unknown[]; total_count?: number };
      const got = Array.isArray(page?.Devices) ? page.Devices : [];
      devices.push(...got);
      if (got.length < 1000 || (typeof page?.total_count === "number" && devices.length >= page.total_count)) break;
    }
    // Application components and service communications add to the devices; either may be missing on an appliance.
    const appComps = (await remote.json(new URL("api/1.0/appcomps/", base).toString(), { headers: { authorization } }, true)) as { app_comps?: unknown[] } | undefined;
    const doql = value(env, "DISCOVERY_DEVICE42_DOQL") || DEVICE42_DOQL;
    const communications = remote.hasTime ? await remote.json(new URL(`services/data/v1.0/query/?${new URLSearchParams({ query: doql, output_type: "json" })}`, base).toString(), { headers: { authorization } }, true) : undefined;
    const inventory = noteCap(
      readDiscoveryRows({ Devices: devices.slice(0, MAX_RESOURCES), app_comps: appComps?.app_comps ?? [], communications: Array.isArray(communications) ? communications : [] }, `Device42 ${base.host}`, "Device42"),
      devices.length,
      "devices",
      stopped,
    );
    return Array.isArray(communications) ? inventory : { ...inventory, skipped: [...inventory.skipped.filter((s) => !s.startsWith("No connection rows")), "The service communications query did not answer, so only where devices run is drawn"] };
  },
};

export { DiscoverError, type DiscoverEnv };
export const SOURCES: Source[] = [aws, azure, gcp, servicenow, bmc, device42];
export const sourceOf = (id: unknown) => SOURCES.find((s) => s.id === id);
