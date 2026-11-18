import { categoryRank, viewCategory } from "../categories";
import { canCommentRole, canEditRole } from "../cloud/backend";
import { cloudEnabled } from "../cloud/config";
import { liveLinkUrl } from "../cloud/embed";
import { addComment, approvalStep, errorText, getBackend, saveNow, useSession } from "../cloud/session";
import { STATUS_LABEL } from "../approvals";
import { cloudFiles, localFiles, type FileStore } from "../files";
import { findByName, normalizeName } from "../model";
import { buildSharePayload, encodeShare, shareUrl } from "../share";
import { useStore } from "../store";
import type { Workspace } from "../types";
import { EXPORT_LABEL, OPEN_LABEL, type ActionOp } from "./edits";
import { FILES_CHANGED, askScreen } from "./screen";

/**
 * What the assistant does for the person beyond the model: comments under their name, marked as
 * written with the assistant; sending the diagram for approval; exports, links and presenting;
 * linking files. Each runs with the person's own rights, as they would do it on the screen, and
 * says what it did or why it could not. Undo does not take these back.
 */

export interface ActionsDone {
  lines: string[];
  problems: string[];
  /** Links made for the person to copy. */
  links: { label: string; url: string }[];
}

/** Said at the end of a comment written by the assistant, so the people reading it know. */
export const WRITTEN_WITH_ASSISTANT = "(Written with the assistant.)";

const hosted = () => cloudEnabled && !!useSession.getState().workspaceId;
const NEEDS_ACCOUNTS = "the hosted app with accounts; this copy runs in the browser only";

function rankHere(ws: Workspace, diagramId: string): number {
  const s = useSession.getState();
  const d = ws.diagrams[diagramId];
  if (!cloudEnabled) return 4;
  return d ? categoryRank(s.role, s.myCategoryRoles, viewCategory(d.viewType)) : 0;
}

/** The diagram's files store: on the server when signed in, else this browser's. */
export function filesHere(): FileStore {
  const workspaceId = useSession.getState().workspaceId;
  return cloudEnabled && workspaceId ? cloudFiles(workspaceId) : localFiles;
}

async function comment(ws: Workspace, diagramId: string, op: Extract<ActionOp, { op: "comment" }>): Promise<string> {
  if (!hosted()) throw new Error(`Comments need ${NEEDS_ACCOUNTS}`);
  const s = useSession.getState();
  if (!canCommentRole(s.role) || rankHere(ws, diagramId) < 2) throw new Error("You may not comment on this diagram");
  let targetKind: "diagram" | "object" | "relationship" = "diagram";
  let targetId = diagramId;
  let parentId: string | null = null;
  if (op.reply_to) {
    const parent = s.comments[op.reply_to];
    if (!parent) throw new Error(`No comment "${op.reply_to}" to reply to`);
    // A reply joins the thread of the first comment.
    const root = parent.parentId ? (s.comments[parent.parentId] ?? parent) : parent;
    parentId = root.id;
    targetKind = root.targetKind;
    targetId = root.targetId;
  } else if (op.on && op.on !== "diagram" && op.on !== diagramId && op.on !== `d:${diagramId}`) {
    if (ws.relationships[op.on]) (targetKind = "relationship"), (targetId = op.on);
    else {
      const object = ws.objects[op.on] ?? findByName(ws, op.on);
      if (!object) throw new Error(`No object "${op.on}" to comment on`);
      targetKind = "object";
      targetId = object.id;
    }
  }
  const wanted = (op.mention ?? []).map(normalizeName);
  const mentions = s.people.filter((p) => wanted.includes(normalizeName(p.name)) || wanted.includes(normalizeName(p.email ?? ""))).map((p) => p.userId);
  const body = `${op.text.trim()}\n\n${WRITTEN_WITH_ASSISTANT}`;
  await addComment({ diagramId, targetKind, targetId, parentId, body, mentions });
  const where = targetKind === "diagram" ? "the diagram" : targetKind === "object" ? (ws.objects[targetId]?.name ?? "an object") : "a connection";
  return `${parentId ? "Replied to a comment" : `Wrote a comment on ${where}`}${mentions.length ? `, mentioning ${s.people.filter((p) => mentions.includes(p.userId)).map((p) => p.name).join(", ")}` : ""}`;
}

async function sendForApproval(ws: Workspace, diagramId: string, note: string): Promise<string> {
  if (!hosted()) throw new Error(`Approval needs ${NEEDS_ACCOUNTS}`);
  const s = useSession.getState();
  if (!canEditRole(s.role) || rankHere(ws, diagramId) < 3) throw new Error("You may not send this diagram for approval");
  // The approvers have to see what is on the screen, so the latest changes are saved first.
  await saveNow();
  const record = await approvalStep((backend, workspaceId) => backend.submitDiagram(workspaceId, diagramId, note));
  return `Sent version ${record.version} for approval: ${STATUS_LABEL[record.status]}`;
}

async function share(ws: Workspace, diagramId: string, op: Extract<ActionOp, { op: "share" }>, links: ActionsDone["links"]): Promise<string> {
  const diagram = ws.diagrams[diagramId];
  if (!diagram) throw new Error("The diagram is no longer there");
  const s = useSession.getState();
  const origin = window.location.origin;
  const kind = op.kind ?? (hosted() ? "live" : "snapshot");
  const expiresAt = op.days ? new Date(Date.now() + op.days * 86_400_000).toISOString() : null;
  if (kind === "live") {
    if (!hosted()) throw new Error(`A live link needs ${NEEDS_ACCOUNTS}; ask for a snapshot link instead`);
    if (!canEditRole(s.role)) throw new Error("You may not make links to this diagram");
    const backend = await getBackend();
    const before = new Set((await backend.listLiveLinks(s.workspaceId!, diagramId)).map((l) => l.id));
    await backend.createLiveLink(s.workspaceId!, diagramId, { expiresAt });
    const made = (await backend.listLiveLinks(s.workspaceId!, diagramId)).filter((l) => !before.has(l.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!made) throw new Error("The link was made but could not be read back; find it in Share");
    links.push({ label: "Live link", url: liveLinkUrl(origin, made.token) });
    return `Made a live link${op.days ? ` that stops after ${op.days} days` : ""}. It shows the diagram as it is, without an account, until it is switched off in Share. For a password, open Share.`;
  }
  // A snapshot carries the diagram as it is; while approval comes first, it has to be approved.
  if (hosted()) {
    const record = await (await getBackend()).diagramRecord(s.workspaceId!, diagramId).catch(() => null);
    if (record?.required && record.status !== "approved") throw new Error("This version is not approved, and in this workspace approval comes first: make a live link, which shows the last approved version");
  }
  const token = await encodeShare(buildSharePayload(ws, diagram));
  links.push({ label: "Snapshot link", url: shareUrl(origin, token) });
  return "Made a snapshot link: it holds the diagram as it is now and cannot be switched off. For a password, open Share.";
}

async function linkFile(ws: Workspace, diagramId: string, wanted: string, linked: boolean): Promise<string> {
  const s = useSession.getState();
  if (cloudEnabled && (!canEditRole(s.role) || rankHere(ws, diagramId) < 3)) throw new Error("You may not link files to this diagram");
  const store = filesHere();
  const files = await store.list();
  const key = normalizeName(wanted);
  const file = files.find((f) => f.id === wanted) ?? files.find((f) => normalizeName(f.name) === key) ?? files.find((f) => normalizeName(f.name).startsWith(key)) ?? files.find((f) => normalizeName(f.name).includes(key));
  if (!file) throw new Error(`No file "${wanted}" in the file library`);
  const has = file.diagramIds.includes(diagramId);
  if (has === linked) return `${file.name} was ${linked ? "already linked" : "not linked"}`;
  await store.setLinks(file.id, linked ? [...file.diagramIds, diagramId] : file.diagramIds.filter((id) => id !== diagramId));
  window.dispatchEvent(new Event(FILES_CHANGED));
  return `${linked ? "Linked" : "Unlinked"} the file ${file.name}`;
}

/** Does the actions in order; one that fails does not stop the others. */
export async function runActions(diagramId: string, ops: ActionOp[]): Promise<ActionsDone> {
  const out: ActionsDone = { lines: [], problems: [], links: [] };
  for (const op of ops) {
    // Each reads the model as it is now, after the changes made before it.
    const ws = useStore.getState().ws;
    try {
      switch (op.op) {
        case "comment":
          out.lines.push(await comment(ws, diagramId, op));
          break;
        case "send_for_approval":
          out.lines.push(await sendForApproval(ws, diagramId, op.note ?? ""));
          break;
        case "export":
          out.lines.push(await askScreen(diagramId, { kind: "export", format: op.format }));
          break;
        case "share":
          out.lines.push(await share(ws, diagramId, op, out.links));
          break;
        case "present":
          out.lines.push(await askScreen(diagramId, { kind: "present" }, 10_000));
          break;
        case "open":
          out.lines.push(await askScreen(diagramId, { kind: "open", what: op.what }, 10_000));
          break;
        case "link_file":
        case "unlink_file":
          out.lines.push(await linkFile(ws, diagramId, op.file, op.op === "link_file"));
          break;
      }
    } catch (e) {
      const what = op.op === "export" ? `Export as ${EXPORT_LABEL[op.format]}` : op.op === "open" ? (op.what === "build" ? "Play the build animation" : `Open ${OPEN_LABEL[op.what]}`) : op.op.replace(/_/g, " ");
      out.problems.push(`${what.replace(/^./, (c) => c.toUpperCase())}: ${errorText(e)}`);
    }
  }
  return out;
}
