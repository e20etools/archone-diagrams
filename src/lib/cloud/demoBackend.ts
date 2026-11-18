import { CATEGORIES, categoryRank, categoryRefusal, hiddenCategories, viewCategory, type CategoryRoles } from "../categories";
import { aiPolicyOf } from "../aiPolicy";
import { emptyWorkspace } from "../model";
import { nextAdrNumber, reviewAdr } from "../adr";
import { scopeRefusal } from "./scope";
import type { TrustPage } from "../trust";
import type { Workspace } from "../types";
import { AUDIT_PAGE_SIZE, matchesQuery, type AuditEntry } from "./audit";
import type { IntegrationInfo } from "../integrations/catalog";
import { BackendError, LIVE_LINK_MIN_PASSWORD, canCommentRole, canEditRole, type ApiKeyInfo, type Backend, type StoredFile, type LiveLink, type WebhookInfo, type CloudUser, type LiveHandlers, type Peer, type Role } from "./backend";
import type { Comment, Review, ReviewSettings, VersionInfo } from "./collab";
import { DEMO_DB_KEY } from "./config";
import { approvalOf, approversOf, boxOf, changedByMeSince, demoFingerprint, diagramTables, nameOfUser, recordOf, requestsOf, roleState, settingsView, tryComplete, type DemoApprovalDb, type DemoApprovalEvent, type DemoPublication } from "./demoApprovals";
import { emptyTables, fromTables, patchTables, sameValue, splitNodeKey, type ChangeSet, type Tables } from "./tables";

/**
 * A stand-in for the hosted backend that lives entirely in this browser. Accounts and
 * workspaces are kept in localStorage and tabs talk over a BroadcastChannel, so two tabs
 * signed in as different people behave like two people on the real service.
 *
 * It exists so the hosted screens can be tried and tested without a server. It is only loaded
 * when the build sets VITE_CLOUD_BACKEND=demo. Passwords are stored as typed: never use it for real data.
 */

interface Db {
  users: Record<string, { id: string; email: string; name: string; password: string }>;
  workspaces: Record<string, { id: string; name: string; scenarioOf?: string; scenarioNote?: string; createdAt?: string }>;
  members: { workspaceId: string; userId: string; role: Role; domains?: string[] | null; categoryRoles?: CategoryRoles }[];
  invites: { id: string; workspaceId: string; email: string; role: Role; by: string }[];
  rows: Record<string, Tables>;
  comments?: Record<string, Comment[]>;
  versions?: Record<string, (VersionInfo & { tables: Tables })[]>;
  reviews?: Record<string, Review[]>;
  settings?: Record<string, ReviewSettings>;
  apiKeys?: Record<string, ApiKeyInfo[]>;
  webhooks?: Record<string, WebhookInfo[]>;
  /** Integrations: settings and which secrets were given. The demo never keeps a secret's value. */
  integrations?: Record<string, IntegrationInfo[]>;
  /** The demo keeps a link's password as written; the real database stores a salted hash. */
  liveLinks?: (LiveLink & { workspaceId: string; password?: string; failed?: number; lockedUntil?: string })[];
  trustPages?: Record<string, TrustPage>;
  /** The file library: each file's record, its links, and its content as a data URL (the demo keeps files small). */
  files?: Record<string, (Omit<StoredFile, "diagramIds"> & { links: string[]; data: string })[]>;
  /** A stand-in for the audit log the real database writes with triggers. It covers the model, members and invitations. */
  audit?: Record<string, AuditEntry[]>;
  /** Approving diagrams: who approves, the requests and their decisions, verified copies, who made each diagram. */
  approval?: DemoApprovalDb["approval"];
  approvalRequests?: DemoApprovalDb["approvalRequests"];
  publications?: DemoPublication[];
  diagramMakers?: DemoApprovalDb["diagramMakers"];
  /** Counts up with every write; see write(). */
  rev?: number;
}

const DB_KEY = DEMO_DB_KEY;
const DEMO_FILE_LIMIT = 2 * 1024 * 1024;
const SESSION_KEY = "archone.demoSession";
const id = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

const read = (): Db => {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return JSON.parse(raw) as Db;
  } catch {
    // fall through to an empty server
  }
  return { users: {}, workspaces: {}, members: [], invites: [], rows: {} };
};
/*
 * Every write counts up a revision, kept beside the data. Another tab can hear about a change on
 * the BroadcastChannel before its copy of localStorage has it, so a message carries the revision
 * it follows and is handed on only once that revision can be read.
 */
const REV_KEY = `${DEMO_DB_KEY}.rev`;
let lastRev = 0;
const write = (db: Db) => {
  db.rev = Math.max(Number(db.rev) || 0, Number(localStorage.getItem(REV_KEY)) || 0) + 1;
  lastRev = db.rev;
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  localStorage.setItem(REV_KEY, String(db.rev));
};
const storedRev = () => Number(localStorage.getItem(REV_KEY)) || 0;
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

type Message =
  | { type: "changes"; workspaceId: string; change: ChangeSet }
  | { type: "members" }
  | { type: "comment"; workspaceId: string; comment: Comment | { id: string; removed: true } }
  | { type: "collab"; workspaceId: string }
  | { type: "hello"; workspaceId: string }
  | { type: "peer"; workspaceId: string; peer: Peer }
  | { type: "bye"; workspaceId: string; key: string };

export function createDemoBackend(): Backend {
  const bus = new BroadcastChannel("archone-demo");
  const listeners = new Set<(message: Message) => void>();
  bus.onmessage = (event: MessageEvent<Message & { rev?: number }>) => {
    const message = event.data;
    const deliver = () => listeners.forEach((listener) => listener(message));
    const wanted = message.rev ?? 0;
    if (storedRev() >= wanted) return deliver();
    const since = Date.now();
    const wait = () => (storedRev() >= wanted || Date.now() - since > 3000 ? deliver() : setTimeout(wait, 10));
    setTimeout(wait, 10);
  };
  const post = (message: Message) => bus.postMessage({ ...message, rev: lastRev });
  const authListeners = new Set<(user: CloudUser | null, event: "session" | "recovery") => void>();

  const current = (): CloudUser | null => {
    const userId = sessionStorage.getItem(SESSION_KEY);
    const user = userId ? Object.values(read().users).find((u) => u.id === userId) : undefined;
    return user ? { id: user.id, email: user.email, name: user.name } : null;
  };
  const me = (): CloudUser => {
    const user = current();
    if (!user) throw new BackendError("forbidden", "Sign in first.");
    return user;
  };
  const COLUMN: Record<string, string> = { typeId: "type_id", parentId: "parent_id", sourceId: "source_id", targetId: "target_id", viewType: "view_type", scopeId: "scope_id", colorBy: "color_by", edgeKinds: "edge_kinds", hiddenRelationshipIds: "hidden_relationship_ids" };
  const log = (db: Db, workspaceId: string, entity: string, entityId: string, entityName: string, action: string, changes: Record<string, unknown> = {}) => {
    const user = current();
    const list = ((db.audit ??= {})[workspaceId] ??= []);
    list.push({ id: (list.at(-1)?.id ?? 0) + 1, at: new Date().toISOString(), actorId: user?.id ?? null, actorName: user?.name || user?.email || "System", via: "app", entity, entityId, entityName, action, changes });
  };
  /** The database refuses a limited editor's change outside their domains; so does this stand-in. */
  const refuseOutsideDomains = (db: Db, workspaceId: string, change: ChangeSet) => {
    const domains = db.members.find((m) => m.workspaceId === workspaceId && m.userId === me().id && m.role === "editor")?.domains;
    if (!domains?.length) return;
    const before = db.rows[workspaceId] ?? emptyTables();
    const after = patchTables(before, change);
    const asWorkspace = (t: Tables) => ({ objects: t.objects, relationships: t.relationships }) as Workspace;
    if (scopeRefusal(asWorkspace(before), asWorkspace(after), domains)) throw new BackendError("forbidden", "You can only change what is inside the domains you were given.");
  };
  /** The database refuses a change outside the categories a member edits; so does this stand-in. */
  const refuseOutsideCategories = (db: Db, workspaceId: string, change: ChangeSet) => {
    const member = db.members.find((m) => m.workspaceId === workspaceId && m.userId === me().id);
    if (!member) return;
    const before = db.rows[workspaceId] ?? emptyTables();
    const refusal = categoryRefusal(fromTables(before), fromTables(patchTables(before, change)), member.role, member.categoryRoles);
    if (refusal) throw new BackendError("forbidden", refusal);
  };
  /** What the database lets a member read: diagrams, their boxes and templates of the categories they may see. */
  const visibleRows = (db: Db, workspaceId: string, rows: Tables): Tables => {
    const member = db.members.find((m) => m.workspaceId === workspaceId && m.userId === me().id);
    const hidden = new Set<string>(hiddenCategories(member?.role ?? null, member?.categoryRoles));
    if (!hidden.size) return rows;
    const diagrams = Object.fromEntries(Object.entries(rows.diagrams).filter(([, d]) => !hidden.has(viewCategory(d.viewType))));
    const nodes = Object.fromEntries(Object.entries(rows.nodes).filter(([key]) => diagrams[splitNodeKey(key)[0]]));
    const templates = Object.fromEntries(Object.entries(rows.templates ?? {}).filter(([, t]) => !hidden.has(t.perspective)));
    return { ...rows, diagrams, nodes, templates };
  };
  /** What the database's triggers would record for a set of row changes. */
  const logChanges = (db: Db, workspaceId: string, before: Tables, change: ChangeSet) => {
    const nameOf = (objectId: string) => before.objects[objectId]?.name ?? change.objects?.[objectId]?.name ?? "?";
    for (const [table, entity] of [["objects", "object"], ["relationships", "relationship"], ["diagrams", "diagram"]] as const) {
      for (const [rowId, after] of Object.entries(change[table] ?? {})) {
        const old = before[table][rowId] as Record<string, unknown> | undefined;
        const row = (after ?? old) as Record<string, unknown> | undefined;
        if (!row) continue;
        const name = entity === "relationship" ? `${nameOf(String(row.sourceId))} → ${nameOf(String(row.targetId))}` : String(row.name ?? "");
        if (!after) {
          log(db, workspaceId, entity, rowId, name, "deleted");
          continue;
        }
        const fields: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(after as Record<string, unknown>)) {
          if (["id", "createdAt", "updatedAt"].includes(key)) continue;
          if (old ? !sameValue(old[key], value) : value !== null && value !== "" && !(Array.isArray(value) && !value.length)) fields[COLUMN[key] ?? key] = [old ? (old[key] ?? null) : null, value];
        }
        if (!old) log(db, workspaceId, entity, rowId, name, "created", fields);
        else if (Object.keys(fields).length) log(db, workspaceId, entity, rowId, name, "updated", fields);
      }
    }
    for (const [rowId, after] of Object.entries(change.rules ?? {})) {
      const old = before.rules?.[rowId];
      if (!after) {
        if (old) log(db, workspaceId, "rule", rowId, old.title, "deleted");
      } else if (!old) log(db, workspaceId, "rule", rowId, after.title, "created", { severity: after.severity });
      else if (old.enabled !== after.enabled) log(db, workspaceId, "rule", rowId, after.title, after.enabled ? "switched on" : "switched off");
      else log(db, workspaceId, "rule", rowId, after.title, "updated");
    }
    for (const [rowId, after] of Object.entries(change.wizards ?? {})) {
      const old = before.wizards?.[rowId];
      if (!after) {
        if (old) log(db, workspaceId, "wizard", rowId, rowId, "reset");
      } else log(db, workspaceId, "wizard", rowId, rowId, old ? "updated" : "created", { steps: [old?.steps.length ?? null, after.steps.length] });
    }
    for (const [rowId, after] of Object.entries(change.templates ?? {})) {
      const old = before.templates?.[rowId];
      if (!after) {
        if (old) log(db, workspaceId, "template", rowId, old.name, "deleted");
      } else if (!old) log(db, workspaceId, "template", rowId, after.name, "created", { perspective: [null, after.perspective] });
      else log(db, workspaceId, "template", rowId, after.name, "updated");
    }
    for (const [rowId, after] of Object.entries(change.adrs ?? {})) {
      const old = before.adrs?.[rowId];
      if (!after) {
        if (old) log(db, workspaceId, "decision", rowId, old.title, "deleted");
      } else if (!old) log(db, workspaceId, "decision", rowId, after.title, "created", { status: after.status });
      else if (old.status !== after.status) log(db, workspaceId, "decision", rowId, after.title, after.status, { status: [old.status, after.status] });
      else log(db, workspaceId, "decision", rowId, after.title, "updated");
    }
    for (const [key, after] of Object.entries(change.nodes ?? {})) {
      if (!!before.nodes[key] === !!after) continue; // a move, or nothing
      const [diagramId, objectId] = splitNodeKey(key);
      const diagram = change.diagrams?.[diagramId] === null ? null : (before.diagrams[diagramId] ?? change.diagrams?.[diagramId]);
      if (diagram) log(db, workspaceId, "diagram", diagramId, diagram.name, after ? "object added" : "object removed", { object: nameOf(objectId) });
    }
  };
  const roleOf = (db: Db, workspaceId: string, userId: string) => db.members.find((m) => m.workspaceId === workspaceId && m.userId === userId)?.role ?? null;
  const requireRole = (db: Db, workspaceId: string, test: (role: Role | null) => boolean) => {
    if (!test(roleOf(db, workspaceId, me().id))) throw new BackendError("forbidden", "You do not have access to do this.");
  };
  const announce = () => authListeners.forEach((listener) => listener(current(), "session"));
  const settingsOf = (db: Db, workspaceId: string): ReviewSettings => db.settings?.[workspaceId] ?? { required: false, stages: [], publishedVersionId: null };
  /** The working model: editors always, everyone else only while review is not required. */
  const readsModel = (db: Db, workspaceId: string, userId: string) => {
    const role = roleOf(db, workspaceId, userId);
    return canEditRole(role) || (role !== null && !settingsOf(db, workspaceId).required);
  };
  const versionsOf = (db: Db, workspaceId: string) => ((db.versions ??= {})[workspaceId] ??= []);
  const reviewsOf = (db: Db, workspaceId: string) => ((db.reviews ??= {})[workspaceId] ??= []);
  const snapshot = (db: Db, workspaceId: string, name: string, note: string, kind: VersionInfo["kind"]): string => {
    const tables = db.rows[workspaceId] ?? emptyTables();
    const version = {
      id: id("ver"),
      name: name.trim(),
      note: note.trim(),
      kind,
      objects: Object.keys(tables.objects).length,
      relationships: Object.keys(tables.relationships).length,
      diagrams: Object.keys(tables.diagrams).length,
      createdBy: me().id,
      createdAt: new Date().toISOString(),
      tables: { ...(JSON.parse(JSON.stringify(tables)) as Tables), proposals: {}, adrs: {}, rules: {}, templates: {}, wizards: {}, reports: {}, branding: {}, library: {}, aiPolicy: {}, processes: {} },
    };
    versionsOf(db, workspaceId).unshift(version);
    return version.id;
  };
  const versionVisible = (db: Db, workspaceId: string, versionId: string) => {
    const user = me();
    const role = roleOf(db, workspaceId, user.id);
    if (canEditRole(role)) return true;
    if (role === null) return false;
    const settings = settingsOf(db, workspaceId);
    if (!settings.required) return true;
    return settings.publishedVersionId === versionId || reviewsOf(db, workspaceId).some((r) => r.versionId === versionId && r.status === "open" && r.stages[r.stageIndex]?.reviewerId === user.id);
  };
  const openReview = (db: Db, workspaceId: string, reviewId: string): Review => {
    requireRole(db, workspaceId, (r) => r !== null);
    const review = reviewsOf(db, workspaceId).find((r) => r.id === reviewId);
    if (!review) throw new BackendError("invalid", "This review no longer exists.");
    if (review.status !== "open") throw new BackendError("invalid", "This review is already closed.");
    return review;
  };
  const collabChanged = (workspaceId: string) => post({ type: "collab", workspaceId } satisfies Message);

  /* The file library, by the database's rules. */
  const filesOf = (db: Db, workspaceId: string) => ((db.files ??= {})[workspaceId] ??= []);
  const diagramVisible = (db: Db, workspaceId: string, diagramId: string, userId = me().id) => {
    const member = db.members.find((m) => m.workspaceId === workspaceId && m.userId === userId);
    const diagram = db.rows[workspaceId]?.diagrams[diagramId];
    return !!member && !!diagram && categoryRank(member.role, member.categoryRoles ?? {}, viewCategory(diagram.viewType)) >= 1;
  };
  const diagramEditable = (db: Db, workspaceId: string, diagramId: string) => {
    const member = db.members.find((m) => m.workspaceId === workspaceId && m.userId === me().id);
    const diagram = db.rows[workspaceId]?.diagrams[diagramId];
    return !!member && !!diagram && canEditRole(member.role) && categoryRank(member.role, member.categoryRoles ?? {}, viewCategory(diagram.viewType)) >= 3;
  };
  type DemoFile = NonNullable<Db["files"]>[string][number];
  const fileVisible = (db: Db, workspaceId: string, f: DemoFile) => roleOf(db, workspaceId, me().id) !== null && (f.uploadedBy === me().id || f.links.some((d) => diagramVisible(db, workspaceId, d)));
  const fileManageable = (db: Db, workspaceId: string, f: DemoFile) => {
    const role = roleOf(db, workspaceId, me().id);
    return role === "owner" || (f.uploadedBy === me().id && canEditRole(role));
  };
  const findFile = (db: Db, workspaceId: string, fileId: string) => {
    const f = filesOf(db, workspaceId).find((x) => x.id === fileId);
    if (!f || !fileVisible(db, workspaceId, f)) throw new BackendError("forbidden", "That file is not there, or you may not open it.");
    return f;
  };
  const shownFile = (db: Db, workspaceId: string, { links, data: _data, ...f }: DemoFile): StoredFile => ({ ...f, diagramIds: links.filter((d) => diagramVisible(db, workspaceId, d)) });

  return {
    onAuth(callback) {
      authListeners.add(callback);
      setTimeout(() => authListeners.has(callback) && callback(current(), "session"), 0);
      return () => void authListeners.delete(callback);
    },
    async signIn(email, password) {
      await pause();
      const user = read().users[email.trim().toLowerCase()];
      if (!user || user.password !== password) throw new BackendError("credentials", "That email and password do not match an account.");
      sessionStorage.setItem(SESSION_KEY, user.id);
      announce();
    },
    async signUp(name, email, password) {
      await pause();
      const db = read();
      const address = email.trim().toLowerCase();
      if (db.users[address]) throw new BackendError("invalid", "An account with this email already exists. Sign in instead.");
      db.users[address] = { id: id("user"), email: address, name: name.trim(), password };
      write(db);
      sessionStorage.setItem(SESSION_KEY, db.users[address].id);
      announce();
      return { needsConfirmation: false };
    },
    async sendPasswordReset() {
      await pause();
    },
    async setPassword(password) {
      const db = read();
      db.users[me().email].password = password;
      write(db);
    },
    async updateName(name) {
      const db = read();
      db.users[me().email].name = name.trim();
      write(db);
      announce();
    },
    async signOut() {
      sessionStorage.removeItem(SESSION_KEY);
      announce();
    },
    async accessToken() {
      return current() ? `demo-${current()!.id}` : null;
    },

    async listWorkspaces() {
      await pause();
      const db = read();
      const user = me();
      return db.members
        .filter((m) => m.userId === user.id && db.workspaces[m.workspaceId])
        .map((m) => ({ id: m.workspaceId, name: db.workspaces[m.workspaceId].name, role: m.role, scenarioOf: db.workspaces[m.workspaceId].scenarioOf ?? null, scenarioNote: db.workspaces[m.workspaceId].scenarioNote ?? "", createdAt: db.workspaces[m.workspaceId].createdAt ?? null, domains: m.role === "editor" && m.domains?.length ? m.domains : null, categoryRoles: m.role === "owner" ? {} : (m.categoryRoles ?? {}) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async createWorkspace(name) {
      const db = read();
      const workspaceId = id("ws");
      db.workspaces[workspaceId] = { id: workspaceId, name: name.trim(), createdAt: new Date().toISOString() };
      db.members.push({ workspaceId, userId: me().id, role: "owner" });
      log(db, workspaceId, "member", me().id, me().name || me().email, "added", { role: [null, "owner"] });
      db.rows[workspaceId] = emptyTables();
      write(db);
      return workspaceId;
    },
    async renameWorkspace(workspaceId, name) {
      const db = read();
      requireRole(db, workspaceId, (r) => r === "owner");
      if (db.workspaces[workspaceId].name !== name.trim()) log(db, workspaceId, "workspace", workspaceId, name.trim(), "updated", { name: [db.workspaces[workspaceId].name, name.trim()] });
      db.workspaces[workspaceId].name = name.trim();
      write(db);
    },
    async deleteWorkspace(workspaceId) {
      const db = read();
      requireRole(db, workspaceId, (r) => r === "owner");
      delete db.workspaces[workspaceId];
      delete db.rows[workspaceId];
      delete db.audit?.[workspaceId];
      // Scenarios go with the workspace they were taken from.
      for (const w of Object.values(db.workspaces)) {
        if (w.scenarioOf !== workspaceId) continue;
        delete db.workspaces[w.id];
        delete db.rows[w.id];
        delete db.audit?.[w.id];
        db.members = db.members.filter((m) => m.workspaceId !== w.id);
      }
      for (const part of [db.comments, db.versions, db.reviews, db.settings, db.apiKeys, db.webhooks]) if (part) delete part[workspaceId];
      db.liveLinks = (db.liveLinks ?? []).filter((l) => l.workspaceId !== workspaceId);
      db.members = db.members.filter((m) => m.workspaceId !== workspaceId);
      db.invites = db.invites.filter((i) => i.workspaceId !== workspaceId);
      write(db);
      post({ type: "members" } satisfies Message);
    },
    async myInvites() {
      const db = read();
      const user = me();
      return db.invites
        .filter((i) => i.email === user.email && db.workspaces[i.workspaceId])
        .map((i) => ({ id: i.id, workspaceId: i.workspaceId, workspaceName: db.workspaces[i.workspaceId].name, role: i.role, invitedBy: Object.values(db.users).find((u) => u.id === i.by)?.name ?? "" }));
    },
    async acceptInvite(inviteId) {
      const db = read();
      const user = me();
      const invite = db.invites.find((i) => i.id === inviteId && i.email === user.email);
      if (!invite) throw new BackendError("invalid", "This invitation no longer exists.");
      if (!roleOf(db, invite.workspaceId, user.id)) {
        db.members.push({ workspaceId: invite.workspaceId, userId: user.id, role: invite.role });
        log(db, invite.workspaceId, "member", user.id, user.name || user.email, "added", { role: [null, invite.role] });
      }
      log(db, invite.workspaceId, "invitation", invite.id, invite.email, "closed");
      db.invites = db.invites.filter((i) => i.id !== inviteId);
      write(db);
      post({ type: "members" } satisfies Message);
      return invite.workspaceId;
    },
    async declineInvite(inviteId) {
      const db = read();
      db.invites = db.invites.filter((i) => !(i.id === inviteId && i.email === me().email));
      write(db);
    },
    async listPeople(workspaceId) {
      const db = read();
      requireRole(db, workspaceId, (r) => r !== null);
      const owner = roleOf(db, workspaceId, me().id) === "owner";
      return {
        members: db.members
          .filter((m) => m.workspaceId === workspaceId)
          .map((m) => {
            const user = Object.values(db.users).find((u) => u.id === m.userId);
            return { userId: m.userId, email: user?.email ?? "", name: user?.name ?? "", role: m.role, domains: m.role === "editor" && m.domains?.length ? m.domains : null, categoryRoles: m.role === "owner" ? {} : (m.categoryRoles ?? {}) };
          }),
        invites: owner ? db.invites.filter((i) => i.workspaceId === workspaceId).map((i) => ({ id: i.id, email: i.email, role: i.role })) : [],
      };
    },
    async invite(workspaceId, email, role) {
      const db = read();
      requireRole(db, workspaceId, (r) => r === "owner");
      const address = email.trim().toLowerCase();
      if (db.invites.some((i) => i.workspaceId === workspaceId && i.email === address)) throw new BackendError("invalid", "That address already has an invitation.");
      const inviteId = id("inv");
      db.invites.push({ id: inviteId, workspaceId, email: address, role, by: me().id });
      log(db, workspaceId, "invitation", inviteId, address, "sent", { role: [null, role] });
      write(db);
    },
    async cancelInvite(inviteId) {
      const db = read();
      const invite = db.invites.find((i) => i.id === inviteId);
      if (!invite) return;
      requireRole(db, invite.workspaceId, (r) => r === "owner");
      log(db, invite.workspaceId, "invitation", invite.id, invite.email, "closed");
      db.invites = db.invites.filter((i) => i.id !== inviteId);
      write(db);
    },
    async setRole(workspaceId, userId, role) {
      const db = read();
      requireRole(db, workspaceId, (r) => r === "owner");
      const member = db.members.find((m) => m.workspaceId === workspaceId && m.userId === userId);
      if (!member) return;
      const otherOwner = db.members.some((m) => m.workspaceId === workspaceId && m.role === "owner" && m.userId !== userId);
      if (member.role === "owner" && role !== "owner" && !otherOwner) throw new BackendError("invalid", "A workspace needs at least one owner. Make someone else an owner first.");
      const person = Object.values(db.users).find((u) => u.id === userId);
      if (member.role !== role) log(db, workspaceId, "member", userId, person?.name || person?.email || "", "role changed", { role: [member.role, role] });
      member.role = role;
      if (role !== "editor") member.domains = null;
      write(db);
      post({ type: "members" } satisfies Message);
    },
    async removeMember(workspaceId, userId) {
      const db = read();
      requireRole(db, workspaceId, (r) => r === "owner" || userId === me().id);
      const member = db.members.find((m) => m.workspaceId === workspaceId && m.userId === userId);
      const otherOwner = db.members.some((m) => m.workspaceId === workspaceId && m.role === "owner" && m.userId !== userId);
      if (member?.role === "owner" && !otherOwner) throw new BackendError("invalid", "A workspace needs at least one owner. Make someone else an owner first.");
      const gone = Object.values(db.users).find((u) => u.id === userId);
      if (member) log(db, workspaceId, "member", userId, gone?.name || gone?.email || "", "removed", { role: [member.role, null] });
      db.members = db.members.filter((m) => !(m.workspaceId === workspaceId && m.userId === userId));
      write(db);
      post({ type: "members" } satisfies Message);
    },

    async load(workspaceId) {
      await pause();
      const db = read();
      requireRole(db, workspaceId, (r) => r !== null);
      return readsModel(db, workspaceId, me().id) ? visibleRows(db, workspaceId, db.rows[workspaceId] ?? emptyTables()) : emptyTables();
    },
    async push(workspaceId, change) {
      await pause();
      if (!navigator.onLine) throw new BackendError("network", "The server could not be reached.");
      const db = read();
      requireRole(db, workspaceId, canEditRole);
      refuseOutsideDomains(db, workspaceId, change);
      refuseOutsideCategories(db, workspaceId, change);
      if (Object.keys(change.rules ?? {}).length && roleOf(db, workspaceId, me().id) !== "owner") throw new BackendError("forbidden", "Only an owner can change the workspace's rules.");
      if (Object.keys(change.wizards ?? {}).length && roleOf(db, workspaceId, me().id) !== "owner") throw new BackendError("forbidden", "Only an owner can change the wizard's questions.");
      if (Object.keys(change.branding ?? {}).length && roleOf(db, workspaceId, me().id) !== "owner") throw new BackendError("forbidden", "Only an owner can change the workspace's branding.");
      if (Object.keys(change.aiPolicy ?? {}).length && roleOf(db, workspaceId, me().id) !== "owner") throw new BackendError("forbidden", "Only an owner can change the AI limits.");
      logChanges(db, workspaceId, db.rows[workspaceId] ?? emptyTables(), change);
      // As the database's trigger does, whoever adds a diagram is its maker.
      for (const [diagramId, diagram] of Object.entries(change.diagrams ?? {})) {
        if (diagram && !db.rows[workspaceId]?.diagrams[diagramId]) ((db.diagramMakers ??= {})[workspaceId] ??= {})[diagramId] ??= me().id;
      }
      db.rows[workspaceId] = patchTables(db.rows[workspaceId] ?? emptyTables(), change);
      write(db);
      post({ type: "changes", workspaceId, change } satisfies Message);
    },
    async listComments(workspaceId) {
      await pause();
      const db = read();
      requireRole(db, workspaceId, (r) => r !== null);
      return db.comments?.[workspaceId] ?? [];
    },
    async addComment(workspaceId, draft) {
      const db = read();
      requireRole(db, workspaceId, canCommentRole);
      const list = ((db.comments ??= {})[workspaceId] ??= []);
      const parent = draft.parentId ? list.find((c) => c.id === draft.parentId && !c.parentId) : null;
      if (draft.parentId && !parent) throw new BackendError("invalid", "That comment thread no longer exists.");
      const comment: Comment = {
        id: id("com"),
        diagramId: parent ? parent.diagramId : draft.diagramId,
        targetKind: parent ? parent.targetKind : draft.targetKind,
        targetId: parent ? parent.targetId : draft.targetId,
        parentId: draft.parentId,
        body: draft.body.trim(),
        mentions: draft.mentions,
        resolved: false,
        authorId: me().id,
        createdAt: new Date().toISOString(),
        editedAt: null,
      };
      list.push(comment);
      write(db);
      post({ type: "comment", workspaceId, comment } satisfies Message);
      return comment;
    },
    async updateComment(workspaceId, commentId, patch) {
      const db = read();
      requireRole(db, workspaceId, canCommentRole);
      const list = db.comments?.[workspaceId] ?? [];
      const comment = list.find((c) => c.id === commentId);
      if (!comment) return;
      const mine = comment.authorId === me().id;
      if ((patch.body !== undefined || patch.mentions !== undefined) && !mine) throw new BackendError("forbidden", "Only its author can change a comment.");
      if (patch.deleted && !mine && roleOf(db, workspaceId, me().id) !== "owner") throw new BackendError("forbidden", "Only its author or an owner can delete a comment.");
      if (patch.deleted) {
        const gone = list.filter((c) => c.id === commentId || c.parentId === commentId);
        db.comments![workspaceId] = list.filter((c) => !gone.includes(c));
        write(db);
        for (const c of gone) post({ type: "comment", workspaceId, comment: { id: c.id, removed: true } } satisfies Message);
        return;
      }
      if (patch.body !== undefined) {
        comment.body = patch.body.trim();
        comment.editedAt = new Date().toISOString();
      }
      if (patch.mentions !== undefined) comment.mentions = patch.mentions;
      if (patch.resolved !== undefined) comment.resolved = patch.resolved;
      write(db);
      post({ type: "comment", workspaceId, comment } satisfies Message);
    },

    async listVersions(workspaceId) {
      await pause();
      const db = read();
      requireRole(db, workspaceId, (r) => r !== null);
      return versionsOf(db, workspaceId)
        .filter((v) => versionVisible(db, workspaceId, v.id))
        .map(({ tables: _tables, ...info }) => info);
    },
    async saveVersion(workspaceId, name, note, safety = false) {
      const db = read();
      if (!canEditRole(roleOf(db, workspaceId, me().id))) throw new BackendError("forbidden", "Only owners and editors can save a version.");
      const versionId = snapshot(db, workspaceId, name, note, safety ? "safety" : "manual");
      write(db);
      collabChanged(workspaceId);
      return versionId;
    },
    async loadVersion(workspaceId, versionId) {
      await pause();
      const db = read();
      const version = versionsOf(db, workspaceId).find((v) => v.id === versionId);
      if (!version || !versionVisible(db, workspaceId, versionId)) throw new BackendError("forbidden", "That version no longer exists, or you may not open it.");
      return visibleRows(db, workspaceId, version.tables);
    },
    async deleteVersion(workspaceId, versionId) {
      const db = read();
      const used = reviewsOf(db, workspaceId).some((r) => r.versionId === versionId) || settingsOf(db, workspaceId).publishedVersionId === versionId;
      if (roleOf(db, workspaceId, me().id) !== "owner" || used) throw new BackendError("forbidden", "Only an owner can delete a version, and not one that was reviewed or is published.");
      db.versions![workspaceId] = versionsOf(db, workspaceId).filter((v) => v.id !== versionId);
      write(db);
      collabChanged(workspaceId);
    },

    async aiUsageReport(workspaceId) {
      // The demo has no AI server to count requests, so it shows the limits in force and no use.
      const db = read();
      requireRole(db, workspaceId, (r) => r !== null);
      const root = db.workspaces[workspaceId]?.scenarioOf ?? workspaceId;
      const policy = aiPolicyOf({ ...emptyWorkspace(""), aiPolicy: db.rows[root]?.aiPolicy ?? {} });
      const limitsOf = (userId: string) => {
        const o = policy.overrides[userId] ?? {};
        return { hour: o.hour ?? policy.perUser.hour, day: o.day ?? policy.perUser.day, tokensDay: o.tokensDay ?? policy.perUser.tokensDay, paused: o.blocked === true };
      };
      const owner = roleOf(db, workspaceId, me().id) === "owner";
      const today = new Date();
      return {
        me: { hour: 0, day: 0, tokensDay: 0, limits: limitsOf(me().id) },
        workspace: { day: 0, tokensDay: 0, limits: { ...policy.workspace } },
        people: owner
          ? db.members
              .filter((m) => m.workspaceId === root)
              .map((m) => ({ userId: m.userId, name: Object.values(db.users).find((u) => u.id === m.userId)?.name ?? "", role: m.role, day: 0, week: 0, month: 0, tokensDay: 0, tokensMonth: 0, failed: 0, lastUsed: null, limits: limitsOf(m.userId) }))
          : null,
        days: owner ? Array.from({ length: 14 }, (_, i) => ({ day: new Date(today.getTime() - (13 - i) * 86_400_000).toISOString().slice(0, 10), requests: 0, tokens: 0 })) : null,
        scenario: root !== workspaceId,
      };
    },
    async reviewSettings(workspaceId) {
      await pause();
      const db = read();
      requireRole(db, workspaceId, (r) => r !== null);
      return settingsOf(db, workspaceId);
    },
    async setReviewSettings(workspaceId, required, stages) {
      const db = read();
      if (roleOf(db, workspaceId, me().id) !== "owner") throw new BackendError("forbidden", "Only an owner can change the review settings.");
      if (stages.some((s) => !s.name.trim())) throw new BackendError("invalid", "Give every stage a name of up to 80 characters.");
      if (stages.some((s) => !roleOf(db, workspaceId, s.reviewerId))) throw new BackendError("invalid", "Choose a member of this workspace as the reviewer of every stage.");
      if (required && stages.length === 0) throw new BackendError("invalid", "Add at least one review stage before switching review on.");
      const settings: ReviewSettings = {
        required,
        stages: stages.map((s) => ({ id: s.id || id("stage"), name: s.name.trim(), reviewerId: s.reviewerId, checklist: s.checklist.map((c) => c.trim()).filter(Boolean) })),
        publishedVersionId: settingsOf(db, workspaceId).publishedVersionId,
      };
      if (required && !settings.publishedVersionId) settings.publishedVersionId = snapshot(db, workspaceId, "Baseline", "The model as it was when review was switched on.", "baseline");
      (db.settings ??= {})[workspaceId] = settings;
      write(db);
      collabChanged(workspaceId);
    },
    async listReviews(workspaceId) {
      await pause();
      const db = read();
      requireRole(db, workspaceId, (r) => r !== null);
      return reviewsOf(db, workspaceId);
    },
    async submitReview(workspaceId, title, note) {
      const db = read();
      if (!canEditRole(roleOf(db, workspaceId, me().id))) throw new BackendError("forbidden", "Only owners and editors can submit the model for review.");
      const settings = settingsOf(db, workspaceId);
      if (!settings.required || !settings.stages.length) throw new BackendError("invalid", "Review before publishing is switched off for this workspace.");
      if (reviewsOf(db, workspaceId).some((r) => r.status === "open")) throw new BackendError("invalid", "A review is already open. Finish or withdraw it first.");
      const review: Review = {
        id: id("rev"),
        versionId: snapshot(db, workspaceId, title, note, "review"),
        baseVersionId: settings.publishedVersionId,
        title: title.trim(),
        note: note.trim(),
        status: "open",
        stages: JSON.parse(JSON.stringify(settings.stages)),
        stageIndex: 0,
        decisions: [],
        submittedBy: me().id,
        submittedAt: new Date().toISOString(),
        closedAt: null,
      };
      reviewsOf(db, workspaceId).unshift(review);
      write(db);
      collabChanged(workspaceId);
      return review.id;
    },
    async decideReview(workspaceId, reviewId, approve, reason, checklist) {
      const db = read();
      const review = openReview(db, workspaceId, reviewId);
      const stage = review.stages[review.stageIndex];
      if (stage.reviewerId !== me().id) throw new BackendError("forbidden", "This stage is waiting for someone else.");
      if (approve && (checklist.length !== stage.checklist.length || checklist.some((c) => !c))) throw new BackendError("invalid", "Tick every item on the checklist before approving.");
      if (!approve && !reason.trim()) throw new BackendError("invalid", "Give the reason for rejecting.");
      const at = new Date().toISOString();
      review.decisions.push({ stageId: stage.id, stageName: stage.name, by: me().id, decision: approve ? "approved" : "rejected", reason: reason.trim(), checklist, at });
      if (!approve) {
        review.status = "rejected";
        review.closedAt = at;
      } else if (review.stageIndex + 1 >= review.stages.length) {
        review.status = "approved";
        review.closedAt = at;
        (db.settings ??= {})[workspaceId] = { ...settingsOf(db, workspaceId), publishedVersionId: review.versionId };
      } else review.stageIndex += 1;
      // The real database writes this record with a trigger on the review.
      const versions = versionsOf(db, workspaceId);
      const rows = db.rows[workspaceId] ?? emptyTables();
      const name = (userId: string | null) => {
        const user = userId ? db.users[Object.keys(db.users).find((k) => db.users[k].id === userId) ?? ""] : undefined;
        return user ? user.name || user.email : "Former member";
      };
      const record = reviewAdr(
        review,
        versions.find((v) => v.id === review.baseVersionId)?.tables ?? null,
        versions.find((v) => v.id === review.versionId)?.tables ?? emptyTables(),
        name,
        nextAdrNumber(rows.adrs ?? {}),
      );
      const change: ChangeSet | null = record ? { adrs: { [record.id]: record } } : null;
      if (change && record) {
        db.rows[workspaceId] = patchTables(rows, change);
        log(db, workspaceId, "decision", record.id, record.title, "created", { status: record.status });
      }
      write(db);
      if (change) {
        const message = { type: "changes", workspaceId, change } satisfies Message;
        post(message);
        listeners.forEach((listener) => listener(message));
      }
      collabChanged(workspaceId);
    },
    async delegateReview(workspaceId, reviewId, toUserId) {
      const db = read();
      const review = openReview(db, workspaceId, reviewId);
      const stage = review.stages[review.stageIndex];
      if (stage.reviewerId !== me().id && roleOf(db, workspaceId, me().id) !== "owner") throw new BackendError("forbidden", "Only this stage's reviewer or an owner can hand it to someone else.");
      if (toUserId === stage.reviewerId || !roleOf(db, workspaceId, toUserId)) throw new BackendError("invalid", "Choose another member of this workspace.");
      review.decisions.push({ stageId: stage.id, stageName: stage.name, by: me().id, decision: "delegated", reason: "", checklist: [], to: toUserId, at: new Date().toISOString() });
      stage.reviewerId = toUserId;
      write(db);
      collabChanged(workspaceId);
    },
    async withdrawReview(workspaceId, reviewId) {
      const db = read();
      const review = openReview(db, workspaceId, reviewId);
      if (review.submittedBy !== me().id && roleOf(db, workspaceId, me().id) !== "owner") throw new BackendError("forbidden", "Only the person who submitted it or an owner can withdraw a review.");
      review.status = "withdrawn";
      review.closedAt = new Date().toISOString();
      write(db);
      collabChanged(workspaceId);
    },
    // The stand-in has no API server: keys and webhooks can be managed here, but nothing answers or is sent.
    apiBaseUrl() {
      return null;
    },
    async listApiKeys(workspaceId) {
      const db = read();
      return roleOf(db, workspaceId, me().id) === "owner" ? (db.apiKeys?.[workspaceId] ?? []) : [];
    },
    async createApiKey(workspaceId, name, access, domains) {
      const db = read();
      if (roleOf(db, workspaceId, me().id) !== "owner") throw new BackendError("forbidden", "Only an owner can create API keys.");
      const key = `ark_${id("demo")}${id("key")}`.replace(/_/g, "");
      const info: ApiKeyInfo = { id: id("key"), name: name.trim(), prefix: key.slice(0, 12), access, domains: access === "write" && domains?.length ? domains : null, createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null };
      ((db.apiKeys ??= {})[workspaceId] ??= []).unshift(info);
      write(db);
      return { id: info.id, key };
    },
    async revokeApiKey(workspaceId, keyId) {
      const db = read();
      if (roleOf(db, workspaceId, me().id) !== "owner") throw new BackendError("forbidden", "Only an owner can revoke API keys.");
      const key = db.apiKeys?.[workspaceId]?.find((k) => k.id === keyId);
      if (key) key.revokedAt = new Date().toISOString();
      write(db);
    },
    async listIntegrations(workspaceId) {
      const db = read();
      const role = roleOf(db, workspaceId, me().id);
      if (!role) throw new BackendError("forbidden", "Not a member of this workspace.");
      const list = db.integrations?.[workspaceId] ?? [];
      return canEditRole(role) ? list : list.map((i) => ({ ...i, settings: {}, secretFields: [] }));
    },
    async saveIntegration(workspaceId, provider, settings, secrets, enabled) {
      const db = read();
      if (roleOf(db, workspaceId, me().id) !== "owner") throw new BackendError("forbidden", "Only an owner can change integrations.");
      const list = ((db.integrations ??= {})[workspaceId] ??= []);
      const old = list.find((i) => i.provider === provider);
      const kept = new Set(old?.secretFields ?? []);
      for (const [k, v] of Object.entries(secrets)) v === null ? kept.delete(k) : v.trim() && kept.add(k);
      const next: IntegrationInfo = { provider, enabled, settings, secretFields: [...kept].sort(), status: "untested", statusMessage: "", checkedAt: null, changedAt: new Date().toISOString() };
      db.integrations[workspaceId] = [...list.filter((i) => i.provider !== provider), next].sort((a, b) => a.provider.localeCompare(b.provider));
      write(db);
    },
    async removeIntegration(workspaceId, provider) {
      const db = read();
      if (roleOf(db, workspaceId, me().id) !== "owner") throw new BackendError("forbidden", "Only an owner can remove integrations.");
      if (db.integrations?.[workspaceId]) db.integrations[workspaceId] = db.integrations[workspaceId].filter((i) => i.provider !== provider);
      write(db);
    },
    async useIntegration(workspaceId, provider, action) {
      await pause();
      const db = read();
      if (!roleOf(db, workspaceId, me().id)) throw new BackendError("forbidden", "Not a member of this workspace.");
      if (action === "notify") return { sent: [] } as never;
      // The demo has no server to reach outside services from; it says so, and records it as the status.
      const message = "The demo cannot reach outside services. Connect this workspace on the hosted app to use it.";
      const item = db.integrations?.[workspaceId]?.find((i) => i.provider === provider);
      if (item) Object.assign(item, { status: "failed", statusMessage: message, checkedAt: new Date().toISOString() });
      write(db);
      throw new BackendError("invalid", message);
    },
    async listWebhooks(workspaceId) {
      const db = read();
      return roleOf(db, workspaceId, me().id) === "owner" ? (db.webhooks?.[workspaceId] ?? []) : [];
    },
    async createWebhook(workspaceId, target) {
      const db = read();
      if (roleOf(db, workspaceId, me().id) !== "owner") throw new BackendError("forbidden", "Only an owner can add webhooks.");
      if (!/^https:\/\/[^/]+\.[^/]+/.test(target.trim())) throw new BackendError("invalid", "Give a public https address with a host name, for example https://example.com/hooks/archone.");
      const hook: WebhookInfo = { id: id("hook"), url: target.trim(), createdAt: new Date().toISOString() };
      ((db.webhooks ??= {})[workspaceId] ??= []).push(hook);
      write(db);
      return { id: hook.id, secret: `whsec_${id("demo")}`.replace("_demo_", "") };
    },
    async deleteWebhook(workspaceId, webhookId) {
      const db = read();
      if (roleOf(db, workspaceId, me().id) !== "owner") throw new BackendError("forbidden", "Only an owner can delete a webhook.");
      if (db.webhooks?.[workspaceId]) db.webhooks[workspaceId] = db.webhooks[workspaceId].filter((h) => h.id !== webhookId);
      write(db);
    },
    async testWebhook() {
      await pause();
    },

    async setMemberCategoryRoles(workspaceId, userId, roles) {
      const db = read();
      requireRole(db, workspaceId, (r) => r === "owner");
      const member = db.members.find((m) => m.workspaceId === workspaceId && m.userId === userId);
      if (!member) throw new BackendError("invalid", "That person is not a member of this workspace.");
      if (member.role === "owner") throw new BackendError("invalid", "An owner has every category. Change the role first.");
      // A role at or above the workspace role changes nothing, so it is not kept.
      const kept = Object.fromEntries(Object.entries(roles).filter(([c, r]) => CATEGORIES.includes(c as never) && r && categoryRank(member.role, { [c]: r }, c) < categoryRank(member.role, {}, c))) as CategoryRoles;
      const person = Object.values(db.users).find((u) => u.id === userId);
      log(db, workspaceId, "member", userId, person?.name || person?.email || "", "category roles changed", { categories: [member.categoryRoles ?? {}, kept] });
      member.categoryRoles = kept;
      write(db);
      post({ type: "members" } satisfies Message);
    },
    async setMemberDomains(workspaceId, userId, domains) {
      const db = read();
      requireRole(db, workspaceId, (r) => r === "owner");
      const member = db.members.find((m) => m.workspaceId === workspaceId && m.userId === userId);
      if (!member) throw new BackendError("invalid", "That person is not a member of this workspace.");
      if (domains?.length && member.role !== "editor") throw new BackendError("invalid", "Only an editor can be limited to domains.");
      const rows = db.rows[workspaceId] ?? emptyTables();
      const nameOf = (list: string[] | null | undefined) => (list ?? []).map((d) => rows.objects[d]?.name ?? d).sort();
      const person = Object.values(db.users).find((u) => u.id === userId);
      log(db, workspaceId, "member", userId, person?.name || person?.email || "", "limit changed", { domains: [nameOf(member.domains), nameOf(domains)] });
      member.domains = domains?.length ? domains : null;
      write(db);
      post({ type: "members" } satisfies Message);
    },
    async trustPage(workspaceId) {
      const db = read();
      return roleOf(db, workspaceId, me().id) === "owner" ? (db.trustPages?.[workspaceId] ?? null) : null;
    },
    async setTrustPage(workspaceId, page) {
      const db = read();
      requireRole(db, workspaceId, (r) => r === "owner");
      if (page.enabled && !page.title.trim()) throw new BackendError("invalid", "Give the page a heading before switching it on.");
      if (page.diagramId && !db.rows[workspaceId]?.diagrams[page.diagramId]) throw new BackendError("invalid", "That diagram no longer exists.");
      const before = db.trustPages?.[workspaceId];
      const saved: TrustPage = { token: before?.token ?? `${id("trust")}${id("x")}`.replace(/_/g, ""), enabled: page.enabled, title: page.title.trim(), intro: page.intro.trim(), contact: page.contact.trim(), diagramId: page.diagramId || null };
      (db.trustPages ??= {})[workspaceId] = saved;
      log(db, workspaceId, "trust page", workspaceId, saved.title, before ? "updated" : "created");
      write(db);
      return saved;
    },
    async createScenario(workspaceId, name, note) {
      await pause();
      const db = read();
      requireRole(db, workspaceId, canEditRole);
      if (db.workspaces[workspaceId].scenarioOf) throw new BackendError("invalid", "A scenario cannot have scenarios of its own. Create it from the main workspace.");
      const scenarioId = id("ws");
      db.workspaces[scenarioId] = { id: scenarioId, name: name.trim(), scenarioOf: workspaceId, scenarioNote: note, createdAt: new Date().toISOString() };
      for (const m of db.members.filter((x) => x.workspaceId === workspaceId && canEditRole(x.role))) db.members.push({ workspaceId: scenarioId, userId: m.userId, role: m.role });
      const source = db.rows[workspaceId] ?? emptyTables();
      // A scenario is judged by the same rules as the model it came from.
      db.rows[scenarioId] = { ...(JSON.parse(JSON.stringify(source)) as Tables), proposals: {}, adrs: {}, rules: JSON.parse(JSON.stringify(source.rules ?? {})) as Tables["rules"], templates: {}, wizards: JSON.parse(JSON.stringify(source.wizards ?? {})) as Tables["wizards"], reports: {}, branding: JSON.parse(JSON.stringify(source.branding ?? {})) as Tables["branding"], library: JSON.parse(JSON.stringify(source.library ?? {})) as Tables["library"], aiPolicy: {}, processes: JSON.parse(JSON.stringify(source.processes ?? {})) as Tables["processes"] };
      log(db, workspaceId, "scenario", scenarioId, name.trim(), "created");
      log(db, scenarioId, "scenario", scenarioId, name.trim(), "created", { "copied from": db.workspaces[workspaceId].name });
      write(db);
      post({ type: "members" } satisfies Message);
      return scenarioId;
    },

    // The stand-in keeps no hashes: it works them out from the entries each time. That shows the
    // screens and catches a changed saved code; only the real database stores the chain.
    async verifyAudit(workspaceId, anchor) {
      const db = read();
      if (roleOf(db, workspaceId, me().id) !== "owner") throw new BackendError("forbidden", "Only an owner can check the audit log.");
      const entries = db.audit?.[workspaceId] ?? [];
      const hex = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
      let prev = "";
      let found: string | null = null;
      for (const e of entries) {
        prev = await hex(JSON.stringify([prev, e.id, e.at, e.actorId, e.actorName, e.via, e.entity, e.entityId, e.entityName, e.action, e.changes]));
        if (anchor && e.id === anchor.id) found = prev;
      }
      const last = entries.at(-1);
      const state = !anchor ? null : found === null ? "missing" : found === anchor.hash ? "match" : "mismatch";
      return { ok: state === null || state === "match", entries: entries.length, brokenAt: null, head: last ? { id: last.id, hash: prev, at: last.at } : null, anchor: state };
    },
    async listAudit(workspaceId, query) {
      await pause();
      const db = read();
      if (roleOf(db, workspaceId, me().id) !== "owner") return { entries: [], more: false };
      const limit = query.limit ?? AUDIT_PAGE_SIZE;
      const rows = [...(db.audit?.[workspaceId] ?? [])].reverse().filter((entry) => matchesQuery(entry, query));
      return { entries: rows.slice(0, limit), more: rows.length > limit };
    },

    async listFiles(workspaceId) {
      const db = read();
      return filesOf(db, workspaceId)
        .filter((f) => fileVisible(db, workspaceId, f))
        .map((f) => shownFile(db, workspaceId, f))
        .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
    },
    async uploadFile(workspaceId, body, upload) {
      const db = read();
      if (!canEditRole(roleOf(db, workspaceId, me().id))) throw new BackendError("forbidden", "Only owners and editors can upload files.");
      if (body.size > DEMO_FILE_LIMIT) throw new BackendError("invalid", "The demo keeps files up to 2 MB. The hosted app takes up to 50 MB.");
      for (const d of upload.diagramIds) if (!diagramEditable(db, workspaceId, d)) throw new BackendError("forbidden", "You can link files only to diagrams you can edit.");
      const data = await new Promise<string>((done, failed) => {
        const reader = new FileReader();
        reader.onload = () => done(String(reader.result));
        reader.onerror = () => failed(new BackendError("invalid", "The file could not be read."));
        reader.readAsDataURL(body);
      });
      const at = new Date().toISOString();
      const file: DemoFile = { id: id("file"), name: upload.name.trim().slice(0, 200) || "Untitled file", kind: upload.kind, description: upload.description.slice(0, 2000), mime: body.type, size: body.size, uploadedBy: me().id, uploadedAt: at, updatedAt: at, links: [...new Set(upload.diagramIds)], data };
      filesOf(db, workspaceId).push(file);
      log(db, workspaceId, "file", file.id, file.name, "created");
      for (const d of file.links) log(db, workspaceId, "file", file.id, file.name, `linked to ${db.rows[workspaceId]?.diagrams[d]?.name ?? d}`);
      write(db);
      return shownFile(db, workspaceId, file);
    },
    async fileUrl(workspaceId, fileId) {
      const f = findFile(read(), workspaceId, fileId);
      return URL.createObjectURL(await (await fetch(f.data)).blob());
    },
    async updateFile(workspaceId, fileId, patch) {
      const db = read();
      const f = findFile(db, workspaceId, fileId);
      if (!fileManageable(db, workspaceId, f)) throw new BackendError("forbidden", "Only the person who uploaded a file, or an owner, can change it.");
      if (patch.name !== undefined) f.name = patch.name.trim().slice(0, 200) || f.name;
      if (patch.kind !== undefined) f.kind = patch.kind;
      if (patch.description !== undefined) f.description = patch.description.slice(0, 2000);
      f.updatedAt = new Date().toISOString();
      log(db, workspaceId, "file", f.id, f.name, "updated");
      write(db);
    },
    async setFileLinks(workspaceId, fileId, diagramIds) {
      const db = read();
      const f = findFile(db, workspaceId, fileId);
      const want = new Set(diagramIds);
      // Links to diagrams this person cannot see are kept as they are.
      const mine = f.links.filter((d) => diagramVisible(db, workspaceId, d));
      const drop = mine.filter((d) => !want.has(d));
      const add = [...want].filter((d) => !f.links.includes(d));
      if (drop.some((d) => !fileManageable(db, workspaceId, f) && !diagramEditable(db, workspaceId, d))) throw new BackendError("forbidden", "Only the person who uploaded a file, an owner, or an editor of the diagram can remove a link.");
      if (add.length && (!fileManageable(db, workspaceId, f) || add.some((d) => !diagramEditable(db, workspaceId, d)))) throw new BackendError("forbidden", "The file could not be linked to every diagram chosen: you can link only your own files, to diagrams you can edit.");
      f.links = [...f.links.filter((d) => !drop.includes(d)), ...add];
      for (const d of drop) log(db, workspaceId, "file", f.id, f.name, `unlinked from ${db.rows[workspaceId]?.diagrams[d]?.name ?? d}`);
      for (const d of add) log(db, workspaceId, "file", f.id, f.name, `linked to ${db.rows[workspaceId]?.diagrams[d]?.name ?? d}`);
      write(db);
    },
    async deleteFile(workspaceId, fileId) {
      const db = read();
      const f = findFile(db, workspaceId, fileId);
      if (!fileManageable(db, workspaceId, f)) throw new BackendError("forbidden", "Only the person who uploaded a file, or an owner, can delete it.");
      db.files![workspaceId] = filesOf(db, workspaceId).filter((x) => x.id !== fileId);
      log(db, workspaceId, "file", f.id, f.name, "deleted");
      write(db);
    },
    async listLiveLinks(workspaceId, diagramId) {
      const db = read();
      if (!canEditRole(roleOf(db, workspaceId, me().id))) return [];
      return (db.liveLinks ?? []).filter((l) => l.workspaceId === workspaceId && l.diagramId === diagramId).map(({ workspaceId: _ws, password: _p, failed: _f, lockedUntil: _l, ...link }) => ({ ...link, protected: link.protected === true, expiresAt: link.expiresAt ?? null }));
    },
    async createLiveLink(workspaceId, diagramId, options) {
      const db = read();
      if (!canEditRole(roleOf(db, workspaceId, me().id))) throw new BackendError("forbidden", "Only owners and editors can create a live link.");
      const password = options?.password ?? "";
      if (password && password.length < LIVE_LINK_MIN_PASSWORD) throw new BackendError("invalid", `Use a password of at least ${LIVE_LINK_MIN_PASSWORD} characters.`);
      const expiresAt = options?.expiresAt ?? null;
      if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) throw new BackendError("invalid", "Choose a date in the future for the link to stop working.");
      (db.liveLinks ??= []).push({
        id: id("link"),
        token: `${id("live")}${id("x")}`.replace(/_/g, ""),
        workspaceId,
        diagramId,
        createdBy: me().id,
        createdAt: new Date().toISOString(),
        protected: !!password,
        expiresAt,
        ...(password ? { password } : {}),
      });
      write(db);
    },
    async revokeLiveLink(workspaceId, linkId) {
      const db = read();
      if (!canEditRole(roleOf(db, workspaceId, me().id))) throw new BackendError("forbidden", "That link no longer exists, or you may not switch it off.");
      db.liveLinks = (db.liveLinks ?? []).filter((l) => l.id !== linkId);
      write(db);
    },

    /* Approving diagrams and verified copies, by the database's rules (see demoApprovals.ts). */
    async approvalSettings(workspaceId) {
      const db = read();
      requireRole(db, workspaceId, (r) => r !== null);
      return settingsView(db, workspaceId);
    },
    async setApprovalSettings(workspaceId, required, ea, security) {
      const db = read();
      if (roleOf(db, workspaceId, me().id) !== "owner") throw new BackendError("forbidden", "Only an owner can choose who approves diagrams.");
      for (const list of [ea, security]) {
        if (list.length > 20) throw new BackendError("invalid", "A role can have at most 20 approvers.");
        if (list.some((u) => roleOf(db, workspaceId, u) === null)) throw new BackendError("invalid", "Every approver has to be a member of the workspace.");
        if (required && !list.length) throw new BackendError("invalid", "Name at least one Enterprise Architecture and one Cybersecurity approver before making approval compulsory.");
      }
      (db.approval ??= {})[workspaceId] = { required, ea: [...new Set(ea)], security: [...new Set(security)] };
      log(db, workspaceId, "workspace", workspaceId, "", "diagram approval set", { compulsory: required, ea: ea.map((u) => nameOfUser(db, u)), security: security.map((u) => nameOfUser(db, u)) });
      write(db);
      collabChanged(workspaceId);
      return settingsView(db, workspaceId);
    },
    async diagramRecord(workspaceId, diagramId) {
      const db = read();
      requireRole(db, workspaceId, (r) => r !== null);
      if (!db.rows[workspaceId]?.diagrams[diagramId]) throw new BackendError("invalid", "There is no such diagram.");
      return recordOf(db, workspaceId, diagramId, me().id);
    },
    async submitDiagram(workspaceId, diagramId, note) {
      const db = read();
      if (!canEditRole(roleOf(db, workspaceId, me().id))) throw new BackendError("forbidden", "Only owners and editors can send a diagram for approval.");
      const diagram = db.rows[workspaceId]?.diagrams[diagramId];
      if (!diagram) throw new BackendError("invalid", "There is no such diagram.");
      if (!approversOf(db, workspaceId, "ea").length || !approversOf(db, workspaceId, "security").length) throw new BackendError("invalid", "An owner has to name the Enterprise Architecture and Cybersecurity approvers in Settings first.");
      const text = note.trim();
      if (text.length > 2000) throw new BackendError("invalid", "The note is longer than 2000 characters.");
      const fingerprint = (await demoFingerprint(db.rows[workspaceId], diagramId))!;
      const requests = requestsOf(db, workspaceId);
      const user = me();
      const at = new Date().toISOString();
      let request = requests.find((r) => r.diagramId === diagramId && (r.status === "pending" || r.status === "returned"));
      if (request) {
        if (request.status === "pending") throw new BackendError("invalid", "This diagram is already waiting for approval.");
        Object.assign(request, { status: "pending", round: request.round + 1, fingerprint, note: text || request.note, updatedAt: at });
        request.events.push({ kind: "resubmitted", role: null, note: text, fingerprint, byId: user.id, byName: nameOfUser(db, user.id), at, round: request.round });
        log(db, workspaceId, "diagram", diagramId, diagram.name, "sent for approval again", { version: request.version, round: request.round });
      } else {
        if (requests.some((r) => r.diagramId === diagramId && r.status === "approved" && r.approvedFingerprint === fingerprint)) throw new BackendError("invalid", "This diagram is approved as it is. Change it to start its next version.");
        const version = requests.filter((r) => r.diagramId === diagramId && r.status === "approved").length + 1;
        request = { id: id("apr"), diagramId, version, status: "pending", round: 1, note: text, fingerprint, requestedBy: user.id, requestedAt: at, updatedAt: at, events: [] };
        request.events.push({ kind: "submitted", role: null, note: text, fingerprint, byId: user.id, byName: nameOfUser(db, user.id), at, round: 1 });
        requests.push(request);
        log(db, workspaceId, "diagram", diagramId, diagram.name, "sent for approval", { version });
      }
      await tryComplete(db, workspaceId, request, { id: user.id, name: nameOfUser(db, user.id) });
      write(db);
      collabChanged(workspaceId);
      return recordOf(db, workspaceId, diagramId, user.id);
    },
    async decideDiagram(workspaceId, diagramId, role, decision, note) {
      const db = read();
      const user = me();
      const roleName = role === "ea" ? "Enterprise Architecture" : "Cybersecurity";
      if (!approvalOf(db, workspaceId)[role].includes(user.id) || roleOf(db, workspaceId, user.id) === null) throw new BackendError("forbidden", `Only a ${roleName} approver can decide this.`);
      const diagram = db.rows[workspaceId]?.diagrams[diagramId];
      if (!diagram) throw new BackendError("invalid", "There is no such diagram.");
      const request = requestsOf(db, workspaceId).find((r) => r.diagramId === diagramId && (r.status === "pending" || r.status === "returned"));
      if (!request) throw new BackendError("invalid", "Nothing on this diagram is waiting for approval.");
      if (request.status === "returned") throw new BackendError("invalid", "This diagram is back with its sender for changes. It can be decided once it is sent again.");
      const text = note.trim();
      if (decision !== "approve" && !text) throw new BackendError("invalid", "Say what has to change, so the sender knows what to fix.");
      if (text.length > 2000) throw new BackendError("invalid", "The note is longer than 2000 characters.");
      const fingerprint = (await demoFingerprint(db.rows[workspaceId], diagramId))!;
      const at = new Date().toISOString();
      const event = (kind: DemoApprovalEvent["kind"]) => request.events.push({ kind, role, note: text, fingerprint, byId: user.id, byName: nameOfUser(db, user.id), at, round: request.round });
      if (decision === "approve") {
        if (request.events.some((e) => e.role === role && (e.kind === "approved" || e.kind === "approved_with_changes") && e.fingerprint === fingerprint)) throw new BackendError("invalid", `${roleName} has already approved the diagram as it is.`);
        const sentAt = request.events.filter((e) => e.kind === "submitted" || e.kind === "resubmitted").at(-1)?.at ?? request.requestedAt;
        const withChanges = fingerprint !== request.fingerprint && changedByMeSince(db, workspaceId, diagramId, user.id, sentAt);
        event(withChanges ? "approved_with_changes" : "approved");
        request.updatedAt = at;
        log(db, workspaceId, "diagram", diagramId, diagram.name, `${withChanges ? "changed and approved" : "approved"} by ${roleName}`, { version: request.version });
        await tryComplete(db, workspaceId, request, { id: user.id, name: nameOfUser(db, user.id) });
        if (request.status === "approved") log(db, workspaceId, "diagram", diagramId, diagram.name, `approved as version ${request.version}`);
      } else if (decision === "return") {
        Object.assign(request, { status: "returned", updatedAt: at });
        event("returned");
        log(db, workspaceId, "diagram", diagramId, diagram.name, `returned for changes by ${roleName}`, { version: request.version, note: text });
      } else {
        Object.assign(request, { status: "rejected", updatedAt: at, closedAt: at });
        event("rejected");
        log(db, workspaceId, "diagram", diagramId, diagram.name, `rejected by ${roleName}`, { version: request.version, note: text });
      }
      write(db);
      collabChanged(workspaceId);
      return recordOf(db, workspaceId, diagramId, user.id);
    },
    async withdrawDiagram(workspaceId, diagramId) {
      const db = read();
      const user = me();
      const request = requestsOf(db, workspaceId).find((r) => r.diagramId === diagramId && (r.status === "pending" || r.status === "returned"));
      if (!request) throw new BackendError("invalid", "Nothing on this diagram is waiting for approval.");
      const role = roleOf(db, workspaceId, user.id);
      if (!(request.requestedBy === user.id && canEditRole(role)) && role !== "owner") throw new BackendError("forbidden", "Only the person who sent it, or an owner, can withdraw it.");
      const at = new Date().toISOString();
      Object.assign(request, { status: "withdrawn", updatedAt: at, closedAt: at });
      request.events.push({ kind: "withdrawn", role: null, note: "", fingerprint: (await demoFingerprint(db.rows[workspaceId], diagramId)) ?? "", byId: user.id, byName: nameOfUser(db, user.id), at, round: request.round });
      log(db, workspaceId, "diagram", diagramId, db.rows[workspaceId]?.diagrams[diagramId]?.name ?? "", "approval request withdrawn", { version: request.version });
      write(db);
      collabChanged(workspaceId);
      return recordOf(db, workspaceId, diagramId, user.id);
    },
    async approvalQueue(workspaceId) {
      const db = read();
      requireRole(db, workspaceId, (r) => r !== null);
      const user = me();
      const tables = db.rows[workspaceId] ?? emptyTables();
      const settings = approvalOf(db, workspaceId);
      const requests = requestsOf(db, workspaceId).filter((r) => tables.diagrams[r.diagramId]);
      const open = await Promise.all(
        requests
          .filter((r) => r.status === "pending" || r.status === "returned")
          .sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : 1))
          .map(async (r) => {
            const fingerprint = await demoFingerprint(tables, r.diagramId);
            return {
              requestId: r.id, diagramId: r.diagramId, name: tables.diagrams[r.diagramId].name, version: r.version, status: r.status as "pending" | "returned", round: r.round, note: r.note,
              requestedBy: nameOfUser(db, r.requestedBy), requestedById: r.requestedBy, requestedAt: r.requestedAt, updatedAt: r.updatedAt,
              ea: roleState(r, "ea", fingerprint), security: roleState(r, "security", fingerprint),
            };
          }),
      );
      const recent = requests
        .filter((r) => r.status === "approved" || r.status === "rejected" || r.status === "withdrawn")
        .sort((a, b) => ((a.closedAt ?? "") < (b.closedAt ?? "") ? 1 : -1))
        .slice(0, 30)
        .map((r) => ({ requestId: r.id, diagramId: r.diagramId, name: tables.diagrams[r.diagramId].name, version: r.version, status: r.status as "approved" | "rejected" | "withdrawn", requestedBy: nameOfUser(db, r.requestedBy), closedAt: r.closedAt ?? r.updatedAt }));
      return { mine: { ea: settings.ea.includes(user.id), security: settings.security.includes(user.id) }, open, recent };
    },
    async publishDiagram(workspaceId, diagramId, options) {
      const db = read();
      const user = me();
      if (!canEditRole(roleOf(db, workspaceId, user.id))) throw new BackendError("forbidden", "Only owners and editors can publish a copy.");
      const diagram = db.rows[workspaceId]?.diagrams[diagramId];
      if (!diagram) throw new BackendError("invalid", "There is no such diagram.");
      const expiresAt = options.expiresAt ?? null;
      const ms = expiresAt ? new Date(expiresAt).getTime() - Date.now() : 0;
      if (expiresAt && (ms <= 60_000 || ms > 366 * 86_400_000)) throw new BackendError("invalid", "Choose an end between a few minutes and a year from now, or none.");
      let copy: Pick<DemoPublication, "fingerprint" | "version" | "tables" | "record">;
      if (approvalOf(db, workspaceId).required) {
        const approved = requestsOf(db, workspaceId).filter((r) => r.diagramId === diagramId && r.status === "approved" && r.copy).sort((a, b) => ((a.closedAt ?? "") < (b.closedAt ?? "") ? 1 : -1))[0];
        if (!approved?.copy) throw new BackendError("invalid", "This diagram has no approved version yet. Approval by Enterprise Architecture and Cybersecurity comes before publishing.");
        copy = { fingerprint: approved.approvedFingerprint!, version: approved.version, tables: approved.copy.tables, record: approved.copy.record };
      } else {
        const record = await boxOf(db, workspaceId, diagramId);
        copy = { fingerprint: record.fingerprint ?? "", version: record.status === "approved" ? record.version : null, tables: diagramTables(db.rows[workspaceId], diagramId), record };
      }
      const row: DemoPublication = {
        id: id("pub"), token: `${id("ver")}${id("x")}${id("y")}`.replace(/_/g, ""), workspaceId, diagramId, ...copy, note: (options.note ?? "").trim().slice(0, 500), files: [],
        createdBy: user.id, createdAt: new Date().toISOString(), expiresAt, revokedAt: null, views: 0,
      };
      (db.publications ??= []).push(row);
      log(db, workspaceId, "diagram", diagramId, diagram.name, "published a verified copy", { version: row.version, expires: expiresAt });
      write(db);
      return { id: row.id, token: row.token, createdAt: row.createdAt, expiresAt, fingerprint: row.fingerprint, version: row.version };
    },
    async listPublications(workspaceId, diagramId) {
      const db = read();
      if (!canEditRole(roleOf(db, workspaceId, me().id))) return [];
      const now = await demoFingerprint(db.rows[workspaceId] ?? emptyTables(), diagramId);
      return (db.publications ?? [])
        .filter((p) => p.workspaceId === workspaceId && p.diagramId === diagramId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map((p) => ({ id: p.id, token: p.token, createdAt: p.createdAt, createdBy: nameOfUser(db, p.createdBy), expiresAt: p.expiresAt, revokedAt: p.revokedAt, views: p.views, note: p.note, fingerprint: p.fingerprint, version: p.version, files: p.files.length, current: p.fingerprint === now }));
    },
    async revokePublication(workspaceId, publicationId) {
      const db = read();
      const row = (db.publications ?? []).find((p) => p.id === publicationId && p.workspaceId === workspaceId && !p.revokedAt);
      if (!row || !canEditRole(roleOf(db, workspaceId, me().id))) throw new BackendError("forbidden", "That copy no longer exists, or you may not switch it off.");
      row.revokedAt = new Date().toISOString();
      log(db, workspaceId, "diagram", row.diagramId, row.record.name, "switched off a verified copy");
      write(db);
    },
    async addPublicationFile(workspaceId, publicationId, sha256, name) {
      const db = read();
      if (!canEditRole(roleOf(db, workspaceId, me().id))) throw new BackendError("forbidden", "Only owners and editors can add a file to a copy.");
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw new BackendError("invalid", "That is not a SHA-256.");
      const row = (db.publications ?? []).find((p) => p.id === publicationId && p.workspaceId === workspaceId && !p.revokedAt);
      if (!row || row.files.length >= 50) throw new BackendError("invalid", "That copy no longer takes files.");
      row.files.push({ sha256, name: name.slice(0, 200), at: new Date().toISOString() });
      write(db);
    },
    connect(workspaceId, user, handlers: LiveHandlers) {
      const key = `${user.id}:${id("tab")}`;
      let self: Peer = { key, userId: user.id, name: user.name || user.email, diagramId: null };
      const peers = new Map<string, Peer>();
      const tell = () => post({ type: "peer", workspaceId, peer: self } satisfies Message);
      const listener = (message: Message) => {
        if (message.type === "members") return handlers.onMembership();
        if (message.workspaceId !== workspaceId) return;
        if (message.type === "changes") {
          // As on the real service, the working model does not reach people who may not read it.
          if (readsModel(read(), workspaceId, user.id)) handlers.onChanges(message.change);
        } else if (message.type === "comment") handlers.onComment(message.comment);
        else if (message.type === "collab") handlers.onCollab();
        else if (message.type === "hello") tell();
        else if (message.type === "peer") {
          peers.set(message.peer.key, message.peer);
          handlers.onPeers([...peers.values()]);
        } else if (message.type === "bye") {
          peers.delete(message.key);
          handlers.onPeers([...peers.values()]);
        }
      };
      listeners.add(listener);
      const leave = () => post({ type: "bye", workspaceId, key } satisfies Message);
      window.addEventListener("pagehide", leave);
      setTimeout(() => {
        handlers.onStatus("live");
        post({ type: "hello", workspaceId } satisfies Message);
        tell();
      }, 0);
      return {
        setPresence(diagramId) {
          if (self.diagramId === diagramId) return;
          self = { ...self, diagramId };
          tell();
        },
        close() {
          listeners.delete(listener);
          window.removeEventListener("pagehide", leave);
          leave();
        },
      };
    },
  };
}
