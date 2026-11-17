import { buildInventory, type RawResource } from "./build";
import { cloudKey, cloudOf, cloudResource, otherCloudResource, type ResourceKind } from "./catalog";
import { asArray, asRecord, InventoryError, keepFields, stringsIn, text, type Inventory } from "./model";

/**
 * Terraform, three ways: the configuration itself (.tf files, read without running Terraform),
 * a plan or state as `terraform show -json` prints it, and a raw state file (.tfstate). Each
 * resource becomes a box; each reference from one resource to another (aws_subnet.app.id, a
 * depends_on) becomes a relationship. Data sources, variables and outputs are not drawn.
 */

const KEEP = ["region", "location", "availability_zone", "instance_type", "engine", "engine_version", "runtime", "image", "image_id", "sku_name", "size", "machine_type", "cidr_block", "address_prefixes", "ip_cidr_range", "version", "kubernetes_version", "node_count"];

function kindOf(type: string): ResourceKind & { technology: string } {
  const cloud = cloudOf(type);
  if (!cloud) return { technology: type };
  const known = cloud === "aws" || cloud === "azure" || cloud === "gcp" ? cloudResource(cloud, cloudKey(cloud, type)) : otherCloudResource(cloud, type);
  return { ...known, technology: type };
}

/** The name people know a resource by: its Name tag, its name argument, else its Terraform name. */
function displayName(localName: string, values: Record<string, unknown>): string {
  const tags = asRecord(values.tags);
  const candidates = [tags.Name, tags.name, values.name, values.bucket, values.function_name, values.identifier, values.cluster_id, values.cluster_name, values.table_name, values.domain_name];
  const found = candidates.map(text).find((v) => v && !v.includes("${") && v.length <= 90);
  return found ?? localName;
}

/* ---------- HCL ---------- */

/** The text between a brace and the brace that closes it, skipping strings, heredocs and comments. */
function block(source: string, open: number): { body: string; end: number } {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      for (i++; i < source.length && source[i] !== '"'; i++) if (source[i] === "\\") i++;
      continue;
    }
    if (c === "#" || (c === "/" && source[i + 1] === "/")) {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close < 0 ? source.length : close + 1;
      continue;
    }
    if (c === "<" && source[i + 1] === "<") {
      const m = /^<<-?\s*([A-Za-z_]+)\s*\n/.exec(source.slice(i, i + 60));
      if (m) {
        const end = new RegExp(`\\n\\s*${m[1]}\\s*(\\n|$)`).exec(source.slice(i + m[0].length));
        i = end ? i + m[0].length + end.index + end[0].length - 1 : source.length;
        continue;
      }
    }
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) return { body: source.slice(open + 1, i), end: i + 1 };
  }
  return { body: source.slice(open + 1), end: source.length };
}

/** A string attribute written plainly in a block: name = "orders". */
function attribute(body: string, name: string): string {
  const m = new RegExp(`(?:^|\\n)\\s*${name}\\s*=\\s*"([^"\\n]*)"`).exec(body);
  return m ? m[1] : "";
}

export function looksLikeTerraform(source: string): boolean {
  return /(^|\n)\s*(resource|module|data)\s+"[^"]+"(\s+"[^"]+")?\s*\{/.test(source);
}

export function readTerraformHcl(source: string, fileName = "Terraform"): Inventory {
  const declared: { type: string; local: string; body: string; module: boolean }[] = [];
  const pattern = /(^|\n)\s*(resource|module|data)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{/g;
  let data = 0;
  for (let m = pattern.exec(source); m; m = pattern.exec(source)) {
    const open = m.index + m[0].length - 1;
    const { body, end } = block(source, open);
    pattern.lastIndex = end;
    if (m[2] === "data") {
      data++;
      continue;
    }
    if (m[2] === "module") declared.push({ type: "module", local: m[3], body, module: true });
    else if (m[4]) declared.push({ type: m[3], local: m[4], body, module: false });
  }
  if (!declared.length) throw new InventoryError(`No resource or module blocks were found in "${fileName}".`);
  const idOf = (d: { type: string; local: string; module: boolean }) => (d.module ? `module.${d.local}` : `${d.type}.${d.local}`);
  const ids = new Set(declared.map(idOf));
  const raw: RawResource[] = declared.map((d) => {
    const refs = new Set<string>();
    for (const r of d.body.matchAll(/\b(module\.[A-Za-z_][\w-]*|[a-z][a-z0-9]*_[a-z0-9_]+\.[A-Za-z_][\w-]*)/g)) if (ids.has(r[1]) && r[1] !== idOf(d)) refs.add(r[1]);
    if (d.module) {
      const source = attribute(d.body, "source");
      return { id: idOf(d), name: d.local, resourceType: "module", refs: [...refs], technology: source ? `Terraform module ${source}` : "Terraform module", typeHint: "system", fields: (source ? { source } : {}) as Record<string, string> };
    }
    const kind = kindOf(d.type);
    const values: Record<string, unknown> = { name: attribute(d.body, "name"), bucket: attribute(d.body, "bucket"), function_name: attribute(d.body, "function_name"), identifier: attribute(d.body, "identifier") };
    const tag = /tags\s*=\s*\{[^}]*?\bName\s*=\s*"([^"]+)"/.exec(d.body);
    if (tag) values.tags = { Name: tag[1] };
    const fields: Record<string, string> = {};
    for (const key of KEEP) {
      const v = attribute(d.body, key);
      if (v && !v.includes("${")) fields[key] = v;
    }
    return { id: idOf(d), name: displayName(d.local, values), resourceType: d.type, component: kind.component, role: kind.role, refs: [...refs], technology: kind.technology, fields: { address: idOf(d), ...fields } };
  });
  return buildInventory("A Terraform configuration", fileName, raw, data ? [`${data} data ${data === 1 ? "source" : "sources"} (read, not created) left out`] : []);
}

/* ---------- JSON: plan, state, raw state ---------- */

export function looksLikeTerraformJson(value: unknown): boolean {
  const v = asRecord(value);
  return (typeof v.format_version === "string" && (!!v.planned_values || !!v.values || !!v.resource_changes)) || (v.version === 4 && Array.isArray(v.resources) && "terraform_version" in v);
}

interface JsonResource {
  address: string;
  type: string;
  name: string;
  mode: string;
  values: Record<string, unknown>;
  depends: string[];
}

function moduleResources(module: unknown, out: JsonResource[]) {
  const m = asRecord(module);
  for (const r of asArray(m.resources)) {
    const res = asRecord(r);
    out.push({ address: text(res.address), type: text(res.type), name: text(res.name), mode: text(res.mode) || "managed", values: asRecord(res.values), depends: asArray(res.depends_on).map(text) });
  }
  for (const child of asArray(m.child_modules)) moduleResources(child, out);
}

/** References written in the configuration part of a plan: every "references" list under a resource's expressions. */
function configReferences(module: unknown, prefix: string, out: Map<string, Set<string>>) {
  const m = asRecord(module);
  for (const r of asArray(m.resources)) {
    const res = asRecord(r);
    const address = `${prefix}${text(res.address)}`;
    const refs = out.get(address) ?? out.set(address, new Set()).get(address)!;
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, inner] of Object.entries(v)) {
          if (k === "references" && Array.isArray(inner)) for (const ref of inner) refs.add(`${prefix}${text(ref)}`);
          else walk(inner);
        }
      }
    };
    walk(res.expressions);
    for (const d of asArray(res.depends_on)) refs.add(`${prefix}${text(d)}`);
  }
  for (const [name, call] of Object.entries(asRecord(m.module_calls))) configReferences(asRecord(call).module, `${prefix}module.${name}.`, out);
}

export function readTerraformJson(value: unknown, fileName = "Terraform"): Inventory {
  const v = asRecord(value);
  const resources: JsonResource[] = [];
  let format = "A Terraform state";
  if (v.version === 4 && Array.isArray(v.resources)) {
    // A raw .tfstate: resources with instances, each listing what it depends on.
    for (const r of asArray(v.resources)) {
      const res = asRecord(r);
      const base = `${text(res.module) ? `${text(res.module)}.` : ""}${res.mode === "data" ? "data." : ""}${text(res.type)}.${text(res.name)}`;
      const instances = asArray(res.instances);
      instances.forEach((inst, i) => {
        const instance = asRecord(inst);
        const key = instance.index_key;
        const address = instances.length > 1 || key !== undefined ? `${base}[${typeof key === "string" ? JSON.stringify(key) : key ?? i}]` : base;
        resources.push({ address, type: text(res.type), name: text(res.name), mode: text(res.mode) || "managed", values: asRecord(instance.attributes), depends: asArray(instance.dependencies).map(text) });
      });
    }
  } else {
    format = v.planned_values ? "A Terraform plan" : "A Terraform state";
    moduleResources(asRecord(v.planned_values ?? v.values).root_module, resources);
  }
  const managed = resources.filter((r) => r.mode !== "data" && r.type);
  if (!managed.length) throw new InventoryError(`"${fileName}" has no managed resources in it.`);

  // A reference names a resource without its instance key; it reaches every instance of it.
  const byBase = new Map<string, string[]>();
  for (const r of managed) {
    const base = r.address.replace(/\[[^\]]*\]$/, "");
    (byBase.get(base) ?? byBase.set(base, []).get(base)!).push(r.address);
  }
  const resolve = (ref: string): string[] => {
    const clean = ref.replace(/\[[^\]]*\]$/, "");
    for (let parts = clean.split("."); parts.length >= 2; parts = parts.slice(0, -1)) {
      const hit = byBase.get(parts.join("."));
      if (hit) return hit;
    }
    return [];
  };
  const fromConfig = new Map<string, Set<string>>();
  configReferences(asRecord(v.configuration).root_module, "", fromConfig);
  // A state holds values, not expressions: a value that is another resource's id, ARN or link refers to it.
  const byValue = new Map<string, string>();
  for (const r of managed) for (const key of ["id", "arn", "self_link"]) {
    const value = text(r.values[key]);
    if (value.length >= 6) byValue.set(value.toLowerCase(), r.address);
  }

  const raw: RawResource[] = managed.map((r) => {
    const kind = kindOf(r.type);
    const refs = new Set<string>();
    for (const d of [...r.depends, ...(fromConfig.get(r.address.replace(/\[[^\]]*\]$/, "")) ?? [])]) for (const hit of resolve(d)) if (hit !== r.address) refs.add(hit);
    for (const [path, value] of stringsIn(r.values)) {
      if (path === "id" || path === "arn" || path === "self_link") continue;
      const hit = byValue.get(value.toLowerCase());
      if (hit && hit !== r.address) refs.add(hit);
    }
    return {
      id: r.address,
      name: displayName(r.address.replace(/^.*\./, "").replace(/\[.*$/, "") || r.name, r.values),
      resourceType: r.type,
      component: kind.component,
      role: kind.role,
      refs: [...refs],
      technology: kind.technology,
      fields: { address: r.address, ...keepFields(r.values, ["id", "arn", ...KEEP]) },
      tags: Object.entries(asRecord(r.values.tags)).filter(([k]) => k !== "Name").map(([k, val]) => `${k}=${text(val)}`).slice(0, 10),
    };
  });
  const data = resources.length - managed.length;
  return buildInventory(format, fileName, raw, data ? [`${data} data ${data === 1 ? "source" : "sources"} left out`] : []);
}
