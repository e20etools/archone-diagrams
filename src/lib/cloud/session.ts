import type { AuditCheck, AuditPage, AuditQuery } from "./audit";
import { create } from "zustand";
import { createContext, useContext } from "react";
import { setAuthTokenProvider } from "../ai/client";
import { emptyWorkspace, nowIso } from "../model";
import { LocalStorageRepository } from "../repository";
import { setChangeGuard, setEditGuard, useStore } from "../store";
import { scopeRefusal } from "./scope";
import { categoryRank, categoryRefusal, hiddenCategories, type Category, type CategoryRoles } from "../categories";
import type { Workspace } from "../types";
import { BackendError, canCommentRole, canEditRole, type Backend, type CloudUser, type Invite, type LiveConnection, type Peer, type Role, type WorkspaceSummary } from "./backend";
import type { Comment, CommentDraft, Person, Review, ReviewSettings, ReviewStage, VersionInfo } from "./collab";
import { cloudEnabled, demoBackend, supabaseKey, supabaseUrl } from "./config";
import { normalizeForCloud } from "./rows";
import { SyncEngine, type SyncState } from "./sync";
import type { TrustPage, TrustPageInput } from "../trust";
import { emptyTables, fromTables, toTables, withoutDangling, type ChangeSet, type Tables } from "./tables";

/**
 * Who is signed in, which workspace is open, and the live connection that keeps it saved and
 * up to date. Only used in hosted mode.
 */

export type Phase = "starting" | "signedOut" | "recovery" | "choosing" | "loading" | "ready";

interface SessionState {
  phase: Phase;
  user: CloudUser | null;
  workspaces: WorkspaceSummary[];
  invites: Invite[];
  workspaceId: string | null;
  role: Role | null;
  /** The signed-in person's roles per category in the open workspace. */
  myCategoryRoles: CategoryRoles;
  sync: SyncState;
  live: boolean;
  peers: Peer[];
  /** A one-line message for the person, shown once. */
  notice: string | null;
  /** The members of the open workspace, for names and mentions. */
  people: Person[];
  comments: Record<string, Comment>;
  review: ReviewSettings;
  versions: VersionInfo[];
  reviews: Review[];
  /**
   * Set when this person is shown the published version instead of the working model: review
   * is required and they cannot edit. `version` is null until something has been published.
   */
  published: { version: VersionInfo | null } | null;
}

const NO_REVIEW: ReviewSettings = { required: false, stages: [], publishedVersionId: null };
const NO_COLLAB = { people: [] as Person[], comments: {} as Record<string, Comment>, review: NO_REVIEW, versions: [] as VersionInfo[], reviews: [] as Review[], published: null };

export const useSession = create<SessionState>(() => ({
  phase: "starting",
  user: null,
  workspaces: [],
  invites: [],
  workspaceId: null,
  role: null,
  myCategoryRoles: {},
  sync: { kind: "saved" },
  live: false,
  peers: [],
  notice: null,
  ...NO_COLLAB,
}));

const set = useSession.setState;
const get = useSession.getState;
const LAST_KEY = "archone.lastWorkspace";

let backendPromise: Promise<Backend> | undefined;
/** The backend is loaded on demand, so a build without hosted mode does not carry its code. */
export function getBackend(): Promise<Backend> {
  backendPromise ??= demoBackend
    ? import("./demoBackend").then((m) => m.createDemoBackend())
    : import("./supabaseBackend").then((m) => m.createSupabaseBackend(supabaseUrl, supabaseKey));
  return backendPromise;
}

let engine: SyncEngine | null = null;
let connection: LiveConnection | null = null;
let unsubscribeStore: (() => void) | null = null;
let started = false;
/** Versions already fetched. A version never changes, so one fetch is enough. */
const versionTables = new Map<string, Promise<Tables>>();
/** The workspace this tab is deleting, so its own membership events are not read as lost access. */
let deleting: string | null = null;

// Development only. This module holds the sign-in and the live connection, and swapping it in
// place while the dev server is running leaves the screen waiting on a session nobody started.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());

export const errorText = (error: unknown) => (error instanceof Error && error.message ? error.message : "Something went wrong. Try again.");

function closeWorkspace(): void {
  engine?.close();
  connection?.close();
  unsubscribeStore?.();
  engine = null;
  connection = null;
  unsubscribeStore = null;
  versionTables.clear();
  set({ workspaceId: null, role: null, myCategoryRoles: {}, peers: [], live: false, sync: { kind: "saved" }, ...NO_COLLAB });
}

async function refreshLists(): Promise<void> {
  const backend = await getBackend();
  const [workspaces, invites] = await Promise.all([backend.listWorkspaces(), backend.myInvites()]);
  set({ workspaces, invites });
}

/** Call once when the app starts in hosted mode. */
export function startSession(): void {
  if (started) return;
  started = true;
  setEditGuard(() => {
    const { phase, role } = get();
    if (phase !== "ready" || canEditRole(role)) return true;
    set({ notice: "You have view access to this workspace, so changes are not saved. Ask an owner for edit access." });
    return false;
  });
  setChangeGuard((before, after) => {
    const { workspaceId, workspaces, role } = get();
    const domains = role === "editor" ? (workspaces.find((w) => w.id === workspaceId)?.domains ?? null) : null;
    // The workspace's rules are its policy; the database lets only owners write them.
    if (before.rules !== after.rules && role !== "owner") {
      set({ notice: "Only an owner can change the workspace's rules." });
      return true;
    }
    if (before.wizards !== after.wizards && role !== "owner") {
      set({ notice: "Only an owner can change the wizard's questions." });
      return true;
    }
    const refusal = scopeRefusal(before, after, domains) ?? categoryRefusal(before, after, role, workspaces.find((w) => w.id === workspaceId)?.categoryRoles);
    if (refusal) set({ notice: refusal });
    return !!refusal;
  });
  void getBackend().then((backend) => {
    setAuthTokenProvider(() => backend.accessToken());
    backend.onAuth((user, event) => {
      const previous = get().user;
      if (!user) {
        closeWorkspace();
        set({ phase: "signedOut", user: null, workspaces: [], invites: [] });
        return;
      }
      if (event === "recovery") {
        set({ phase: "recovery", user });
        return;
      }
      set({ user });
      // A refreshed session or a changed name for the same person does not reload anything.
      if (previous?.id === user.id && get().phase !== "starting" && get().phase !== "signedOut" && get().phase !== "recovery") return;
      void enter();
    });
  });
}

/** After sign-in: reopen the last workspace, open the only one, or let the person choose. */
async function enter(): Promise<void> {
  set({ phase: "loading" });
  try {
    await refreshLists();
  } catch (error) {
    set({ phase: "choosing", notice: errorText(error) });
    return;
  }
  const { workspaces, invites } = get();
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_KEY);
  } catch {
    last = null;
  }
  const target = workspaces.find((w) => w.id === last) ?? (workspaces.length === 1 && invites.length === 0 ? workspaces[0] : undefined);
  if (target) await openWorkspace(target.id);
  else set({ phase: "choosing" });
}

export async function openWorkspace(workspaceId: string): Promise<void> {
  const backend = await getBackend();
  const { user } = get();
  if (!user) return;
  closeWorkspace();
  set({ phase: "loading" });
  try {
    const summary = get().workspaces.find((w) => w.id === workspaceId) ?? (await backend.listWorkspaces()).find((w) => w.id === workspaceId);
    if (!summary) throw new BackendError("forbidden", "You are no longer a member of that workspace.");
    // With review required, people who cannot edit read the published version, never the working model.
    const review = await backend.reviewSettings(workspaceId);
    const readsPublished = review.required && !canEditRole(summary.role);
    const source = async (): Promise<Tables> => {
      if (!readsPublished) return backend.load(workspaceId);
      const publishedId = (await backend.reviewSettings(workspaceId)).publishedVersionId;
      return publishedId ? backend.loadVersion(workspaceId, publishedId) : emptyTables();
    };
    const tables = withoutDangling(await source());
    const ws: Workspace = { ...emptyWorkspace(summary.name), userName: user.name || user.email, ...fromTables(tables), updatedAt: nowIso() };
    useStore.getState().adopt(ws);

    engine = new SyncEngine(
      {
        getWorkspace: () => useStore.getState().ws,
        applyRemote: (change) => useStore.getState().applyRemote(change),
        push: (change) => backend.push(workspaceId, change),
        load: source,
        canEdit: () => canEditRole(get().role),
        onState: (sync) => set({ sync }),
      },
      tables,
    );
    const current = engine;
    unsubscribeStore = useStore.subscribe((state, previous) => {
      if (state.ws !== previous.ws) current.localChanged();
    });
    let connectedBefore = false;
    connection = backend.connect(workspaceId, user, {
      onChanges: (change) => current.remote(change),
      onStatus: (status) => {
        set({ live: status === "live" });
        if (status !== "live") return;
        // The first connection follows a fresh load. Later ones may have missed changes.
        if (connectedBefore) void current.resync();
        connectedBefore = true;
      },
      onMembership: () => void membershipChanged(workspaceId),
      onPeers: (peers) => set({ peers }),
      onComment: (comment) => {
        if (get().workspaceId !== workspaceId) return;
        const comments = { ...get().comments };
        if ("removed" in comment) delete comments[comment.id];
        else comments[comment.id] = comment;
        set({ comments });
      },
      onCollab: () => void refreshCollab().catch(() => undefined),
    });
    try {
      localStorage.setItem(LAST_KEY, workspaceId);
    } catch {
      // Not remembered; the picker is shown next time.
    }
    set({ phase: "ready", workspaceId, role: summary.role, myCategoryRoles: summary.categoryRoles ?? {}, sync: { kind: "saved" }, review, published: readsPublished ? { version: null } : null });
    void refreshCollab().catch(() => undefined);
  } catch (error) {
    closeWorkspace();
    set({ phase: "choosing", notice: errorText(error) });
  }
}

/** Someone's role changed, or someone joined or left. If it was this person, the app follows. */
async function membershipChanged(workspaceId: string): Promise<void> {
  if (deleting === workspaceId) return;
  try {
    await refreshLists();
  } catch {
    return;
  }
  if (get().workspaceId !== workspaceId) return;
  const mine = get().workspaces.find((w) => w.id === workspaceId);
  if (!mine) {
    closeWorkspace();
    set({ phase: "choosing", notice: "You no longer have access to that workspace." });
    return;
  }
  const previous = get().myCategoryRoles;
  if (JSON.stringify(previous) !== JSON.stringify(mine.categoryRoles ?? {})) {
    set({ myCategoryRoles: mine.categoryRoles ?? {} });
    if (mine.role === get().role) set({ notice: "Your roles per category in this workspace have changed." });
    // Diagrams of a category that is now hidden, or no longer hidden, come and go with a fresh load.
    if (JSON.stringify(hiddenCategories(mine.role, previous)) !== JSON.stringify(hiddenCategories(mine.role, mine.categoryRoles))) {
      await openWorkspace(workspaceId);
      return;
    }
  }
  if (mine.role !== get().role) {
    set({ role: mine.role, notice: `Your role in this workspace is now ${mine.role}.` });
    if (get().sync.kind === "readonly" && canEditRole(mine.role)) set({ sync: { kind: "saved" } });
  }
  await refreshCollab().catch(() => undefined);
}

/**
 * Reloads members, comments, versions, reviews and the review settings of the open workspace.
 * If what this person should be looking at changed (a new version was published, review was
 * switched on or off, their role changed), the workspace is opened again from the right source.
 */
export async function refreshCollab(): Promise<void> {
  const { workspaceId } = get();
  if (!workspaceId) return;
  const backend = await getBackend();
  const [people, comments, review, versions, reviews] = await Promise.all([
    backend.listPeople(workspaceId),
    backend.listComments(workspaceId),
    backend.reviewSettings(workspaceId),
    backend.listVersions(workspaceId),
    backend.listReviews(workspaceId),
  ]);
  if (get().workspaceId !== workspaceId) return;
  const shouldReadPublished = review.required && !canEditRole(get().role);
  const was = get().published;
  const before = get().review.publishedVersionId;
  set({
    people: people.members.map((m) => ({ userId: m.userId, name: m.name, email: m.email })),
    comments: Object.fromEntries(comments.map((c) => [c.id, c])),
    review,
    versions,
    reviews,
    published: shouldReadPublished ? { version: versions.find((v) => v.id === review.publishedVersionId) ?? null } : null,
  });
  if (shouldReadPublished !== !!was || (shouldReadPublished && before !== review.publishedVersionId)) {
    const notice = shouldReadPublished && was ? "A new version was published." : null;
    await openWorkspace(workspaceId);
    if (notice) set({ notice });
  }
}

const here = async (): Promise<{ backend: Backend; workspaceId: string }> => {
  const { workspaceId } = get();
  if (!workspaceId) throw new BackendError("invalid", "Open a workspace first.");
  return { backend: await getBackend(), workspaceId };
};

/* ---------- comments ---------- */

export async function addComment(draft: CommentDraft): Promise<Comment> {
  const { backend, workspaceId } = await here();
  const comment = await backend.addComment(workspaceId, draft);
  set({ comments: { ...get().comments, [comment.id]: comment } });
  return comment;
}

export async function changeComment(commentId: string, patch: { body?: string; mentions?: string[]; resolved?: boolean }): Promise<void> {
  const { backend, workspaceId } = await here();
  await backend.updateComment(workspaceId, commentId, patch);
  const current = get().comments[commentId];
  if (current) set({ comments: { ...get().comments, [commentId]: { ...current, ...patch, editedAt: patch.body !== undefined ? nowIso() : current.editedAt } } });
}

/** Deleting the first comment of a thread removes its replies with it. */
export async function deleteComment(commentId: string): Promise<void> {
  const { backend, workspaceId } = await here();
  const replies = Object.values(get().comments).filter((c) => c.parentId === commentId);
  await backend.updateComment(workspaceId, commentId, { deleted: true });
  const comments = { ...get().comments };
  delete comments[commentId];
  for (const reply of replies) delete comments[reply.id];
  set({ comments });
}

/** What the signed-in person may do in a category: 0 nothing, 1 view, 2 comment, 3 edit, 4 own. Everything in browser-only mode. */
export function useCategoryRank(): (category: Category | string) => number {
  const role = useSession((s) => s.role);
  const roles = useSession((s) => s.myCategoryRoles);
  if (!cloudEnabled) return () => 4;
  return (category) => categoryRank(role, roles, category);
}
export function useMyCategoryRoles(): { role: Role | null; roles: CategoryRoles } {
  const role = useSession((s) => s.role);
  const roles = useSession((s) => s.myCategoryRoles);
  return cloudEnabled ? { role, roles } : { role: null, roles: {} };
}

/** The category of the diagram whose comments are shown; commenting there takes that category's comment role. */
export const CommentCategory = createContext<Category | null>(null);

export function useCanComment(): boolean {
  const role = useSession((s) => s.role);
  const roles = useSession((s) => s.myCategoryRoles);
  const category = useContext(CommentCategory);
  return canCommentRole(role) && (!category || categoryRank(role, roles, category) >= 2);
}

/* ---------- versions ---------- */

/** Saves first, so the version holds what is on the screen. */
async function saved(): Promise<void> {
  await engine?.flush().catch(() => undefined);
  if (engine?.dirty) throw new BackendError("network", "Your latest changes are not saved yet. Wait for Saved in the header, then try again.");
}

export async function saveVersion(name: string, note: string): Promise<void> {
  const { backend, workspaceId } = await here();
  await saved();
  await backend.saveVersion(workspaceId, name.trim(), note.trim());
  await refreshCollab();
}

export async function deleteVersion(versionId: string): Promise<void> {
  const { backend, workspaceId } = await here();
  await backend.deleteVersion(workspaceId, versionId);
  versionTables.delete(versionId);
  await refreshCollab();
}

export function versionTablesOf(versionId: string): Promise<Tables> {
  let tables = versionTables.get(versionId);
  if (!tables) {
    tables = here().then(({ backend, workspaceId }) => backend.loadVersion(workspaceId, versionId));
    versionTables.set(versionId, tables);
    tables.catch(() => versionTables.delete(versionId));
  }
  return tables;
}

/**
 * Makes the working model equal to a version, for everyone. The model as it is now is saved as
 * a version first, so this can itself be taken back. AI drafts are left as they are.
 */
export async function revertToVersion(version: VersionInfo): Promise<void> {
  const { backend, workspaceId } = await here();
  await saved();
  const tables = withoutDangling(await versionTablesOf(version.id));
  await backend.saveVersion(workspaceId, `Before reverting to "${version.name}"`.slice(0, 120), "Saved automatically so that the revert can be taken back.", true);
  const current = useStore.getState().ws;
  useStore.getState().replace({ ...current, ...fromTables({ ...tables, proposals: toTables(current).proposals, adrs: toTables(current).adrs, rules: toTables(current).rules, templates: toTables(current).templates, wizards: toTables(current).wizards }), updatedAt: nowIso() });
  await engine?.flush().catch(() => undefined);
  await refreshCollab();
}

/* ---------- review before publishing ---------- */

export async function saveReviewSettings(required: boolean, stages: ReviewStage[]): Promise<void> {
  const { backend, workspaceId } = await here();
  // Switching review on publishes the model as it is now, so it has to be saved first.
  if (required && !get().review.required) await saved();
  await backend.setReviewSettings(workspaceId, required, stages);
  await refreshCollab();
}

export async function submitForReview(title: string, note: string): Promise<string> {
  const { backend, workspaceId } = await here();
  await saved();
  const reviewId = await backend.submitReview(workspaceId, title.trim(), note.trim());
  await refreshCollab();
  return reviewId;
}

export async function decideReview(reviewId: string, approve: boolean, reason: string, checklist: boolean[]): Promise<void> {
  const { backend, workspaceId } = await here();
  await backend.decideReview(workspaceId, reviewId, approve, reason.trim(), checklist);
  await refreshCollab();
}

export async function delegateReview(reviewId: string, toUserId: string): Promise<void> {
  const { backend, workspaceId } = await here();
  await backend.delegateReview(workspaceId, reviewId, toUserId);
  await refreshCollab();
}

export async function withdrawReview(reviewId: string): Promise<void> {
  const { backend, workspaceId } = await here();
  await backend.withdrawReview(workspaceId, reviewId);
  await refreshCollab();
}

export function showWorkspaceList(): void {
  closeWorkspace();
  try {
    localStorage.removeItem(LAST_KEY);
  } catch {
    // nothing to forget
  }
  set({ phase: "choosing" });
  void refreshLists().catch(() => undefined);
}

/** The workspace kept in this browser by the version without accounts, if it holds anything. */
export function localWorkspace(): Workspace | null {
  const ws = new LocalStorageRepository().load();
  return Object.keys(ws.objects).length || Object.keys(ws.diagrams).length ? ws : null;
}

export async function createWorkspace(name: string, startFrom?: Workspace): Promise<void> {
  const backend = await getBackend();
  const workspaceId = await backend.createWorkspace(name.trim());
  await refreshLists();
  await openWorkspace(workspaceId);
  if (startFrom && get().workspaceId === workspaceId) {
    // Loading it as an ordinary edit lets the sync engine save every row.
    const { user } = get();
    const tables = toTables(startFrom);
    const objects = Object.fromEntries(Object.entries(tables.objects).map(([k, v]) => [k, normalizeForCloud(v)]));
    const relationships = Object.fromEntries(Object.entries(tables.relationships).map(([k, v]) => [k, normalizeForCloud(v)]));
    const diagrams = Object.fromEntries(Object.entries(tables.diagrams).map(([k, v]) => [k, normalizeForCloud(v)]));
    const copy: Tables = { ...tables, objects, relationships, diagrams };
    useStore.getState().replace({ ...startFrom, name: name.trim(), userName: user?.name || user?.email || "", ...fromTables(copy) });
    await engine?.flush();
  }
}

export async function acceptInvite(inviteId: string): Promise<void> {
  const backend = await getBackend();
  const workspaceId = await backend.acceptInvite(inviteId);
  await refreshLists();
  await openWorkspace(workspaceId);
}

export async function declineInvite(inviteId: string): Promise<void> {
  await (await getBackend()).declineInvite(inviteId);
  await refreshLists();
}

export async function renameCurrentWorkspace(name: string): Promise<void> {
  const { workspaceId } = get();
  if (!workspaceId) return;
  await (await getBackend()).renameWorkspace(workspaceId, name.trim());
  useStore.getState().applyRemote((ws) => ({ ...ws, name: name.trim() }));
  await refreshLists();
}

/**
 * Removes the open workspace with its model, diagrams, drafts, members and invitations, for
 * everyone. Only an owner may; the database refuses anyone else. Nothing brings it back.
 */
export async function deleteCurrentWorkspace(): Promise<void> {
  const { workspaceId } = get();
  if (!workspaceId) return;
  deleting = workspaceId;
  try {
    await (await getBackend()).deleteWorkspace(workspaceId);
  } finally {
    deleting = null;
  }
  // Edits still waiting to be saved belong to a workspace that no longer exists.
  closeWorkspace();
  try {
    localStorage.removeItem(LAST_KEY);
  } catch {
    // nothing to forget
  }
  set({ phase: "choosing", notice: "Workspace deleted.", workspaces: get().workspaces.filter((w) => w.id !== workspaceId) });
  void refreshLists().catch(() => undefined);
}

export async function updateMyName(name: string): Promise<void> {
  await (await getBackend()).updateName(name.trim());
  const { user } = get();
  if (user) set({ user: { ...user, name: name.trim() } });
  useStore.getState().applyRemote((ws) => ({ ...ws, userName: name.trim() || user?.email || "" }));
}

export async function signOut(): Promise<void> {
  await engine?.flush().catch(() => undefined);
  await (await getBackend()).signOut();
}

export function setPresence(diagramId: string | null): void {
  connection?.setPresence(diagramId);
}
export const clearNotice = () => set({ notice: null });
export const finishRecovery = () => void enter();
/** True while edits exist that the server has not confirmed; used to warn before the tab closes. */
export const hasUnsavedChanges = () => !!engine && engine.dirty;

/** Whether the person may change the model: always in browser-only mode, by role in hosted mode. */
export function useCanEdit(): boolean {
  const role = useSession((s) => s.role);
  return !cloudEnabled || canEditRole(role);
}

/** A page of the open workspace's audit log, newest first. Only owners get entries. */
export async function listAudit(query: AuditQuery): Promise<AuditPage> {
  const { workspaceId } = useSession.getState();
  if (!workspaceId) return { entries: [], more: false };
  return (await getBackend()).listAudit(workspaceId, query);
}

/** Walks the chain of hashes of the open workspace's audit log. */
export async function verifyAudit(anchor?: { id: number; hash: string }): Promise<AuditCheck> {
  const { workspaceId } = useSession.getState();
  if (!workspaceId) throw new Error("No workspace is open.");
  return (await getBackend()).verifyAudit(workspaceId, anchor);
}

/** Branches the open workspace's model into a scenario and opens it. */
export async function createScenario(name: string, note: string): Promise<void> {
  const { workspaceId } = get();
  if (!workspaceId) return;
  const backend = await getBackend();
  const scenarioId = await backend.createScenario(workspaceId, name.trim(), note.trim());
  await refreshLists();
  await openWorkspace(scenarioId);
}

/** The model of another workspace the person belongs to, for comparing a scenario with where it came from. */
export async function tablesOfWorkspace(workspaceId: string): Promise<Tables> {
  return (await getBackend()).load(workspaceId);
}

/** The open workspace's public trust page settings; null when it was never set up or this person is not an owner. */
export async function trustPage(): Promise<TrustPage | null> {
  const { workspaceId } = get();
  return workspaceId ? (await getBackend()).trustPage(workspaceId) : null;
}
export async function saveTrustPage(page: TrustPageInput): Promise<TrustPage> {
  const { workspaceId } = get();
  if (!workspaceId) throw new Error("No workspace is open.");
  return (await getBackend()).setTrustPage(workspaceId, page);
}

/** Saves a scenario's chosen changes into its main model. The main model's own rules decide whether this person may. */
export async function bringIntoWorkspace(workspaceId: string, change: ChangeSet): Promise<void> {
  await (await getBackend()).push(workspaceId, change);
}
