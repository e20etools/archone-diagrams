import { OBJECT_TYPES } from "../catalog";
import type { Lifecycle, ObjectRequirement, RuleCheck, Selector, Workspace } from "../types";
import { emptySelector, isEverything } from "./custom";

/**
 * Reads a rule written as a sentence, in English or Arabic, into the three shapes the checks
 * can run. It works by recognising words, not by understanding: it knows the kinds of object,
 * tags, lifecycles, the names of objects in the model, and a few dozen ways of saying "must",
 * "never", "only" and "through". What it reads is always shown back for the person to correct.
 */

export interface ParsedRule {
  check: RuleCheck;
  severity: "high" | "medium" | "low";
  /** Parts of the sentence nothing was read from. Empty when every part was used. */
  unread: string[];
}

/** Words for each kind of object, beyond its own label. Longer phrases are tried first. */
const TYPE_WORDS: Record<string, string[]> = {
  database: ["databases", "database", "data stores", "data store", "db", "قواعد البيانات", "قاعدة البيانات", "قواعد بيانات", "قاعدة بيانات"],
  storage: ["file storage", "storage", "buckets", "bucket", "التخزين", "تخزين الملفات"],
  queue: ["queues", "queue", "streams", "stream", "topics", "الطوابير", "طابور", "قوائم الانتظار"],
  cache: ["caches", "cache", "الذاكرة المؤقتة"],
  "external-system": ["external systems", "external system", "third parties", "third party", "third-party systems", "outside systems", "outside parties", "vendors", "suppliers", "الأنظمة الخارجية", "أنظمة خارجية", "نظام خارجي", "الأطراف الخارجية", "أطراف خارجية", "طرف خارجي", "طرف ثالث", "الموردين"],
  actor: ["people", "persons", "users", "customers", "actors", "teams", "المستخدمين", "المستخدمون", "العملاء", "الأشخاص"],
  system: ["software systems", "software system", "systems", "system", "الأنظمة", "أنظمة", "نظام"],
  application: ["applications", "application", "apps", "التطبيقات", "تطبيقات", "تطبيق"],
  "web-app": ["web apps", "web app", "web applications", "front ends", "frontends", "تطبيقات الويب", "تطبيق ويب"],
  "mobile-app": ["mobile apps", "mobile app", "تطبيقات الجوال", "تطبيق جوال"],
  service: ["services", "service", "apis", "api", "microservices", "الخدمات", "خدمات", "خدمة"],
  gateway: ["gateways", "gateway", "api gateways", "api gateway", "load balancers", "load balancer", "البوابات", "بوابات", "بوابة"],
  server: ["servers", "server", "vms", "virtual machines", "الخوادم", "خوادم", "خادم"],
  cluster: ["clusters", "cluster", "العناقيد"],
  network: ["firewalls", "firewall", "network devices", "جدران الحماية", "جدار الحماية", "جدار حماية"],
  component: ["components", "component", "المكونات", "مكونات"],
  domain: ["domains", "domain", "النطاقات", "نطاق"],
  "ai-agent": ["ai agents", "ai agent", "agents", "agent", "وكلاء الذكاء الاصطناعي", "وكلاء الذكاء", "وكيل ذكاء", "الوكلاء", "وكلاء"],
  "ai-model": ["ai models", "ai model", "language models", "llms", "llm", "نماذج الذكاء", "نموذج ذكاء"],
  "mcp-server": ["mcp servers", "mcp server", "خوادم mcp", "خادم mcp"],
  process: ["processes", "process", "العمليات", "عملية"],
};
const LIFECYCLE_WORDS: Record<Lifecycle, string[]> = {
  planned: ["planned", "مخطط لها", "مخططة"],
  active: ["active", "live", "in production", "نشطة", "نشط", "فعالة"],
  deprecated: ["deprecated", "being phased out", "legacy", "متقادمة", "متقادم", "قديمة"],
  retired: ["retired", "decommissioned", "متقاعدة", "متقاعد", "موقوفة"],
};
const CLASS_WORDS: [string, string[]][] = [
  ["Restricted", ["restricted", "مقيدة", "مقيد"]],
  ["Confidential", ["confidential", "سرية", "سري"]],
  ["Internal", ["internal data", "داخلية"]],
  ["Public", ["public data", "عامة"]],
];
const PERSONAL = ["personal data", "personal information", "pii", "customer data", "بيانات شخصية", "البيانات الشخصية"];
const EVERYTHING = ["everything", "every object", "all objects", "any object", "anything", "كل شيء", "جميع العناصر", "كل العناصر", "أي عنصر"];

const NEVER = /\b(nothing(?! else| but)|none of|must not|must never|should not|shall not|cannot|can not|can't|may not|never|is not allowed|are not allowed|not allowed|forbidden|no )|لا يجوز|لا يجب|لا ينبغي|يمنع|يُمنع|ممنوع|ألا|عدم|يحظر|لا ي|لا ت/i;
const ONLY = /\bonly\b|\bnothing (else|but)\b|فقط|حصرا|حصراً/i;
const VIA = /\b(pass(es|ing)? through|go(es|ing)? through|going via|through|via|by way of)\b|من خلال|عبر|مرورا ب|مروراً ب|يمر ب|تمر ب|يمر على|تمر على/i;
const WITHOUT = /\bwithout (passing|going)?\s*(through|via)?\b|دون المرور|بدون المرور|دون أن ي|دون أن ت|بدون/i;
const CONNECT = /\b(connect(s|ed|ion|ions)?( directly)?( to| with)?|call(s|ed)?|talk(s)? to|use(s)?|depend(s)? on|reach(es)?|access(es)?|send(s)? (data )?to|read(s)? from|write(s)? to|integrate(s)? with)\b|يتصل|تتصل|اتصال|الاتصال|يستدعي|تستدعي|يصل إلى|تصل إلى|الوصول إلى|يعتمد على|تعتمد على|يرسل إلى|ترسل إلى|يستخدم|تستخدم/i;
const FROM_TO = /\b(?:from|between)\s+(.+?)\s+(?:to|and)\s+(.+?)\s+(?=must|should|shall|may|can|never|always|is|are|use|go|pass)/i;
const FROM_TO_AR = /(?:من|بين)\s+(.+?)\s+(?:إلى|الى|و)\s+(.+?)\s+(?=يجب|لا |يمر|تمر|ي|ت)/;
const PROTOCOLS = ["https", "mtls", "tls", "sftp", "ssh", "grpc", "amqps", "wss", "ldaps", "http", "ftp", "tcp"];
const HIGH = /\b(must|shall|never|forbidden|cannot|may not)\b|يجب|لا يجوز|يمنع|ممنوع|يحظر/i;
const LOW = /\b(could|nice to have|preferably|ideally)\b|يفضل|يستحسن/i;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A word or phrase as a whole, with Arabic's attached "the", "and", "to" and "by" allowed in front. */
const phrase = (words: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:[وبلف]|ال|بال|لل|وال)?${escape(words)}(?![\\p{L}\\p{N}])`, "iu");

const TYPE_CANDIDATES = OBJECT_TYPES.flatMap((t) => [...(TYPE_WORDS[t.id] ?? []), t.label.toLowerCase(), `${t.label.toLowerCase()}s`].map((w) => ({ id: t.id, w }))).sort((a, b) => b.w.length - a.w.length);

/**
 * Where a piece of the sentence that names two kinds of object changes from the first to the
 * second. Arabic puts the verb first ("must not connect A to B"), so both ends come after it.
 */
function splitTwo(segment: string): [string, string] | null {
  const hits: { at: number; end: number }[] = [];
  let rest = segment;
  for (const { w } of TYPE_CANDIDATES) {
    const hit = phrase(w).exec(rest);
    if (!hit) continue;
    hits.push({ at: hit.index, end: hit.index + hit[0].length });
    // Blanked out, not cut, so later positions stay true.
    rest = `${rest.slice(0, hit.index)}${" ".repeat(hit[0].length)}${rest.slice(hit.index + hit[0].length)}`;
  }
  hits.sort((a, b) => a.at - b.at);
  return hits.length >= 2 ? [segment.slice(0, hits[1].at), segment.slice(hits[1].at)] : null;
}

interface Reading {
  selector: Selector;
  /** The segment with everything that was recognised taken out. */
  rest: string;
}

/** Reads which objects a piece of the sentence is about. */
function readSelector(ws: Pick<Workspace, "objects">, segment: string): Reading {
  const selector = emptySelector();
  let rest = ` ${segment} `;
  const take = (pattern: RegExp) => {
    const hit = pattern.exec(rest);
    if (!hit) return null;
    rest = `${rest.slice(0, hit.index)} ${rest.slice(hit.index + hit[0].length)}`;
    return hit;
  };

  // A name in quotes, or the name of an object in the model, is the most exact thing a sentence can say.
  const quoted = take(/["“«']([^"”»']{2,80})["”»']/);
  const names = Object.values(ws.objects).map((o) => o.name).filter((n) => n.trim().length >= 3).sort((a, b) => b.length - a.length);
  const inside = take(/\b(?:inside|within|in the|under)\s+|داخل\s+|ضمن\s+/i);
  let named = quoted?.[1]?.trim() ?? "";
  if (!named) {
    for (const name of names) {
      if (take(phrase(name))) {
        named = name;
        break;
      }
    }
  }
  if (named) {
    const object = Object.values(ws.objects).find((o) => o.name.toLowerCase() === named.toLowerCase());
    if (inside && object) selector.inside = object.id;
    else selector.name = named;
  }

  let tag: RegExpExecArray | null;
  while ((tag = take(/(?:\btagged(?: as| with)?|\bwith (?:the )?tag|\bin scope of|موسومة? ب|الموسومة? ب|بوسم|ذات الوسم)\s*#?([\p{L}\p{N}][\p{L}\p{N}_-]*)|#([\p{L}\p{N}][\p{L}\p{N}_-]*)/iu))) selector.tags.push((tag[1] ?? tag[2]).toLowerCase());
  if (take(/\btier[- ]?1\b/i)) selector.tags.push("tier-1");
  if (take(/\bpci\b/i)) selector.tags.push("pci");
  selector.tags = [...new Set(selector.tags)];

  if (PERSONAL.some((w) => take(phrase(w)))) selector.personal = true;
  for (const [name, words] of CLASS_WORDS) if (words.some((w) => take(phrase(w)))) selector.classification.push(name);
  for (const [lifecycle, words] of Object.entries(LIFECYCLE_WORDS) as [Lifecycle, string[]][]) if (words.some((w) => take(phrase(w)))) selector.lifecycle.push(lifecycle);

  for (const { id, w } of TYPE_CANDIDATES) if (take(phrase(w)) && !selector.types.includes(id)) selector.types.push(id);
  EVERYTHING.some((w) => take(phrase(w)));
  return { selector, rest };
}

const FILLER = /\b(a|an|the|all|every|each|any|of|that|which|who|is|are|be|to|it|its|their|them|they|there|must|should|shall|may|can|will|always|have|has|hold|holds|with|and|or|data|directly|traffic|way|ways|path|paths|route|routes|way from|on|in|at|by|for|not|no|do|does|objects?|things?|anything|go|goes|needs?|required?)\b|يجب|ينبغي|أن|ان|كل|جميع|على|في|من|إلى|الى|التي|الذي|لا|يجوز|هو|هي|تكون|يكون|له|لها|لديها|لديه|أي|و|أو/giu;
const leftover = (rest: string) => rest.replace(FILLER, " ").replace(/[.,;:!?،؛()]/g, " ").replace(/\s+/g, " ").trim();

function cut(text: string, pattern: RegExp): [string, string] | null {
  const hit = pattern.exec(text);
  return hit ? [text.slice(0, hit.index), text.slice(hit.index + hit[0].length)] : null;
}

/** Reads a sentence into a rule, or returns null when it says nothing a rule could be made of. */
export function parseRule(ws: Pick<Workspace, "objects">, sentence: string): ParsedRule | null {
  const text = sentence.replace(/\s+/g, " ").trim();
  if (text.length < 4) return null;
  const never = NEVER.test(text);
  const severity = HIGH.test(text) ? "high" : LOW.test(text) ? "low" : "medium";
  const unread: string[] = [];
  const note = (rest: string) => {
    const left = leftover(rest);
    if (left) unread.push(left);
  };
  const read = (segment: string) => {
    const reading = readSelector(ws, segment);
    note(reading.rest);
    return reading.selector;
  };

  // A journey: what lies on the way from one set of objects to another.
  const without = cut(text, WITHOUT);
  const via = without ?? cut(text, VIA);
  if (via) {
    const [before, after] = via;
    const ends = FROM_TO.exec(`${before} must`) ?? FROM_TO_AR.exec(`${before} يجب`);
    let from: Selector;
    let to: Selector;
    if (ends) {
      from = read(ends[1]);
      to = read(ends[2]);
    } else {
      const sides = cut(before, CONNECT);
      let parts = sides ? [sides[0].replace(NEVER, " "), sides[1]] : [before.replace(NEVER, " "), ""];
      if (sides && isEverything(readSelector(ws, parts[0]).selector)) parts = splitTwo(parts[1]) ?? parts;
      from = read(parts[0]);
      to = parts[1].trim() ? read(parts[1]) : emptySelector();
    }
    const through = read(after);
    if (!isEverything(through) && !(isEverything(from) && isEverything(to))) {
      // "must not reach X without passing through Y" asks for Y on every way, like "must reach X through Y".
      const mode = without ? "always" : never ? "never" : "always";
      return { check: { kind: "journey", from, to, through, mode }, severity, unread };
    }
    unread.length = 0;
  }

  // How two sets of objects connect.
  const protocol = PROTOCOLS.filter((p) => new RegExp(`\\b${p}\\b`, "i").test(text));
  const ends = FROM_TO.exec(text) ?? FROM_TO_AR.exec(text);
  const sides = cut(text, CONNECT);
  if (ends && protocol.length) {
    return { check: { kind: "connection", from: read(ends[1]), to: read(ends[2]), mode: "protocol", value: protocol.join(", ") }, severity, unread };
  }
  if (sides && sides[1].trim()) {
    const strip = (part: string) => PROTOCOLS.reduce((t, p) => t.replace(new RegExp(`\\b(over|using|with|use|uses)?\\s*${p}\\b`, "gi"), " "), part.replace(NEVER, " ").replace(ONLY, " "));
    let ends = [strip(sides[0]), strip(sides[1])];
    if (isEverything(readSelector(ws, ends[0]).selector)) ends = splitTwo(ends[1]) ?? ends;
    const from = read(ends[0]);
    const to = read(ends[1]);
    if (!(isEverything(from) && isEverything(to))) {
      const mode = protocol.length && !never ? "protocol" : ONLY.test(text) ? "only" : never ? "never" : null;
      if (mode) return { check: { kind: "connection", from, to, mode, value: mode === "protocol" ? protocol.join(", ") : "" }, severity, unread };
    }
    unread.length = 0;
  }

  // Something every chosen object has to have or be.
  const requirements: [RegExp, ObjectRequirement][] = [
    [/\bowners?\b|\bowned\b|مالك|مالكا|مالكاً/i, "owner"],
    [/\bdescriptions?\b|\bdescribed\b|وصف|وصفا|وصفاً/i, "description"],
    [/\btechnolog(y|ies)\b|\btech stack\b|التقنية|تقنية/i, "technology"],
    [/\bclassifi(ed|cation)\b|تصنيف/i, "classification"],
    [/\b(region|residency|where (it|its data|their data) (is|are) kept|country)\b|منطقة|بلد|مكان حفظ|إقامة البيانات/i, "residency"],
  ];
  for (const [pattern, require] of requirements) {
    const parts = cut(text, pattern);
    if (!parts) continue;
    const subject = read(parts[0].replace(NEVER, " "));
    return { check: { kind: "object", subject, require, value: "" }, severity, unread };
  }
  const tagged = /\b(?:be |are |is )?tagged(?: as| with)?\s+#?([\p{L}\p{N}][\p{L}\p{N}_-]*)|(?:موسومة?|توسم) ب#?([\p{L}\p{N}][\p{L}\p{N}_-]*)/iu.exec(text);
  if (tagged && /\b(must|should|shall|have to|need)\b|يجب|ينبغي|لا يجوز/i.test(text.slice(0, tagged.index))) {
    const subject = read(text.slice(0, tagged.index).replace(NEVER, " "));
    return { check: { kind: "object", subject, require: never ? "no-tag" : "tag", value: (tagged[1] ?? tagged[2]).toLowerCase() }, severity, unread };
  }
  const state = cut(text, /\b(?:must|should|shall|may|can)(?: not| never)? be\b|\b(?:cannot|can't) be\b|يجب (?:أن|ألا) تكون|لا يجوز أن تكون/i);
  if (state) {
    const named = (Object.entries(LIFECYCLE_WORDS) as [Lifecycle, string[]][]).filter(([, words]) => words.some((w) => phrase(w).test(state[1]))).map(([l]) => l);
    if (named.length) {
      const allowed = never ? (["planned", "active", "deprecated", "retired"] as Lifecycle[]).filter((l) => !named.includes(l)) : named;
      return { check: { kind: "object", subject: read(state[0]), require: "lifecycle", value: allowed.join(", ") }, severity, unread };
    }
  }
  return null;
}
