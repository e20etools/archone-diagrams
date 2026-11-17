import type { CategoryRoles } from "../categories";
import type { TrustPage } from "../trust";
import { AUDIT_PAGE_SIZE, cleanSearch, dayBounds, type AuditEntry } from "./audit";
import { createClient, type PostgrestError, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { BackendError, type ApiKeyInfo, type Backend, type FileKind, type StoredFile, type CloudUser, type LiveLink, type WebhookInfo, type Invite, type LiveHandlers, type Member, type Peer, type PendingInvite, type Role, type WorkspaceSummary } from "./backend";
import { snapshotToTables, type Comment, type Review, type ReviewDecision, type ReviewStage, type VersionInfo } from "./collab";
import { KEY_COLUMNS, SQL_TABLE, fromRow, toRow, type Row } from "./rows";
import { TABLE_NAMES, emptyTables, splitNodeKey, type ChangeSet, type TableName, type Tables } from "./tables";

/** The hosted backend on Supabase: Auth for accounts, Postgres behind row-level security, Realtime for live changes. */

const PAGE = 1000;
const CHUNK = 500;

function fail(error: PostgrestError | { message: string; status?: number; code?: string } | null, fallback: string): never {
  const message = error?.message ?? fallback;
  const code = (error as { code?: string } | null)?.code ?? "";
  const status = (error as { status?: number } | null)?.status;
  if (/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(message)) {
    throw new BackendError("network", "The server could not be reached.");
  }
  if (code === "42501" || code === "28000" || status === 401 || status === 403) throw new BackendError("forbidden", message);
  if (code === "invalid_credentials" || /invalid login credentials/i.test(message)) {
    throw new BackendError("credentials", "That email and password do not match an account.");
  }
  throw new BackendError(code ? "invalid" : "unknown", message);
}

const FILE_BUCKET = "diagram-files";
/** A name safe to keep in storage: letters, digits, dots, dashes and underscores. */
const storageName = (name: string) => (name.normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "file");
const FILE_KINDS_KNOWN = new Set(["vendor", "supporting", "design", "other"]);
const fileRow = (r: Row, diagramIds: string[]): StoredFile => ({
  id: String(r.id),
  name: String(r.name ?? ""),
  kind: (FILE_KINDS_KNOWN.has(String(r.kind)) ? String(r.kind) : "other") as FileKind,
  description: String(r.description ?? ""),
  mime: String(r.mime ?? ""),
  size: Number(r.size ?? 0),
  uploadedBy: typeof r.uploaded_by === "string" ? r.uploaded_by : null,
  uploadedAt: stamp(r.uploaded_at),
  updatedAt: stamp(r.updated_at),
  diagramIds,
});

const trustRow = (r: Row): TrustPage => ({
  token: String(r.token ?? ""),
  enabled: r.enabled === true,
  title: String(r.title ?? ""),
  intro: String(r.intro ?? ""),
  contact: String(r.contact ?? ""),
  diagramId: typeof r.diagram_id === "string" && r.diagram_id ? r.diagram_id : null,
});
const stamp = (value: unknown): string => {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
};
/** A uuid[] column arrives as an array from the API and, on some realtime paths, as the text "{a,b}". */
const uuidList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.length > 2) return value.slice(1, -1).split(",").filter(Boolean);
  return [];
};
const toComment = (row: Row): Comment => ({
  id: String(row.id),
  diagramId: typeof row.diagram_id === "string" ? row.diagram_id : null,
  targetKind: row.target_kind as Comment["targetKind"],
  targetId: String(row.target_id),
  parentId: typeof row.parent_id === "string" ? row.parent_id : null,
  body: String(row.body ?? ""),
  mentions: uuidList(row.mentions),
  resolved: row.resolved === true,
  authorId: typeof row.author_id === "string" ? row.author_id : null,
  createdAt: stamp(row.created_at),
  editedAt: row.edited_at ? stamp(row.edited_at) : null,
});
const toStages = (value: unknown): ReviewStage[] =>
  (Array.isArray(value) ? (value as Row[]) : []).map((s) => ({
    id: String(s.id ?? ""),
    name: String(s.name ?? ""),
    reviewerId: String(s.reviewerId ?? ""),
    checklist: Array.isArray(s.checklist) ? s.checklist.map(String) : [],
  }));
const toReview = (row: Row): Review => ({
  id: String(row.id),
  versionId: String(row.version_id),
  baseVersionId: typeof row.base_version_id === "string" ? row.base_version_id : null,
  title: String(row.title ?? ""),
  note: String(row.note ?? ""),
  status: row.status as Review["status"],
  stages: toStages(row.stages),
  stageIndex: Number(row.stage_index) || 0,
  decisions: (Array.isArray(row.decisions) ? (row.decisions as Row[]) : []).map(
    (d): ReviewDecision => ({
      stageId: String(d.stageId ?? ""),
      stageName: String(d.stageName ?? ""),
      by: String(d.by ?? ""),
      decision: d.decision as ReviewDecision["decision"],
      reason: String(d.reason ?? ""),
      checklist: Array.isArray(d.checklist) ? d.checklist.map((c) => c === true) : [],
      to: typeof d.to === "string" ? d.to : undefined,
      at: stamp(d.at),
    }),
  ),
  submittedBy: typeof row.submitted_by === "string" ? row.submitted_by : null,
  submittedAt: stamp(row.submitted_at),
  closedAt: row.closed_at ? stamp(row.closed_at) : null,
});
const VERSION_COLUMNS = "id, name, note, kind, object_count, relationship_count, diagram_count, created_by, created_at";
const COMMENT_COLUMNS = "id, diagram_id, target_kind, target_id, parent_id, body, mentions, resolved, author_id, created_at, edited_at";

export function createSupabaseBackend(url: string, key: string): Backend {
  const supabase: SupabaseClient = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const uid = async (): Promise<string> => {
    const { data } = await supabase.auth.getSession();
    const id = data.session?.user.id;
    if (!id) throw new BackendError("forbidden", "Sign in first.");
    return id;
  };

  async function describeUser(user: { id: string; email?: string; user_metadata?: Record<string, unknown> }): Promise<CloudUser> {
    let name = typeof user.user_metadata?.display_name === "string" ? user.user_metadata.display_name : "";
    const { data } = await supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle();
    if (data && typeof data.display_name === "string" && data.display_name) name = data.display_name;
    return { id: user.id, email: user.email ?? "", name };
  }

  async function fetchAll(table: TableName, workspaceId: string): Promise<Row[]> {
    const rows: Row[] = [];
    for (let from = 0; ; from += PAGE) {
      let query = supabase.from(SQL_TABLE[table]).select("*").eq("workspace_id", workspaceId).eq("deleted", false);
      for (const column of KEY_COLUMNS[table].slice(1)) query = query.order(column);
      const { data, error } = await query.range(from, from + PAGE - 1);
      // A database from before decisions or the workspace's own rules existed has no table for them; the rest of the workspace still opens.
      if (error && (table === "adrs" || table === "rules" || table === "templates" || table === "wizards" || table === "reports" || table === "branding" || table === "library") && (error.code === "42P01" || error.code === "PGRST205")) return rows;
      if (error) fail(error, "The workspace could not be loaded.");
      rows.push(...((data ?? []) as Row[]));
      if (!data || data.length < PAGE) return rows;
    }
  }

  return {
    onAuth(callback) {
      let active = true;
      const { data } = supabase.auth.onAuthStateChange((event, session) => {
        // Supabase asks that no other client call is made inside this callback, so the work is deferred.
        setTimeout(() => {
          if (!active) return;
          if (!session) return callback(null, "session");
          if (event === "TOKEN_REFRESHED") return;
          void describeUser(session.user).then(
            (user) => active && callback(user, event === "PASSWORD_RECOVERY" ? "recovery" : "session"),
            () => active && callback({ id: session.user.id, email: session.user.email ?? "", name: "" }, "session"),
          );
        }, 0);
      });
      return () => {
        active = false;
        data.subscription.unsubscribe();
      };
    },
    async signIn(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) fail(error, "Sign-in failed.");
    },
    async signUp(name, email, password) {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { display_name: name }, emailRedirectTo: window.location.origin },
      });
      if (error) fail(error, "The account could not be created.");
      return { needsConfirmation: !data.session };
    },
    async sendPasswordReset(email) {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
      if (error) fail(error, "The reset email could not be sent.");
    },
    async setPassword(password) {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) fail(error, "The password could not be changed.");
    },
    async updateName(name) {
      const id = await uid();
      const { error } = await supabase.from("profiles").update({ display_name: name }).eq("id", id);
      if (error) fail(error, "The name could not be saved.");
      await supabase.auth.updateUser({ data: { display_name: name } });
    },
    async signOut() {
      await supabase.auth.signOut();
    },
    async accessToken() {
      return (await supabase.auth.getSession()).data.session?.access_token ?? null;
    },

    async listWorkspaces() {
      const id = await uid();
      let { data, error } = await supabase.from("workspace_members").select("role, domains, category_roles, workspaces (id, name, scenario_of, scenario_note, created_at)").eq("user_id", id);
      // Before the category migration there is no category_roles column.
      if (error && (error.code === "42703" || /category_roles/.test(error.message))) {
        ({ data, error } = (await supabase.from("workspace_members").select("role, domains, workspaces (id, name, scenario_of, scenario_note, created_at)").eq("user_id", id)) as unknown as { data: typeof data; error: typeof error });
      }
      // A database that has not had the domain-limit migration yet has no such column; everything else still works.
      if (error && (error.code === "42703" || /domains/.test(error.message))) {
        ({ data, error } = (await supabase.from("workspace_members").select("role, workspaces (id, name, scenario_of, scenario_note, created_at)").eq("user_id", id)) as unknown as { data: typeof data; error: typeof error });
      }
      if (error) fail(error, "Your workspaces could not be listed.");
      const out: WorkspaceSummary[] = [];
      type Listed = { id: string; name: string; scenario_of: string | null; scenario_note: string | null; created_at?: string | null };
      for (const row of (data ?? []) as unknown as { role: Role; domains: string[] | null; category_roles?: CategoryRoles | null; workspaces: Listed | Listed[] | null }[]) {
        const workspace = Array.isArray(row.workspaces) ? row.workspaces[0] : row.workspaces;
        if (workspace) out.push({ id: workspace.id, name: workspace.name, role: row.role, scenarioOf: workspace.scenario_of ?? null, scenarioNote: workspace.scenario_note ?? "", createdAt: workspace.created_at ? stamp(workspace.created_at) : null, domains: row.role === "editor" && Array.isArray(row.domains) && row.domains.length ? row.domains : null, categoryRoles: row.category_roles ?? {} });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    async createWorkspace(name) {
      const { data, error } = await supabase.rpc("create_workspace", { p_name: name });
      if (error) fail(error, "The workspace could not be created.");
      return String(data);
    },
    async renameWorkspace(workspaceId, name) {
      // The access rules skip rows a person may not change without raising an error, so the
      // changed row is asked for and its absence is the refusal.
      const { data, error } = await supabase.from("workspaces").update({ name }).eq("id", workspaceId).select("id");
      if (error) fail(error, "The workspace could not be renamed.");
      if (!data?.length) throw new BackendError("forbidden", "Only an owner can rename the workspace.");
    },
    async deleteWorkspace(workspaceId) {
      const { data, error } = await supabase.from("workspaces").delete().eq("id", workspaceId).select("id");
      if (error) fail(error, "The workspace could not be deleted.");
      if (!data?.length) throw new BackendError("forbidden", "Only an owner can delete the workspace.");
    },
    async myInvites() {
      const { data, error } = await supabase.rpc("my_invites");
      if (error) fail(error, "Your invitations could not be listed.");
      return ((data ?? []) as Row[]).map(
        (r): Invite => ({ id: String(r.id), workspaceId: String(r.workspace_id), workspaceName: String(r.workspace_name), role: r.role as Role, invitedBy: String(r.invited_by_name ?? "") }),
      );
    },
    async acceptInvite(inviteId) {
      const { data, error } = await supabase.rpc("accept_invite", { p_invite: inviteId });
      if (error) fail(error, "The invitation could not be accepted.");
      return String(data);
    },
    async declineInvite(inviteId) {
      const { error } = await supabase.rpc("decline_invite", { p_invite: inviteId });
      if (error) fail(error, "The invitation could not be declined.");
    },
    async listPeople(workspaceId) {
      const [people, invites] = await Promise.all([
        supabase.rpc("workspace_people", { p_workspace: workspaceId }),
        supabase.from("workspace_invites").select("id, email, role").eq("workspace_id", workspaceId).order("created_at"),
      ]);
      if (people.error) fail(people.error, "The members could not be listed.");
      return {
        members: ((people.data ?? []) as Row[]).map((r): Member => ({ userId: String(r.user_id), email: String(r.email), name: String(r.display_name ?? ""), role: r.role as Role, domains: Array.isArray(r.domains) && r.domains.length ? (r.domains as string[]) : null, categoryRoles: (r.category_roles as CategoryRoles | null) ?? {} })),
        // Only owners may read invitations; for everyone else the list is simply empty.
        invites: ((invites.data ?? []) as Row[]).map((r): PendingInvite => ({ id: String(r.id), email: String(r.email), role: r.role as Role })),
      };
    },
    async invite(workspaceId, email, role) {
      const { error } = await supabase.from("workspace_invites").insert({ workspace_id: workspaceId, email: email.trim().toLowerCase(), role, invited_by: await uid() });
      if (error?.code === "23505") throw new BackendError("invalid", "That address already has an invitation.");
      if (error) fail(error, "The invitation could not be saved.");
    },
    async cancelInvite(inviteId) {
      const { error } = await supabase.from("workspace_invites").delete().eq("id", inviteId);
      if (error) fail(error, "The invitation could not be cancelled.");
    },
    async setRole(workspaceId, userId, role) {
      const { error } = await supabase.from("workspace_members").update({ role }).eq("workspace_id", workspaceId).eq("user_id", userId);
      if (error) fail(error, "The role could not be changed.");
    },
    async removeMember(workspaceId, userId) {
      const { error } = await supabase.from("workspace_members").delete().eq("workspace_id", workspaceId).eq("user_id", userId);
      if (error) fail(error, "The member could not be removed.");
    },

    async load(workspaceId) {
      const tables = emptyTables();
      const loaded = await Promise.all(TABLE_NAMES.map((table) => fetchAll(table, workspaceId)));
      TABLE_NAMES.forEach((table, i) => {
        const target = tables[table] as Record<string, unknown>;
        for (const row of loaded[i]) {
          const { key, value } = fromRow(table, row);
          if (value !== null) target[key] = value;
        }
      });
      return tables as Tables;
    },

    async push(workspaceId, change) {
      // Saves first, then deletion marks, table by table. Each call is safe to repeat after a failure.
      for (const table of TABLE_NAMES) {
        const entries = Object.entries(change[table] ?? {});
        const rows = entries.filter(([, value]) => value !== null).map(([key, value]) => toRow(table, workspaceId, key, value));
        for (let i = 0; i < rows.length; i += CHUNK) {
          const { error } = await supabase.from(SQL_TABLE[table]).upsert(rows.slice(i, i + CHUNK), { onConflict: KEY_COLUMNS[table].join(",") });
          if (error) fail(error, "The change could not be saved.");
        }
        const removed = entries.filter(([, value]) => value === null).map(([key]) => key);
        if (!removed.length) continue;
        if (table === "nodes") {
          const byDiagram = new Map<string, string[]>();
          for (const key of removed) {
            const [diagramId, objectId] = splitNodeKey(key);
            byDiagram.set(diagramId, [...(byDiagram.get(diagramId) ?? []), objectId]);
          }
          for (const [diagramId, objectIds] of byDiagram) {
            for (let i = 0; i < objectIds.length; i += CHUNK) {
              const { error } = await supabase.from("diagram_nodes").update({ deleted: true }).eq("workspace_id", workspaceId).eq("diagram_id", diagramId).in("object_id", objectIds.slice(i, i + CHUNK));
              if (error) fail(error, "The change could not be saved.");
            }
          }
        } else {
          for (let i = 0; i < removed.length; i += CHUNK) {
            const { error } = await supabase.from(SQL_TABLE[table]).update({ deleted: true }).eq("workspace_id", workspaceId).in("id", removed.slice(i, i + CHUNK));
            if (error) fail(error, "The change could not be saved.");
          }
        }
      }
    },

    async listComments(workspaceId) {
      const { data, error } = await supabase.from("comments").select(COMMENT_COLUMNS).eq("workspace_id", workspaceId).eq("deleted", false).order("created_at").limit(5000);
      if (error) fail(error, "The comments could not be loaded.");
      return ((data ?? []) as Row[]).map(toComment);
    },
    async addComment(workspaceId, draft) {
      const { data, error } = await supabase
        .from("comments")
        .insert({ workspace_id: workspaceId, diagram_id: draft.diagramId, target_kind: draft.targetKind, target_id: draft.targetId, parent_id: draft.parentId, body: draft.body.trim(), mentions: draft.mentions })
        .select(COMMENT_COLUMNS)
        .single();
      if (error) fail(error, "The comment could not be saved.");
      return toComment(data as Row);
    },
    async updateComment(workspaceId, commentId, patch) {
      const change: Row = {};
      if (patch.body !== undefined) change.body = patch.body.trim();
      if (patch.mentions !== undefined) change.mentions = patch.mentions;
      if (patch.resolved !== undefined) change.resolved = patch.resolved;
      if (patch.deleted) change.deleted = true;
      const { data, error } = await supabase.from("comments").update(change).eq("workspace_id", workspaceId).eq("id", commentId).select("id");
      if (error) fail(error, "The comment could not be changed.");
      if (!data?.length) throw new BackendError("forbidden", "You have view access, so you cannot change comments.");
    },

    async listVersions(workspaceId) {
      const { data, error } = await supabase.from("versions").select(VERSION_COLUMNS).eq("workspace_id", workspaceId).order("created_at", { ascending: false });
      if (error) fail(error, "The versions could not be listed.");
      return ((data ?? []) as Row[]).map(
        (r): VersionInfo => ({
          id: String(r.id),
          name: String(r.name),
          note: String(r.note ?? ""),
          kind: r.kind as VersionInfo["kind"],
          objects: Number(r.object_count) || 0,
          relationships: Number(r.relationship_count) || 0,
          diagrams: Number(r.diagram_count) || 0,
          createdBy: typeof r.created_by === "string" ? r.created_by : null,
          createdAt: stamp(r.created_at),
        }),
      );
    },
    async saveVersion(workspaceId, name, note, safety = false) {
      const { data, error } = await supabase.rpc("save_version", { p_workspace: workspaceId, p_name: name, p_note: note, p_safety: safety });
      if (error) fail(error, "The version could not be saved.");
      return String(data);
    },
    async loadVersion(workspaceId, versionId) {
      // Read through a function that leaves out the diagrams of categories the person may not see.
      const { data, error } = await supabase.rpc("version_snapshot", { p_workspace: workspaceId, p_version: versionId });
      if (error) fail(error, "The version could not be opened.");
      if (!data) throw new BackendError("forbidden", "That version no longer exists, or you may not open it.");
      return snapshotToTables(data);
    },
    async deleteVersion(workspaceId, versionId) {
      const { data, error } = await supabase.from("versions").delete().eq("workspace_id", workspaceId).eq("id", versionId).select("id");
      if (error) fail(error, "The version could not be deleted.");
      if (!data?.length) throw new BackendError("forbidden", "Only an owner can delete a version, and not one that was reviewed or is published.");
    },

    async reviewSettings(workspaceId) {
      const { data, error } = await supabase.from("workspaces").select("review_required, review_stages, published_version_id").eq("id", workspaceId).maybeSingle();
      if (error) fail(error, "The review settings could not be loaded.");
      const row = (data ?? {}) as Row;
      return { required: row.review_required === true, stages: toStages(row.review_stages), publishedVersionId: typeof row.published_version_id === "string" ? row.published_version_id : null };
    },
    async setReviewSettings(workspaceId, required, stages) {
      const { error } = await supabase.rpc("set_review_settings", { p_workspace: workspaceId, p_required: required, p_stages: stages });
      if (error) fail(error, "The review settings could not be saved.");
    },
    async listReviews(workspaceId) {
      const { data, error } = await supabase.from("reviews").select("*").eq("workspace_id", workspaceId).order("submitted_at", { ascending: false }).limit(200);
      if (error) fail(error, "The reviews could not be listed.");
      return ((data ?? []) as Row[]).map(toReview);
    },
    async submitReview(workspaceId, title, note) {
      const { data, error } = await supabase.rpc("submit_review", { p_workspace: workspaceId, p_title: title, p_note: note });
      if (error) fail(error, "The model could not be submitted for review.");
      return String(data);
    },
    async decideReview(_workspaceId, reviewId, approve, reason, checklist) {
      const { error } = await supabase.rpc("decide_review", { p_review: reviewId, p_approve: approve, p_reason: reason, p_checklist: checklist });
      if (error) fail(error, "The decision could not be saved.");
    },
    async delegateReview(_workspaceId, reviewId, toUserId) {
      const { error } = await supabase.rpc("delegate_review", { p_review: reviewId, p_to: toUserId });
      if (error) fail(error, "The stage could not be handed over.");
    },
    async withdrawReview(_workspaceId, reviewId) {
      const { error } = await supabase.rpc("withdraw_review", { p_review: reviewId });
      if (error) fail(error, "The review could not be withdrawn.");
    },

    apiBaseUrl() {
      return `${url.replace(/\/$/, "")}/functions/v1/api/v1`;
    },
    async listApiKeys(workspaceId) {
      const columns = "id, name, prefix, access, created_at, last_used_at, revoked_at";
      const first = await supabase.from("api_keys").select(`${columns}, domains`).eq("workspace_id", workspaceId).order("created_at", { ascending: false });
      // A database that has not had the phase 4 migration yet has no limits on keys.
      const { data, error } = first.error ? await supabase.from("api_keys").select(columns).eq("workspace_id", workspaceId).order("created_at", { ascending: false }) : first;
      if (error) fail(error, "The API keys could not be listed.");
      return ((data ?? []) as Row[]).map(
        (r): ApiKeyInfo => ({ id: String(r.id), name: String(r.name), prefix: String(r.prefix), access: r.access === "write" ? "write" : r.access === "propose" ? "propose" : "read", domains: Array.isArray(r.domains) && r.domains.length ? (r.domains as string[]) : null, createdAt: stamp(r.created_at), lastUsedAt: r.last_used_at ? stamp(r.last_used_at) : null, revokedAt: r.revoked_at ? stamp(r.revoked_at) : null }),
      );
    },
    async createApiKey(workspaceId, name, access, domains) {
      const { data, error } = await supabase.rpc("create_api_key", { p_workspace: workspaceId, p_name: name, p_access: access });
      const row = (Array.isArray(data) ? data[0] : data) as Row | null;
      if (error || !row) fail(error, "The API key could not be created.");
      if (access === "write" && domains?.length) {
        const limit = await supabase.rpc("set_api_key_domains", { p_key: row!.id, p_domains: domains });
        // A key that was meant to be limited must not be left without its limit.
        if (limit.error) {
          await supabase.rpc("revoke_api_key", { p_key: row!.id });
          fail(limit.error, "The key could not be limited to the chosen domains, so it was not created.");
        }
      }
      return { id: String(row!.id), key: String(row!.key) };
    },
    async revokeApiKey(_workspaceId, keyId) {
      const { error } = await supabase.rpc("revoke_api_key", { p_key: keyId });
      if (error) fail(error, "The API key could not be revoked.");
    },
    async listWebhooks(workspaceId) {
      const { data, error } = await supabase.from("webhooks").select("id, url, created_at").eq("workspace_id", workspaceId).order("created_at");
      if (error) fail(error, "The webhooks could not be listed.");
      return ((data ?? []) as Row[]).map((r): WebhookInfo => ({ id: String(r.id), url: String(r.url), createdAt: stamp(r.created_at) }));
    },
    async createWebhook(workspaceId, target) {
      const { data, error } = await supabase.rpc("create_webhook", { p_workspace: workspaceId, p_url: target });
      const row = (Array.isArray(data) ? data[0] : data) as Row | null;
      if (error || !row) fail(error, "The webhook could not be added.");
      return { id: String(row!.id), secret: String(row!.secret) };
    },
    async deleteWebhook(workspaceId, webhookId) {
      const { data, error } = await supabase.from("webhooks").delete().eq("workspace_id", workspaceId).eq("id", webhookId).select("id");
      if (error) fail(error, "The webhook could not be deleted.");
      if (!data?.length) throw new BackendError("forbidden", "Only an owner can delete a webhook.");
    },
    async testWebhook(_workspaceId, webhookId) {
      const { error } = await supabase.rpc("test_webhook", { p_webhook: webhookId });
      if (error) fail(error, "The test could not be sent.");
    },

    async setMemberCategoryRoles(workspaceId, userId, roles) {
      const { error } = await supabase.rpc("set_member_category_roles", { p_workspace: workspaceId, p_user: userId, p_roles: roles });
      if (error) fail(error, "The roles per category could not be saved.");
    },
    async setMemberDomains(workspaceId, userId, domains) {
      const { error } = await supabase.rpc("set_member_domains", { p_workspace: workspaceId, p_user: userId, p_domains: domains });
      if (error) fail(error, "The limit could not be changed.");
    },
    async trustPage(workspaceId) {
      const { data, error } = await supabase.from("trust_pages").select("token, enabled, title, intro, contact, diagram_id").eq("workspace_id", workspaceId).maybeSingle();
      // A database without the trust page migration has no such table: the page is simply not set up.
      if (error && (error.code === "42P01" || error.code === "PGRST205")) return null;
      if (error) fail(error, "The trust page settings could not be read.");
      return data ? trustRow(data as Row) : null;
    },
    async setTrustPage(workspaceId, page) {
      const { data, error } = await supabase.rpc("set_trust_page", { p_workspace: workspaceId, p_enabled: page.enabled, p_title: page.title, p_intro: page.intro, p_contact: page.contact, p_diagram: page.diagramId });
      if (error) fail(error, "The trust page could not be saved.");
      return trustRow(data as Row);
    },
    async createScenario(workspaceId, name, note) {
      const { data, error } = await supabase.rpc("create_scenario", { p_workspace: workspaceId, p_name: name, p_note: note });
      if (error) fail(error, "The scenario could not be created.");
      return String(data);
    },

    async verifyAudit(workspaceId, anchor) {
      const { data, error } = await supabase.rpc("verify_audit_log", { p_workspace: workspaceId, p_anchor_id: anchor?.id ?? null, p_anchor_hash: anchor?.hash ?? null });
      if (error) fail(error, "The audit log could not be checked.");
      const result = (data ?? {}) as Record<string, unknown>;
      const head = result.head as Record<string, unknown> | null | undefined;
      return {
        ok: result.ok === true,
        entries: Number(result.entries) || 0,
        brokenAt: result.brokenAt == null ? null : Number(result.brokenAt),
        head: head ? { id: Number(head.id), hash: String(head.hash), at: stamp(head.at) } : null,
        anchor: result.anchor === "match" || result.anchor === "mismatch" || result.anchor === "missing" ? result.anchor : null,
      };
    },

    async listAudit(workspaceId, query) {
      const limit = query.limit ?? AUDIT_PAGE_SIZE;
      const { since, until } = dayBounds(query.from, query.to);
      const search = cleanSearch(query.search ?? "");
      let request = supabase.from("audit_log").select("id, at, actor_id, actor_name, via, entity, entity_id, entity_name, action, changes").eq("workspace_id", workspaceId);
      if (query.entity) request = request.eq("entity", query.entity);
      if (since) request = request.gte("at", since);
      if (until) request = request.lt("at", until);
      if (query.before !== undefined) request = request.lt("id", query.before);
      if (search) request = request.or(["actor_name", "action", "entity_name"].map((column) => `${column}.ilike."%${search}%"`).join(","));
      const { data, error } = await request.order("id", { ascending: false }).limit(limit + 1);
      if (error) fail(error, "The audit log could not be read.");
      const rows = ((data ?? []) as Row[]).map(
        (r): AuditEntry => ({
          id: Number(r.id),
          at: stamp(r.at),
          actorId: typeof r.actor_id === "string" ? r.actor_id : null,
          actorName: String(r.actor_name),
          via: r.via === "api" || r.via === "system" ? r.via : "app",
          entity: String(r.entity),
          entityId: String(r.entity_id),
          entityName: String(r.entity_name ?? ""),
          action: String(r.action),
          changes: r.changes && typeof r.changes === "object" ? (r.changes as Record<string, unknown>) : {},
        }),
      );
      return { entries: rows.slice(0, limit), more: rows.length > limit };
    },

    async listFiles(workspaceId) {
      const [files, links] = await Promise.all([
        supabase.from("diagram_files").select("id, name, kind, description, mime, size, uploaded_by, uploaded_at, updated_at").eq("workspace_id", workspaceId).order("uploaded_at", { ascending: false }),
        supabase.from("diagram_file_links").select("file_id, diagram_id").eq("workspace_id", workspaceId),
      ]);
      // A database that has not had the file library yet has no files.
      if (files.error) {
        if (/diagram_files|does not exist|schema cache/i.test(files.error.message)) return [];
        fail(files.error, "The files could not be listed.");
      }
      if (links.error) fail(links.error, "The files could not be listed.");
      const byFile = new Map<string, string[]>();
      for (const l of (links.data ?? []) as Row[]) (byFile.get(String(l.file_id)) ?? byFile.set(String(l.file_id), []).get(String(l.file_id))!).push(String(l.diagram_id));
      return ((files.data ?? []) as Row[]).map((r) => fileRow(r, byFile.get(String(r.id)) ?? []));
    },
    async uploadFile(workspaceId, body, upload) {
      const fileId = crypto.randomUUID();
      const path = `${workspaceId}/${fileId}/${storageName(upload.name)}`;
      const user = (await supabase.auth.getUser()).data.user;
      if (!user) throw new BackendError("forbidden", "Sign in again to upload.");
      const { error } = await supabase.from("diagram_files").insert({
        id: fileId,
        workspace_id: workspaceId,
        name: upload.name.trim().slice(0, 200) || "Untitled file",
        kind: upload.kind,
        description: upload.description.slice(0, 2000),
        mime: (body.type || "application/octet-stream").slice(0, 200),
        size: body.size,
        storage_path: path,
        uploaded_by: user.id,
      });
      if (error) fail(error, "The file could not be added.");
      const stored = await supabase.storage.from(FILE_BUCKET).upload(path, body, { contentType: body.type || "application/octet-stream", upsert: false });
      if (stored.error) {
        // Nothing half-kept: without the file, its record goes too.
        await supabase.from("diagram_files").delete().eq("id", fileId);
        fail({ message: stored.error.message }, "The file could not be uploaded.");
      }
      if (upload.diagramIds.length) {
        const linked = await supabase.from("diagram_file_links").insert(upload.diagramIds.map((d) => ({ workspace_id: workspaceId, file_id: fileId, diagram_id: d, linked_by: user.id })));
        if (linked.error) fail(linked.error, "The file was uploaded, but could not be linked to every diagram chosen.");
      }
      const { data, error: readError } = await supabase.from("diagram_files").select("id, name, kind, description, mime, size, uploaded_by, uploaded_at, updated_at").eq("id", fileId).single();
      if (readError) fail(readError, "The file was uploaded but could not be read back.");
      return fileRow(data as Row, upload.diagramIds);
    },
    async fileUrl(_workspaceId, fileId, download) {
      const { data, error } = await supabase.from("diagram_files").select("storage_path, name").eq("id", fileId).single();
      if (error || !data) fail(error, "That file is not there, or you may not open it.");
      const signed = await supabase.storage.from(FILE_BUCKET).createSignedUrl(String((data as Row).storage_path), 120, download ? { download: String((data as Row).name) } : undefined);
      if (signed.error || !signed.data) fail({ message: signed.error?.message ?? "" }, "The file could not be opened.");
      return signed.data.signedUrl;
    },
    async updateFile(_workspaceId, fileId, patch) {
      const row: Row = {};
      if (patch.name !== undefined) row.name = patch.name.trim().slice(0, 200);
      if (patch.kind !== undefined) row.kind = patch.kind;
      if (patch.description !== undefined) row.description = patch.description.slice(0, 2000);
      const { data, error } = await supabase.from("diagram_files").update(row).eq("id", fileId).select("id");
      if (error) fail(error, "The file could not be changed.");
      if (!data?.length) throw new BackendError("forbidden", "Only the person who uploaded a file, or an owner, can change it.");
    },
    async setFileLinks(workspaceId, fileId, diagramIds) {
      const { data, error } = await supabase.from("diagram_file_links").select("diagram_id").eq("file_id", fileId);
      if (error) fail(error, "The links could not be read.");
      const now = new Set(((data ?? []) as Row[]).map((r) => String(r.diagram_id)));
      const want = new Set(diagramIds);
      const drop = [...now].filter((d) => !want.has(d));
      const add = [...want].filter((d) => !now.has(d));
      if (drop.length) {
        const removed = await supabase.from("diagram_file_links").delete().eq("file_id", fileId).in("diagram_id", drop).select("diagram_id");
        if (removed.error) fail(removed.error, "The links could not be changed.");
        if ((removed.data ?? []).length < drop.length) throw new BackendError("forbidden", "Only the person who uploaded a file, an owner, or an editor of the diagram can remove a link.");
      }
      if (add.length) {
        const user = (await supabase.auth.getUser()).data.user;
        const linked = await supabase.from("diagram_file_links").insert(add.map((d) => ({ workspace_id: workspaceId, file_id: fileId, diagram_id: d, linked_by: user?.id })));
        if (linked.error) fail(linked.error, "The file could not be linked to every diagram chosen: you can link only your own files, to diagrams you can edit.");
      }
    },
    async deleteFile(_workspaceId, fileId) {
      const { data, error } = await supabase.from("diagram_files").select("storage_path").eq("id", fileId).single();
      if (error || !data) fail(error, "That file is not there, or you may not delete it.");
      const removed = await supabase.storage.from(FILE_BUCKET).remove([String((data as Row).storage_path)]);
      if (removed.error) fail({ message: removed.error.message }, "The file could not be deleted.");
      const gone = await supabase.from("diagram_files").delete().eq("id", fileId).select("id");
      if (gone.error) fail(gone.error, "The file could not be deleted.");
      if (!gone.data?.length) throw new BackendError("forbidden", "Only the person who uploaded a file, or an owner, can delete it.");
    },

    async listLiveLinks(workspaceId, diagramId) {
      const { data, error } = await supabase.from("embeds").select("id, token, diagram_id, created_by, created_at, protected, expires_at").eq("workspace_id", workspaceId).eq("diagram_id", diagramId).is("revoked_at", null).order("created_at");
      if (error) fail(error, "The live links could not be listed.");
      return ((data ?? []) as Row[]).map((r): LiveLink => ({ id: String(r.id), token: String(r.token), diagramId: String(r.diagram_id), createdBy: typeof r.created_by === "string" ? r.created_by : null, createdAt: stamp(r.created_at), protected: r.protected === true, expiresAt: r.expires_at ? stamp(r.expires_at) : null }));
    },
    async createLiveLink(workspaceId, diagramId, options) {
      const { error } = await supabase.rpc("create_embed", {
        p_workspace: workspaceId,
        p_diagram: diagramId,
        // Sent only when asked for, so a database that has not had the migration yet still creates open links.
        ...(options?.password ? { p_password: options.password } : {}),
        ...(options?.expiresAt ? { p_expires_at: options.expiresAt } : {}),
      });
      if (error) fail(error, "The live link could not be created.");
    },
    async revokeLiveLink(_workspaceId, linkId) {
      const { error } = await supabase.rpc("revoke_embed", { p_embed: linkId });
      if (error) fail(error, "The live link could not be switched off.");
    },

    connect(workspaceId, me, handlers: LiveHandlers) {
      const tabKey = `${me.id}:${Math.random().toString(36).slice(2, 8)}`;
      let presence = { userId: me.id, name: me.name || me.email, diagramId: null as string | null };
      let subscribed = false;
      // Changes arrive row by row; a short pause groups a burst (an import, a paste) into one update.
      let pending: ChangeSet = {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const queue = (table: TableName, key: string, value: unknown | null) => {
        ((pending as Record<string, Record<string, unknown>>)[table] ??= {})[key] = value;
        clearTimeout(timer);
        timer = setTimeout(() => {
          const batch = pending;
          pending = {};
          handlers.onChanges(batch);
        }, 40);
      };

      const channel: RealtimeChannel = supabase.channel(`workspace:${workspaceId}`, { config: { presence: { key: tabKey } } });
      for (const table of TABLE_NAMES) {
        channel.on("postgres_changes", { event: "*", schema: "public", table: SQL_TABLE[table], filter: `workspace_id=eq.${workspaceId}` }, (payload) => {
          // Rows are marked deleted rather than removed, so only inserts and updates carry model changes.
          if (payload.eventType === "DELETE") return;
          const row = payload.new as Row;
          if (row.workspace_id !== workspaceId) return;
          const { key, value } = fromRow(table, row);
          queue(table, key, value);
        });
      }
      channel.on("postgres_changes", { event: "*", schema: "public", table: "comments", filter: `workspace_id=eq.${workspaceId}` }, (payload) => {
        if (payload.eventType === "DELETE") return;
        const row = payload.new as Row;
        if (row.workspace_id !== workspaceId) return;
        handlers.onComment(row.deleted === true ? { id: String(row.id), removed: true } : toComment(row));
      });
      channel.on("postgres_changes", { event: "*", schema: "public", table: "reviews", filter: `workspace_id=eq.${workspaceId}` }, () => handlers.onCollab());
      channel.on("postgres_changes", { event: "UPDATE", schema: "public", table: "workspaces", filter: `id=eq.${workspaceId}` }, () => handlers.onCollab());
      // Delete events cannot be filtered by the server, so the workspace is checked here.
      channel.on("postgres_changes", { event: "*", schema: "public", table: "workspace_members" }, (payload) => {
        const row = (payload.eventType === "DELETE" ? payload.old : payload.new) as Row;
        if (!row.workspace_id || row.workspace_id === workspaceId) handlers.onMembership();
      });
      channel.on("presence", { event: "sync" }, () => {
        const state = channel.presenceState<{ userId: string; name: string; diagramId: string | null }>();
        const peers: Peer[] = [];
        for (const [peerKey, entries] of Object.entries(state)) {
          const latest = entries[entries.length - 1];
          if (latest && peerKey !== tabKey) peers.push({ key: peerKey, userId: latest.userId, name: latest.name, diagramId: latest.diagramId ?? null });
        }
        handlers.onPeers(peers);
      });
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          subscribed = true;
          void channel.track(presence);
          handlers.onStatus("live");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          subscribed = false;
          handlers.onStatus("reconnecting");
        }
      });

      return {
        setPresence(diagramId) {
          if (presence.diagramId === diagramId) return;
          presence = { ...presence, diagramId };
          if (subscribed) void channel.track(presence);
        },
        close() {
          clearTimeout(timer);
          void supabase.removeChannel(channel);
        },
      };
    },
  };
}
