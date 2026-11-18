import { APPROVAL_ROLES, type ApprovalEventKind, type ApprovalRole, type ApprovalSettings, type BoxRecord, type DiagramRecord, type DiagramStanding, type RequestStatus, type RoleStanding } from "../approvals";
import type { AuditEntry } from "./audit";
import { emptyTables, nodeKey, splitNodeKey, type Tables } from "./tables";

/**
 * Approving diagrams in the in-browser stand-in server, by the same rules as the database
 * (supabase/migrations/*_diagram_approvals.sql). The fingerprint is worked out differently, but
 * the same way every time, so it moves when the database's would.
 */

export interface DemoApprovalEvent {
  kind: ApprovalEventKind;
  role: ApprovalRole | null;
  note: string;
  fingerprint: string;
  byId: string | null;
  byName: string;
  at: string;
  round: number;
}
export interface DemoApprovalRequest {
  id: string;
  diagramId: string;
  version: number;
  status: RequestStatus;
  round: number;
  note: string;
  fingerprint: string;
  approvedFingerprint?: string;
  requestedBy: string | null;
  requestedAt: string;
  updatedAt: string;
  closedAt?: string;
  events: DemoApprovalEvent[];
  /** Kept once both roles approve: the approved picture and its box. */
  copy?: { tables: Tables; record: BoxRecord };
}
export interface DemoPublication {
  id: string;
  token: string;
  workspaceId: string;
  diagramId: string;
  fingerprint: string;
  version: number | null;
  tables: Tables;
  record: BoxRecord;
  note: string;
  files: { sha256: string; name: string; at: string }[];
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  views: number;
}
export interface DemoApprovalDb {
  users: Record<string, { id: string; email: string; name: string }>;
  workspaces: Record<string, { id: string; name: string }>;
  members: { workspaceId: string; userId: string }[];
  rows: Record<string, Tables>;
  audit?: Record<string, AuditEntry[]>;
  approval?: Record<string, { required: boolean; ea: string[]; security: string[] }>;
  approvalRequests?: Record<string, DemoApprovalRequest[]>;
  publications?: DemoPublication[];
  /** Who added each diagram. */
  diagramMakers?: Record<string, Record<string, string>>;
}

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as object)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
};
const omit = <T extends object>(row: T, keys: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

const placed = (tables: Tables, diagramId: string) =>
  Object.entries(tables.nodes)
    .filter(([key]) => splitNodeKey(key)[0] === diagramId)
    .map(([key, node]) => [splitNodeKey(key)[1], node] as const);

/** The diagram, its boxes, the objects in them and the relationships between them, as a viewer draws them. */
export function diagramTables(tables: Tables, diagramId: string): Tables {
  const diagram = tables.diagrams[diagramId];
  const out = emptyTables();
  if (!diagram) return out;
  const { titleBlock: _box, ...meta } = diagram;
  out.diagrams[diagramId] = meta;
  const ids = new Set<string>();
  for (const [objectId, node] of placed(tables, diagramId)) {
    out.nodes[nodeKey(diagramId, objectId)] = node;
    ids.add(objectId);
  }
  if (diagram.scopeId) ids.add(diagram.scopeId);
  for (const id of ids) {
    const object = tables.objects[id];
    if (object) out.objects[id] = { ...object, links: undefined } as typeof object;
  }
  for (const [id, r] of Object.entries(tables.relationships)) if (ids.has(r.sourceId) && ids.has(r.targetId)) out.relationships[id] = { ...r, links: undefined } as typeof r;
  return out;
}

export async function demoFingerprint(tables: Tables, diagramId: string): Promise<string | null> {
  const diagram = tables.diagrams[diagramId];
  if (!diagram) return null;
  const nodes = placed(tables, diagramId).map(([id, n]) => [id, Math.round(n.x), Math.round(n.y)] as const);
  const ids = new Set(nodes.map(([id]) => id));
  const hidden = new Set(diagram.hiddenRelationshipIds ?? []);
  const objects = Object.values(tables.objects).filter((o) => ids.has(o.id) || o.id === diagram.scopeId);
  const relationships = Object.values(tables.relationships).filter((r) => ids.has(r.sourceId) && ids.has(r.targetId) && !hidden.has(r.id));
  const content = stable({
    diagram: omit(diagram, ["createdAt", "updatedAt", "titleBlock", "archive"]),
    nodes: nodes.sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    objects: objects.map((o) => omit(o, ["createdAt", "updatedAt", "provenance", "links"])).sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1)),
    relationships: relationships.map((r) => omit(r, ["createdAt", "updatedAt", "provenance", "links"])).sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1)),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const nameOfUser = (db: DemoApprovalDb, userId: string | null | undefined) => {
  const user = userId ? Object.values(db.users).find((u) => u.id === userId) : undefined;
  return user ? user.name.trim() || user.email : "";
};
export const requestsOf = (db: DemoApprovalDb, workspaceId: string) => ((db.approvalRequests ??= {})[workspaceId] ??= []);
export const approvalOf = (db: DemoApprovalDb, workspaceId: string) => db.approval?.[workspaceId] ?? { required: false, ea: [], security: [] };
const isMember = (db: DemoApprovalDb, workspaceId: string, userId: string) => db.members.some((m) => m.workspaceId === workspaceId && m.userId === userId);
export const approversOf = (db: DemoApprovalDb, workspaceId: string, role: ApprovalRole) =>
  approvalOf(db, workspaceId)
    [role].filter((id) => isMember(db, workspaceId, id))
    .map((id) => ({ id, name: nameOfUser(db, id) }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
export const settingsView = (db: DemoApprovalDb, workspaceId: string): ApprovalSettings => ({
  required: approvalOf(db, workspaceId).required,
  ea: approversOf(db, workspaceId, "ea"),
  security: approversOf(db, workspaceId, "security"),
});

const WAITING: RoleStanding = { state: "waiting", by: "", at: null, note: "", withChanges: false };
const standingOfEvent = (state: RoleStanding["state"], e: DemoApprovalEvent | undefined): RoleStanding =>
  e ? { state, by: e.byName, at: e.at, note: e.note, withChanges: e.kind === "approved_with_changes" } : { ...WAITING, state };

export function roleState(request: DemoApprovalRequest, role: ApprovalRole, fingerprint: string | null): RoleStanding {
  const since = request.events.reduce((at, e, i) => (e.kind === "submitted" || e.kind === "resubmitted" ? i : at), -1);
  const said = request.events.filter((e, i) => i > since && e.role === role && (e.kind === "returned" || e.kind === "rejected")).at(-1);
  if (said) return standingOfEvent(said.kind as "returned" | "rejected", said);
  const approvals = request.events.filter((e) => e.role === role && (e.kind === "approved" || e.kind === "approved_with_changes"));
  const current = approvals.filter((e) => e.fingerprint === fingerprint).at(-1);
  if (current) return standingOfEvent("approved", current);
  return approvals.length ? standingOfEvent("stale", approvals.at(-1)) : WAITING;
}

export function standingOf(requests: DemoApprovalRequest[], diagramId: string, fingerprint: string | null): DiagramStanding {
  const mine = requests.filter((r) => r.diagramId === diagramId);
  const open = mine.find((r) => r.status === "pending" || r.status === "returned");
  const approved = mine.filter((r) => r.status === "approved").sort((a, b) => (a.closedAt! < b.closedAt! ? 1 : -1))[0];
  const last = [...mine].sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))[0];
  const count = mine.filter((r) => r.status === "approved").length;
  let status: DiagramStanding["status"] = "draft";
  let request: DemoApprovalRequest | undefined;
  if (open) [status, request] = [open.status as "pending" | "returned", open];
  else if (approved && approved.approvedFingerprint === fingerprint) [status, request] = ["approved", approved];
  else if (last?.status === "rejected" && (!approved || last.requestedAt > approved.requestedAt)) [status, request] = ["rejected", last];
  else if (approved) [status, request] = ["changed", approved];
  return {
    fingerprint,
    status,
    version: status === "approved" ? approved!.version : count + 1,
    approvedVersion: approved?.version ?? null,
    approvedAt: approved?.closedAt ?? null,
    approvedFingerprint: approved?.approvedFingerprint ?? null,
    request: request
      ? { id: request.id, version: request.version, status: request.status, round: request.round, note: request.note, requestedById: request.requestedBy, requestedBy: "", requestedAt: request.requestedAt, sentFingerprint: request.fingerprint }
      : null,
    roles: { ea: request ? roleState(request, "ea", fingerprint) : WAITING, security: request ? roleState(request, "security", fingerprint) : WAITING },
  };
}

/** The ids of what a diagram shows, for its audit entries. */
function touches(tables: Tables, diagramId: string): Set<string> {
  const ids = new Set(placed(tables, diagramId).map(([id]) => id));
  const out = new Set([diagramId, ...ids]);
  for (const r of Object.values(tables.relationships)) if (ids.has(r.sourceId) && ids.has(r.targetId)) out.add(r.id);
  return out;
}
const entriesFor = (db: DemoApprovalDb, workspaceId: string, diagramId: string) => {
  const ids = touches(db.rows[workspaceId] ?? emptyTables(), diagramId);
  return (db.audit?.[workspaceId] ?? []).filter((a) => ["diagram", "object", "relationship"].includes(a.entity) && ids.has(a.entityId) && !/approv|returned|rejected|withdrawn|verified copy|information box/.test(a.action));
};
export const changedByMeSince = (db: DemoApprovalDb, workspaceId: string, diagramId: string, userId: string, since: string) =>
  entriesFor(db, workspaceId, diagramId).some((a) => a.actorId === userId && a.at > since);

export async function recordOf(db: DemoApprovalDb, workspaceId: string, diagramId: string, userId: string | null): Promise<DiagramRecord> {
  const tables = db.rows[workspaceId] ?? emptyTables();
  const diagram = tables.diagrams[diagramId];
  const fingerprint = await demoFingerprint(tables, diagramId);
  const requests = requestsOf(db, workspaceId);
  const standing = standingOf(requests, diagramId, fingerprint);
  if (standing.request) standing.request.requestedBy = nameOfUser(db, standing.request.requestedById);
  const last = entriesFor(db, workspaceId, diagramId).at(-1);
  const settings = approvalOf(db, workspaceId);
  // One request is open at a time, so requests in the order they were sent, and their events in order, are the history.
  const events = requests
    .filter((r) => r.diagramId === diagramId)
    .sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : 1))
    .flatMap((r) => r.events.map((e) => ({ kind: e.kind, role: e.role, by: e.byName, at: e.at, note: e.note, version: r.version, round: e.round })))
    .reverse();
  return {
    ...standing,
    diagramId,
    required: settings.required,
    created: { at: diagram?.createdAt ?? null, by: nameOfUser(db, db.diagramMakers?.[workspaceId]?.[diagramId]) },
    changed: last && (!diagram?.updatedAt || last.at >= diagram.updatedAt) ? { at: last.at, by: last.actorName } : { at: diagram?.updatedAt ?? null, by: last?.actorName ?? "" },
    approvers: { ea: approversOf(db, workspaceId, "ea"), security: approversOf(db, workspaceId, "security") },
    mine: { ea: !!userId && settings.ea.includes(userId), security: !!userId && settings.security.includes(userId) },
    history: events.slice(0, 60),
  };
}

export async function boxOf(db: DemoApprovalDb, workspaceId: string, diagramId: string): Promise<BoxRecord> {
  const { approvers: _a, history: _h, mine: _m, ...record } = await recordOf(db, workspaceId, diagramId, null);
  const tables = db.rows[workspaceId] ?? emptyTables();
  const diagram = tables.diagrams[diagramId];
  const branding = tables.branding?.workspace;
  const workspace = db.workspaces[workspaceId]?.name ?? "";
  return {
    ...record,
    name: diagram?.name ?? "",
    workspace,
    company: diagram?.titleBlock?.company?.trim() || branding?.company?.trim() || workspace,
    logo: diagram?.titleBlock?.logo || branding?.companyLogo || "",
    show: !!diagram?.titleBlock?.show || !!branding?.boxRequired,
    corner: diagram?.titleBlock?.corner ?? "bottom-right",
    hidden: diagram?.titleBlock?.hidden ?? [],
    requiredFields: branding?.boxFields ?? [],
  };
}

/** Closes the open request as approved once both roles approved the diagram as it is. */
export async function tryComplete(db: DemoApprovalDb, workspaceId: string, request: DemoApprovalRequest, actor: { id: string; name: string }): Promise<void> {
  if (request.status !== "pending") return;
  const fingerprint = await demoFingerprint(db.rows[workspaceId] ?? emptyTables(), request.diagramId);
  const approvedBy = (role: ApprovalRole) => request.events.some((e) => e.role === role && (e.kind === "approved" || e.kind === "approved_with_changes") && e.fingerprint === fingerprint);
  if (!fingerprint || !APPROVAL_ROLES.every(approvedBy)) return;
  const at = new Date().toISOString();
  Object.assign(request, { status: "approved", approvedFingerprint: fingerprint, closedAt: at, updatedAt: at });
  request.events.push({ kind: "completed", role: null, note: "", fingerprint, byId: actor.id, byName: actor.name, at, round: request.round });
  request.copy = { tables: diagramTables(db.rows[workspaceId] ?? emptyTables(), request.diagramId), record: await boxOf(db, workspaceId, request.diagramId) };
}
