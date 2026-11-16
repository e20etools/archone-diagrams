/**
 * "May this connect to that?", answered from the model for a coding agent before it writes
 * the call. The answer is yes, no or unknown, with the reason. It reads the model as the
 * API returns it and uses a few plain rules, the same ones the checks apply; it is advice
 * drawn from what the model records, not a guarantee.
 */

interface ApiObject {
  id: string;
  name: string;
  typeId: string;
  owner?: string;
  lifecycle?: string;
  tags?: string[];
  fields?: Record<string, string>;
}
interface ApiRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  kind: string;
  protocol?: string;
  label?: string;
}

export interface Verdict {
  answer: "yes" | "no" | "unknown";
  /** One sentence a person can read. */
  summary: string;
  /** The rule or fact behind each part of the answer. */
  reasons: { rule: string; says: string; blocks: boolean }[];
  source: { id: string; name: string } | null;
  target: { id: string; name: string } | null;
  /** The relationship in the model, when there is one. */
  existing: { id: string; kind: string; protocol: string } | null;
  next: string;
}

const CLEAR_TEXT = /^(http|ftp|telnet|smtp|ldap|amqp|mqtt|redis|tcp|udp|jdbc|odbc|rsh|tftp|ws)$/i;
const DATA_STORES = new Set(["database", "storage", "queue", "cache"]);
const OUTSIDE = new Set(["external-system", "actor"]);
const SENSITIVE = new Set(["Confidential", "Restricted"]);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function find(objects: ApiObject[], wanted: string): ApiObject[] {
  const byId = objects.filter((o) => o.id === wanted);
  return byId.length ? byId : objects.filter((o) => same(o.name, wanted));
}

export function mayConnect(model: unknown, args: { source?: unknown; target?: unknown; protocol?: unknown }): Verdict {
  const data = (model ?? {}) as { objects?: ApiObject[]; relationships?: ApiRelationship[] };
  const objects = Array.isArray(data.objects) ? data.objects : [];
  const relationships = Array.isArray(data.relationships) ? data.relationships : [];
  const protocol = typeof args.protocol === "string" ? args.protocol.trim() : "";
  const unknown = (summary: string, next: string, source: ApiObject | null = null, target: ApiObject | null = null): Verdict => ({
    answer: "unknown",
    summary,
    reasons: [],
    source: source && { id: source.id, name: source.name },
    target: target && { id: target.id, name: target.name },
    existing: null,
    next,
  });

  const ends: (ApiObject | null)[] = [];
  for (const [side, wanted] of [["source", args.source], ["target", args.target]] as const) {
    const text = typeof wanted === "string" ? wanted.trim() : "";
    const found = find(objects, text);
    if (found.length === 0) {
      return unknown(`The model has no object called "${text}", so it cannot say anything about the ${side}.`, "Look it up with list_objects (search matches the name). If it is new, propose it with propose_changes together with the relationship.", ends[0] ?? null);
    }
    if (found.length > 1) {
      return unknown(`${found.length} objects are called "${text}". Ask again with the id of the one you mean: ${found.map((o) => o.id).join(", ")}.`, "Ask again with an id.", ends[0] ?? null);
    }
    ends.push(found[0]);
  }
  const [source, target] = ends as [ApiObject, ApiObject];
  if (source.id === target.id) return unknown("Source and target are the same object.", "Name two different objects.", source, target);

  const drawn = relationships.find((r) => r.sourceId === source.id && r.targetId === target.id);
  const reasons: Verdict["reasons"] = [];
  const say = (rule: string, says: string, blocks: boolean) => reasons.push({ rule, says, blocks });

  if (target.lifecycle === "retired") say("retired-in-use", `${target.name} is retired. Nothing should depend on it.`, true);
  else if (target.lifecycle === "deprecated") say("deprecated-in-use", `${target.name} is deprecated, so no new dependency on it should be added.`, !drawn);
  if (source.lifecycle === "retired") say("retired-in-use", `${source.name} is retired.`, true);
  if (OUTSIDE.has(source.typeId) && DATA_STORES.has(target.typeId)) say("store-exposed", `${target.name} is a data store, and ${source.name} is outside the organisation. Data stores are reached through a service, not from outside.`, true);
  const used = protocol || drawn?.protocol?.trim() || "";
  if (used && CLEAR_TEXT.test(used)) say("clear-text", `${used.toUpperCase()} is not encrypted. Use the encrypted form of the protocol.`, true);
  const classification = source.fields?.["Data classification"] ?? "";
  if (target.typeId === "external-system" && (SENSITIVE.has(classification) || /^y/i.test(source.fields?.["Personal data"] ?? ""))) {
    say("data-to-outside", `${source.name} holds ${SENSITIVE.has(classification) ? classification.toLowerCase() : "personal"} data and ${target.name} is an outside system. That flow needs a person's decision.`, !drawn);
  }
  const owners = [source.owner?.trim() ?? "", target.owner?.trim() ?? ""];
  if (!drawn && owners[0] && owners[1] && !same(owners[0], owners[1])) say("dependency-unconfirmed", `${target.name} belongs to ${owners[1]}, who would have to confirm a new dependency from ${owners[0]}.`, false);

  const blocked = reasons.filter((r) => r.blocks);
  const base = { reasons, source: { id: source.id, name: source.name }, target: { id: target.id, name: target.name }, existing: drawn ? { id: drawn.id, kind: drawn.kind, protocol: drawn.protocol ?? "" } : null };
  if (blocked.length) {
    return { ...base, answer: "no", summary: `No. ${blocked.map((r) => r.says).join(" ")}`, next: "Do not write this connection. If it is needed all the same, a person has to decide: describe it with propose_changes and say why in the notes." };
  }
  if (drawn) {
    return { ...base, answer: "yes", summary: `Yes. The model has ${source.name} ${drawn.kind.replace(/_/g, " ")} ${target.name}${drawn.protocol ? ` over ${drawn.protocol}` : ""}.`, next: "Go ahead. Keep to the protocol the model records." };
  }
  return {
    ...base,
    answer: "unknown",
    summary: `Not known. Nothing in the model forbids ${source.name} connecting to ${target.name}, but the relationship is not in the model, so nobody has agreed to it.`,
    next: "Propose the relationship with propose_changes before relying on it, or ask a person.",
  };
}
