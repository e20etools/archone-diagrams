import { objectType } from "../catalog";
import type { RelationKind } from "../types";
import { normalizeDraft, type Draft } from "./schema";

/**
 * Built-in drafting rules, used when no AI model is configured. They read a plain
 * description, pick out well-known products and phrases such as "order service"
 * or "API gateway", and turn verbs between them into relationships. Deterministic,
 * offline, and deliberately conservative: they only report what the text says.
 */

export const RULES_ENGINE = "Built-in rules (no AI model)";

type Role = "entity" | "tech" | "person";

interface Entry {
  re: RegExp;
  typeId: string;
  /** Null means "use the proper spelling of the matched text". */
  name: string | null;
  role: Role;
  generic: boolean;
}

interface Span {
  start: number;
  end: number;
  role: Role;
  typeId: string;
  name: string;
  generic: boolean;
  technology: string;
  consumed: boolean;
}

interface Entity {
  key: string;
  name: string;
  typeId: string;
  technology: string;
  parentKey: string | null;
}

interface Mention {
  key: string;
  start: number;
  end: number;
}

const PROPER: Record<string, string> = {
  postgresql: "PostgreSQL", postgres: "PostgreSQL", mysql: "MySQL", mariadb: "MariaDB", mongodb: "MongoDB", mongo: "MongoDB",
  dynamodb: "DynamoDB", cassandra: "Cassandra", elasticsearch: "Elasticsearch", opensearch: "OpenSearch", snowflake: "Snowflake",
  bigquery: "BigQuery", redshift: "Redshift", redis: "Redis", memcached: "Memcached", kafka: "Kafka", rabbitmq: "RabbitMQ",
  activemq: "ActiveMQ", nats: "NATS", sqs: "Amazon SQS", sns: "Amazon SNS", s3: "Amazon S3", minio: "MinIO",
  kubernetes: "Kubernetes", k8s: "Kubernetes", aks: "AKS", eks: "EKS", gke: "GKE", openshift: "OpenShift",
  nginx: "Nginx", haproxy: "HAProxy", kong: "Kong", apigee: "Apigee", cloudflare: "Cloudflare", cloudfront: "CloudFront", akamai: "Akamai",
  keycloak: "Keycloak", okta: "Okta", auth0: "Auth0", stripe: "Stripe", paypal: "PayPal", adyen: "Adyen", moyasar: "Moyasar",
  hyperpay: "HyperPay", payfort: "PayFort", twilio: "Twilio", unifonic: "Unifonic", sendgrid: "SendGrid", mailgun: "Mailgun",
  salesforce: "Salesforce", sap: "SAP", servicenow: "ServiceNow", workday: "Workday", jira: "Jira", slack: "Slack", zendesk: "Zendesk",
  hubspot: "HubSpot", sharepoint: "SharePoint", prometheus: "Prometheus", grafana: "Grafana", datadog: "Datadog", splunk: "Splunk",
  dynatrace: "Dynatrace", jenkins: "Jenkins", firebase: "Firebase", supabase: "Supabase", react: "React", angular: "Angular",
  vue: "Vue", "vue.js": "Vue", "next.js": "Next.js", nextjs: "Next.js", flutter: "Flutter", "react native": "React Native",
  "node.js": "Node.js", nodejs: "Node.js", node: "Node.js", "spring boot": "Spring Boot", spring: "Spring", ".net": ".NET",
  ".net core": ".NET", "asp.net": "ASP.NET", django: "Django", flask: "Flask", fastapi: "FastAPI", laravel: "Laravel", rails: "Rails",
  java: "Java", python: "Python", golang: "Go", php: "PHP", typescript: "TypeScript", kotlin: "Kotlin", swift: "Swift",
  express: "Express", nestjs: "NestJS", oracle: "Oracle Database", "sql server": "SQL Server", mssql: "SQL Server",
};

const ACRONYMS: Record<string, string> = {
  api: "API", apis: "APIs", sms: "SMS", erp: "ERP", crm: "CRM", sso: "SSO", cdn: "CDN", waf: "WAF", vpn: "VPN", db: "DB", ui: "UI",
  etl: "ETL", bff: "BFF", sql: "SQL", aws: "AWS", gcp: "GCP", hr: "HR", id: "ID", iam: "IAM", ldap: "LDAP", mq: "MQ", ai: "AI",
  ml: "ML", pos: "POS", otp: "OTP", kyc: "KYC", ios: "iOS", rest: "REST", graphql: "GraphQL", grpc: "gRPC", oauth: "OAuth",
  hrms: "HRMS", cms: "CMS", lms: "LMS", iot: "IoT", bi: "BI", b2b: "B2B", b2c: "B2C", pdf: "PDF", it: "IT", dns: "DNS",
};

function pretty(words: string[]): string {
  const out = words.map((w) => PROPER[w] ?? ACRONYMS[w] ?? w);
  if (out[0] && out[0] === words[0]) out[0] = out[0].charAt(0).toUpperCase() + out[0].slice(1);
  return out.join(" ");
}

const entry = (source: string, typeId: string, name: string | null, role: Role = "entity", generic = false): Entry => ({
  re: new RegExp(`(?<![a-z0-9])(?:${source})(?![a-z0-9])`, "gi"),
  typeId,
  name,
  role,
  generic,
});

const DICTIONARY: Entry[] = [
  // people
  entry("end[- ]?users?|users?", "actor", "User", "person"),
  entry("customers?", "actor", "Customer", "person"),
  entry("admins?|administrators?", "actor", "Administrator", "person"),
  entry("employees?|staff", "actor", "Employee", "person"),
  entry("operations team|support team|operators?", "actor", "Operations team", "person"),
  entry("partners?", "actor", "Partner", "person"),
  entry("visitors?", "actor", "Visitor", "person"),
  // front ends and back ends
  entry("front[- ]?ends?|single[- ]page app(?:lication)?s?|spa", "web-app", "Frontend", "entity", true),
  entry("web ?sites?", "web-app", "Website", "entity", true),
  entry("back[- ]?ends?(?: api)?|application servers?|api servers?", "service", "Backend", "entity", true),
  entry("bff|backend[- ]for[- ]frontend", "service", "BFF", "entity", true),
  entry("micro-?services", "service", "Microservices", "entity", true),
  // gateways and network
  entry("load[- ]?balancers?|alb|elb|nlb", "gateway", "Load balancer", "entity", true),
  entry("reverse proxy", "gateway", "Reverse proxy", "entity", true),
  entry("cdn", "gateway", "CDN", "entity", true),
  entry("cloudfront|akamai|cloudflare|nginx|haproxy|kong|apigee", "gateway", null),
  entry("waf|web application firewalls?", "network", "WAF", "entity", true),
  entry("firewalls?", "network", "Firewall", "entity", true),
  entry("vpn", "network", "VPN", "entity", true),
  // identity
  entry("identity providers?|idp|sso|single sign[- ]on", "service", "Identity provider", "entity", true),
  entry("keycloak", "service", null),
  entry("okta|auth0", "external-system", null),
  entry("azure ad|entra id|azure active directory", "external-system", "Microsoft Entra ID"),
  entry("active directory", "service", "Active Directory"),
  // payments and messaging providers
  entry("payment (?:gateway|provider|processor)s?", "external-system", "Payment gateway", "entity", true),
  entry("stripe|paypal|adyen|moyasar|hyperpay|payfort", "external-system", null),
  entry("sms (?:gateway|provider|service)s?", "external-system", "SMS gateway", "entity", true),
  entry("twilio|unifonic", "external-system", null),
  entry("e?-?mail (?:service|provider|server|gateway)s?", "external-system", "Email service", "entity", true),
  entry("sendgrid|mailgun", "external-system", null),
  // data
  entry("postgresql|postgres|mysql|mariadb|mongodb|mongo|dynamodb|cassandra|elasticsearch|opensearch|snowflake|bigquery|redshift|supabase", "database", null),
  entry("oracle(?: db| database)?", "database", "Oracle Database"),
  entry("sql server|mssql", "database", "SQL Server"),
  entry("data ?warehouses?", "database", "Data warehouse", "entity", true),
  entry("data ?lakes?", "storage", "Data lake", "entity", true),
  entry("redis|memcached", "cache", null),
  entry("kafka|rabbitmq|activemq|nats|sqs|sns", "queue", null),
  entry("azure service bus|service bus", "queue", "Azure Service Bus"),
  entry("event ?hubs?", "queue", "Azure Event Hubs"),
  entry("pub/?sub", "queue", "Pub/Sub"),
  entry("s3|minio", "storage", null),
  entry("blob storage|azure blob", "storage", "Azure Blob Storage"),
  entry("sharepoint", "storage", null),
  // infrastructure
  entry("kubernetes|k8s|aks|eks|gke|openshift", "cluster", null),
  entry("vms?|virtual machines?|ec2(?: instances?)?", "server", "Virtual machine", "entity", true),
  entry("lambda(?: functions?)?|azure functions?|cloud functions?|serverless functions?", "service", "Serverless function", "entity", true),
  entry("prometheus|grafana|datadog|splunk|dynatrace|jenkins", "service", null),
  // enterprise systems
  entry("salesforce|servicenow|workday|jira|slack|zendesk|hubspot|firebase", "external-system", null),
  entry("sap(?: s/4hana| erp)?", "external-system", "SAP"),
  entry("erp|crm|hrms|cms|lms|core banking", "system", null, "entity", true),
  // technologies: attached to the component they describe, never drawn as boxes
  entry("react native|react|angular|vue(?:\\.js)?|next\\.?js|flutter|swift|kotlin", "tech", null, "tech"),
  entry("node(?:\\.?js)?|spring boot|spring|asp\\.net|\\.net(?: core)?|django|flask|fastapi|laravel|rails|express|nestjs", "tech", null, "tech"),
  entry("java|python|golang|php|typescript", "tech", null, "tech"),
];

const FRONTEND_TECH = new Set(["React", "Angular", "Vue", "Next.js"]);
const MOBILE_TECH = new Set(["Flutter", "React Native", "Swift", "Kotlin"]);

/** Head nouns: "order service" is a service named "Order service". */
const HEADS: Record<string, string> = {
  service: "service", microservice: "service", api: "service", engine: "service", worker: "service", job: "service",
  system: "system", platform: "system", solution: "system", portal: "web-app", dashboard: "web-app", console: "web-app",
  app: "application", application: "application", gateway: "gateway", proxy: "gateway", database: "database", db: "database",
  server: "server", module: "component", component: "component", queue: "queue", bus: "queue", broker: "queue", topic: "queue",
  stream: "queue", cache: "cache", bucket: "storage", storage: "storage", cluster: "cluster",
};
/** Heads that make sense on their own: "a database", "a cache". */
const STANDALONE: Record<string, string> = {
  database: "Database", db: "Database", cache: "Cache", queue: "Message queue", gateway: "Gateway", storage: "File storage",
  cluster: "Cluster", broker: "Message broker",
};
const APP_TYPES = ["web-app", "mobile-app", "application"];
const EXTERNAL_WORDS = new Set(["external", "third-party", "3rd-party", "thirdparty", "outside"]);

const STOP = new Set(
  (
    "the a an this that these those each every our their its his her my your some any all both no new existing main central shared " +
    "separate dedicated single multiple several various other another one two three four many few and or but nor to of with from by " +
    "for in on at as into onto via through over under between across per is are was were be been being has have had do does did will " +
    "would can could should may might must which who whom whose where when while then also it they them he she we you i not only just " +
    "calls call calling uses use using used invokes invoke requests request sends send sent receives receive reads read writes write " +
    "stores store stored persists saves save queries query fetches fetch loads load publishes publish emits emit consumes consume " +
    "subscribes subscribe connects connect connected talks talk communicates communicate integrates integrate routes route forwards " +
    "forward hosted deployed running runs run depends depend relies requires require needs need accesses access contains contain " +
    "includes include consists composed comprises behind front protected secured backed built written developed implemented called " +
    "named known handles handle manages manage provides provide exposes expose serves serve processes process"
  ).split(/\s+/),
);

interface Rule {
  re: RegExp;
  kind: RelationKind | "contains";
  reverse?: boolean;
  label?: string;
  /** "A reaches B via C": C is used by A, the source of the previous relationship. */
  fromPrevious?: boolean;
}

const RULES: Rule[] = [
  { re: /\b(?:is|are) (?:called|used|consumed|accessed|invoked|queried) by\b/, kind: "calls", reverse: true },
  { re: /\b(?:is|are) part of\b|\b(?:inside|within|belongs? to)\b/, kind: "contains", reverse: true },
  { re: /\b(?:consists? of|composed of|made up of|comprises?|includes?|contains?)\b/, kind: "contains" },
  { re: /\b(?:hosted|deployed|running|runs?|lives?) (?:on|in|inside)\b/, kind: "hosted_on" },
  { re: /\bbehind\b|\b(?:protected|secured|fronted) by\b/, kind: "routes_to", reverse: true },
  { re: /\bin front of\b|\bfronts\b/, kind: "routes_to" },
  { re: /\b(?:routes?|forwards?|redirects?|proxies|distributes?|balances?)\b[^.]*?\b(?:to|across|between)\b/, kind: "routes_to" },
  { re: /\b(?:replicates?|mirrors?|backs? up|synchroni[sz]es?|syncs?)\b[^.]*?\b(?:to|with|into)\b/, kind: "replicates_to" },
  { re: /\b(?:publish(?:es)?|emits?|produces?|pushes?|enqueues?|sends? (?:events?|messages?))\b[^.]*?\b(?:to|on|onto|into)\b/, kind: "calls", label: "publishes to" },
  { re: /\b(?:subscribes? to|consumes? (?:events? |messages? )?from|listens? (?:to|on)|pulls? from)\b/, kind: "calls", label: "consumes from" },
  { re: /\b(?:reads?|writes?|stores?|persists?|saves?|caches?|loads?|fetch(?:es)?|quer(?:y|ies))\b[^.]*?\b(?:from|to|in|into|on)\b/, kind: "reads_writes" },
  { re: /\b(?:stored|persisted|saved|kept|cached) (?:in|on|to)\b|\bbacked by\b/, kind: "reads_writes" },
  { re: /\b(?:depends? on|relies on|requires?|needs?)\b/, kind: "depends_on" },
  { re: /\b(?:authenticates?|logs? ?in|signs? ?in)\b[^.]*?\b(?:with|via|through|against|using)\b/, kind: "calls", label: "authenticates with" },
  {
    re: /\b(?:calls?|invokes?|requests?|talks? to|communicates? with|connects? to|integrates? with|sends?\b[^.]*?\bto|uses?|using|consumes?|access(?:es)?|quer(?:y|ies)|interacts? with|notif(?:y|ies))\b/,
    kind: "calls",
  },
  { re: /\b(?:via|through)\b/, kind: "calls", fromPrevious: true },
  { re: /<?-+>|→|=>|➜|⟶/, kind: "calls" },
];

const LIST_GLUE = /^\s*(?:,|and|or|&|\+|as well as|plus|,\s*(?:and|or))?\s*(?:the|a|an)?\s*$/;
const CONJUNCTION_START = /^\s*,?\s*(?:and|then|and then|also|and also|but)\b/;
const ARROW = /<?-+>|→|=>|➜|⟶/;
const HOSTS_EVERYTHING =
  /\b(?:everything|all (?:of )?(?:the |these |those )?(?:services|components|apps|applications|microservices|workloads)|the (?:whole |entire )?(?:system|platform|solution|stack))\b.*\b(?:hosted|deployed|runs?|running) (?:on|in)\b/;

function splitSentences(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])|\n+|;\s*/)
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

interface Token {
  lower: string;
  start: number;
  end: number;
}

function tokenize(sentence: string): Token[] {
  const tokens: Token[] = [];
  const re = /[A-Za-z0-9][A-Za-z0-9.+#/'-]*[A-Za-z0-9+#]|[A-Za-z0-9]/g;
  for (const m of sentence.matchAll(re)) {
    tokens.push({ lower: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

function headOf(word: string): string | null {
  if (HEADS[word]) return word;
  if (word.endsWith("s") && HEADS[word.slice(0, -1)]) return word.slice(0, -1);
  if (word.endsWith("es") && HEADS[word.slice(0, -2)]) return word.slice(0, -2);
  return null;
}

function dictionarySpans(sentence: string): Span[] {
  const found: Span[] = [];
  for (const e of DICTIONARY) {
    for (const m of sentence.matchAll(e.re)) {
      const raw = m[0].toLowerCase();
      found.push({
        start: m.index,
        end: m.index + m[0].length,
        role: e.role,
        typeId: e.typeId,
        name: e.name ?? PROPER[raw] ?? pretty(raw.split(/\s+/)),
        generic: e.generic,
        technology: "",
        consumed: false,
      });
    }
  }
  // Longest match wins where two entries overlap ("react native" over "react").
  found.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: Span[] = [];
  for (const s of found) if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  return kept.sort((a, b) => a.start - b.start);
}

export function draftFromText(text: string): Draft {
  const entities = new Map<string, Entity>();
  const recent: string[] = [];
  const relationships: { sourceKey: string; targetKey: string; kind: RelationKind; label: string }[] = [];
  const hostsOfEverything: string[] = [];

  const touchEntity = (name: string, typeId: string, technology = ""): string => {
    const id = name.trim().toLowerCase().replace(/\s+/g, " ");
    let entity = entities.get(id);
    if (!entity) {
      entity = { key: `e${entities.size + 1}`, name: name.trim(), typeId, technology, parentKey: null };
      entities.set(id, entity);
    } else if (technology && !entity.technology) {
      entity.technology = technology;
    }
    const at = recent.indexOf(entity.key);
    if (at >= 0) recent.splice(at, 1);
    recent.push(entity.key);
    return entity.key;
  };
  const byKey = (k: string) => [...entities.values()].find((e) => e.key === k)!;
  const lastOfTypes = (types: string[]): string | null => {
    for (let i = recent.length - 1; i >= 0; i--) if (types.includes(byKey(recent[i]).typeId)) return recent[i];
    return null;
  };

  for (const sentence of splitSentences(text)) {
    const lower = sentence.toLowerCase();
    const spans = dictionarySpans(lower);
    const tokens = tokenize(sentence);
    const spanAt = (t: Token) => spans.find((s) => !s.consumed && t.start >= s.start && t.end <= s.end);
    // Candidates are collected first and resolved in reading order, so "the gateway"
    // can point back at an "API gateway" named earlier in the same sentence.
    const candidates: { start: number; end: number; resolve: () => string | null }[] = [];

    // Head nouns with their modifiers: "the order management service", "customer portal".
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (spanAt(token)) continue;
      const head = headOf(token.lower);
      if (!head) continue;
      // In a compound such as "API gateway" or "database server" the last noun is the head.
      const following = tokens[i + 1];
      if (following && !spanAt(following) && headOf(following.lower) && /^\s+$/.test(sentence.slice(token.end, following.start))) continue;
      const words: string[] = [];
      let technology = "";
      let external = false;
      let start = token.start;
      let absorbed: Span | null = null;
      for (let j = i - 1; j >= 0 && words.length < 3; j--) {
        const prev = tokens[j];
        // Words of one name are separated by spaces only; an arrow or a comma ends the name.
        if (!/^\s+$/.test(sentence.slice(prev.end, start))) break;
        const span = spanAt(prev);
        if (span && span.role === "entity") {
          absorbed = span;
          break;
        }
        if (span && span.role === "tech") {
          technology = span.name;
          span.consumed = true;
          start = span.start;
          continue;
        }
        if (span && span.role === "person") span.consumed = true;
        else if (EXTERNAL_WORDS.has(prev.lower)) {
          external = true;
          start = prev.start;
          continue;
        } else if (STOP.has(prev.lower)) break;
        words.unshift(prev.lower);
        start = prev.start;
      }
      if (absorbed) {
        // "PostgreSQL database" is the product, not a second box.
        absorbed.end = token.end;
        continue;
      }
      let typeId = HEADS[head];
      if (typeId === "application" && words.includes("web")) typeId = "web-app";
      if (typeId === "application" && words.some((w) => ["mobile", "ios", "android"].includes(w))) typeId = "mobile-app";
      if (external && ["service", "system", "application"].includes(typeId)) typeId = "external-system";

      const resolve = (): string | null => {
        if (words.length) return touchEntity(pretty([...words, head]), typeId, technology);
        if (technology && typeId === "application") {
          if (FRONTEND_TECH.has(technology)) return touchEntity("Web app", "web-app", technology);
          if (MOBILE_TECH.has(technology)) return touchEntity("Mobile app", "mobile-app", technology);
          return touchEntity("Application", "application", technology);
        }
        if (technology) return touchEntity(`${technology} ${head === "api" ? "API" : head}`, typeId, technology);
        if (external) return touchEntity(pretty(["external", head]), typeId);
        // A bare "the gateway" or "the service" points back at the last one mentioned.
        const types = typeId === "application" || typeId === "web-app" ? APP_TYPES : [typeId];
        const known = lastOfTypes(types);
        if (known) return touchEntity(byKey(known).name, byKey(known).typeId);
        return STANDALONE[head] ? touchEntity(STANDALONE[head], typeId) : null;
      };
      candidates.push({ start, end: token.end, resolve });
    }

    // Dictionary matches that were not folded into a head noun.
    const entitySpans = spans.filter((s) => !s.consumed && s.role !== "tech");
    for (let i = 0; i < entitySpans.length; i++) {
      const span = entitySpans[i];
      const next = entitySpans[i + 1];
      // "Stripe payment gateway": the product and the generic phrase are one thing.
      if (next && span.generic !== next.generic && /^\s*$/.test(lower.slice(span.end, next.start))) {
        const product = span.generic ? next : span;
        candidates.push({ start: span.start, end: next.end, resolve: () => touchEntity(product.name, product.typeId) });
        i++;
        continue;
      }
      candidates.push({ start: span.start, end: span.end, resolve: () => touchEntity(span.name, span.typeId) });
    }

    // In "A -> B -> C" lines, a segment the rules do not recognise is still a box.
    if (ARROW.test(sentence)) {
      let offset = 0;
      for (const segment of sentence.split(ARROW)) {
        const start = offset;
        const end = offset + segment.length;
        offset = end + (sentence.slice(end).match(ARROW)?.[0].length ?? 0);
        if (candidates.some((c) => c.start >= start && c.end <= end)) continue;
        const name = segment.trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9)]+$/g, "");
        if (!name || name.length > 60 || name.split(/\s+/).length > 6) continue;
        const from = start + segment.indexOf(name);
        candidates.push({ start: from, end: from + name.length, resolve: () => touchEntity(name, "application") });
      }
    }

    const mentions: Mention[] = [];
    for (const c of candidates.sort((a, b) => a.start - b.start)) {
      const key = c.resolve();
      if (key) mentions.push({ key, start: c.start, end: c.end });
    }

    // Technologies describe the nearest component: "React frontend", "backend built with Node.js".
    for (const tech of spans.filter((s) => s.role === "tech" && !s.consumed)) {
      const after = mentions.find((m) => m.start >= tech.end && /^[\s-]*$/.test(lower.slice(tech.end, m.start)));
      const before = [...mentions].reverse().find((m) => m.end <= tech.start);
      const gap = before ? lower.slice(before.end, tech.start) : "";
      const target =
        after ??
        (before &&
        gap.length < 40 &&
        /^[\s(,–-]*(?:is |are )?(?:built|written|developed|implemented|running|based|powered)?\s*(?:in|with|using|on|by)?\s*$/.test(gap)
          ? before
          : undefined);
      if (target && !byKey(target.key).technology) byKey(target.key).technology = tech.name;
    }

    // Verbs between two components become relationships.
    let last: { source: string; rule: Rule } | null = null;
    for (let i = 1; i < mentions.length; i++) {
      const prev = mentions[i - 1];
      const current = mentions[i];
      if (prev.key === current.key) continue;
      const gap = lower.slice(prev.end, current.start);
      let rule = RULES.find((r) => r.re.test(gap)) ?? null;
      let source = prev.key;
      if (rule) {
        // "X stores data in A and publishes events to B": the second verb still belongs to X.
        if ((CONJUNCTION_START.test(gap) || rule.fromPrevious) && last) source = last.source;
      } else if (last && LIST_GLUE.test(gap)) {
        rule = last.rule;
        source = last.source;
      } else {
        last = null;
        continue;
      }
      last = { source, rule };

      const from = rule.reverse ? current.key : source;
      const to = rule.reverse ? source : current.key;
      if (from === to) continue;
      if (rule.kind === "contains") {
        const parent = byKey(from);
        const child = byKey(to);
        if (objectType(parent.typeId).level >= objectType(child.typeId).level && ["application", "service", "web-app"].includes(parent.typeId)) {
          parent.typeId = "system";
        }
        if (objectType(parent.typeId).level < objectType(child.typeId).level) child.parentKey = parent.key;
        continue;
      }
      const target = objectType(byKey(to).typeId);
      let kind: RelationKind = rule.kind;
      let label = rule.label ?? "";
      if (kind === "calls" && !label && target.category === "data") {
        if (target.id === "queue") label = "publishes to";
        else kind = "reads_writes";
      }
      if (kind === "reads_writes" && target.category !== "data") kind = "calls";
      if (kind === "calls" && !label && byKey(from).typeId === "actor") label = "uses";
      relationships.push({ sourceKey: from, targetKey: to, kind, label });
    }

    // "Everything is hosted on Kubernetes."
    if (HOSTS_EVERYTHING.test(lower)) {
      const hosts = mentions.map((m) => byKey(m.key)).filter((e) => objectType(e.typeId).category === "infrastructure");
      if (hosts.length === 1) hostsOfEverything.push(hosts[0].key);
    }
  }

  for (const host of hostsOfEverything) {
    for (const e of entities.values()) {
      const t = objectType(e.typeId);
      if (t.level === 3 && t.category === "application") relationships.push({ sourceKey: e.key, targetKey: host, kind: "hosted_on", label: "" });
    }
  }

  const draft = normalizeDraft({
    objects: [...entities.values()].map((e) => ({ ...e, description: "" })),
    relationships,
    notes: entities.size
      ? "Drafted by the built-in rules, without an AI model. They recognise common products and phrases only, so check names, types and arrows."
      : "The built-in rules found no components in this text. Name the parts, for example: \"The web portal calls the order service, which stores data in PostgreSQL.\"",
  });
  return draft ?? { objects: [], relationships: [], notes: "" };
}
