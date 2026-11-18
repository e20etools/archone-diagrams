import type { IntegrationId, IntegrationInfo } from "../integrations/catalog";
import type { CategoryRoles } from "../categories";
import type { AuditCheck, AuditPage, AuditQuery } from "./audit";
import type { Comment, CommentDraft, CommentPatch, Review, ReviewSettings, ReviewStage, VersionInfo } from "./collab";
import type { TrustPage, TrustPageInput } from "../trust";
import type { ChangeSet, Tables } from "./tables";
import type { ApprovalQueue, ApprovalRole, ApprovalSettings, DiagramRecord } from "../approvals";

/**
 * Everything the app needs from a hosted backend. The Supabase implementation is in
 * supabaseBackend.ts; demoBackend.ts is a stand-in that runs inside the browser so the
 * sign-in, sharing and live-editing screens can be tried and tested without a server.
 */

export const ROLES = ["owner", "editor", "commenter", "viewer"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_INFO: Record<Role, { label: string; can: string }> = {
  owner: { label: "Owner", can: "Edits the model and manages members" },
  editor: { label: "Editor", can: "Edits the model" },
  commenter: { label: "Commenter", can: "Reads the model and comments" },
  viewer: { label: "Viewer", can: "Reads the model" },
};
export const canEditRole = (role: Role | null) => role === "owner" || role === "editor";
export const canCommentRole = (role: Role | null) => canEditRole(role) || role === "commenter";

export interface CloudUser {
  id: string;
  email: string;
  name: string;
}
export interface WorkspaceSummary {
  id: string;
  name: string;
  role: Role;
  /** The workspace this one is a scenario of, or null for a workspace in its own right. */
  scenarioOf: string | null;
  scenarioNote: string;
  /** When the workspace was created. For a scenario, that is when it was copied from its main model. */
  createdAt: string | null;
  /** The domains an editor is limited to, or null when they may change the whole model. */
  domains: string[] | null;
  /** The member's role in each category, where it narrows the workspace role. */
  categoryRoles: CategoryRoles;
}
export interface Invite {
  id: string;
  workspaceId: string;
  workspaceName: string;
  role: Role;
  invitedBy: string;
}
export interface Member {
  userId: string;
  email: string;
  name: string;
  role: Role;
  domains: string[] | null;
  categoryRoles: CategoryRoles;
}
/** Fair use of the AI as the database counts it: one's own use and limits, the workspace's, and for owners use by person and by day. */
export interface AiLimits {
  hour: number;
  day: number;
  tokensDay: number;
  paused: boolean;
}
export interface AiUsePerson {
  userId: string;
  name: string;
  role: string;
  /** Requests in the last 24 hours, 7 days and 30 days. */
  day: number;
  week: number;
  month: number;
  tokensDay: number;
  tokensMonth: number;
  failed: number;
  lastUsed: string | null;
  limits: AiLimits;
}
export interface AiUsageReport {
  me: { hour: number; day: number; tokensDay: number; limits: AiLimits };
  workspace: { day: number; tokensDay: number; limits: { day: number; tokensDay: number } };
  /** Owners only. */
  people: AiUsePerson[] | null;
  days: { day: string; requests: number; tokens: number }[] | null;
  /** True in a scenario, which follows the limits of the workspace it was made from. */
  scenario: boolean;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: Role;
}
/** Someone who has the workspace open right now. One person with two tabs is two peers. */
export interface Peer {
  key: string;
  userId: string;
  name: string;
  diagramId: string | null;
}

export type KeyAccess = "read" | "propose" | "write";
export interface ApiKeyInfo {
  id: string;
  name: string;
  /** The first characters of the key, to tell keys apart. The key itself is shown once, when it is created. */
  prefix: string;
  access: KeyAccess;
  /** Ids of the domains a write key is limited to; null when it has no limit. */
  domains: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export interface WebhookInfo {
  id: string;
  url: string;
  createdAt: string;
}
/** A link that shows one diagram, read-only and current, until it is switched off. */
export type ApprovalDecision = "approve" | "return" | "reject";
/** A verified copy just published. */
export interface PublishedCopy {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string | null;
  fingerprint: string;
  version: number | null;
}
export interface Publication extends PublishedCopy {
  createdBy: string;
  revokedAt: string | null;
  views: number;
  note: string;
  /** How many exported files were registered with it. */
  files: number;
  /** The diagram still matches it. */
  current: boolean;
}

export interface LiveLink {
  id: string;
  token: string;
  diagramId: string;
  createdBy: string | null;
  createdAt: string;
  /** The link asks for a password before it shows anything. The password itself is never read back. */
  protected: boolean;
  /** When the link stops working by itself, or null for never. */
  expiresAt: string | null;
}
/** What may be asked of a new live link. Both are optional. */
/** A file in the library: a vendor document, a supporting file or a design, linked to diagrams. */
export type FileKind = "vendor" | "supporting" | "design" | "other";
export interface StoredFile {
  id: string;
  name: string;
  kind: FileKind;
  description: string;
  mime: string;
  size: number;
  uploadedBy: string | null;
  uploadedAt: string;
  updatedAt: string;
  /** The diagrams it is linked to that this person can see. */
  diagramIds: string[];
}
export interface FileUpload {
  name: string;
  kind: FileKind;
  description: string;
  diagramIds: string[];
}
export type FilePatch = Partial<Pick<StoredFile, "name" | "kind" | "description">>;

export interface LiveLinkOptions {
  password?: string;
  expiresAt?: string | null;
}
export const LIVE_LINK_MIN_PASSWORD = 8;

export type BackendErrorCode = "credentials" | "forbidden" | "network" | "invalid" | "unknown";
export class BackendError extends Error {
  constructor(
    public code: BackendErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface LiveHandlers {
  onChanges(change: ChangeSet): void;
  /** "live" after every (re)connection: changes made while disconnected may have been missed. */
  onStatus(status: "live" | "reconnecting"): void;
  onMembership(): void;
  onPeers(peers: Peer[]): void;
  /** A comment was written or changed; `removed` when it was deleted. */
  onComment(comment: Comment | { id: string; removed: true }): void;
  /** A review moved, or the workspace's review settings or published version changed. */
  onCollab(): void;
}
export interface LiveConnection {
  setPresence(diagramId: string | null): void;
  close(): void;
}

export interface Backend {
  /** Calls back with the signed-in person (or null) now and on every change. "recovery" follows a password-reset link. */
  onAuth(callback: (user: CloudUser | null, event: "session" | "recovery") => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  signUp(name: string, email: string, password: string): Promise<{ needsConfirmation: boolean }>;
  sendPasswordReset(email: string): Promise<void>;
  setPassword(password: string): Promise<void>;
  updateName(name: string): Promise<void>;
  signOut(): Promise<void>;
  accessToken(): Promise<string | null>;

  listWorkspaces(): Promise<WorkspaceSummary[]>;
  createWorkspace(name: string): Promise<string>;
  renameWorkspace(workspaceId: string, name: string): Promise<void>;
  deleteWorkspace(workspaceId: string): Promise<void>;
  myInvites(): Promise<Invite[]>;
  acceptInvite(inviteId: string): Promise<string>;
  declineInvite(inviteId: string): Promise<void>;
  listPeople(workspaceId: string): Promise<{ members: Member[]; invites: PendingInvite[] }>;
  /** The AI use and limits of the open workspace; null where the database does not count AI use. */
  aiUsageReport(workspaceId: string): Promise<AiUsageReport | null>;
  invite(workspaceId: string, email: string, role: Role): Promise<void>;
  cancelInvite(inviteId: string): Promise<void>;
  setRole(workspaceId: string, userId: string, role: Role): Promise<void>;
  removeMember(workspaceId: string, userId: string): Promise<void>;

  load(workspaceId: string): Promise<Tables>;
  push(workspaceId: string, change: ChangeSet): Promise<void>;

  listComments(workspaceId: string): Promise<Comment[]>;
  addComment(workspaceId: string, draft: CommentDraft): Promise<Comment>;
  updateComment(workspaceId: string, commentId: string, patch: CommentPatch): Promise<void>;

  listVersions(workspaceId: string): Promise<VersionInfo[]>;
  /** Freezes the model as the server holds it now. `safety` marks a copy taken just before a revert. */
  saveVersion(workspaceId: string, name: string, note: string, safety?: boolean): Promise<string>;
  loadVersion(workspaceId: string, versionId: string): Promise<Tables>;
  deleteVersion(workspaceId: string, versionId: string): Promise<void>;

  reviewSettings(workspaceId: string): Promise<ReviewSettings>;
  setReviewSettings(workspaceId: string, required: boolean, stages: ReviewStage[]): Promise<void>;
  listReviews(workspaceId: string): Promise<Review[]>;
  submitReview(workspaceId: string, title: string, note: string): Promise<string>;
  decideReview(workspaceId: string, reviewId: string, approve: boolean, reason: string, checklist: boolean[]): Promise<void>;
  delegateReview(workspaceId: string, reviewId: string, toUserId: string): Promise<void>;
  withdrawReview(workspaceId: string, reviewId: string): Promise<void>;

  /** Where the REST API is served, or null when this backend has none. */
  apiBaseUrl(): string | null;
  listApiKeys(workspaceId: string): Promise<ApiKeyInfo[]>;
  createApiKey(workspaceId: string, name: string, access: KeyAccess, domains?: string[] | null): Promise<{ id: string; key: string }>;
  revokeApiKey(workspaceId: string, keyId: string): Promise<void>;
  /** The services the workspace connects to (Settings → Integrations): settings, never secrets. */
  listIntegrations(workspaceId: string): Promise<IntegrationInfo[]>;
  /** Owners only. A secret left empty is kept; null removes it. */
  saveIntegration(workspaceId: string, provider: IntegrationId, settings: Record<string, string>, secrets: Record<string, string | null>, enabled: boolean): Promise<void>;
  removeIntegration(workspaceId: string, provider: IntegrationId): Promise<void>;
  /** Asks the integrations function to use a connected service: test it, discover, notify, create an issue... */
  useIntegration<T = Record<string, unknown>>(workspaceId: string, provider: IntegrationId | null, action: string, args?: Record<string, unknown>): Promise<T>;
  listWebhooks(workspaceId: string): Promise<WebhookInfo[]>;
  createWebhook(workspaceId: string, url: string): Promise<{ id: string; secret: string }>;
  deleteWebhook(workspaceId: string, webhookId: string): Promise<void>;
  testWebhook(workspaceId: string, webhookId: string): Promise<void>;

  /** The files this person may see: those they uploaded, and those linked to a diagram they can see. */
  listFiles(workspaceId: string): Promise<StoredFile[]>;
  /** Keeps the file and links it to the diagrams given. Owners and editors. */
  uploadFile(workspaceId: string, body: Blob, upload: FileUpload): Promise<StoredFile>;
  /** A short-lived address to open or download the file. */
  fileUrl(workspaceId: string, fileId: string, download?: boolean): Promise<string>;
  updateFile(workspaceId: string, fileId: string, patch: FilePatch): Promise<void>;
  /** Makes the file's links exactly these diagrams (among those this person can see). */
  setFileLinks(workspaceId: string, fileId: string, diagramIds: string[]): Promise<void>;
  deleteFile(workspaceId: string, fileId: string): Promise<void>;

  listLiveLinks(workspaceId: string, diagramId: string): Promise<LiveLink[]>;
  createLiveLink(workspaceId: string, diagramId: string, options?: LiveLinkOptions): Promise<void>;
  revokeLiveLink(workspaceId: string, linkId: string): Promise<void>;

  /* Approving diagrams by Enterprise Architecture and Cybersecurity, and verified copies. */
  approvalSettings(workspaceId: string): Promise<ApprovalSettings>;
  /** Owners only. The lists replace the approvers of each role. */
  setApprovalSettings(workspaceId: string, required: boolean, ea: string[], security: string[]): Promise<ApprovalSettings>;
  diagramRecord(workspaceId: string, diagramId: string): Promise<DiagramRecord>;
  /** Sends the diagram for approval, or sends a returned one again. */
  submitDiagram(workspaceId: string, diagramId: string, note: string): Promise<DiagramRecord>;
  decideDiagram(workspaceId: string, diagramId: string, role: ApprovalRole, decision: ApprovalDecision, note: string): Promise<DiagramRecord>;
  withdrawDiagram(workspaceId: string, diagramId: string): Promise<DiagramRecord>;
  approvalQueue(workspaceId: string): Promise<ApprovalQueue>;
  publishDiagram(workspaceId: string, diagramId: string, options: { expiresAt?: string | null; note?: string }): Promise<PublishedCopy>;
  listPublications(workspaceId: string, diagramId: string): Promise<Publication[]>;
  revokePublication(workspaceId: string, publicationId: string): Promise<void>;
  addPublicationFile(workspaceId: string, publicationId: string, sha256: string, name: string): Promise<void>;

  /** Limits an editor to the given domains, or lifts the limit with null. Owners only. */
  setMemberDomains(workspaceId: string, userId: string, domains: string[] | null): Promise<void>;

  /** Sets a member's role per category; a category left out keeps the workspace role. Owners only. */
  setMemberCategoryRoles(workspaceId: string, userId: string, roles: CategoryRoles): Promise<void>;

  /** Copies the model into a new workspace tied to this one, and returns the new workspace's id. */
  createScenario(workspaceId: string, name: string, note: string): Promise<string>;

  /** The public trust page's settings, or null when it was never set up. Owners only. */
  trustPage(workspaceId: string): Promise<TrustPage | null>;
  setTrustPage(workspaceId: string, page: TrustPageInput): Promise<TrustPage>;

  /** The audit log, newest first. Owners only; anyone else gets an empty page. */
  listAudit(workspaceId: string, query: AuditQuery): Promise<AuditPage>;
  /** Walks the audit log's chain of hashes. With a saved code, also checks that entry is still there unchanged. Owners only. */
  verifyAudit(workspaceId: string, anchor?: { id: number; hash: string }): Promise<AuditCheck>;

  connect(workspaceId: string, me: CloudUser, handlers: LiveHandlers): LiveConnection;
}
