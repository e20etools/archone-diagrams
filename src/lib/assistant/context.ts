import { APPROVAL_ROLES, EVENT_LABEL, ROLE_LABEL, STATUS_LABEL, type ApprovalQueue, type DiagramRecord, type RoleStanding } from "../approvals";
import { LIFECYCLE_INFO, RELATION_KIND_INFO, VIEW_TYPE_INFO, objectType } from "../catalog";
import { PACKS, RULES, runChecks, type Finding, type PackId } from "../checks/checks";
import type { Comment, Person, Review } from "../cloud/collab";
import { activitiesInOrder } from "../bpm/bpmn";
import { graphOf, linksOf } from "../bpm/processes";
import { flowsOf, stepLine } from "../flows";
import { componentById, componentLabel } from "../library";
import { mentionedObjects } from "../ask/ask";
import { normalizeName, protocolsOf } from "../model";
import type { Diagram, ModelObject, Relationship, Workspace } from "../types";

/**
 * What the assistant knows: everything the workspace holds that the person can see, written out
 * as text for the AI model. The diagrams and objects the conversation is about (the one open on
 * screen, and those it names) come first and in full: who made the diagram and when, its approval
 * by Enterprise Architecture and Cybersecurity with their notes, every object on it with its basic
 * information (IP address, operating system, classification...), every connection with its
 * protocols, ports, network and encryption, its flows, what the checks find on it and its comments.
 * Then the whole workspace follows, cut to fit when it is too large, and the text says where.
 *
 * Objects are written [[id]] and diagrams [[d:id]], the tags the assistant answers with.
 */

export interface AssistantFacts {
  ws: Workspace;
  /** The person asking, and their role in the workspace. */
  me?: { name: string; role?: string | null };
  /** What is open on screen. */
  page?: { diagramId?: string | null; objectId?: string | null };
  /** What the database says about diagrams: who made and changed them, their approval and its history. */
  records?: Record<string, DiagramRecord | undefined>;
  queue?: ApprovalQueue | null;
  comments?: Comment[];
  people?: Person[];
  reviews?: Review[];
  /** The day it was read, YYYY-MM-DD. */
  today?: string;
  /** The file library as this person sees it: names, kinds and the diagrams each is linked to. */
  files?: { id: string; name: string; kind: string; description: string; diagramIds: string[] }[];
}

export interface AssistantContext {
  text: string;
  /** False when something had to be left out to fit. */
  complete: boolean;
  focus: { diagramIds: string[]; objectIds: string[] };
}

export const objectTag = (id: string) => `[[${id}]]`;
export const diagramTag = (id: string) => `[[d:${id}]]`;

const oneLine = (value: string | undefined | null, limit: number) => {
  const flat = (value ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};
const quoted = (value: string, limit = 600) => `"${oneLine(value, limit).replace(/"/g, "'")}"`;
/** A moment as YYYY-MM-DD HH:MM (UTC), or the day alone when that is all there is. */
const when = (iso: string | null | undefined) => {
  if (!iso) return "";
  const t = iso.replace("T", " ");
  return /\d{2}:\d{2}/.test(t) ? t.slice(0, 16) : t.slice(0, 10);
};
const parts = (...items: (string | false | null | undefined)[]) => items.filter((x): x is string => !!x && !!x.trim()).join(" | ");

/* ---------- what the conversation is about ---------- */

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const named = (text: string, name: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(normalizeName(name))}(?![\\p{L}\\p{N}])`, "u").test(text);

/**
 * The diagrams and objects to give in full: the ones open on screen, then the ones the person's
 * messages name, latest message first.
 */
export function focusOf(ws: Workspace, texts: string[], page?: AssistantFacts["page"]): { diagramIds: string[]; objectIds: string[] } {
  const diagramIds: string[] = [];
  const objectIds: string[] = [];
  const addDiagram = (id: string | null | undefined) => id && ws.diagrams[id] && !diagramIds.includes(id) && diagramIds.length < 4 && diagramIds.push(id);
  const addObject = (id: string | null | undefined) => id && ws.objects[id] && !objectIds.includes(id) && objectIds.length < 8 && objectIds.push(id);
  addDiagram(page?.diagramId);
  addObject(page?.objectId);
  const diagrams = Object.values(ws.diagrams)
    .filter((d) => normalizeName(d.name).length >= 3)
    .sort((a, b) => b.name.length - a.name.length);
  for (const text of [...texts].reverse()) {
    const plain = ` ${normalizeName(text)} `;
    for (const d of diagrams) if (named(plain, d.name)) addDiagram(d.id);
    for (const m of mentionedObjects(ws, text).mentions) addObject(m.object.id);
  }
  return { diagramIds, objectIds };
}

/* ---------- lines ---------- */

function objectLine(ws: Workspace, o: ModelObject, describe: number): string {
  const type = objectType(o.typeId).label;
  const component = componentById(o.componentId);
  const made = component ? componentLabel(component) : "";
  const fields = Object.entries(o.fields)
    .filter(([key, value]) => key.trim() && value.trim())
    .map(([key, value]) => `${oneLine(key, 60)}=${oneLine(value, 160)}`)
    .join("; ");
  return parts(
    `${objectTag(o.id)} ${oneLine(o.name, 120)}`,
    `type: ${type}`,
    made && made !== type && made !== o.name && `component: ${made}`,
    o.owner.trim() && `owner: ${oneLine(o.owner, 80)}`,
    `lifecycle: ${LIFECYCLE_INFO[o.lifecycle].label.toLowerCase()}`,
    o.technology.trim() && `technology: ${oneLine(o.technology, 80)}`,
    o.tags.length > 0 && `tags: ${o.tags.join(", ")}`,
    o.parentId && ws.objects[o.parentId] && `inside: ${objectTag(o.parentId)}`,
    o.diagramId && ws.diagrams[o.diagramId] && `stands for: ${diagramTag(o.diagramId)}`,
    fields && `details: ${fields}`,
    (o.links?.length ?? 0) > 0 && `links: ${o.links!.map((l) => oneLine(l.label, 40)).join(", ")}`,
    describe > 0 && o.description.trim() && `description: ${oneLine(o.description, describe)}`,
  );
}

const TRAFFIC = { out: "", in: "traffic flows from target to source", both: "traffic both ways" } as const;

function relationshipLine(r: Relationship, describe: number, people: Map<string, string>): string {
  const protocols = protocolsOf(r)
    .map((p) => [p.name, p.port, "transport" in p && p.transport ? `/${p.transport}` : ""].filter(Boolean).join(" ").replace(" /", "/"))
    .join(", ");
  return parts(
    `${objectTag(r.sourceId)} -> ${objectTag(r.targetId)}`,
    RELATION_KIND_INFO[r.kind].verb,
    `connection id ${r.id}`,
    r.label.trim() && `label: ${oneLine(r.label, 80)}`,
    protocols && `protocols: ${protocols}`,
    r.network?.trim() && `network: ${oneLine(r.network, 60)}`,
    r.encrypted && `encrypted: ${r.encrypted}`,
    r.flow && TRAFFIC[r.flow],
    r.acknowledgement && `confirmed by the target's owner ${people.get(r.acknowledgement.by) ?? r.acknowledgement.by} on ${when(r.acknowledgement.at)}`,
    describe > 0 && r.description.trim() && `description: ${oneLine(r.description, describe)}`,
  );
}

function roleLine(role: string, s: RoleStanding): string {
  const said = s.note.trim() ? `; note: ${quoted(s.note)}` : "";
  switch (s.state) {
    case "approved":
      return `${role}: ${s.withChanges ? "changed and approved" : "approved"} by ${s.by || "an approver"} on ${when(s.at)}${said}`;
    case "stale":
      return `${role}: approved an earlier form (by ${s.by || "an approver"} on ${when(s.at)}); the diagram changed since, so it needs approving again${said}`;
    case "returned":
      return `${role}: returned it for changes (${s.by || "an approver"}, ${when(s.at)})${said}`;
    case "rejected":
      return `${role}: rejected it (${s.by || "an approver"}, ${when(s.at)})${said}`;
    default:
      return `${role}: not decided yet`;
  }
}

function stampOf(d: Diagram, record: DiagramRecord | undefined): string {
  if (!record) return `created ${when(d.createdAt)}; last changed ${when(d.updatedAt)}`;
  return `made by ${record.created.by || "someone not recorded"} on ${when(record.created.at)}; last changed by ${record.changed.by || "someone not recorded"} on ${when(record.changed.at)}`;
}

function standingOf(d: Diagram, record: DiagramRecord | undefined, queue: ApprovalQueue | null | undefined): string {
  if (record) {
    const approved = record.approvedVersion ? `; last approved version ${record.approvedVersion} on ${when(record.approvedAt)}` : "";
    return `approval: ${STATUS_LABEL[record.status].toLowerCase()}, version ${record.version}${approved}`;
  }
  const open = queue?.open.find((q) => q.diagramId === d.id);
  if (open) return `approval: ${open.status === "pending" ? "waiting for approval" : "returned for changes"}, version ${open.version}`;
  const last = queue?.recent.find((q) => q.diagramId === d.id);
  if (last) return `approval: last request ${last.status} on ${when(last.closedAt)}, version ${last.version}`;
  return "";
}

const findingLine = (f: Finding, title: string, pack: string) =>
  parts(`[${f.severity}] ${pack} · ${title}`, oneLine(f.message, 300), f.objectIds.length > 0 && `objects: ${f.objectIds.slice(0, 12).map(objectTag).join(", ")}${f.objectIds.length > 12 ? ` and ${f.objectIds.length - 12} more` : ""}`);

const ALL_PACKS = PACKS.map((p) => p.id) as PackId[];
const PACK_NAME = new Map<string, string>(PACKS.map((p) => [p.id, p.name]));

function findingLines(ws: Workspace, findings: Finding[]): string[] {
  return findings.map((f) => {
    const builtIn = RULES.find((r) => r.id === f.ruleId);
    const own = ws.rules?.[f.ruleId];
    const pack = builtIn ? builtIn.packs.map((p) => PACK_NAME.get(p) ?? p).join(", ") : "Workspace rule";
    return findingLine(f, builtIn?.title ?? own?.title ?? f.ruleId, pack);
  });
}

function commentLines(ws: Workspace, comments: Comment[], people: Map<string, string>, where: (c: Comment) => boolean): string[] {
  const threads = comments.filter((c) => !c.parentId && where(c)).sort((a, b) => Number(a.resolved) - Number(b.resolved) || b.createdAt.localeCompare(a.createdAt));
  const lines: string[] = [];
  for (const c of threads) {
    const target =
      c.targetKind === "diagram"
        ? diagramTag(c.targetId)
        : c.targetKind === "object"
          ? objectTag(c.targetId)
          : (() => {
              const r = ws.relationships[c.targetId];
              return r ? `the connection ${objectTag(r.sourceId)} -> ${objectTag(r.targetId)}` : "a connection";
            })();
    const on = c.diagramId && c.targetKind !== "diagram" ? ` in ${diagramTag(c.diagramId)}` : "";
    lines.push(`- ${people.get(c.authorId ?? "") ?? "a former member"}, ${when(c.createdAt)}, on ${target}${on} (${c.resolved ? "resolved" : "open"}; comment id ${c.id}): ${quoted(c.body)}`);
    for (const reply of comments.filter((x) => x.parentId === c.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      lines.push(`  - reply by ${people.get(reply.authorId ?? "") ?? "a former member"}, ${when(reply.createdAt)} (comment id ${reply.id}): ${quoted(reply.body)}`);
    }
  }
  return lines;
}

/* ---------- the sections ---------- */

interface Section {
  title: string;
  lines: string[];
  /** Its share of the room when everything does not fit. */
  weight: number;
}

function diagramDetail(facts: AssistantFacts, d: Diagram, people: Map<string, string>): string[] {
  const { ws } = facts;
  const record = facts.records?.[d.id];
  const shown = Object.keys(d.nodes).filter((id) => ws.objects[id]);
  const shownSet = new Set(shown);
  const hidden = new Set(d.hiddenRelationshipIds);
  const connections = Object.values(ws.relationships).filter((r) => shownSet.has(r.sourceId) && shownSet.has(r.targetId) && !hidden.has(r.id) && (!d.edgeKinds || d.edgeKinds.includes(r.kind)));
  const drawn = new Set(connections.map((r) => r.id));
  // In the model but not drawn here: hidden on this diagram, its kind of arrow switched off, or an end not on it.
  const notDrawn = Object.values(ws.relationships)
    .filter((r) => !drawn.has(r.id) && ws.objects[r.sourceId] && ws.objects[r.targetId] && (shownSet.has(r.sourceId) || shownSet.has(r.targetId)))
    .map((r) => ({
      r,
      why: hidden.has(r.id)
        ? "hidden on this diagram"
        : d.edgeKinds && !d.edgeKinds.includes(r.kind)
          ? "this kind of arrow is switched off here"
          : `${objectTag(shownSet.has(r.sourceId) ? r.targetId : r.sourceId)} is not on this diagram`,
    }))
    .slice(0, 120);
  const lines = [
    `DIAGRAM ${diagramTag(d.id)} ${oneLine(d.name, 160)}`,
    `- Kind: ${VIEW_TYPE_INFO[d.viewType].label}${d.notation && d.notation !== "plain" ? `; notation: ${d.notation === "archimate" ? "ArchiMate" : "BPMN"}` : ""}${d.scopeId && ws.objects[d.scopeId] ? `; shows the inside of ${objectTag(d.scopeId)}` : ""}${d.archive?.archived ? "; archived" : ""}`,
    d.description.trim() ? `- Description: ${oneLine(d.description, 1200)}` : "",
    `- ${stampOf(d, record).replace(/^./, (c) => c.toUpperCase())}`,
  ];
  if (record) {
    lines.push(`- Approval: ${STATUS_LABEL[record.status]}; version ${record.version}${record.approvedVersion ? ` (last approved version ${record.approvedVersion}, ${when(record.approvedAt)})` : ""}. Approval by Enterprise Architecture and Cybersecurity is ${record.required ? "compulsory" : "not compulsory"} before publishing in this workspace.`);
    if (record.request) lines.push(`  - Request: version ${record.request.version}, sent by ${record.request.requestedBy || "someone"} on ${when(record.request.requestedAt)}, round ${record.request.round}${record.request.note.trim() ? `, with the note ${quoted(record.request.note)}` : ""}`);
    for (const role of APPROVAL_ROLES) lines.push(`  - ${roleLine(ROLE_LABEL[role], record.roles[role])}`);
    lines.push(`  - Approvers: ${APPROVAL_ROLES.map((role) => `${ROLE_LABEL[role]}: ${record.approvers[role].map((a) => a.name).join(", ") || "nobody named"}`).join("; ")}`);
    if (record.history.length) {
      lines.push("  - History, newest first:");
      for (const e of record.history.slice(0, 30)) {
        lines.push(`    - ${when(e.at)} ${EVENT_LABEL[e.kind]}${e.role ? ` (${ROLE_LABEL[e.role]})` : ""} by ${e.by || "someone"}, version ${e.version}, round ${e.round}${e.note.trim() ? `: ${quoted(e.note)}` : ""}`);
      }
    }
  } else {
    const standing = standingOf(d, record, facts.queue);
    if (standing) lines.push(`- ${standing.replace(/^./, (c) => c.toUpperCase())}`);
  }
  const box = d.titleBlock;
  if (box) lines.push(`- Information box: ${box.show ? `shown, ${box.corner}` : "hidden"}${box.company ? `; company ${quoted(box.company, 120)}` : ""}${box.hidden?.length ? `; fields left out: ${box.hidden.join(", ")}` : ""}`);
  lines.push(`- Drawn ${d.direction === "LR" ? "left to right" : "top to bottom"}; boxes coloured by ${d.colorBy}; arrows shown: ${d.edgeKinds ? d.edgeKinds.join(", ") || "none" : "every kind"}`);
  lines.push(`- Objects on it (${shown.length}), with where each box sits (x, y):`);
  for (const id of shown) lines.push(`  ${objectLine(ws, ws.objects[id], 600)} | at ${Math.round(d.nodes[id].x)}, ${Math.round(d.nodes[id].y)}`);
  lines.push(`- Connections drawn on it (${connections.length}):`);
  for (const r of connections) lines.push(`  ${relationshipLine(r, 300, people)}`);
  if (notDrawn.length) {
    lines.push(`- Connections in the model that are not drawn on it (${notDrawn.length}):`);
    for (const { r, why } of notDrawn) lines.push(`  ${relationshipLine(r, 0, people)} | not drawn: ${why}`);
  }
  for (const flow of flowsOf(d)) {
    lines.push(`- Flow ${quoted(flow.name, 120)}${flow.description.trim() ? `: ${oneLine(flow.description, 300)}` : ""}`);
    flow.steps.forEach((step, i) => lines.push(`  ${stepLine(ws, step, i)}`));
  }
  const findings = runChecks(ws, d, ALL_PACKS);
  lines.push(findings.length ? `- What the checks find on this diagram (${findings.length}):` : "- The checks find nothing on this diagram.");
  for (const line of findingLines(ws, findings).slice(0, 80)) lines.push(`  ${line}`);
  const comments = commentLines(ws, facts.comments ?? [], people, (c) => c.diagramId === d.id || (c.targetKind === "diagram" && c.targetId === d.id));
  if (comments.length) lines.push("- Comments:", ...comments.map((c) => `  ${c}`));
  const decisions = Object.values(ws.adrs ?? {}).filter((a) => a.objectIds.some((id) => shownSet.has(id)));
  if (decisions.length) lines.push(`- Decisions about what it shows: ${decisions.map((a) => `ADR-${a.number} ${quoted(a.title, 120)} (${a.status})`).join("; ")}`);
  const processes = Object.values(ws.processes ?? {}).filter((p) => linksOf(p).includes(d.id));
  lines.push(processes.length ? `- Business processes (BPMN) linked to it: ${processes.map((p) => `${quoted(p.name, 120)} (${p.status})`).join("; ")}` : "- No business process is linked to it.");
  if (facts.files) {
    const linked = facts.files.filter((f) => f.diagramIds.includes(d.id));
    lines.push(linked.length ? `- Files linked to it: ${linked.map((f) => `${quoted(f.name, 120)} (${f.kind})`).join("; ")}` : "- No file from the file library is linked to it.");
  }
  return lines.filter(Boolean);
}

/** The steps of a process in order, with their lanes, briefly. */
function stepsOf(p: NonNullable<Workspace["processes"]>[string]): string {
  const graph = graphOf(p);
  if (!graph) return "";
  const steps = activitiesInOrder(graph);
  const lane = (id: string) => graph.lanes.find((l) => l.id === graph.nodes[id]?.laneId)?.name ?? "";
  const shown = steps.slice(0, 30).map((n) => `${oneLine(n.name || n.type, 60)}${lane(n.id) ? ` (${oneLine(lane(n.id), 40)})` : ""}`);
  return `${steps.length} steps: ${shown.join(" > ")}${steps.length > 30 ? ` and ${steps.length - 30} more` : ""}`;
}

function objectDetail(facts: AssistantFacts, o: ModelObject, people: Map<string, string>, everywhere: Finding[]): string[] {
  const { ws } = facts;
  const all = Object.values(ws.relationships);
  const out = all.filter((r) => r.sourceId === o.id && ws.objects[r.targetId]);
  const into = all.filter((r) => r.targetId === o.id && ws.objects[r.sourceId]);
  const inside = Object.values(ws.objects).filter((x) => x.parentId === o.id);
  const diagrams = Object.values(ws.diagrams).filter((d) => o.id in d.nodes || d.scopeId === o.id);
  const findings = everywhere.filter((f) => f.objectIds.includes(o.id));
  const lines = [
    `OBJECT ${objectLine(ws, o, 1500)}`,
    inside.length ? `- Inside it: ${inside.map((x) => objectTag(x.id)).join(", ")}` : "",
    `- On diagrams: ${diagrams.map((d) => diagramTag(d.id)).join(", ") || "none"}`,
    `- Connections out (${out.length}):`,
    ...out.map((r) => `  ${relationshipLine(r, 300, people)}`),
    `- Connections in (${into.length}):`,
    ...into.map((r) => `  ${relationshipLine(r, 300, people)}`),
    findings.length ? `- What the checks find on it (${findings.length}):` : "- The checks find nothing on it.",
    ...findingLines(ws, findings).map((line) => `  ${line}`),
  ];
  const comments = commentLines(ws, facts.comments ?? [], people, (c) => c.targetKind === "object" && c.targetId === o.id);
  if (comments.length) lines.push("- Comments:", ...comments.map((c) => `  ${c}`));
  const decisions = Object.values(ws.adrs ?? {}).filter((a) => a.objectIds.includes(o.id));
  if (decisions.length) lines.push(`- Decisions about it: ${decisions.map((a) => `ADR-${a.number} ${quoted(a.title, 120)} (${a.status})`).join("; ")}`);
  return lines.filter(Boolean);
}

function sections(facts: AssistantFacts, focus: AssistantContext["focus"]): { header: string[]; rest: Section[] } {
  const { ws } = facts;
  const people = new Map<string, string>((facts.people ?? []).map((p) => [p.userId, p.name || p.email.split("@")[0]]));
  const objects = Object.values(ws.objects).sort((a, b) => a.name.localeCompare(b.name));
  const relationships = Object.values(ws.relationships).filter((r) => ws.objects[r.sourceId] && ws.objects[r.targetId]);
  const diagrams = Object.values(ws.diagrams).sort((a, b) => a.name.localeCompare(b.name));
  const adrs = Object.values(ws.adrs ?? {}).sort((a, b) => b.number - a.number);
  const processes = Object.values(ws.processes ?? {}).sort((a, b) => a.name.localeCompare(b.name));

  const header = [
    `Workspace: ${oneLine(ws.name, 120) || "Untitled"}`,
    `Read on ${facts.today ?? new Date().toISOString().slice(0, 10)}. Times are in UTC.`,
    facts.me?.name.trim() ? `Asked by: ${oneLine(facts.me.name, 80)}${facts.me.role ? `, ${facts.me.role} of this workspace` : ""}.` : "",
    `It holds ${objects.length} objects, ${relationships.length} connections, ${diagrams.length} diagrams, ${adrs.length} decisions and ${processes.length} business processes.`,
    focus.diagramIds.length || focus.objectIds.length ? "The conversation is about what FOCUS describes in full; the rest of the workspace follows it." : "",
  ].filter(Boolean);

  const findings = runChecks(ws, null, ALL_PACKS);
  const focusLines: string[] = [];
  for (const id of focus.diagramIds) focusLines.push(...diagramDetail(facts, ws.diagrams[id], people), "");
  for (const id of focus.objectIds) focusLines.push(...objectDetail(facts, ws.objects[id], people, findings), "");

  const diagramLines = diagrams.map((d) =>
    parts(
      `${diagramTag(d.id)} ${oneLine(d.name, 120)}`,
      VIEW_TYPE_INFO[d.viewType].label,
      `${Object.keys(d.nodes).filter((id) => ws.objects[id]).length} objects`,
      stampOf(d, facts.records?.[d.id]),
      standingOf(d, facts.records?.[d.id], facts.queue),
      (d.flows?.length ?? 0) > 0 && `${d.flows!.length} flows`,
      processes.some((p) => linksOf(p).includes(d.id)) && `processes: ${processes.filter((p) => linksOf(p).includes(d.id)).map((p) => oneLine(p.name, 60)).join(", ")}`,
      d.archive?.archived && "archived",
      d.description.trim() && `description: ${oneLine(d.description, 160)}`,
    ),
  );
  const onDiagram = diagrams.map((d) => `${diagramTag(d.id)} shows ${Object.keys(d.nodes).filter((id) => ws.objects[id]).map(objectTag).join(", ") || "nothing yet"}`);

  const tally = PACKS.map((p) => {
    const mine = findings.filter((f) => RULES.find((r) => r.id === f.ruleId)?.packs.includes(p.id));
    return `${p.name}: ${mine.length} findings (${mine.filter((f) => f.severity === "high").length} high)`;
  });
  const findingSection = [
    "The rule packs: " + PACKS.map((p) => `${p.name} (${oneLine(p.about, 220)})`).join(" "),
    `Totals: ${tally.join("; ")}; workspace rules: ${findings.filter((f) => !RULES.some((r) => r.id === f.ruleId)).length} findings.`,
    ...findingLines(ws, findings),
  ];

  const approvalLines: string[] = [];
  if (facts.queue) {
    const q = facts.queue;
    approvalLines.push(`Open requests (${q.open.length}):`);
    for (const item of q.open) {
      approvalLines.push(
        `- ${diagramTag(item.diagramId)} version ${item.version}, ${item.status === "pending" ? "waiting" : "returned to the sender"}, sent by ${item.requestedBy || "someone"} on ${when(item.requestedAt)}, round ${item.round}${item.note.trim() ? `, note ${quoted(item.note)}` : ""} | ${roleLine("Enterprise Architecture", item.ea)} | ${roleLine("Cybersecurity", item.security)}`,
      );
    }
    approvalLines.push(`Decided lately (${q.recent.length}):`);
    for (const item of q.recent) approvalLines.push(`- ${diagramTag(item.diagramId)} version ${item.version} ${item.status} on ${when(item.closedAt)}, sent by ${item.requestedBy || "someone"}`);
    approvalLines.push(`The person asking approves for: ${APPROVAL_ROLES.filter((r) => q.mine[r]).map((r) => ROLE_LABEL[r]).join(" and ") || "neither role"}.`);
  }
  const notesLines: string[] = [];
  for (const [id, record] of Object.entries(facts.records ?? {})) {
    if (!record || focus.diagramIds.includes(id) || !ws.diagrams[id]) continue;
    for (const e of record.history.filter((h) => h.note.trim()).slice(0, 8)) {
      notesLines.push(`- ${diagramTag(id)} ${when(e.at)} ${EVENT_LABEL[e.kind]}${e.role ? ` (${ROLE_LABEL[e.role]})` : ""} by ${e.by || "someone"}, version ${e.version}: ${quoted(e.note, 400)}`);
    }
  }

  const reviewLines = (facts.reviews ?? []).slice(0, 30).map((r) =>
    parts(
      quoted(r.title, 120),
      r.status,
      `submitted by ${people.get(r.submittedBy ?? "") ?? "someone"} on ${when(r.submittedAt)}`,
      r.note.trim() && `note: ${quoted(r.note, 300)}`,
      r.decisions.length > 0 && `decisions: ${r.decisions.map((d) => `${d.stageName}: ${d.decision} by ${people.get(d.by) ?? "a former member"}${d.reason.trim() ? ` (${oneLine(d.reason, 200)})` : ""}`).join("; ")}`,
    ),
  );

  const rest: Section[] = [
    { title: "FOCUS", lines: focusLines, weight: 8 },
    { title: "DIAGRAMS: tag name | kind | objects | made and changed | approval", lines: diagramLines, weight: 3 },
    { title: "OBJECTS: tag name | type | component | owner | lifecycle | technology | tags | inside | details | description", lines: objects.map((o) => objectLine(ws, o, 240)), weight: 5 },
    { title: "CONNECTIONS: source -> target | kind | label | protocols and ports | network | encrypted | direction", lines: relationships.map((r) => relationshipLine(r, 120, people)), weight: 4 },
    { title: "WHAT EACH DIAGRAM SHOWS", lines: onDiagram, weight: 1.5 },
    { title: `CHECK FINDINGS on the whole model (${findings.length})`, lines: findingSection, weight: 2.5 },
    { title: "APPROVAL OF DIAGRAMS by Enterprise Architecture and Cybersecurity", lines: approvalLines, weight: 2 },
    { title: "NOTES FROM APPROVERS on other diagrams", lines: notesLines, weight: 1.5 },
    { title: "COMMENTS", lines: commentLines(ws, facts.comments ?? [], people, (c) => !focus.diagramIds.includes(c.diagramId ?? "")), weight: 1.5 },
    {
      title: "DECISIONS (architecture decision records)",
      lines: adrs.map((a) => parts(`ADR-${a.number} ${quoted(a.title, 160)}`, a.status, a.author && `by ${a.author}`, a.decidedAt && `decided ${when(a.decidedAt)}`, a.objectIds.length > 0 && `about ${a.objectIds.filter((id) => ws.objects[id]).map(objectTag).join(", ")}`, a.decision.trim() && `decision: ${oneLine(a.decision, 400)}`, a.consequences.trim() && `consequences: ${oneLine(a.consequences, 240)}`)),
      weight: 1,
    },
    {
      title: "THE WORKSPACE'S OWN RULES",
      lines: Object.values(ws.rules ?? {}).map((r) => parts(quoted(r.title, 120), `${r.severity} severity`, r.enabled ? "switched on" : "switched off", r.text.trim() && `written as ${quoted(r.text, 300)}`)),
      weight: 0.5,
    },
    {
      title: "BUSINESS PROCESSES",
      lines: processes.map((p) =>
        parts(
          oneLine(p.name, 120),
          `${p.category} process, level ${p.level}`,
          p.owner.trim() && `owner: ${oneLine(p.owner, 80)}`,
          `${p.status}${p.version ? `, version ${p.version}` : ""}`,
          p.objectId && ws.objects[p.objectId] && `stands as ${objectTag(p.objectId)}`,
          p.risks.length > 0 && `risks: ${p.risks.map((r) => `${oneLine(r.name, 80)} (${r.severity}${r.control.trim() ? `, control: ${oneLine(r.control, 120)}` : ""})`).join("; ")}`,
          p.kpis.length > 0 && `KPIs: ${p.kpis.map((k) => `${oneLine(k.name, 60)} target ${k.target || "-"}${k.unit ? ` ${k.unit}` : ""}, actual ${k.actual || "-"}`).join("; ")}`,
          linksOf(p).some((id) => ws.diagrams[id]) && `linked to diagrams: ${linksOf(p).filter((id) => ws.diagrams[id]).map(diagramTag).join(", ")}`,
          stepsOf(p),
          p.description.trim() && `description: ${oneLine(p.description, 240)}`,
        ),
      ),
      weight: 1,
    },
    { title: "MODEL REVIEWS before publishing", lines: reviewLines, weight: 0.5 },
    { title: "PEOPLE in the workspace", lines: facts.people?.length ? [facts.people.map((p) => p.name || p.email.split("@")[0]).join(", ")] : [], weight: 0.3 },
    {
      title: "FILES in the file library",
      lines: (facts.files ?? []).map((f) =>
        parts(quoted(f.name, 160), f.kind, f.diagramIds.some((id) => ws.diagrams[id]) ? `linked to ${f.diagramIds.filter((id) => ws.diagrams[id]).map(diagramTag).join(", ")}` : "linked to no diagram", f.description.trim() && oneLine(f.description, 160)),
      ),
      weight: 0.4,
    },
  ];
  return { header, rest: rest.filter((s) => s.lines.length > 0) };
}

/* ---------- fitting it in ---------- */

const render = (s: Section, lines: string[]) => `== ${s.title} ==\n${lines.join("\n")}`;

/** As many of a section's lines as fit in a room, saying how many were left out. */
function cut(s: Section, room: number): { text: string; complete: boolean } {
  const whole = render(s, s.lines);
  if (whole.length <= room) return { text: whole, complete: true };
  const kept: string[] = [];
  let size = s.title.length + 8;
  for (const line of s.lines) {
    if (size + line.length + 1 > room - 70) break;
    kept.push(line);
    size += line.length + 1;
  }
  const left = s.lines.length - kept.length;
  return { text: render(s, [...kept, `(${left} more ${left === 1 ? "line" : "lines"} of this section not listed, to fit)`]), complete: false };
}

/**
 * Everything the assistant may know, within a number of characters. When it does not all fit,
 * each section gets a share of the room by its weight, and what a section does not use goes to
 * the others.
 */
export function assistantContext(facts: AssistantFacts, texts: string[], budget = 150_000): AssistantContext {
  const focus = focusOf(facts.ws, texts, facts.page);
  const { header, rest } = sections(facts, focus);
  const head = header.join("\n");
  const sizes = rest.map((s) => render(s, s.lines).length + 2);
  const total = head.length + sizes.reduce((n, x) => n + x, 0);
  if (total <= budget) return { text: [head, ...rest.map((s) => render(s, s.lines))].join("\n\n"), complete: true, focus };

  const rooms = new Array<number>(rest.length).fill(0);
  let left = budget - head.length - 2 * rest.length;
  let open = rest.map((_, i) => i);
  while (open.length && left > 0) {
    const weight = open.reduce((n, i) => n + rest[i].weight, 0);
    const fits = open.filter((i) => sizes[i] <= (left * rest[i].weight) / weight);
    if (!fits.length) {
      for (const i of open) rooms[i] = Math.floor((left * rest[i].weight) / weight);
      break;
    }
    for (const i of fits) {
      rooms[i] = sizes[i];
      left -= sizes[i];
    }
    open = open.filter((i) => !fits.includes(i));
  }
  let complete = true;
  const texts2: string[] = [head];
  rest.forEach((s, i) => {
    if (rooms[i] < s.title.length + 120) {
      complete = false;
      texts2.push(`== ${s.title} ==\n(not listed, to fit)`);
      return;
    }
    const piece = cut(s, rooms[i]);
    complete &&= piece.complete;
    texts2.push(piece.text);
  });
  return { text: texts2.join("\n\n").slice(0, budget), complete, focus };
}
