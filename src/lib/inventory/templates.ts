import { parseAllDocuments, parse as parseYaml, type Tags } from "yaml";
import { buildInventory, type RawResource } from "./build";
import { awsType, azureType, cloudKey, cloudOf, cloudResource, gcpType, kubernetesKind } from "./catalog";
import { asArray, asRecord, generalComponent, InventoryError, keepFields, stringsIn, text, type Inventory } from "./model";
import { guessType } from "../import/diagramFile";

/**
 * Templates and manifests: AWS CloudFormation (and SAM), Azure Resource Manager and Bicep,
 * Kubernetes manifests (OpenShift included), Docker Compose and a Pulumi stack export.
 */

/* ---------- YAML with CloudFormation's short tags ---------- */

const CFN_TAGS = ["Ref", "GetAtt", "Sub", "Join", "Select", "Split", "If", "Equals", "And", "Or", "Not", "FindInMap", "GetAZs", "ImportValue", "Base64", "Cidr", "Condition", "Transform"];
const customTags: Tags = CFN_TAGS.flatMap((name) => {
  const key = name === "Ref" || name === "Condition" ? name : `Fn::${name}`;
  const value = (v: unknown) => ({ [key]: name === "GetAtt" && typeof v === "string" ? v.split(".") : v });
  return [
    { tag: `!${name}`, resolve: (s: string) => value(s) },
    { tag: `!${name}`, collection: "seq" as const, resolve: (seq: { toJSON: () => unknown }) => value(seq.toJSON()) },
    { tag: `!${name}`, collection: "map" as const, resolve: (map: { toJSON: () => unknown }) => value(map.toJSON()) },
  ];
}) as unknown as Tags;

/** A JSON or YAML text as a value; YAML may hold several documents. */
export function parseStructured(source: string): unknown[] {
  const trimmed = source.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return [JSON.parse(trimmed)];
    } catch {
      // Not JSON after all: JSON lines, or YAML.
      const lines = trimmed.split(/\n/).filter((l) => l.trim());
      if (lines.length > 1 && lines.every((l) => l.trim().startsWith("{"))) {
        try {
          return [lines.map((l) => JSON.parse(l))];
        } catch {
          /* fall through to YAML */
        }
      }
    }
  }
  try {
    return parseAllDocuments(source, { customTags, uniqueKeys: false })
      .map((d) => d.toJS({ maxAliasCount: 200 }))
      .filter((d) => d !== null && d !== undefined);
  } catch {
    return [parseYaml(source, { customTags })];
  }
}

/* ---------- CloudFormation ---------- */

export const looksLikeCloudFormation = (v: unknown) => {
  const r = asRecord(v);
  const resources = asRecord(r.Resources);
  return Object.values(resources).some((res) => /^(AWS|Alexa|Custom)::/.test(text(asRecord(res).Type))) || "AWSTemplateFormatVersion" in r;
};

const SAM: Record<string, string> = { "AWS::Serverless::Function": "AWS::Lambda::Function", "AWS::Serverless::Api": "AWS::ApiGateway::RestApi", "AWS::Serverless::HttpApi": "AWS::ApiGatewayV2::Api", "AWS::Serverless::SimpleTable": "AWS::DynamoDB::Table", "AWS::Serverless::StateMachine": "AWS::StepFunctions::StateMachine" };
const CFN_NAMES = ["Name", "BucketName", "FunctionName", "TableName", "QueueName", "TopicName", "DBInstanceIdentifier", "DBClusterIdentifier", "ClusterName", "DomainName", "RepositoryName", "StateMachineName", "RestApiName", "LoadBalancerName", "StreamName", "ServiceName", "UserPoolName"];

export function readCloudFormation(template: unknown, fileName = "CloudFormation"): Inventory {
  const resources = asRecord(asRecord(template).Resources);
  const ids = Object.keys(resources);
  if (!ids.length) throw new InventoryError(`"${fileName}" has no Resources.`);
  const raw: RawResource[] = ids.map((id) => {
    const res = asRecord(resources[id]);
    const type = text(res.Type);
    const props = asRecord(res.Properties);
    const refs = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, inner] of Object.entries(v)) {
          if (k === "Ref" && typeof inner === "string") refs.add(inner);
          else if (k === "Fn::GetAtt") refs.add(Array.isArray(inner) ? text(inner[0]) : text(inner).split(".")[0]);
          else if (k === "Fn::Sub") for (const m of JSON.stringify(inner).matchAll(/\$\{([A-Za-z0-9]+)(\.[A-Za-z0-9.]+)?\}/g)) refs.add(m[1]);
          else walk(inner);
        }
      }
    };
    walk(props);
    for (const d of typeof res.DependsOn === "string" ? [res.DependsOn] : asArray(res.DependsOn)) refs.add(text(d));
    const kind = cloudResource("aws", awsType(SAM[type] ?? type));
    const tags = asArray(props.Tags).map(asRecord);
    const tagName = text(tags.find((t) => t.Key === "Name")?.Value);
    const named = [tagName, ...CFN_NAMES.map((n) => text(props[n]))].find((n) => n && n.length <= 90);
    return { id, name: named || id, resourceType: type, component: kind.component, role: kind.role, refs: [...refs].filter((r) => r !== id && ids.includes(r)), technology: type, fields: { logicalId: id, ...keepFields(props, ["Runtime", "Engine", "EngineVersion", "InstanceType", "DBInstanceClass", "CidrBlock", "MemorySize"]) } };
  });
  return buildInventory(/Serverless/.test(JSON.stringify(asRecord(template).Transform ?? "")) ? "An AWS SAM template" : "A CloudFormation template", text(asRecord(template).Description) || fileName, raw);
}

/* ---------- Azure Resource Manager and Bicep ---------- */

/** The arguments of the first call to a function in an ARM expression, quotes and nested calls kept whole. */
function callArgs(expr: string, fn: string): string[] | null {
  const start = expr.indexOf(`${fn}(`);
  if (start < 0) return null;
  const args: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let i = start + fn.length + 1; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'" && expr[i + 1] === "'" && quoted) {
      current += "''";
      i++;
      continue;
    }
    if (c === "'") quoted = !quoted;
    if (!quoted && c === "(") depth++;
    if (!quoted && c === ")") {
      if (depth === 0) {
        args.push(current.trim());
        return args;
      }
      depth--;
    }
    if (!quoted && c === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  return null;
}

export const looksLikeArm = (v: unknown) => {
  const r = asRecord(v);
  return /deploymentTemplate\.json/i.test(text(r.$schema)) || (Array.isArray(r.resources) && asArray(r.resources).some((x) => /^Microsoft\./.test(text(asRecord(x).type))));
};

export function readArm(template: unknown, fileName = "ARM template"): Inventory {
  const t = asRecord(template);
  const params = asRecord(t.parameters);
  const vars = asRecord(t.variables);
  // Simple expressions are worked out for names: [parameters('x')] with a default, [variables('y')].
  const evaluate = (expr: string): string => {
    const m = /^\[\s*(parameters|variables)\('([^']+)'\)\s*\]$/.exec(expr);
    if (!m) return expr.replace(/^\[|\]$/g, "");
    const value = m[1] === "parameters" ? asRecord(params[m[2]]).defaultValue : vars[m[2]];
    return typeof value === "string" && !value.startsWith("[") ? value : m[2];
  };
  const flatList: { type: string; name: string; res: Record<string, unknown> }[] = [];
  const collect = (list: unknown[], parentType = "", parentName = "") => {
    for (const r of list) {
      const res = asRecord(r);
      const type = parentType && !text(res.type).includes("/") ? `${parentType}/${text(res.type)}` : text(res.type);
      const name = parentName && !text(res.name).includes("/") ? `${parentName}/${text(res.name)}` : text(res.name);
      flatList.push({ type, name, res });
      collect(asArray(res.resources), type, name);
    }
  };
  collect(asArray(t.resources));
  if (!flatList.length) throw new InventoryError(`"${fileName}" has no resources.`);
  const idOf = (type: string, name: string) => `${type.toLowerCase()}|${evaluate(name).toLowerCase()}`;
  const ids = new Set(flatList.map((r) => idOf(r.type, r.name)));
  const lastName = new Map<string, string>();
  for (const r of flatList) lastName.set(`${r.type.toLowerCase()}|${evaluate(r.name).split("/").pop()!.toLowerCase()}`, idOf(r.type, r.name));
  // resourceId('Type', 'a', 'b') or a resource's name alone.
  const target = (expr: string): string | null => {
    const args = callArgs(expr, "resourceId");
    const typeAt = args ? args.findIndex((a) => /^'[A-Za-z]+\.[A-Za-z]+\/[^']+'$/.test(a)) : -1;
    if (args && typeAt >= 0 && args.length > typeAt + 1) {
      const type = args[typeAt].slice(1, -1);
      const name = evaluate(`[${args[args.length - 1]}]`).replace(/^'|'$/g, "");
      return lastName.get(`${type.toLowerCase()}|${name.toLowerCase()}`) ?? null;
    }
    const plain = evaluate(expr).toLowerCase();
    return flatList.map((r) => idOf(r.type, r.name)).find((id) => id.endsWith(`|${plain}`)) ?? null;
  };
  const raw: RawResource[] = flatList.map(({ type, name, res }) => {
    const id = idOf(type, name);
    const refs = new Set<string>();
    for (const d of asArray(res.dependsOn)) {
      const hit = target(text(d));
      if (hit) refs.add(hit);
    }
    for (const [, value] of stringsIn(res.properties)) if (/resourceId\(/.test(value)) for (const piece of value.split(/(?=resourceId\()/)) {
      const hit = target(piece);
      if (hit) refs.add(hit);
    }
    if (ids.has(idOf(type.split("/").slice(0, -1).join("/"), name.split("/").slice(0, -1).join("/")))) refs.add(idOf(type.split("/").slice(0, -1).join("/"), name.split("/").slice(0, -1).join("/")));
    const kindKey = text(res.kind).toLowerCase().includes("functionapp") ? "websitesfunctionapp" : azureType(type);
    const kind = cloudResource("azure", kindKey);
    return { id, name: evaluate(name).split("/").pop() || type, resourceType: type, component: kind.component, role: kind.role, refs: [...refs].filter((r) => r !== id && ids.has(r)), technology: type, fields: keepFields({ location: evaluate(text(res.location)), sku: text(asRecord(res.sku).name), kind: text(res.kind) }, ["location", "sku", "kind"]) };
  });
  return buildInventory("An Azure Resource Manager template", fileName, raw);
}

export const looksLikeBicep = (source: string) => /(^|\n)\s*resource\s+\w+\s+'[A-Za-z]+\.[A-Za-z]+\/[^'@]+@[^']+'/.test(source);

export function readBicep(source: string, fileName = "Bicep"): Inventory {
  const decl = [...source.matchAll(/(^|\n)\s*(resource|module)\s+(\w+)\s+'([^']+)'\s*(existing\s*)?=\s*(?:if\s*\([^)]*\)\s*)?(\{|\[)/g)];
  if (!decl.length) throw new InventoryError(`No resource declarations were found in "${fileName}".`);
  const symbols = decl.map((d) => d[3]);
  const bodies = decl.map((d, i) => source.slice((d.index ?? 0) + d[0].length, i + 1 < decl.length ? decl[i + 1].index : source.length));
  const raw: RawResource[] = decl.map((d, i) => {
    const [, , what, symbol, typeAndVersion, existing] = d;
    const body = bodies[i];
    const refs = symbols.filter((s, j) => j !== i && new RegExp(`\\b${s}\\b`).test(body));
    const name = /\n\s*name:\s*'([^'\n]*)'/.exec(body)?.[1]?.replace(/\$\{([^}]+)\}/g, "$1") || symbol;
    if (what === "module") return { id: symbol, name: symbol, resourceType: "module", refs, technology: `Bicep module ${typeAndVersion}`, typeHint: "system" };
    const type = typeAndVersion.split("@")[0];
    const kind = cloudResource("azure", azureType(type));
    return { id: symbol, name, resourceType: type, component: kind.component, role: kind.role, refs, technology: type, fields: (existing ? { existing: "yes" } : {}) as Record<string, string> };
  });
  return buildInventory("A Bicep file", fileName, raw);
}

/* ---------- Kubernetes ---------- */

export const looksLikeKubernetes = (docs: unknown[]) => docs.some((d) => typeof asRecord(d).apiVersion === "string" && typeof asRecord(d).kind === "string");

export function readKubernetes(docs: unknown[], fileName = "Kubernetes"): Inventory {
  const objects: Record<string, unknown>[] = [];
  const add = (d: unknown) => {
    const r = asRecord(d);
    if (r.kind === "List" || Array.isArray(r.items)) asArray(r.items).forEach(add);
    else if (typeof r.kind === "string") objects.push(r);
  };
  docs.forEach(add);
  if (!objects.length) throw new InventoryError(`No Kubernetes objects were found in "${fileName}".`);
  const nsOf = (o: Record<string, unknown>) => text(asRecord(o.metadata).namespace) || (o.kind === "Namespace" ? "" : "default");
  const idOf = (kind: string, ns: string, name: string) => `${kind.toLowerCase()}/${ns}/${name}`;
  const nameOf = (o: Record<string, unknown>) => text(asRecord(o.metadata).name);
  const namespaces = new Set(objects.filter((o) => o.kind !== "Namespace").map(nsOf));
  const declared = new Set(objects.filter((o) => o.kind === "Namespace").map(nameOf));
  // A namespace used but not declared is still a place things sit in.
  for (const ns of namespaces) if (!declared.has(ns) && namespaces.size > 1) objects.push({ kind: "Namespace", apiVersion: "v1", metadata: { name: ns } });
  const workloads = objects.filter((o) => ["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "Pod", "DeploymentConfig"].includes(text(o.kind)));
  const podLabels = (o: Record<string, unknown>) => {
    const spec = asRecord(o.spec);
    const template = o.kind === "Pod" ? o : o.kind === "CronJob" ? asRecord(asRecord(asRecord(spec.jobTemplate).spec).template) : asRecord(spec.template);
    return asRecord(asRecord(template.metadata).labels);
  };
  const podSpec = (o: Record<string, unknown>) => {
    const spec = asRecord(o.spec);
    if (o.kind === "Pod") return spec;
    if (o.kind === "CronJob") return asRecord(asRecord(asRecord(asRecord(spec.jobTemplate).spec).template).spec);
    return asRecord(asRecord(spec.template).spec);
  };
  const raw: RawResource[] = objects.map((o) => {
    const kind = text(o.kind);
    const ns = nsOf(o);
    const name = nameOf(o);
    const id = kind === "Namespace" ? idOf("namespace", "", name) : idOf(kind, ns, name);
    const known = kubernetesKind(kind);
    const refs: string[] = [];
    const fields: Record<string, string> = { kind, ...(ns ? { namespace: ns } : {}) };
    let typeHint: string | undefined;
    let technology = `${text(o.apiVersion)} ${kind}`;
    const spec = asRecord(o.spec);
    if (kind === "Service" || kind === "Route" || kind === "Ingress" || kind === "HTTPRoute") {
      if (kind === "Service") {
        const selector = asRecord(spec.selector);
        const keys = Object.keys(selector);
        if (keys.length) for (const w of workloads) if (nsOf(w) === ns && keys.every((k) => podLabels(w)[k] === selector[k])) refs.push(idOf(text(w.kind), ns, nameOf(w)));
        const ports = asArray(spec.ports).map((p) => text(asRecord(p).port)).filter(Boolean);
        if (ports.length) fields.ports = ports.join(", ");
        if (spec.type) fields.serviceType = text(spec.type);
      }
      const backends = new Set<string>();
      for (const [path, value] of stringsIn(spec)) if (/(service\.name|serviceName|backendRefs\.name|to\.name)$/.test(path)) backends.add(value);
      for (const b of backends) refs.push(idOf("Service", ns, b));
      const hosts = [...stringsIn(spec)].filter(([p]) => /(^|\.)host(s)?$/.test(p)).map(([, h]) => h);
      if (hosts.length) fields.hosts = [...new Set(hosts)].slice(0, 5).join(", ");
    }
    if (workloads.includes(o)) {
      const pod = podSpec(o);
      const containers = [...asArray(pod.containers), ...asArray(pod.initContainers)].map(asRecord);
      const images = containers.map((c) => text(c.image)).filter(Boolean);
      if (images.length) {
        technology = images.join(", ").slice(0, 200);
        fields.image = images[0];
        // A workload whose image is a database or a queue is drawn as one.
        typeHint = guessType(images.join(" "), "") ?? undefined;
      }
      if (spec.replicas !== undefined) fields.replicas = text(spec.replicas);
      for (const [path, value] of stringsIn(pod)) {
        if (/configMap(Ref|KeyRef)?\.name$|configMap\.name$/.test(path)) refs.push(idOf("ConfigMap", ns, value));
        if (/secret(Ref|KeyRef)?\.name$|secret\.secretName$/.test(path)) refs.push(idOf("Secret", ns, value));
        if (/persistentVolumeClaim\.claimName$/.test(path)) refs.push(idOf("PersistentVolumeClaim", ns, value));
      }
      for (const t of asArray(spec.volumeClaimTemplates)) refs.push(idOf("PersistentVolumeClaim", ns, nameOf(asRecord(t))));
      // An address in the environment that is another service's name: this calls it.
      for (const c of containers) for (const env of asArray(c.env)) {
        const value = text(asRecord(env).value);
        for (const svc of objects.filter((x) => x.kind === "Service")) {
          const n = nameOf(svc);
          if (n && new RegExp(`(^|[/@.:])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([.:/]|$)`).test(value)) refs.push(idOf("Service", nsOf(svc), n));
        }
      }
    }
    if (kind === "HorizontalPodAutoscaler") {
      const target = asRecord(spec.scaleTargetRef);
      refs.push(idOf(text(target.kind), ns, text(target.name)));
    }
    return {
      id,
      name,
      resourceType: kind,
      component: known.component,
      role: known.role,
      refs,
      parentId: kind !== "Namespace" && namespaces.size > 1 ? idOf("namespace", "", ns) : null,
      technology,
      fields,
      typeHint,
      tags: Object.entries(asRecord(asRecord(o.metadata).labels)).slice(0, 8).map(([k, v]) => `${k}=${text(v)}`),
    };
  });
  return buildInventory(objects.some((o) => /openshift/.test(text(o.apiVersion))) ? "OpenShift and Kubernetes manifests" : "Kubernetes manifests", fileName, raw);
}

/* ---------- Docker Compose ---------- */

export const looksLikeCompose = (v: unknown) => {
  const services = asRecord(asRecord(v).services);
  return Object.keys(services).length > 0 && Object.values(services).every((s) => s && typeof s === "object" && ("image" in asRecord(s) || "build" in asRecord(s)));
};

export function readCompose(file: unknown, fileName = "Docker Compose"): Inventory {
  const services = asRecord(asRecord(file).services);
  const names = Object.keys(services);
  const networks = Object.keys(asRecord(asRecord(file).networks));
  const raw: RawResource[] = names.map((name) => {
    const s = asRecord(services[name]);
    const image = text(s.image);
    const depends = Array.isArray(s.depends_on) ? s.depends_on.map(text) : Object.keys(asRecord(s.depends_on));
    const links = asArray(s.links).map((l) => text(l).split(":")[0]);
    const env = [...stringsIn(s.environment)].map(([, v]) => v).join(" ");
    const mentioned = names.filter((n) => n !== name && new RegExp(`(^|[/@=:\\s])${n}([:/\\s]|$)`).test(env));
    const own = asArray(s.networks).map(text).concat(Object.keys(asRecord(Array.isArray(s.networks) ? {} : s.networks)));
    const words = `${image} ${name}`;
    const hint = guessType(words, "") ?? undefined;
    return {
      id: name,
      name: text(s.container_name) || name,
      resourceType: "compose service",
      component: hint ? undefined : generalComponent("Container"),
      refs: [...new Set([...depends, ...links, ...mentioned])],
      parentId: networks.length > 1 && own.length ? `network:${own[0]}` : null,
      technology: image || (s.build ? "built from source" : ""),
      typeHint: hint ?? "service",
      fields: { ...(image ? { image } : {}), ...(asArray(s.ports).length ? { ports: asArray(s.ports).map(text).join(", ").slice(0, 200) } : {}), ...(s.replicas || asRecord(s.deploy).replicas ? { replicas: text(s.replicas ?? asRecord(s.deploy).replicas) } : {}) },
    };
  });
  if (networks.length > 1) for (const n of networks) raw.push({ id: `network:${n}`, name: n, resourceType: "compose network", role: "zone", refs: [] });
  if (!raw.length) throw new InventoryError(`"${fileName}" has no services.`);
  return buildInventory("A Docker Compose file", fileName, raw);
}

/* ---------- Pulumi ---------- */

export const looksLikePulumi = (v: unknown) => Array.isArray(asRecord(asRecord(v).deployment).resources) || (Array.isArray(asRecord(v).resources) && asArray(asRecord(v).resources).some((r) => text(asRecord(r).urn).startsWith("urn:pulumi:")));

export function readPulumi(file: unknown, fileName = "Pulumi"): Inventory {
  const resources = asArray(asRecord(asRecord(file).deployment).resources ?? asRecord(file).resources).map(asRecord);
  const raw: RawResource[] = [];
  let internal = 0;
  for (const r of resources) {
    const type = text(r.type);
    if (/^pulumi:(providers|pulumi):/.test(type)) {
      internal++;
      continue;
    }
    const urn = text(r.urn);
    const cloud = cloudOf(type);
    // aws:ec2/instance:Instance → ec2:instance; kubernetes:apps/v1:Deployment → Deployment.
    const m = /^([^:]+):([^:]+):(.+)$/.exec(type);
    let kind = {} as ReturnType<typeof cloudResource>;
    if (m && m[1] === "kubernetes") kind = kubernetesKind(m[3]);
    else if (m && cloud) {
      const module = m[2].split("/")[0];
      const key = cloud === "aws" ? `${module}${m[3]}` : cloud === "gcp" ? gcpType(`${module}${m[3]}`) : `${module}${m[3]}`;
      kind = cloudResource(cloud, cloudKey(cloud, key));
    }
    const outputs = asRecord(r.outputs);
    const refs = [...asArray(r.dependencies).map(text), ...Object.values(asRecord(r.propertyDependencies)).flatMap((v) => asArray(v).map(text))];
    raw.push({ id: urn, name: text(outputs.name) || urn.split("::").pop() || type, resourceType: type, component: kind.component, role: kind.role, refs, technology: type, fields: keepFields({ id: r.id, ...outputs }, ["id", "arn", "region", "location"]) });
  }
  if (!raw.length) throw new InventoryError(`"${fileName}" has no resources.`);
  return buildInventory("A Pulumi stack", fileName, raw, internal ? [`${internal} Pulumi providers and stacks left out`] : []);
}
