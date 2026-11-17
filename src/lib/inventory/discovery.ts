import type { RelationKind } from "../types";
import { guessType } from "../import/diagramFile";
import { buildInventory, type RawResource } from "./build";
import { arnType, awsType, azureType, cloudResource, gcpType } from "./catalog";
import { asArray, asRecord, generalComponent, InventoryError, keepFields, shortName, stringsIn, text, type Inventory } from "./model";

/**
 * What a cloud or a discovery tool says is running, read from its own export or from the live
 * connection (which hands back the same shapes):
 *  - AWS: AWS Config query results (with relationships), Resource Explorer search results, or
 *    the Resource Groups Tagging API's resource list;
 *  - Azure: Resource Graph query results;
 *  - Google Cloud: Cloud Asset Inventory search results or export;
 *  - ServiceNow CMDB: configuration items and their relationships (Table API);
 *  - BMC Helix Discovery and Device42: rows of nodes and of connections, from their APIs or exports.
 */

const tagsOf = (list: unknown, key = "Key", value = "Value") =>
  asArray(list)
    .map(asRecord)
    .map((t) => [text(t[key] ?? t.key), text(t[value] ?? t.value)] as const)
    .filter(([k]) => k);

/* ---------- AWS ---------- */

export function looksLikeAws(v: unknown): boolean {
  const r = asRecord(v);
  return Array.isArray(r.Results) || Array.isArray(r.resourceIdentifiers) || Array.isArray(r.ResourceTagMappingList) || (Array.isArray(r.Resources) && asArray(r.Resources).some((x) => text(asRecord(x).Arn).startsWith("arn:"))) || Array.isArray(r.configurationItems) || Array.isArray(r.baseConfigurationItems);
}

export function readAws(value: unknown, fileName = "AWS"): Inventory {
  const r = asRecord(value);
  const raw = new Map<string, RawResource>();
  const add = (id: string, type: string, name: string, extra: Partial<RawResource> = {}) => {
    if (!id || raw.has(id)) return;
    const kind = cloudResource("aws", type.includes("::") ? awsType(type) : type);
    raw.set(id, { id, name: name || shortName(id), resourceType: type, component: kind.component, role: kind.role, refs: [], technology: type, ...extra });
  };
  let format = "An AWS inventory";
  // AWS Config: one configuration item per resource, with what it is contained in and attached to.
  const configItems = [...asArray(r.Results).map((x) => (typeof x === "string" ? (JSON.parse(x) as unknown) : x)), ...asArray(r.configurationItems), ...asArray(r.baseConfigurationItems)].map(asRecord);
  if (configItems.length) {
    format = "AWS Config resources";
    for (const c of configItems) {
      const tags = tagsOf(c.tags, "key", "value").length ? tagsOf(c.tags, "key", "value") : Object.entries(asRecord(c.tags)).map(([k, v]) => [k, text(v)] as const);
      const name = tags.find(([k]) => k === "Name")?.[1] || text(c.resourceName) || text(c.resourceId);
      const refs: string[] = [];
      let parentId: string | null = null;
      for (const rel of asArray(c.relationships).map(asRecord)) {
        const target = text(rel.resourceId);
        const how = text(rel.relationshipName ?? rel.name);
        if (/^Is contained in (Subnet|Vpc)$/i.test(how)) parentId = parentId && /Subnet/.test(how) === false ? parentId : target;
        else if (!/^Contains /i.test(how)) refs.push(target);
      }
      add(text(c.resourceId), text(c.resourceType), name, {
        refs,
        parentId,
        fields: { ...keepFields(c, ["awsRegion", "accountId", "availabilityZone", "arn"]), ...keepFields(asRecord(c.configuration), ["instanceType", "engine", "engineVersion", "runtime", "cidrBlock", "privateIpAddress", "dBInstanceClass"]) },
        tags: tags.filter(([k]) => k !== "Name").slice(0, 10).map(([k, v]) => `${k}=${v}`),
      });
    }
  }
  for (const id of asArray(r.resourceIdentifiers).map(asRecord)) add(text(id.resourceId), text(id.resourceType), text(id.resourceName));
  // Resource Explorer and the Tagging API: what exists, by ARN, without relationships.
  for (const res of asArray(r.Resources).map(asRecord)) {
    const tags = asArray(res.Properties).map(asRecord).filter((p) => p.Name === "tags").flatMap((p) => tagsOf(p.Data));
    add(text(res.Arn), text(res.ResourceType) || arnType(text(res.Arn)), tags.find(([k]) => k === "Name")?.[1] ?? "", { fields: keepFields({ region: res.Region, account: res.OwningAccountId }, ["region", "account"]), tags: tags.filter(([k]) => k !== "Name").slice(0, 10).map(([k, v]) => `${k}=${v}`) });
    format = configItems.length ? format : "AWS Resource Explorer results";
  }
  for (const m of asArray(r.ResourceTagMappingList).map(asRecord)) {
    const tags = tagsOf(m.Tags);
    add(text(m.ResourceARN), arnType(text(m.ResourceARN)), tags.find(([k]) => k === "Name")?.[1] ?? "", { tags: tags.filter(([k]) => k !== "Name").slice(0, 10).map(([k, v]) => `${k}=${v}`) });
    format = configItems.length ? format : "AWS tagged resources";
  }
  if (!raw.size) throw new InventoryError(`No AWS resources were found in "${fileName}".`);
  return buildInventory(format, fileName, [...raw.values()], configItems.length ? [] : ["This list gives no relationships; AWS Config query results do"]);
}

/* ---------- Azure ---------- */

export function looksLikeAzure(v: unknown): boolean {
  const list = Array.isArray(v) ? v : asArray(asRecord(v).data ?? asRecord(v).value);
  return list.length > 0 && list.every((x) => /^\/subscriptions\//i.test(text(asRecord(x).id)) && text(asRecord(x).type).includes("/"));
}

export function readAzure(value: unknown, fileName = "Azure"): Inventory {
  const list = (Array.isArray(value) ? value : asArray(asRecord(value).data ?? asRecord(value).value)).map(asRecord);
  const raw: RawResource[] = [];
  const known = new Set<string>();
  for (const res of list) {
    const id = text(res.id).toLowerCase();
    const type = text(res.type);
    const kindKey = text(res.kind).toLowerCase().includes("functionapp") ? "websitesfunctionapp" : azureType(type);
    const kind = cloudResource("azure", kindKey);
    raw.push({ id, name: text(res.name), resourceType: type, component: kind.component, role: kind.role, refs: [], technology: type, fields: keepFields({ location: res.location, resourceGroup: res.resourceGroup, subscription: res.subscriptionId, sku: asRecord(res.sku).name }, ["location", "resourceGroup", "subscription", "sku"]), tags: Object.entries(asRecord(res.tags)).slice(0, 10).map(([k, v]) => `${k}=${text(v)}`) });
    known.add(id);
    // Subnets live inside their network's properties; each becomes a zone of its own.
    for (const sub of asArray(asRecord(res.properties).subnets).map(asRecord)) {
      const sid = text(sub.id).toLowerCase();
      if (!sid || known.has(sid)) continue;
      const kindSub = cloudResource("azure", "networkvirtualnetworkssubnets");
      raw.push({ id: sid, name: text(sub.name), resourceType: "Microsoft.Network/virtualNetworks/subnets", component: kindSub.component, role: "zone", refs: [id], technology: "Microsoft.Network/virtualNetworks/subnets", fields: keepFields(asRecord(sub.properties), ["addressPrefix"]) });
      known.add(sid);
    }
  }
  if (!raw.length) throw new InventoryError(`No Azure resources were found in "${fileName}".`);
  // A property that holds another resource's id refers to it; an id under another's is part of it.
  for (const item of raw) {
    const res = list.find((x) => text(x.id).toLowerCase() === item.id);
    if (!res) continue;
    for (const [, value] of stringsIn(res.properties)) {
      const v = value.toLowerCase();
      if (known.has(v) && v !== item.id) item.refs.push(v);
    }
    const parent = item.id.split("/providers/")[1]?.split("/").length > 3 ? item.id.slice(0, item.id.lastIndexOf("/", item.id.lastIndexOf("/") - 1)) : "";
    if (parent && known.has(parent)) item.refs.push(parent);
  }
  return buildInventory("Azure Resource Graph results", fileName, raw);
}

/* ---------- Google Cloud ---------- */

export function looksLikeGcp(v: unknown): boolean {
  const list = Array.isArray(v) ? v : asArray(asRecord(v).results ?? asRecord(v).resources ?? asRecord(v).assets);
  return list.length > 0 && list.some((x) => /^\/\/[a-z]+\.googleapis\.com\//.test(text(asRecord(x).name)) && (asRecord(x).assetType || asRecord(x).asset_type));
}

/** projects/p/zones/z/instances/vm from a full name, a self link or a relative name. */
const gcpKey = (value: string) => {
  const at = value.indexOf("projects/");
  return at >= 0 ? value.slice(at).toLowerCase().replace(/\/+$/, "") : "";
};

export function readGcp(value: unknown, fileName = "Google Cloud"): Inventory {
  const list = (Array.isArray(value) ? value : asArray(asRecord(value).results ?? asRecord(value).resources ?? asRecord(value).assets)).map(asRecord);
  const byKey = new Map<string, string>();
  for (const a of list) {
    const key = gcpKey(text(a.name));
    if (key) byKey.set(key, text(a.name));
  }
  const raw: RawResource[] = list.map((a) => {
    const name = text(a.name);
    const type = text(a.assetType ?? a.asset_type);
    const kind = cloudResource("gcp", gcpType(type));
    const refs = new Set<string>();
    const data = [a.additionalAttributes, a.versionedResources, asRecord(a.resource).data, a.parentFullResourceName];
    for (const [, v] of stringsIn(data)) {
      const hit = byKey.get(gcpKey(v));
      if (hit && hit !== name) refs.add(hit);
    }
    const labels = Object.entries(asRecord(a.labels ?? asRecord(asRecord(a.resource).data).labels));
    return { id: name, name: text(a.displayName) || shortName(name), resourceType: type, component: kind.component, role: kind.role, refs: [...refs], technology: type, fields: keepFields({ location: a.location, project: a.project, state: a.state }, ["location", "project", "state"]), tags: labels.slice(0, 10).map(([k, v]) => `${k}=${text(v)}`) };
  });
  if (!raw.length) throw new InventoryError(`No Google Cloud assets were found in "${fileName}".`);
  return buildInventory("Google Cloud Asset Inventory results", fileName, raw);
}

/* ---------- ServiceNow CMDB ---------- */

/** A ServiceNow field: a plain value, or { value, display_value, link }. */
const sn = (v: unknown, display = true): string => {
  if (v && typeof v === "object") {
    const r = asRecord(v);
    return text(display ? r.display_value || r.value : r.value || r.display_value);
  }
  return text(v);
};

function snRecords(value: unknown, table: "ci" | "rel"): Record<string, unknown>[] {
  const r = asRecord(value);
  const pick = (v: unknown) => (Array.isArray(v) ? v : asArray(asRecord(v).result ?? asRecord(v).records));
  if (table === "ci") return [...pick(r.cmdb_ci ?? r.cis), ...pick(Array.isArray(value) ? value : r.result ?? r.records)].map(asRecord).filter((x) => x.sys_id && !("child" in x));
  return [...pick(r.cmdb_rel_ci ?? r.relationships), ...pick(Array.isArray(value) ? value : r.result ?? r.records)].map(asRecord).filter((x) => "parent" in x && "child" in x);
}

export const looksLikeServiceNow = (v: unknown) => snRecords(v, "ci").some((x) => "sys_class_name" in x) || snRecords(v, "rel").some((x) => "type" in x);

function snType(className: string, name: string): string {
  const c = className.toLowerCase();
  if (/kubernetes|openshift|cluster/.test(c)) return "cluster";
  if (/(^|_)(db|database)(_|$)|_instance$.*db|mssql|oracle|postgres|mysql|mongo/.test(c)) return "database";
  if (/lb|load_bal/.test(c)) return "gateway";
  if (/netgear|router|switch|firewall|ip_network|network/.test(c)) return "network";
  if (/storage|san|nas|disk/.test(c)) return "storage";
  if (/business_app|service_auto|service_discovered|cmdb_ci_service|service_offering|application_service/.test(c)) return "system";
  if (/appl|app_server|web_server|tomcat|iis|jboss|weblogic|websphere/.test(c)) return "application";
  if (/server|computer|vm_instance|vmware|hyper_v|virtual_machine|esx|host/.test(c)) return "server";
  return guessType(c.replace(/_/g, " "), name) ?? "application";
}

const SN_KIND: [RegExp, RelationKind, boolean][] = [
  [/^runs on/i, "hosted_on", false],
  [/^hosted on/i, "hosted_on", false],
  [/^virtualized by/i, "hosted_on", false],
  [/^(cluster of|members?|member of)/i, "hosted_on", true],
  [/^(contains|contained by)/i, "depends_on", true],
  [/^(connects to|sends data to|calls)/i, "calls", false],
  [/^(uses|depends on|consumes)/i, "depends_on", false],
];

export function readServiceNow(value: unknown, fileName = "ServiceNow"): Inventory {
  const cis = snRecords(value, "ci");
  const rels = snRecords(value, "rel");
  if (!cis.length) throw new InventoryError(`No configuration items were found in "${fileName}". Export cmdb_ci with sys_id, name and sys_class_name.`);
  const raw = new Map<string, RawResource>();
  for (const ci of cis) {
    const id = sn(ci.sys_id, false);
    const className = sn(ci.sys_class_name, false);
    const name = sn(ci.name) || id;
    const typeId = snType(className, name);
    raw.set(id, {
      id,
      name,
      resourceType: className || "cmdb_ci",
      component: generalComponent(name) ?? undefined,
      refs: [],
      typeHint: typeId,
      technology: sn(ci.sys_class_name) || className,
      description: sn(ci.short_description).slice(0, 500),
      fields: Object.fromEntries(["ip_address", "fqdn", "os", "os_version", "environment", "operational_status", "install_status", "used_for", "owned_by", "support_group", "location"].map((k) => [k, sn(ci[k])]).filter(([, v]) => v)),
    });
  }
  let unknownTypes = 0;
  for (const rel of rels) {
    const parent = raw.get(sn(rel.parent, false));
    const child = sn(rel.child, false);
    if (!parent || !raw.has(child)) continue;
    const label = sn(rel.type).split("::")[0];
    const rule = SN_KIND.find(([p]) => p.test(label));
    if (!rule) unknownTypes++;
    const [kind, reversed] = rule ? [rule[1], rule[2]] : (["depends_on", false] as const);
    if (reversed) raw.get(child)!.links = [...(raw.get(child)!.links ?? []), { targetId: parent.id, kind, label: label.toLowerCase() }];
    else parent.links = [...(parent.links ?? []), { targetId: child, kind, label: label.toLowerCase() }];
  }
  return buildInventory("A ServiceNow CMDB export", fileName, [...raw.values()], [
    ...(rels.length ? [] : ["No relationships were in the file; export cmdb_rel_ci with parent, child and type too"]),
    ...(unknownTypes ? [`${unknownTypes} relationships of other types were read as "depends on"`] : []),
  ]);
}

/* ---------- BMC Helix Discovery and Device42: rows ---------- */

const ROW_CONTAINERS = ["Devices", "devices", "app_comps", "appcomps", "services", "service_instances", "communications", "hosts", "software", "applications", "nodes", "links", "rows", "results"];

/** Rows from a search: [{ headings, results }] tables, or plain objects. */
function rowsOf(value: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const take = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) take(x);
      return;
    }
    const r = asRecord(v);
    if (Array.isArray(r.headings) && Array.isArray(r.results)) {
      const headings = r.headings.map(text);
      for (const row of r.results) out.push(Array.isArray(row) ? Object.fromEntries(headings.map((h, i) => [h, row[i]])) : asRecord(row));
      return;
    }
    let container = false;
    for (const key of ROW_CONTAINERS)
      if (Array.isArray(r[key])) {
        container = true;
        take(r[key]);
      }
    if (!container && Object.keys(r).length) out.push(r);
  };
  take(value);
  return out;
}

const pick = (row: Record<string, unknown>, names: string[]): unknown => {
  const keys = Object.keys(row);
  for (const n of names) {
    const k = keys.find((key) => key.toLowerCase().replace(/[^a-z0-9#]/g, "") === n);
    if (k !== undefined && row[k] !== null && row[k] !== undefined && row[k] !== "") return row[k];
  }
  return undefined;
};
const many = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === "object" ? text(asRecord(x).name ?? asRecord(x).id) : text(x))) : text(v) ? text(v).split(/\s*[,;]\s*/) : []).filter(Boolean);

export function looksLikeDiscoveryRows(v: unknown): boolean {
  // A list, a search table or a known list inside an object: one object on its own (a package.json) is not rows.
  const r = asRecord(v);
  if (!Array.isArray(v) && !(Array.isArray(r.headings) && Array.isArray(r.results)) && !ROW_CONTAINERS.some((k) => Array.isArray(r[k]))) return false;
  const rows = rowsOf(v);
  return rows.length > 0 && rows.some((r) => pick(r, ["name", "hostname", "devicename"]) !== undefined || pick(r, ["client", "clientdevice", "source"]) !== undefined) && rows.some((r) => pick(r, ["kind", "type", "devicetype", "os", "osname", "listener", "listenerdevice", "host", "hostname", "device", "virtualhost", "port"]) !== undefined);
}

/**
 * Nodes and connections as rows. Recognised columns: an id (#id, id, device_pk), a name
 * (name, hostname, device_name), a kind (kind, type, device_type), the host it runs on
 * (host, host_name, device, virtual_host_name), what it depends on (depends_on, dependencies,
 * talks_to), members (members, contains); and connection rows with a client and a listener
 * (client, listener, port, protocol) or a source and a target.
 */
export function readDiscoveryRows(value: unknown, fileName: string, tool: "BMC Helix Discovery" | "Device42" | "a discovery tool"): Inventory {
  const rows = rowsOf(value);
  if (!rows.length) throw new InventoryError(`No rows were found in "${fileName}".`);
  const raw = new Map<string, RawResource>();
  const byName = new Map<string, string>();
  const ensure = (name: string, hint = "server"): string => {
    const key = name.trim().toLowerCase();
    const known = byName.get(key);
    if (known) return known;
    const id = `name:${key}`;
    raw.set(id, { id, name: name.trim(), resourceType: hint, refs: [], typeHint: hint });
    byName.set(key, id);
    return id;
  };
  const connections: Record<string, unknown>[] = [];
  for (const row of rows) {
    const client = pick(row, ["client", "clientdevice", "clientdevicename", "source", "from", "parent"]);
    const listener = pick(row, ["listener", "listenerdevice", "listenerdevicename", "target", "to", "child", "server"]);
    if (client !== undefined && listener !== undefined && pick(row, ["name", "hostname", "devicename"]) === undefined) {
      connections.push(row);
      continue;
    }
    const name = text(pick(row, ["name", "hostname", "devicename", "appcompname"]));
    if (!name) continue;
    const kindText = text(pick(row, ["kind", "type", "devicetype", "category", "what", "class"]));
    const os = text(pick(row, ["os", "osname", "ostype"]));
    const id = text(pick(row, ["#id", "id", "nodeid", "devicepk", "deviceid", "appcompid"])) || `name:${name.toLowerCase()}`;
    const typeId = /cluster/i.test(kindText) ? "cluster" : /^(host|physical|virtual|device|server|vm)$/i.test(kindText) || os ? "server" : /database|db/i.test(kindText) ? "database" : /business ?app|application ?instance|service$/i.test(kindText) ? "system" : guessType(`${kindText} ${name}`, "") ?? (kindText ? "application" : "server");
    raw.set(id, {
      id,
      name,
      resourceType: kindText || (os ? "Host" : "node"),
      refs: [],
      typeHint: typeId,
      technology: [kindText, os, text(pick(row, ["product", "version", "hwmodel"]))].filter(Boolean).join(" · "),
      fields: Object.fromEntries(Object.entries({ ip: many(pick(row, ["ip", "ipaddress", "ipaddresses"])).join(", "), os, environment: text(pick(row, ["environment", "servicelevel"])), location: text(pick(row, ["location", "building", "datacenter"])) }).filter(([, v]) => v)),
    });
    byName.set(name.toLowerCase(), id);
  }
  // Second pass: what each runs on, depends on and holds, now that every name is known.
  for (const row of rows) {
    const name = text(pick(row, ["name", "hostname", "devicename", "appcompname"]));
    const id = text(pick(row, ["#id", "id", "nodeid", "devicepk", "deviceid", "appcompid"])) || (name ? byName.get(name.toLowerCase()) : undefined);
    const item = id ? raw.get(id) : undefined;
    if (!item) continue;
    const resolve = (v: string) => raw.get(v)?.id ?? byName.get(v.toLowerCase()) ?? ensure(v);
    for (const host of many(pick(row, ["host", "hostid", "hostname", "hostedon", "runson", "device", "devicename", "virtualhost", "virtualhostname"])).filter((h) => h.toLowerCase() !== name.toLowerCase()))
      item.links = [...(item.links ?? []), { targetId: resolve(host), kind: "hosted_on", label: "runs on" }];
    for (const dep of many(pick(row, ["dependson", "dependencies", "talksto", "uses", "dependsonid"]))) item.links = [...(item.links ?? []), { targetId: resolve(dep), kind: "depends_on", label: "depends on" }];
    for (const member of many(pick(row, ["members", "contains", "memberids", "softwareinstances"]))) {
      const m = raw.get(resolve(member));
      if (m) m.links = [...(m.links ?? []), { targetId: item.id, kind: "depends_on", label: "part of" }];
    }
  }
  const resolveEnd = (v: string) => raw.get(v)?.id ?? byName.get(v.toLowerCase()) ?? ensure(v);
  for (const row of connections) {
    const from = resolveEnd(text(pick(row, ["client", "clientdevice", "clientdevicename", "source", "from", "parent"])));
    const to = resolveEnd(text(pick(row, ["listener", "listenerdevice", "listenerdevicename", "target", "to", "child", "server"])));
    const port = text(pick(row, ["port", "listenerport"]));
    const protocol = text(pick(row, ["protocol", "service", "servicename"]));
    raw.get(from)!.links = [...(raw.get(from)!.links ?? []), { targetId: to, kind: "calls", label: [protocol, port && `port ${port}`].filter(Boolean).join(" "), ...(port ? { port } : {}), ...(protocol ? { protocol } : {}) }];
  }
  if (!raw.size) throw new InventoryError(`No nodes were found in "${fileName}".`);
  return buildInventory(tool === "a discovery tool" ? "A discovery tool export" : `A ${tool} export`, fileName, [...raw.values()], connections.length ? [] : ["No connection rows were in the file; add the service communications or dependencies to draw the links"]);
}
