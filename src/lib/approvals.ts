import { TITLE_BLOCK_FIELD_IDS, type Diagram, type TitleBlockField, type Workspace } from "./types";

/**
 * Approving a diagram by Enterprise Architecture and Cybersecurity, and the information box that
 * shows where a diagram stands. The rules live in the database (supabase/migrations/*_diagram_approvals.sql);
 * this file names what it returns and turns it into what a box shows.
 */

export type ApprovalRole = "ea" | "security";
export const APPROVAL_ROLES: ApprovalRole[] = ["ea", "security"];
export const ROLE_LABEL: Record<ApprovalRole, string> = { ea: "Enterprise Architecture", security: "Cybersecurity" };
export const ROLE_SHORT: Record<ApprovalRole, string> = { ea: "EA", security: "Cybersecurity" };

/** A role's word on the open (or last) request: approved the diagram as it is, approved an earlier form, nothing yet, returned or rejected it. */
export type RoleState = "approved" | "stale" | "waiting" | "returned" | "rejected";
export interface RoleStanding {
  state: RoleState;
  by: string;
  at: string | null;
  note: string;
  /** The approver changed the diagram before approving it. */
  withChanges: boolean;
}

export type DiagramStatus = "draft" | "pending" | "returned" | "approved" | "changed" | "rejected";
export type RequestStatus = "pending" | "returned" | "approved" | "rejected" | "withdrawn";
export interface ApprovalRequestInfo {
  id: string;
  version: number;
  status: RequestStatus;
  round: number;
  note: string;
  requestedById: string | null;
  requestedBy: string;
  requestedAt: string;
  sentFingerprint: string;
}

/** Where a diagram stands. */
export interface DiagramStanding {
  fingerprint: string | null;
  status: DiagramStatus;
  /** The version it is (when approved) or is becoming. */
  version: number;
  approvedVersion: number | null;
  approvedAt: string | null;
  approvedFingerprint: string | null;
  request: ApprovalRequestInfo | null;
  roles: Record<ApprovalRole, RoleStanding>;
}

export interface Approver {
  id: string;
  name: string;
}
export type ApprovalEventKind = "submitted" | "resubmitted" | "approved" | "approved_with_changes" | "returned" | "rejected" | "withdrawn" | "completed";
export interface ApprovalEvent {
  kind: ApprovalEventKind;
  role: ApprovalRole | null;
  by: string;
  at: string;
  note: string;
  version: number;
  round: number;
}
export interface Stamped {
  at: string | null;
  by: string;
}

/** What members see about a diagram: its standing, who made and changed it, who approves, its history. */
export interface DiagramRecord extends DiagramStanding {
  diagramId: string;
  /** Approval comes before publishing in this workspace. */
  required: boolean;
  created: Stamped;
  changed: Stamped;
  approvers: Record<ApprovalRole, Approver[]>;
  /** The roles the signed-in person approves for. */
  mine: Record<ApprovalRole, boolean>;
  history: ApprovalEvent[];
}

/** The information box as the database froze it for a copy outside the app. */
export interface BoxRecord extends DiagramStanding {
  diagramId: string;
  name: string;
  workspace: string;
  company: string;
  logo: string;
  show: boolean;
  corner: string;
  hidden: string[];
  requiredFields: string[];
  created: Stamped;
  changed: Stamped;
  required: boolean;
}

export interface ApprovalSettings {
  required: boolean;
  ea: Approver[];
  security: Approver[];
}

export interface QueueItem {
  requestId: string;
  diagramId: string;
  name: string;
  version: number;
  status: "pending" | "returned";
  round: number;
  note: string;
  requestedBy: string;
  requestedById: string | null;
  requestedAt: string;
  updatedAt: string;
  ea: RoleStanding;
  security: RoleStanding;
}
export interface ApprovalQueue {
  mine: Record<ApprovalRole, boolean>;
  open: QueueItem[];
  recent: { requestId: string; diagramId: string; name: string; version: number; status: "approved" | "rejected" | "withdrawn"; requestedBy: string; closedAt: string }[];
}

/** Whether a role still has to act on an open request. */
export const waitsFor = (item: Pick<QueueItem, "status" | "ea" | "security">, role: ApprovalRole) => item.status === "pending" && item[role].state !== "approved";

export const STATUS_LABEL: Record<DiagramStatus, string> = {
  draft: "Not approved yet",
  pending: "Waiting for approval",
  returned: "Returned for changes",
  approved: "Approved",
  changed: "Changed after approval",
  rejected: "Rejected",
};
export const STATUS_TONE: Record<DiagramStatus, "ok" | "warn" | "danger" | "muted" | "blue"> = {
  draft: "muted",
  pending: "blue",
  returned: "warn",
  approved: "ok",
  changed: "warn",
  rejected: "danger",
};

export const EVENT_LABEL: Record<ApprovalEventKind, string> = {
  submitted: "Sent for approval",
  resubmitted: "Sent again",
  approved: "Approved",
  approved_with_changes: "Changed and approved",
  returned: "Returned for changes",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  completed: "Approved by both: a new version",
};

/** A role's cell in the box: yes only when it approved the diagram as it is now. */
export function roleCell(role: RoleStanding | undefined): { yes: boolean; text: string } {
  if (!role) return { yes: false, text: "Not yet" };
  switch (role.state) {
    case "approved":
      return { yes: true, text: role.by ? `${role.withChanges ? "Changed and approved" : "Approved"} by ${role.by}` : "Approved" };
    case "stale":
      return { yes: false, text: "Changed since it was approved" };
    case "returned":
      return { yes: false, text: "Returned for changes" };
    case "rejected":
      return { yes: false, text: "Rejected" };
    default:
      return { yes: false, text: "Not yet" };
  }
}

/** The short code printed on a copy: the start of its fingerprint, in groups, easy to read out and compare. */
export function sealCode(fingerprint: string | null | undefined): string {
  if (!fingerprint || !/^[0-9a-f]{12}/i.test(fingerprint)) return "";
  const head = fingerprint.slice(0, 12).toUpperCase();
  return `${head.slice(0, 4)}-${head.slice(4, 8)}-${head.slice(8, 12)}`;
}

/** What the seal says about the diagram as it is: matches its approved version, differs from it, or nothing was approved. */
export function sealOf(standing: DiagramStanding | null): { code: string; tone: "ok" | "warn" | "muted"; text: string } {
  const code = sealCode(standing?.fingerprint);
  if (!standing) return { code, tone: "muted", text: "Approval needs a shared workspace" };
  if (standing.status === "approved") return { code, tone: "ok", text: `Original: matches approved version ${standing.version}` };
  if (standing.approvedVersion) return { code, tone: "warn", text: `Differs from approved version ${standing.approvedVersion}` };
  return { code, tone: "muted", text: "Not approved yet" };
}

export const FIELD_LABEL: Record<TitleBlockField, string> = {
  company: "Company",
  name: "Diagram",
  version: "Version",
  createdBy: "Created by",
  createdAt: "Created on",
  changedBy: "Last changed by",
  changedAt: "Last changed on",
  ea: "EA approval",
  security: "Cybersecurity approval",
  seal: "Authenticity",
};

const known = (list: readonly string[] | undefined) => (list ?? []).filter((f): f is TitleBlockField => (TITLE_BLOCK_FIELD_IDS as readonly string[]).includes(f));

/** The fields a box shows: all of them, less those the diagram hid, except the ones the workspace requires. */
export function shownFields(hidden: readonly string[] | undefined, required: readonly string[] | undefined): TitleBlockField[] {
  const must = new Set(known(required));
  const off = new Set(known(hidden).filter((f) => !must.has(f)));
  return TITLE_BLOCK_FIELD_IDS.filter((f) => !off.has(f));
}

/** Whether a diagram shows its box: its own setting, or the workspace requiring it. */
export const boxShown = (ws: Pick<Workspace, "branding">, diagram: Pick<Diagram, "titleBlock">) => !!diagram.titleBlock?.show || !!ws.branding?.workspace?.boxRequired;

/** The company a diagram's box names, and its logo: the diagram's own, else the workspace's, else the workspace name. */
export function companyOf(ws: Pick<Workspace, "branding" | "name">, diagram: Pick<Diagram, "titleBlock">): { company: string; logo: string } {
  const branding = ws.branding?.workspace;
  return {
    company: diagram.titleBlock?.company?.trim() || branding?.company?.trim() || ws.name,
    logo: diagram.titleBlock?.logo || branding?.companyLogo || "",
  };
}

export const boxDate = (at: string | null | undefined) =>
  at && !Number.isNaN(new Date(at).getTime()) ? new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

export interface BoxCell {
  field: Exclude<TitleBlockField, "company">;
  label: string;
  value: string;
  /** A yes or no mark, for the approval cells. */
  mark?: "yes" | "no";
  tone?: "ok" | "warn" | "muted";
}
export interface BoxView {
  /** Null when the company field is hidden. */
  company: { name: string; logo: string } | null;
  cells: BoxCell[];
  sealTone: "ok" | "warn" | "muted";
}

export interface BoxInput {
  name: string;
  company: string;
  logo: string;
  /** Null without a shared workspace, where nothing is approved. */
  standing: DiagramStanding | null;
  created: Stamped;
  changed: Stamped;
  fields: readonly TitleBlockField[];
}

/** What an information box shows, cell by cell, the same on the canvas, in an exported picture and on a verified copy. */
export function boxView(input: BoxInput): BoxView {
  const show = new Set(input.fields);
  const { standing } = input;
  const seal = sealOf(standing);
  const cells: BoxCell[] = [];
  const add = (cell: BoxCell) => show.has(cell.field) && cells.push(cell);
  add({ field: "name", label: FIELD_LABEL.name, value: input.name || "Untitled" });
  add({
    field: "version",
    label: FIELD_LABEL.version,
    value: standing ? `${standing.version} · ${STATUS_LABEL[standing.status]}` : "—",
    tone: !standing ? "muted" : standing.status === "approved" ? "ok" : standing.status === "draft" ? "muted" : "warn",
  });
  add({ field: "createdBy", label: FIELD_LABEL.createdBy, value: input.created.by || "—" });
  add({ field: "createdAt", label: FIELD_LABEL.createdAt, value: boxDate(input.created.at) });
  add({ field: "changedBy", label: FIELD_LABEL.changedBy, value: input.changed.by || "—" });
  add({ field: "changedAt", label: FIELD_LABEL.changedAt, value: boxDate(input.changed.at) });
  for (const role of APPROVAL_ROLES) {
    const cell = standing ? roleCell(standing.roles[role]) : null;
    add({ field: role, label: FIELD_LABEL[role], value: cell ? `${cell.yes ? "Yes" : "No"} · ${cell.text}` : "—", mark: cell ? (cell.yes ? "yes" : "no") : undefined, tone: cell ? (cell.yes ? "ok" : "warn") : "muted" });
  }
  add({ field: "seal", label: FIELD_LABEL.seal, value: seal.code ? `${seal.code} · ${seal.text}` : seal.text, tone: seal.tone });
  return { company: show.has("company") ? { name: input.company, logo: input.logo } : null, cells, sealTone: seal.tone };
}

/** The SHA-256 of a file, as hex, to register it with a verified copy or check it against one. */
export async function sha256Hex(data: Blob | ArrayBuffer): Promise<string> {
  const bytes = data instanceof Blob ? await data.arrayBuffer() : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const verifyUrl = (origin: string, token: string) => `${origin.replace(/\/$/, "")}/verify/${token}`;
