import { z } from "zod";
import { objectType } from "../catalog";
import { PACKS, RULES, runChecks, type Finding, type PackId } from "../checks/checks";
import { exactComponent, objectFromComponent, searchLibrary } from "../library";
import { createObject, createRelationship, deleteObject, deleteRelationship, findByName, nowIso, removeNodes, setProtocols, updateDiagram, updateObject, updateRelationship } from "../model";
import { LIFECYCLES, RELATION_KINDS, type Provenance, type Workspace } from "../types";
import { addObjectsToDiagram, relayout } from "../views";

/**
 * Changes the assistant makes to the diagram on screen. The AI model ends its answer with a block
 * of operations in three lists: what the person asked for, made at once as one step they can undo;
 * what removes or replaces things, which waits for their yes; and what it suggests, offered one by
 * one. Every operation is checked here before it touches the model, and a removal is never made
 * without a yes, whichever list it came in.
 */

const name = z.string().trim().min(1).max(120);
const ref = z.string().trim().min(1).max(120);
const text = (max: number) => z.string().max(max);
const protocol = z.object({ name: z.string().trim().min(1).max(60), port: z.union([z.string(), z.number()]).transform(String).optional(), transport: z.enum(["TCP", "UDP", "TCP/UDP", "IP", "Other"]).optional().catch(undefined) });
const fields = z.record(z.union([z.string(), z.number(), z.boolean()]).transform(String)).optional();
const objectFields = {
  type: z.string().max(60).optional(),
  component: z.string().max(120).optional(),
  technology: text(120).optional(),
  owner: text(120).optional(),
  // A value the app does not know is left out rather than losing the whole change.
  lifecycle: z.enum(LIFECYCLES).optional().catch(undefined),
  description: text(2000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  parent: ref.optional(),
  fields,
};
const connectionFields = {
  kind: z.preprocess((v) => (typeof v === "string" ? v.replace(/-/g, "_") : v), z.enum(RELATION_KINDS).optional().catch(undefined)),
  label: text(120).optional(),
  protocols: z.array(protocol).max(12).optional(),
  network: text(80).optional(),
  encrypted: z.preprocess((v) => (v === true ? "yes" : v === false ? "no" : typeof v === "string" ? v.toLowerCase() : v), z.enum(["yes", "no"]).optional().catch(undefined)),
  description: text(2000).optional(),
};

export const editOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_object"), ref: z.string().max(40).optional(), name, ...objectFields }),
  z.object({ op: z.literal("show_object"), id: ref }),
  z.object({ op: z.literal("update_object"), id: ref, name: name.optional(), ...objectFields }),
  z.object({ op: z.literal("connect"), from: ref, to: ref, ...connectionFields }),
  z.object({ op: z.literal("update_connection"), id: ref.optional(), from: ref.optional(), to: ref.optional(), ...connectionFields }),
  z.object({ op: z.literal("hide_object"), id: ref }),
  z.object({ op: z.literal("delete_object"), id: ref }),
  z.object({ op: z.literal("delete_connection"), id: ref.optional(), from: ref.optional(), to: ref.optional() }),
  z.object({ op: z.literal("rename_diagram"), name: z.string().trim().min(1).max(200) }),
  z.object({ op: z.literal("describe_diagram"), description: text(4000) }),
  z.object({ op: z.literal("tidy") }),
]);
export type EditOp = z.infer<typeof editOpSchema>;

/** A suggestion: one change, or a few that belong together, such as adding a firewall and routing a connection through it. */
export interface Suggestion {
  say?: string;
  ops: EditOp[];
}

export interface EditPlan {
  apply: EditOp[];
  confirm: EditOp[];
  suggest: Suggestion[];
}

/** Every operation of a plan, to find the objects it adds by their ref when a later step names them. */
export const planOps = (plan: EditPlan): EditOp[] => [...plan.apply, ...plan.confirm, ...plan.suggest.flatMap((s) => s.ops)];

/** Operations that take something away: never made without the person's yes. */
export const REMOVES = new Set<EditOp["op"]>(["hide_object", "delete_object", "delete_connection"]);
const MAX_OPS = 60;
const BLOCK = /```\s*archone-changes\s*\n([\s\S]*?)```/i;

/** The answer without its block of changes, and the changes it asks for, each one checked. */
export function readPlan(answer: string): { text: string; plan: EditPlan | null; dropped: number } {
  const found = BLOCK.exec(answer);
  if (!found) return { text: answer.trim(), plan: null, dropped: 0 };
  const text = `${answer.slice(0, found.index)}${answer.slice(found.index + found[0].length)}`.replace(/\n{3,}/g, "\n\n").trim();
  let raw: unknown;
  try {
    raw = JSON.parse(found[1]);
  } catch {
    return { text, plan: null, dropped: 1 };
  }
  const lists = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  let dropped = 0;
  let total = 0;
  const read = (key: string, items?: unknown[]): EditOp[] =>
    (items ?? (Array.isArray(lists[key]) ? (lists[key] as unknown[]) : [])).flatMap((item) => {
      const parsed = editOpSchema.safeParse(item);
      if (!parsed.success || total >= MAX_OPS) {
        dropped++;
        return [];
      }
      total++;
      return [parsed.data];
    });
  const asked = read("apply");
  const suggest = (Array.isArray(lists.suggest) ? (lists.suggest as unknown[]) : []).slice(0, 12).flatMap((item): Suggestion[] => {
    const group = item && typeof item === "object" && Array.isArray((item as { ops?: unknown }).ops) ? (item as { say?: unknown; ops: unknown[] }) : null;
    const ops = read("", group ? group.ops.slice(0, 10) : [item]);
    if (!ops.length) return [];
    const say = group && typeof group.say === "string" && group.say.trim() ? group.say.trim().slice(0, 240) : undefined;
    return [{ ...(say ? { say } : {}), ops }];
  });
  const plan: EditPlan = { apply: asked.filter((op) => !REMOVES.has(op.op)), confirm: [...asked.filter((op) => REMOVES.has(op.op)), ...read("confirm")], suggest };
  return { text, plan: plan.apply.length || plan.confirm.length || plan.suggest.length ? plan : null, dropped };
}

/* ---------- making the changes ---------- */

interface Context {
  ws: Workspace;
  diagramId: string;
  /** New objects by the ref the plan gave them. */
  refs: Map<string, string>;
  /** The whole plan, so a step made later can name an object an earlier step added by its ref. */
  plan: EditOp[];
  lines: string[];
  problems: string[];
  show: string[];
  /** Changed in place: to point them out. */
  touched: string[];
}

const nameOf = (ws: Workspace, id: string) => ws.objects[id]?.name ?? "an object";

/** An object the plan names: its id in the model, the ref of one it adds, or its exact name. */
function resolve(c: Context, key: string | undefined): string | null {
  if (!key) return null;
  if (c.ws.objects[key]) return key;
  if (c.refs.has(key)) return c.refs.get(key)!;
  const adding = c.plan.find((op) => op.op === "add_object" && op.ref === key);
  if (adding && adding.op === "add_object") return findByName(c.ws, adding.name)?.id ?? null;
  return findByName(c.ws, key)?.id ?? null;
}

function connectionOf(c: Context, op: { id?: string; from?: string; to?: string }): string | null {
  if (op.id && c.ws.relationships[op.id]) return op.id;
  const from = resolve(c, op.from);
  const to = resolve(c, op.to);
  if (!from || !to) return null;
  return Object.values(c.ws.relationships).find((r) => r.sourceId === from && r.targetId === to)?.id ?? Object.values(c.ws.relationships).find((r) => r.sourceId === to && r.targetId === from)?.id ?? null;
}

const cleanFields = (current: Record<string, string>, given: Record<string, string> | undefined) => {
  if (!given) return undefined;
  const next = { ...current };
  for (const [key, value] of Object.entries(given)) {
    const k = key.trim().slice(0, 60);
    if (!k) continue;
    if (value.trim()) next[k] = value.trim().slice(0, 200);
    else delete next[k];
  }
  return next;
};

const protocolText = (protocols: { name: string; port?: string; transport?: string }[] | undefined) =>
  (protocols ?? []).map((p) => [p.name, p.port, p.transport ? `/${p.transport}` : ""].filter(Boolean).join(" ").replace(" /", "/")).join(", ");

function patchConnection(c: Context, id: string, op: Partial<Record<keyof typeof connectionFields, unknown>> & { protocols?: { name: string; port?: string; transport?: "TCP" | "UDP" | "TCP/UDP" | "IP" | "Other" }[] }) {
  const patch: Record<string, unknown> = {};
  for (const key of ["kind", "label", "network", "encrypted", "description"] as const) if (op[key] !== undefined) patch[key] = op[key];
  if (Object.keys(patch).length) c.ws = updateRelationship(c.ws, id, patch);
  if (op.protocols) c.ws = setProtocols(c.ws, id, op.protocols.map((p) => ({ name: p.name, port: p.port ?? "", ...(p.transport ? { transport: p.transport } : {}) })));
}

function applyOne(c: Context, op: EditOp, provenance: Provenance) {
  switch (op.op) {
    case "add_object": {
      const existing = findByName(c.ws, op.name);
      if (existing) {
        if (op.ref) c.refs.set(op.ref, existing.id);
        c.show.push(existing.id);
        c.lines.push(`${existing.name} was already in the model: shown here`);
        return;
      }
      const component = op.component ? (exactComponent(op.component) ?? searchLibrary(op.component, { limit: 1 })[0]) : undefined;
      const fromComponent = component ? objectFromComponent(component) : null;
      const typeId = op.type && objectType(op.type).id === op.type ? op.type : (fromComponent?.typeId ?? "application");
      const made = createObject(c.ws, {
        typeId,
        name: op.name,
        technology: op.technology ?? fromComponent?.technology ?? "",
        owner: op.owner,
        lifecycle: op.lifecycle,
        description: op.description,
        tags: op.tags,
        fields: cleanFields({}, op.fields),
        ...(component ? { componentId: component.id } : {}),
        provenance,
      });
      c.ws = made.ws;
      if (op.ref) c.refs.set(op.ref, made.object.id);
      c.show.push(made.object.id);
      c.lines.push(`Added ${made.object.name} (${objectType(made.object.typeId).label})`);
      return;
    }
    case "show_object": {
      const id = resolve(c, op.id);
      if (!id) return c.problems.push(`No object "${op.id}" to show`);
      c.show.push(id);
      c.lines.push(`Showed ${nameOf(c.ws, id)}`);
      return;
    }
    case "update_object": {
      const id = resolve(c, op.id);
      if (!id) return c.problems.push(`No object "${op.id}" to change`);
      const o = c.ws.objects[id];
      const changed: string[] = [];
      const patch: Record<string, unknown> = {};
      if (op.name && op.name !== o.name) (patch.name = op.name), changed.push(`renamed to ${op.name}`);
      if (op.type && op.type !== o.typeId && objectType(op.type).id === op.type) (patch.typeId = op.type), changed.push(`a ${objectType(op.type).label.toLowerCase()} now`);
      for (const key of ["technology", "owner", "lifecycle", "description"] as const) if (op[key] !== undefined && op[key] !== o[key]) (patch[key] = op[key]), changed.push(key);
      if (op.tags) (patch.tags = op.tags), changed.push("tags");
      const nextFields = cleanFields(o.fields, op.fields);
      if (nextFields) (patch.fields = nextFields), changed.push(...Object.keys(op.fields ?? {}));
      if (!changed.length) return;
      c.ws = updateObject(c.ws, id, patch);
      c.touched.push(id);
      c.lines.push(`Changed ${o.name}: ${changed.join(", ")}`);
      return;
    }
    case "connect": {
      const from = resolve(c, op.from);
      const to = resolve(c, op.to);
      if (!from || !to) return c.problems.push(`No object to connect: ${!from ? op.from : op.to}`);
      const made = createRelationship(c.ws, { sourceId: from, targetId: to, kind: op.kind ?? "calls", label: op.label, description: op.description, provenance });
      if (!made.relationship) return c.problems.push(`${nameOf(c.ws, from)} cannot be connected to itself`);
      c.ws = made.ws;
      patchConnection(c, made.relationship.id, op);
      c.show.push(from, to);
      const via = protocolText(op.protocols);
      c.lines.push(`${made.created ? "Connected" : "Updated the connection"} ${nameOf(c.ws, from)} → ${nameOf(c.ws, to)}${via ? ` over ${via}` : ""}${op.encrypted ? `, ${op.encrypted === "yes" ? "encrypted" : "not encrypted"}` : ""}`);
      return;
    }
    case "update_connection": {
      const id = connectionOf(c, op);
      if (!id) return c.problems.push("No such connection to change");
      patchConnection(c, id, op);
      const r = c.ws.relationships[id];
      c.touched.push(r.sourceId, r.targetId);
      c.lines.push(`Changed the connection ${nameOf(c.ws, r.sourceId)} → ${nameOf(c.ws, r.targetId)}`);
      return;
    }
    case "hide_object": {
      const id = resolve(c, op.id);
      if (!id || !(id in (c.ws.diagrams[c.diagramId]?.nodes ?? {}))) return c.problems.push(`"${op.id}" is not on this diagram`);
      c.ws = removeNodes(c.ws, c.diagramId, [id]);
      c.lines.push(`Took ${nameOf(c.ws, id)} off this diagram (it stays in the model)`);
      return;
    }
    case "delete_object": {
      const id = resolve(c, op.id);
      if (!id) return c.problems.push(`No object "${op.id}" to delete`);
      const was = nameOf(c.ws, id);
      c.ws = deleteObject(c.ws, id);
      c.lines.push(`Deleted ${was} from the model`);
      return;
    }
    case "delete_connection": {
      const id = connectionOf(c, op);
      if (!id) return c.problems.push("No such connection to delete");
      const r = c.ws.relationships[id];
      const was = `${nameOf(c.ws, r.sourceId)} → ${nameOf(c.ws, r.targetId)}`;
      c.ws = deleteRelationship(c.ws, id);
      c.lines.push(`Deleted the connection ${was}`);
      return;
    }
    case "rename_diagram":
      c.ws = updateDiagram(c.ws, c.diagramId, { name: op.name });
      c.lines.push(`Renamed the diagram to ${op.name}`);
      return;
    case "describe_diagram":
      c.ws = updateDiagram(c.ws, c.diagramId, { description: op.description });
      c.lines.push("Changed the diagram's description");
      return;
    case "tidy":
      c.ws = relayout(c.ws, c.diagramId, true);
      c.lines.push("Tidied the layout");
      return;
  }
}

export interface Applied {
  ws: Workspace;
  /** What changed, in words, one line each. */
  lines: string[];
  /** What could not be done. */
  problems: string[];
  /** The objects the changes added, showed or changed, and the ends of the connections they touched. */
  touched: string[];
}

/**
 * Makes a list of changes on a diagram, in order, with new objects marked as made by the AI model
 * at the person's request. New and shown objects are placed by the layout; boxes placed by hand stay.
 */
export function applyOps(ws: Workspace, diagramId: string, ops: EditOp[], who: { by: string; source: string; engine: string }, plan: EditOp[] = ops): Applied {
  if (!ws.diagrams[diagramId]) return { ws, lines: [], problems: ["The diagram is no longer there"], touched: [] };
  const provenance: Provenance = { origin: "ai-prompt", source: who.source.slice(0, 500), engine: who.engine, approvedBy: who.by, approvedAt: nowIso() };
  const c: Context = { ws, diagramId, refs: new Map(), plan, lines: [], problems: [], show: [], touched: [] };
  for (const op of ops) applyOne(c, op, provenance);
  // Parents are set once every new object exists, so a plan may name them in any order.
  for (const op of ops) {
    if ((op.op !== "add_object" && op.op !== "update_object") || !op.parent) continue;
    const id = op.op === "add_object" ? (op.ref ? c.refs.get(op.ref) : findByName(c.ws, op.name)?.id) : resolve(c, op.id);
    const parent = resolve(c, op.parent);
    if (id && parent && c.ws.objects[id]?.parentId !== parent) {
      c.ws = updateObject(c.ws, id, { parentId: parent });
      if (c.ws.objects[id].parentId === parent) c.lines.push(`Put ${nameOf(c.ws, id)} inside ${nameOf(c.ws, parent)}`);
    }
  }
  const shown = [...new Set(c.show)].filter((id) => c.ws.objects[id]);
  if (shown.length) c.ws = addObjectsToDiagram(c.ws, diagramId, shown);
  const touched = [...new Set([...c.show, ...c.touched])].filter((id) => c.ws.diagrams[diagramId]?.nodes[id]);
  return { ws: c.ws, lines: c.lines, problems: c.problems, touched };
}

/** One change in words, before it is made: for the changes that wait for a yes and the suggestions. */
export function describeOp(ws: Workspace, op: EditOp, plan: EditOp[] = []): string {
  const refName = (key: string | undefined) => {
    if (!key) return "an object";
    if (ws.objects[key]) return ws.objects[key].name;
    const adding = plan.find((p) => p.op === "add_object" && p.ref === key);
    return adding && adding.op === "add_object" ? adding.name : (findByName(ws, key)?.name ?? key);
  };
  switch (op.op) {
    case "add_object":
      return `Add ${op.name}${op.type ? ` (${objectType(op.type).label})` : op.component ? ` (${op.component})` : ""}`;
    case "show_object":
      return `Show ${refName(op.id)}`;
    case "update_object": {
      const what = [op.name && `rename to ${op.name}`, op.owner !== undefined && `owner ${op.owner || "none"}`, op.technology !== undefined && `technology ${op.technology}`, op.lifecycle && `lifecycle ${op.lifecycle}`, ...Object.entries(op.fields ?? {}).map(([k, v]) => `${k} ${v || "removed"}`)].filter(Boolean);
      return `Change ${refName(op.id)}${what.length ? `: ${what.join(", ")}` : ""}`;
    }
    case "connect": {
      const via = protocolText(op.protocols);
      return `Connect ${refName(op.from)} → ${refName(op.to)}${via ? ` over ${via}` : ""}`;
    }
    case "update_connection": {
      const r = op.id ? ws.relationships[op.id] : undefined;
      const via = protocolText(op.protocols);
      return `Change the connection ${r ? `${refName(r.sourceId)} → ${refName(r.targetId)}` : `${refName(op.from)} → ${refName(op.to)}`}${via ? `: ${via}` : ""}${op.encrypted ? `, ${op.encrypted === "yes" ? "encrypted" : "not encrypted"}` : ""}`;
    }
    case "hide_object":
      return `Take ${refName(op.id)} off this diagram`;
    case "delete_object":
      return `Delete ${refName(op.id)} from the whole model`;
    case "delete_connection": {
      const r = op.id ? ws.relationships[op.id] : undefined;
      return `Delete the connection ${r ? `${refName(r.sourceId)} → ${refName(r.targetId)}` : `${refName(op.from)} → ${refName(op.to)}`}`;
    }
    case "rename_diagram":
      return `Rename the diagram to ${op.name}`;
    case "describe_diagram":
      return "Change the diagram's description";
    case "tidy":
      return "Tidy the layout";
  }
}

/* ---------- what the checks say about a change ---------- */

const ALL_PACKS = PACKS.map((p) => p.id) as PackId[];
const key = (f: Finding) => `${f.ruleId}|${f.message}`;

export const diagramFindings = (ws: Workspace, diagramId: string): Finding[] => (ws.diagrams[diagramId] ? runChecks(ws, ws.diagrams[diagramId], ALL_PACKS) : []);

/** What the checks find after a change that they did not find before, worst first, in words. */
export function newFindings(ws: Workspace, before: Finding[], after: Finding[]): string[] {
  const had = new Set(before.map(key));
  return after
    .filter((f) => !had.has(key(f)) && f.severity !== "low")
    .slice(0, 8)
    .map((f) => {
      const rule = RULES.find((r) => r.id === f.ruleId);
      const own = ws.rules?.[f.ruleId];
      const pack = rule ? rule.packs.map((p) => PACKS.find((x) => x.id === p)?.name ?? p).join(", ") : "Workspace rule";
      return `[${f.severity}] ${pack}: ${f.message}${own ? ` (${own.title})` : ""}`;
    });
}

/** Findings that a change cleared, for the good news. */
export const clearedFindings = (before: Finding[], after: Finding[]): number => {
  const now = new Set(after.map(key));
  return before.filter((f) => !now.has(key(f)) && f.severity !== "low").length;
};
