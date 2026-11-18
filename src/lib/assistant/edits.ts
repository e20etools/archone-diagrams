import { z } from "zod";
import { objectType } from "../catalog";
import { alignNodes, distributeNodes } from "../arrange";
import { linkProcessDiagram } from "../bpm/processes";
import { PACKS, RULES, runChecks, type Finding, type PackId } from "../checks/checks";
import { addFlow, addStep, deleteFlow, flowsOf, updateFlow } from "../flows";
import { NODE_H, NODE_W } from "../layout";
import { exactComponent, LIBRARY, objectFromComponent, searchLibrary } from "../library";
import { protocolByName } from "../library/protocols";
import { saveComponent, saveProtocol } from "../libraryEdits";
import { cleanLinks } from "../links";
import {
  archiveDiagram,
  createObject,
  createRelationship,
  deleteDiagram,
  deleteObject,
  deleteRelationship,
  diagramBox,
  duplicateDiagram,
  findByName,
  normalizeName,
  nowIso,
  placeNodes,
  removeNodes,
  setProtocols,
  setRelationshipHidden,
  updateDiagram,
  updateObject,
  updateRelationship,
} from "../model";
import { COLOR_BY, LIFECYCLES, NOTATIONS, RELATION_KINDS, TITLE_BLOCK_CORNERS, VIEW_TYPES, type Provenance, type ViewType, type Workspace } from "../types";
import { addObjectsToDiagram, relayout } from "../views";

/**
 * Changes the assistant makes to the diagram on screen. The AI model ends its answer with a block
 * of operations in three lists: what the person asked for, made at once as one step they can undo;
 * what waits for their yes; and what it suggests, offered one by one. The assistant may do on the
 * diagram whatever the person may do there. Deleting the diagram, or taking everything off it,
 * always waits for a person's yes, whichever list the model put it in. Every operation is checked
 * here before it touches the model, and the person's own permissions still decide what is saved.
 */

const name = z.string().trim().min(1).max(120);
const ref = z.string().trim().min(1).max(120);
const text = (max: number) => z.string().max(max);
// A value the app does not know is left out rather than losing the whole change.
const loose = <const T extends readonly [string, ...string[]]>(values: T) => z.enum(values as unknown as [T[number], ...T[number][]]).optional().catch(undefined);
const protocol = z.object({ name: z.string().trim().min(1).max(60), port: z.union([z.string(), z.number()]).transform(String).optional(), transport: loose(["TCP", "UDP", "TCP/UDP", "IP", "Other"]) });
const fields = z.record(z.union([z.string(), z.number(), z.boolean()]).transform(String)).optional();
const links = z.array(z.object({ label: z.string().max(120).optional(), url: z.string().max(2000) })).max(20).optional();
const objectFields = {
  type: z.string().max(60).optional(),
  component: z.string().max(120).optional(),
  technology: text(120).optional(),
  owner: text(120).optional(),
  lifecycle: loose(LIFECYCLES),
  description: text(2000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  parent: z.string().max(120).optional(),
  fields,
  links,
};
const connectionFields = {
  kind: z.preprocess((v) => (typeof v === "string" ? v.replace(/-/g, "_") : v), z.enum(RELATION_KINDS).optional().catch(undefined)),
  label: text(120).optional(),
  protocols: z.array(protocol).max(12).optional(),
  network: text(80).optional(),
  encrypted: z.preprocess((v) => (v === true ? "yes" : v === false ? "no" : typeof v === "string" ? v.toLowerCase() : v), z.enum(["yes", "no"]).optional().catch(undefined)),
  flow: loose(["out", "in", "both"]),
  description: text(2000).optional(),
  links,
};
const which = { id: ref.optional(), from: ref.optional(), to: ref.optional() };

export const editOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_object"), ref: z.string().max(40).optional(), name, ...objectFields }),
  z.object({ op: z.literal("show_object"), id: ref }),
  z.object({ op: z.literal("update_object"), id: ref, name: name.optional(), ...objectFields }),
  z.object({ op: z.literal("connect"), from: ref, to: ref, ...connectionFields }),
  z.object({ op: z.literal("update_connection"), ...which, ...connectionFields }),
  z.object({ op: z.literal("show_connection"), ...which, kind: connectionFields.kind }),
  z.object({ op: z.literal("hide_connection"), ...which }),
  z.object({ op: z.literal("hide_object"), id: ref }),
  z.object({ op: z.literal("delete_object"), id: ref }),
  z.object({ op: z.literal("delete_connection"), ...which }),
  z.object({ op: z.literal("move_object"), id: ref, x: z.number().finite().optional(), y: z.number().finite().optional(), near: ref.optional(), side: loose(["left", "right", "above", "below"]) }),
  z.object({ op: z.literal("arrange"), ids: z.array(ref).min(2).max(80), align: loose(["left", "center", "right", "top", "middle", "bottom"]), distribute: loose(["horizontal", "vertical"]) }),
  z.object({ op: z.literal("tidy") }),
  z.object({ op: z.literal("rename_diagram"), name: z.string().trim().min(1).max(200) }),
  z.object({ op: z.literal("describe_diagram"), description: text(4000) }),
  z.object({
    op: z.literal("set_diagram"),
    name: z.string().trim().min(1).max(200).optional(),
    description: text(4000).optional(),
    viewType: loose(VIEW_TYPES),
    scope: z.string().max(120).optional(),
    direction: loose(["TB", "LR"]),
    notation: loose(NOTATIONS),
    colorBy: loose(COLOR_BY),
    arrows: z.union([z.literal("all"), z.array(z.preprocess((v) => (typeof v === "string" ? v.replace(/-/g, "_") : v), z.enum(RELATION_KINDS)))]).optional().catch(undefined),
  }),
  z.object({ op: z.literal("info_box"), show: z.boolean().optional(), corner: loose(TITLE_BLOCK_CORNERS), company: text(120).optional() }),
  z.object({ op: z.literal("add_diagram_box"), ref: z.string().max(40).optional(), diagram: ref }),
  z.object({ op: z.literal("add_flow"), name: z.string().trim().min(1).max(120), description: text(2000).optional(), steps: z.array(z.object({ from: ref, to: ref, text: text(500).optional() })).max(60).default([]) }),
  z.object({ op: z.literal("delete_flow"), name: ref }),
  z.object({ op: z.literal("link_process"), process: ref, linked: z.boolean().default(true) }),
  z.object({ op: z.literal("add_component"), name, type: z.string().max(60).optional(), aliases: text(400).optional() }),
  z.object({ op: z.literal("add_protocol"), name: z.string().trim().min(1).max(60), port: z.union([z.string(), z.number()]).transform(String).optional(), transport: loose(["TCP", "UDP", "TCP/UDP", "IP", "Other"]), secure: z.boolean().optional(), use: text(300).optional() }),
  z.object({ op: z.literal("duplicate_diagram"), name: z.string().trim().min(1).max(200).optional() }),
  z.object({ op: z.literal("archive_diagram"), reason: z.string().trim().min(1).max(500) }),
  z.object({ op: z.literal("delete_diagram") }),
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

/** What only a person may decide: never made without their yes. */
export const NEEDS_YES = new Set<EditOp["op"]>(["delete_diagram"]);
/** What takes boxes off the diagram: made at once, unless together they would empty it. */
const TAKES_OFF = new Set<EditOp["op"]>(["hide_object", "delete_object"]);
const MAX_OPS = 80;
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
    const ops = read("", group ? group.ops.slice(0, 10) : [item]).filter((op) => !NEEDS_YES.has(op.op));
    if (!ops.length) return [];
    const say = group && typeof group.say === "string" && group.say.trim() ? group.say.trim().slice(0, 240) : undefined;
    return [{ ...(say ? { say } : {}), ops }];
  });
  const plan: EditPlan = { apply: asked.filter((op) => !NEEDS_YES.has(op.op)), confirm: [...asked.filter((op) => NEEDS_YES.has(op.op)), ...read("confirm")], suggest };
  return { text, plan: plan.apply.length || plan.confirm.length || plan.suggest.length ? plan : null, dropped };
}

/**
 * The changes asked for, with whatever would empty the diagram moved to wait for a yes: taking
 * off, or deleting, every box on it (or most of a large one) is the same as wiping it.
 */
export function holdWipes(ws: Workspace, diagramId: string, plan: EditPlan, who: Who): EditPlan {
  const before = Object.keys(ws.diagrams[diagramId]?.nodes ?? {}).length;
  if (before < 2 || !plan.apply.some((op) => TAKES_OFF.has(op.op))) return plan;
  const after = Object.keys(applyOps(ws, diagramId, plan.apply, who, planOps(plan)).ws.diagrams[diagramId]?.nodes ?? {}).length;
  const wiped = after === 0 || (before >= 5 && after <= before * 0.2);
  if (!wiped) return plan;
  return { ...plan, apply: plan.apply.filter((op) => !TAKES_OFF.has(op.op)), confirm: [...plan.apply.filter((op) => TAKES_OFF.has(op.op)), ...plan.confirm] };
}

/* ---------- making the changes ---------- */

export interface Who {
  by: string;
  source: string;
  engine: string;
  /** Whether the person may make the diagram this kind (their role in its category). Everything when missing. */
  mayUseView?: (viewType: ViewType) => boolean;
}

interface Context {
  ws: Workspace;
  diagramId: string;
  who: Who;
  /** New objects by the ref the plan gave them. */
  refs: Map<string, string>;
  /** The whole plan, so a step made later can name an object an earlier step added by its ref. */
  plan: EditOp[];
  lines: string[];
  problems: string[];
  /** To put on the diagram once every change is made, so the layout places them together. */
  pending: string[];
  /** Added, shown or changed: to point them out. */
  touched: string[];
}

const nameOf = (ws: Workspace, id: string) => ws.objects[id]?.name ?? "an object";
const onDiagram = (c: Context, id: string) => id in (c.ws.diagrams[c.diagramId]?.nodes ?? {});

/** An object the plan names: its id in the model, the ref of one it adds, or its exact name. */
function resolve(c: Context, key: string | undefined): string | null {
  if (!key) return null;
  if (c.ws.objects[key]) return key;
  if (c.refs.has(key)) return c.refs.get(key)!;
  const adding = c.plan.find((op) => (op.op === "add_object" || op.op === "add_diagram_box") && op.ref === key);
  if (adding?.op === "add_object") return findByName(c.ws, adding.name)?.id ?? null;
  if (adding?.op === "add_diagram_box") {
    const target = diagramOf(c.ws, adding.diagram);
    return (target && Object.values(c.ws.objects).find((o) => o.typeId === "diagram" && o.diagramId === target)?.id) ?? null;
  }
  return findByName(c.ws, key)?.id ?? null;
}

/** A diagram by its id or its name. */
function diagramOf(ws: Workspace, key: string): string | null {
  const bare = key.replace(/^d:/, "");
  if (ws.diagrams[bare]) return bare;
  const wanted = normalizeName(key);
  return Object.values(ws.diagrams).find((d) => normalizeName(d.name) === wanted)?.id ?? null;
}

/** A connection by its id, or by its two ends (either way round), of the kind given when there are several. */
function connectionOf(c: Context, op: { id?: string; from?: string; to?: string; kind?: string }): string | null {
  if (op.id && c.ws.relationships[op.id]) return op.id;
  const from = resolve(c, op.from);
  const to = resolve(c, op.to);
  if (!from || !to) return null;
  const all = Object.values(c.ws.relationships);
  const forward = all.filter((r) => r.sourceId === from && r.targetId === to);
  const back = all.filter((r) => r.sourceId === to && r.targetId === from);
  const pick = (list: typeof all) => (op.kind ? list.find((r) => r.kind === op.kind) : undefined) ?? (op.kind ? undefined : list[0]);
  return pick(forward)?.id ?? pick(back)?.id ?? null;
}

/** Puts what waits for the diagram on it now, for a change that needs the boxes in place. */
function flush(c: Context) {
  const fresh = [...new Set(c.pending)].filter((id) => c.ws.objects[id] && !onDiagram(c, id));
  c.pending = [];
  if (fresh.length) c.ws = addObjectsToDiagram(c.ws, c.diagramId, fresh);
}

/** Makes a connection visible here: both ends on the diagram, not hidden, and its kind of arrow shown. */
function reveal(c: Context, id: string): boolean {
  const r = c.ws.relationships[id];
  const d = c.ws.diagrams[c.diagramId];
  if (!r || !d) return false;
  let changed = false;
  for (const end of [r.sourceId, r.targetId]) {
    if (!onDiagram(c, end)) (c.pending.push(end), (changed = true));
    c.touched.push(end);
  }
  if (d.hiddenRelationshipIds.includes(id)) (c.ws = setRelationshipHidden(c.ws, c.diagramId, id, false)), (changed = true);
  const kinds = c.ws.diagrams[c.diagramId].edgeKinds;
  if (kinds && !kinds.includes(r.kind)) {
    const next = RELATION_KINDS.filter((k) => k === r.kind || kinds.includes(k));
    c.ws = updateDiagram(c.ws, c.diagramId, { edgeKinds: next.length === RELATION_KINDS.length ? null : next });
    changed = true;
  }
  return changed;
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

const linksFrom = (given: { label?: string; url: string }[] | undefined) => (given ? cleanLinks(given.map((l) => ({ label: l.label ?? "", url: l.url }))) : undefined);

const protocolText = (protocols: { name: string; port?: string; transport?: string }[] | undefined) =>
  (protocols ?? []).map((p) => [p.name, p.port, p.transport ? `/${p.transport}` : ""].filter(Boolean).join(" ").replace(" /", "/")).join(", ");

type Transport = "TCP" | "UDP" | "TCP/UDP" | "IP" | "Other";
type ConnectionChange = { kind?: string; label?: string; network?: string; encrypted?: string; flow?: string; description?: string; links?: { label?: string; url: string }[]; protocols?: { name: string; port?: string; transport?: Transport }[] };

/** A protocol the library does not know is added to the workspace's own, so it can be picked again. */
function learnProtocol(c: Context, p: { name: string; port?: string; transport?: Transport }) {
  if (protocolByName(p.name) || Object.values(c.ws.library ?? {}).some((i) => i.type === "protocol" && normalizeName(i.protocol?.name ?? "") === normalizeName(p.name))) return;
  c.ws = saveProtocol(c.ws, { name: p.name, port: p.port ?? "", transport: p.transport ?? "TCP", group: "Your own", secure: false, use: "Added by the assistant." }).ws;
  c.lines.push(`Added the protocol ${p.name} to the library`);
}

function patchConnection(c: Context, id: string, op: ConnectionChange) {
  const patch: Record<string, unknown> = {};
  for (const key of ["kind", "label", "network", "encrypted", "flow", "description"] as const) if (op[key] !== undefined) patch[key] = op[key];
  const nextLinks = linksFrom(op.links);
  if (nextLinks) patch.links = nextLinks;
  if (Object.keys(patch).length) c.ws = updateRelationship(c.ws, id, patch);
  if (op.protocols) {
    for (const p of op.protocols) learnProtocol(c, p);
    c.ws = setProtocols(c.ws, id, op.protocols.map((p) => ({ name: p.name, port: p.port ?? "", ...(p.transport ? { transport: p.transport } : {}) })));
  }
}

/** A component of the library by name; one it does not have is added to the workspace's own. */
function componentFor(c: Context, wanted: string, typeId: string | undefined): { id: string; typeId: string; technology: string } | null {
  const known = exactComponent(wanted) ?? searchLibrary(wanted, { limit: 1 })[0];
  if (known) {
    const from = objectFromComponent(known);
    return { id: known.id, typeId: from.typeId, technology: from.technology };
  }
  const own = Object.values(c.ws.library ?? {}).find((i) => i.type === "component" && normalizeName(i.component?.name ?? "") === normalizeName(wanted));
  if (own?.component) return { id: own.id, typeId: own.component.kind, technology: "" };
  const kind = typeId && objectType(typeId).id === typeId ? typeId : "application";
  // Shelved beside components of the same kind, with their icon and the basic information they ask for.
  const like = LIBRARY.find((x) => !x.provider && x.kind === kind);
  const saved = saveComponent(c.ws, { name: wanted, sectionId: like?.sectionId ?? "applications", kind, icon: like?.icon ?? "AppWindow", profile: like?.profile ?? "application", aliases: "" });
  if (!saved.id) return null;
  c.ws = saved.ws;
  c.lines.push(`Added ${wanted} to the component library`);
  return { id: saved.id, typeId: kind, technology: "" };
}

function applyOne(c: Context, op: EditOp, provenance: Provenance) {
  switch (op.op) {
    case "add_object": {
      const existing = findByName(c.ws, op.name);
      if (existing) {
        if (op.ref) c.refs.set(op.ref, existing.id);
        c.pending.push(existing.id);
        c.touched.push(existing.id);
        c.lines.push(`${existing.name} was already in the model: shown here`);
        return;
      }
      const wantedType = op.type && objectType(op.type).id === op.type ? op.type : undefined;
      const component = op.component ? componentFor(c, op.component, wantedType) : null;
      const made = createObject(c.ws, {
        typeId: wantedType ?? component?.typeId ?? "application",
        name: op.name,
        technology: op.technology ?? component?.technology ?? "",
        owner: op.owner,
        lifecycle: op.lifecycle as (typeof LIFECYCLES)[number] | undefined,
        description: op.description,
        tags: op.tags,
        fields: cleanFields({}, op.fields),
        ...(component ? { componentId: component.id } : {}),
        provenance,
      });
      c.ws = made.ws;
      const nextLinks = linksFrom(op.links);
      if (nextLinks?.length) c.ws = updateObject(c.ws, made.object.id, { links: nextLinks });
      if (op.ref) c.refs.set(op.ref, made.object.id);
      c.pending.push(made.object.id);
      c.touched.push(made.object.id);
      c.lines.push(`Added ${made.object.name} (${objectType(made.object.typeId).label})`);
      return;
    }
    case "show_object": {
      const id = resolve(c, op.id);
      if (!id) return c.problems.push(`No object "${op.id}" to show`);
      c.pending.push(id);
      c.touched.push(id);
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
      if (op.component) {
        const component = componentFor(c, op.component, (patch.typeId as string | undefined) ?? o.typeId);
        if (component && component.id !== o.componentId) (patch.componentId = component.id), changed.push(`component ${op.component}`);
      }
      for (const key of ["technology", "owner", "lifecycle", "description"] as const) if (op[key] !== undefined && op[key] !== o[key]) (patch[key] = op[key]), changed.push(key);
      if (op.tags) (patch.tags = op.tags), changed.push("tags");
      const nextFields = cleanFields(o.fields, op.fields);
      if (nextFields) (patch.fields = nextFields), changed.push(...Object.keys(op.fields ?? {}));
      const nextLinks = linksFrom(op.links);
      if (nextLinks) (patch.links = nextLinks), changed.push("links");
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
      if (from === to) return c.problems.push(`${nameOf(c.ws, from)} cannot be connected to itself`);
      // The same two, the same way round, already connected: that connection is shown and changed, not copied.
      const existing = connectionOf(c, { from, to, kind: op.kind });
      const sameWay = existing && c.ws.relationships[existing].sourceId === from ? existing : null;
      let id = sameWay;
      if (!id) {
        const made = createRelationship(c.ws, { sourceId: from, targetId: to, kind: op.kind ?? "calls", label: op.label, description: op.description, provenance });
        if (!made.relationship) return c.problems.push(`${nameOf(c.ws, from)} and ${nameOf(c.ws, to)} could not be connected`);
        c.ws = made.ws;
        id = made.relationship.id;
      }
      patchConnection(c, id, op);
      reveal(c, id);
      const via = protocolText(op.protocols);
      const how = `${via ? ` over ${via}` : ""}${op.encrypted ? `, ${op.encrypted === "yes" ? "encrypted" : "not encrypted"}` : ""}`;
      c.lines.push(sameWay ? `${nameOf(c.ws, from)} → ${nameOf(c.ws, to)} was already connected: shown here${how ? ` and changed${how}` : ""}` : `Connected ${nameOf(c.ws, from)} → ${nameOf(c.ws, to)}${how}`);
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
    case "show_connection": {
      let id = connectionOf(c, op);
      if (!id) {
        // Not in the model yet: drawn, as a person would draw it.
        const from = resolve(c, op.from);
        const to = resolve(c, op.to);
        if (!from || !to || from === to) return c.problems.push("No such connection to show");
        const made = createRelationship(c.ws, { sourceId: from, targetId: to, kind: op.kind ?? "calls", provenance });
        if (!made.relationship) return c.problems.push("No such connection to show");
        c.ws = made.ws;
        id = made.relationship.id;
        reveal(c, id);
        return c.lines.push(`Connected ${nameOf(c.ws, from)} → ${nameOf(c.ws, to)} (it was not in the model)`);
      }
      const r = c.ws.relationships[id];
      const changed = reveal(c, id);
      c.lines.push(`${changed ? "Showed" : "Already showing"} the connection ${nameOf(c.ws, r.sourceId)} → ${nameOf(c.ws, r.targetId)}`);
      return;
    }
    case "hide_connection": {
      const id = connectionOf(c, op);
      if (!id) return c.problems.push("No such connection to hide");
      const r = c.ws.relationships[id];
      c.ws = setRelationshipHidden(c.ws, c.diagramId, id, true);
      c.lines.push(`Hid the connection ${nameOf(c.ws, r.sourceId)} → ${nameOf(c.ws, r.targetId)} on this diagram (it stays in the model)`);
      return;
    }
    case "hide_object": {
      const id = resolve(c, op.id);
      if (!id || !onDiagram(c, id)) return c.problems.push(`"${op.id}" is not on this diagram`);
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
    case "move_object": {
      const id = resolve(c, op.id);
      if (!id) return c.problems.push(`No object "${op.id}" to move`);
      flush(c);
      const nodes = c.ws.diagrams[c.diagramId]?.nodes ?? {};
      let at: { x: number; y: number } | null = null;
      if (op.near) {
        const near = resolve(c, op.near);
        const base = near ? nodes[near] : undefined;
        if (!base) return c.problems.push(`"${op.near}" is not on this diagram to move next to`);
        const gap = 80;
        const side = op.side ?? "right";
        at = side === "left" ? { x: base.x - NODE_W - gap, y: base.y } : side === "above" ? { x: base.x, y: base.y - NODE_H - gap } : side === "below" ? { x: base.x, y: base.y + NODE_H + gap } : { x: base.x + NODE_W + gap, y: base.y };
      } else if (op.x !== undefined || op.y !== undefined) {
        at = { x: op.x ?? nodes[id]?.x ?? 0, y: op.y ?? nodes[id]?.y ?? 0 };
      }
      if (!at) return c.problems.push(`Where to move ${nameOf(c.ws, id)} was not said`);
      c.ws = placeNodes(c.ws, c.diagramId, { [id]: { x: Math.round(at.x), y: Math.round(at.y), pinned: true } });
      c.touched.push(id);
      c.lines.push(`Moved ${nameOf(c.ws, id)}${op.near ? ` ${op.side ?? "right"} of ${nameOf(c.ws, resolve(c, op.near)!)}` : ""}`);
      return;
    }
    case "arrange": {
      flush(c);
      const nodes = c.ws.diagrams[c.diagramId]?.nodes ?? {};
      const ids = [...new Set(op.ids.map((k) => resolve(c, k)).filter((id): id is string => !!id && id in nodes))];
      if (ids.length < 2 || (!op.align && !op.distribute)) return c.problems.push("Nothing to line up: name two boxes on this diagram, and how");
      let positions = Object.fromEntries(ids.map((id) => [id, { x: nodes[id].x, y: nodes[id].y }]));
      // Both return only the boxes that move.
      if (op.align) positions = { ...positions, ...alignNodes(positions, ids, op.align) };
      if (op.distribute) positions = { ...positions, ...distributeNodes(positions, ids, op.distribute) };
      c.ws = placeNodes(c.ws, c.diagramId, Object.fromEntries(ids.map((id) => [id, { x: Math.round(positions[id].x), y: Math.round(positions[id].y), pinned: true }])));
      c.touched.push(...ids);
      c.lines.push(`${op.align ? `Lined up ${ids.length} boxes (${op.align})` : ""}${op.align && op.distribute ? " and spaced them" : op.distribute ? `Spaced ${ids.length} boxes evenly` : ""}`);
      return;
    }
    case "tidy":
      flush(c);
      c.ws = relayout(c.ws, c.diagramId, true);
      c.lines.push("Tidied the layout");
      return;
    case "rename_diagram":
      c.ws = updateDiagram(c.ws, c.diagramId, { name: op.name });
      c.lines.push(`Renamed the diagram to ${op.name}`);
      return;
    case "describe_diagram":
      c.ws = updateDiagram(c.ws, c.diagramId, { description: op.description });
      c.lines.push("Changed the diagram's description");
      return;
    case "set_diagram": {
      const d = c.ws.diagrams[c.diagramId];
      if (!d) return;
      const patch: Record<string, unknown> = {};
      const said: string[] = [];
      if (op.name && op.name !== d.name) (patch.name = op.name), said.push(`renamed to ${op.name}`);
      if (op.description !== undefined && op.description !== d.description) (patch.description = op.description), said.push("description");
      if (op.viewType && op.viewType !== d.viewType) {
        if (c.who.mayUseView && !c.who.mayUseView(op.viewType as ViewType)) c.problems.push(`You may not make diagrams of the kind "${op.viewType}"`);
        else (patch.viewType = op.viewType), said.push(`kind ${op.viewType}`);
      }
      if (op.scope !== undefined) {
        const scope = op.scope.trim() ? resolve(c, op.scope) : null;
        if (op.scope.trim() && !scope) c.problems.push(`No object "${op.scope}" to show the inside of`);
        else if (scope !== d.scopeId) (patch.scopeId = scope), said.push(scope ? `the inside of ${nameOf(c.ws, scope)}` : "no single object inside");
      }
      if (op.notation && op.notation !== (d.notation ?? "plain")) (patch.notation = op.notation), said.push(`notation ${op.notation}`);
      if (op.colorBy && op.colorBy !== d.colorBy) (patch.colorBy = op.colorBy), said.push(`colours by ${op.colorBy}`);
      if (op.arrows) {
        const next = op.arrows === "all" ? null : RELATION_KINDS.filter((k) => (op.arrows as string[]).includes(k));
        (patch.edgeKinds = next && next.length < RELATION_KINDS.length ? next : null), said.push(next && next.length < RELATION_KINDS.length ? `arrows shown: ${next.join(", ")}` : "every kind of arrow shown");
      }
      const turn = op.direction && op.direction !== d.direction;
      if (turn) (patch.direction = op.direction), said.push(op.direction === "LR" ? "left to right" : "top to bottom");
      if (!said.length) return;
      c.ws = updateDiagram(c.ws, c.diagramId, patch);
      if (turn) c.ws = relayout(c.ws, c.diagramId, true);
      c.lines.push(`Changed the diagram: ${said.join(", ")}`);
      return;
    }
    case "info_box": {
      const d = c.ws.diagrams[c.diagramId];
      if (!d) return;
      const box = { show: false, corner: "bottom-right" as const, ...d.titleBlock };
      const next = { ...box, ...(op.show !== undefined ? { show: op.show } : {}), ...(op.corner ? { corner: op.corner as typeof box.corner } : {}), ...(op.company !== undefined ? { company: op.company.trim() || undefined } : {}) };
      c.ws = updateDiagram(c.ws, c.diagramId, { titleBlock: next });
      c.lines.push(`${next.show ? "Showed" : "Hid"} the information box${next.show ? ` (${next.corner})` : ""}${op.company !== undefined ? `, company ${op.company || "none"}` : ""}`);
      return;
    }
    case "add_diagram_box": {
      const target = diagramOf(c.ws, op.diagram);
      if (!target || target === c.diagramId) return c.problems.push(`No other diagram "${op.diagram}" to add as a box`);
      const made = diagramBox(c.ws, target);
      if (!made.objectId) return c.problems.push(`No other diagram "${op.diagram}" to add as a box`);
      c.ws = made.ws;
      if (op.ref) c.refs.set(op.ref, made.objectId);
      c.pending.push(made.objectId);
      c.touched.push(made.objectId);
      c.lines.push(`Added the diagram ${c.ws.diagrams[target].name} as one box`);
      return;
    }
    case "add_flow": {
      flush(c);
      const d = c.ws.diagrams[c.diagramId];
      if (!d) return;
      let flow = flowsOf(d).find((f) => normalizeName(f.name) === normalizeName(op.name)) ?? null;
      const fresh = !flow;
      if (!flow) {
        const made = addFlow(c.ws, c.diagramId, op.name);
        if (!made.flow) return c.problems.push("This diagram has as many flows as it can hold");
        c.ws = made.ws;
        flow = made.flow;
      }
      if (op.description !== undefined) c.ws = updateFlow(c.ws, c.diagramId, flow.id, { description: op.description });
      let added = 0;
      for (const step of op.steps) {
        const from = resolve(c, step.from);
        const to = resolve(c, step.to);
        if (!from || !to || !onDiagram(c, from) || !onDiagram(c, to)) {
          c.problems.push(`A step of "${op.name}" names a box that is not on this diagram: ${!from || !onDiagram(c, from) ? step.from : step.to}`);
          continue;
        }
        const made = addStep(c.ws, c.diagramId, flow.id, from, to, step.text ?? "");
        if (made.step) (c.ws = made.ws), added++;
      }
      c.lines.push(`${fresh ? "Added the flow" : "Added to the flow"} "${flow.name}"${added ? ` with ${added} ${added === 1 ? "step" : "steps"}` : ""}`);
      return;
    }
    case "delete_flow": {
      const d = c.ws.diagrams[c.diagramId];
      const flow = d && flowsOf(d).find((f) => f.id === op.name || normalizeName(f.name) === normalizeName(op.name));
      if (!flow) return c.problems.push(`No flow "${op.name}" on this diagram`);
      c.ws = deleteFlow(c.ws, c.diagramId, flow.id);
      c.lines.push(`Deleted the flow "${flow.name}"`);
      return;
    }
    case "link_process": {
      const all = Object.values(c.ws.processes ?? {});
      const p = c.ws.processes?.[op.process] ?? all.find((x) => normalizeName(x.name) === normalizeName(op.process));
      if (!p) return c.problems.push(`No business process "${op.process}"`);
      c.ws = linkProcessDiagram(c.ws, p.id, c.diagramId, op.linked);
      c.lines.push(`${op.linked ? "Linked" : "Unlinked"} the business process "${p.name}"`);
      return;
    }
    case "add_component": {
      const before = c.lines.length;
      const type = op.type && objectType(op.type).id === op.type ? op.type : undefined;
      const got = componentFor(c, op.name, type);
      if (got && c.lines.length === before) c.lines.push(`${op.name} is already in the component library`);
      if (got && op.aliases && c.ws.library?.[got.id]?.component) {
        const item = c.ws.library[got.id];
        c.ws = saveComponent(c.ws, { ...item.component!, aliases: op.aliases }, got.id).ws;
      }
      return;
    }
    case "add_protocol": {
      const before = c.lines.length;
      learnProtocol(c, { name: op.name, port: op.port, transport: op.transport as Transport | undefined });
      if (c.lines.length === before) c.lines.push(`${op.name} is already among the protocols`);
      else if (op.secure !== undefined || op.use) {
        const item = Object.values(c.ws.library ?? {}).find((i) => i.type === "protocol" && normalizeName(i.protocol?.name ?? "") === normalizeName(op.name));
        if (item?.protocol) c.ws = saveProtocol(c.ws, { ...item.protocol, secure: op.secure ?? item.protocol.secure, use: op.use ?? item.protocol.use }, item.id).ws;
      }
      return;
    }
    case "duplicate_diagram": {
      const made = duplicateDiagram(c.ws, c.diagramId);
      if (!made.diagram) return;
      c.ws = op.name ? updateDiagram(made.ws, made.diagram.id, { name: op.name }) : made.ws;
      c.lines.push(`Made a copy of the diagram named "${c.ws.diagrams[made.diagram.id].name}"`);
      return;
    }
    case "archive_diagram": {
      const next = archiveDiagram(c.ws, c.diagramId, c.who.by, op.reason);
      if (next === c.ws) return c.problems.push("The diagram is archived already");
      c.ws = next;
      c.lines.push(`Archived the diagram: ${op.reason}`);
      return;
    }
    case "delete_diagram": {
      const was = c.ws.diagrams[c.diagramId]?.name;
      if (!was) return;
      c.ws = deleteDiagram(c.ws, c.diagramId);
      c.lines.push(`Deleted the diagram "${was}" (its objects stay in the model)`);
      return;
    }
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
export function applyOps(ws: Workspace, diagramId: string, ops: EditOp[], who: Who, plan: EditOp[] = ops): Applied {
  if (!ws.diagrams[diagramId]) return { ws, lines: [], problems: ["The diagram is no longer there"], touched: [] };
  const provenance: Provenance = { origin: "ai-prompt", source: who.source.slice(0, 500), engine: who.engine, approvedBy: who.by, approvedAt: nowIso() };
  const c: Context = { ws, diagramId, who, refs: new Map(), plan, lines: [], problems: [], pending: [], touched: [] };
  for (const op of ops) applyOne(c, op, provenance);
  // Parents are set once every new object exists, so a plan may name them in any order.
  for (const op of ops) {
    if ((op.op !== "add_object" && op.op !== "update_object") || op.parent === undefined) continue;
    const id = op.op === "add_object" ? (op.ref ? c.refs.get(op.ref) : findByName(c.ws, op.name)?.id) : resolve(c, op.id);
    if (!id || !c.ws.objects[id]) continue;
    if (!op.parent.trim()) {
      if (c.ws.objects[id].parentId) (c.ws = updateObject(c.ws, id, { parentId: null })), c.lines.push(`Took ${nameOf(c.ws, id)} out of what held it`);
      continue;
    }
    const parent = resolve(c, op.parent);
    if (parent && c.ws.objects[id].parentId !== parent) {
      c.ws = updateObject(c.ws, id, { parentId: parent });
      if (c.ws.objects[id].parentId === parent) c.lines.push(`Put ${nameOf(c.ws, id)} inside ${nameOf(c.ws, parent)}`);
      else c.problems.push(`${nameOf(c.ws, id)} cannot go inside ${nameOf(c.ws, parent)}`);
    }
  }
  flush(c);
  const touched = [...new Set(c.touched)].filter((id) => c.ws.diagrams[diagramId]?.nodes[id]);
  return { ws: c.ws, lines: c.lines.filter(Boolean), problems: c.problems, touched };
}

/** One change in words, before it is made: for the changes that wait for a yes and the suggestions. */
export function describeOp(ws: Workspace, op: EditOp, plan: EditOp[] = []): string {
  const refName = (key: string | undefined) => {
    if (!key) return "an object";
    if (ws.objects[key]) return ws.objects[key].name;
    const adding = plan.find((p) => p.op === "add_object" && p.ref === key);
    return adding && adding.op === "add_object" ? adding.name : (findByName(ws, key)?.name ?? key);
  };
  const ends = (o: { id?: string; from?: string; to?: string }) => {
    const r = o.id ? ws.relationships[o.id] : undefined;
    return r ? `${refName(r.sourceId)} → ${refName(r.targetId)}` : `${refName(o.from)} → ${refName(o.to)}`;
  };
  switch (op.op) {
    case "add_object":
      return `Add ${op.name}${op.type ? ` (${objectType(op.type).label})` : op.component ? ` (${op.component})` : ""}`;
    case "show_object":
      return `Show ${refName(op.id)}`;
    case "update_object": {
      const what = [op.name && `rename to ${op.name}`, op.owner !== undefined && `owner ${op.owner || "none"}`, op.technology !== undefined && `technology ${op.technology}`, op.lifecycle && `lifecycle ${op.lifecycle}`, op.component && `component ${op.component}`, ...Object.entries(op.fields ?? {}).map(([k, v]) => `${k} ${v || "removed"}`)].filter(Boolean);
      return `Change ${refName(op.id)}${what.length ? `: ${what.join(", ")}` : ""}`;
    }
    case "connect": {
      const via = protocolText(op.protocols);
      return `Connect ${refName(op.from)} → ${refName(op.to)}${via ? ` over ${via}` : ""}`;
    }
    case "update_connection": {
      const via = protocolText(op.protocols);
      return `Change the connection ${ends(op)}${via ? `: ${via}` : ""}${op.encrypted ? `, ${op.encrypted === "yes" ? "encrypted" : "not encrypted"}` : ""}`;
    }
    case "show_connection":
      return `Show the connection ${ends(op)}`;
    case "hide_connection":
      return `Hide the connection ${ends(op)} on this diagram`;
    case "hide_object":
      return `Take ${refName(op.id)} off this diagram`;
    case "delete_object":
      return `Delete ${refName(op.id)} from the whole model`;
    case "delete_connection":
      return `Delete the connection ${ends(op)}`;
    case "move_object":
      return `Move ${refName(op.id)}${op.near ? ` ${op.side ?? "right"} of ${refName(op.near)}` : ""}`;
    case "arrange":
      return `Line up ${op.ids.length} boxes`;
    case "tidy":
      return "Tidy the layout";
    case "rename_diagram":
      return `Rename the diagram to ${op.name}`;
    case "describe_diagram":
      return "Change the diagram's description";
    case "set_diagram":
      return `Change the diagram's settings${op.name ? `: rename to ${op.name}` : ""}`;
    case "info_box":
      return op.show === false ? "Hide the information box" : "Show the information box";
    case "add_diagram_box":
      return `Add the diagram ${ws.diagrams[op.diagram]?.name ?? op.diagram} as one box`;
    case "add_flow":
      return `Add the flow "${op.name}"${op.steps.length ? ` with ${op.steps.length} steps` : ""}`;
    case "delete_flow":
      return `Delete the flow "${op.name}"`;
    case "link_process":
      return `${op.linked ? "Link" : "Unlink"} the business process "${ws.processes?.[op.process]?.name ?? op.process}"`;
    case "add_component":
      return `Add ${op.name} to the component library`;
    case "add_protocol":
      return `Add the protocol ${op.name}${op.port ? ` ${op.port}` : ""} to the library`;
    case "duplicate_diagram":
      return `Make a copy of the diagram${op.name ? ` named "${op.name}"` : ""}`;
    case "archive_diagram":
      return `Archive the diagram: ${op.reason}`;
    case "delete_diagram":
      return "Delete this whole diagram (its objects stay in the model)";
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
