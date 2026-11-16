import type { Review } from "./cloud/collab";
import type { Tables } from "./cloud/tables";
import { sameValue } from "./cloud/tables";
import { newId, nowIso } from "./model";
import type { Adr, AdrStatus, ModelObject, Workspace } from "./types";

/**
 * Architecture decision records: what was decided, why, and what follows from it.
 * A record is written once. Its text is fixed when it is decided; a later decision
 * supersedes it instead of rewriting it, so the log stays a history.
 */

export const ADR_STATUS_LABEL: Record<AdrStatus, string> = { proposed: "Proposed", accepted: "Accepted", rejected: "Rejected", superseded: "Superseded" };

export const adrLabel = (adr: Pick<Adr, "number">) => `ADR-${adr.number}`;

export const nextAdrNumber = (adrs: Record<string, Adr>) => Object.values(adrs).reduce((max, a) => Math.max(max, a.number), 0) + 1;

/** Newest first. */
export const sortedAdrs = (ws: Pick<Workspace, "adrs">): Adr[] => Object.values(ws.adrs).sort((a, b) => b.number - a.number || b.createdAt.localeCompare(a.createdAt));

export const adrsAbout = (ws: Pick<Workspace, "adrs">, objectId: string): Adr[] => sortedAdrs(ws).filter((a) => a.objectIds.includes(objectId));

/** The text of a decided record is fixed. */
export const adrLocked = (adr: Adr) => adr.status !== "proposed";

export interface AdrInput {
  title: string;
  context?: string;
  decision?: string;
  consequences?: string;
  objectIds?: string[];
  author: string;
}

const clean = (ws: Pick<Workspace, "objects">, ids: string[] | undefined) => [...new Set(ids ?? [])].filter((id) => ws.objects[id]);

export function createAdr(ws: Workspace, input: AdrInput): { ws: Workspace; adr: Adr } {
  const now = nowIso();
  const adr: Adr = {
    id: newId("adr"),
    number: nextAdrNumber(ws.adrs),
    title: input.title.trim() || "Untitled decision",
    status: "proposed",
    context: input.context?.trim() ?? "",
    decision: input.decision?.trim() ?? "",
    consequences: input.consequences?.trim() ?? "",
    objectIds: clean(ws, input.objectIds),
    supersededBy: null,
    origin: "manual",
    author: input.author,
    decidedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  return { ws: { ...ws, adrs: { ...ws.adrs, [adr.id]: adr }, updatedAt: now }, adr };
}

export type AdrPatch = Partial<Pick<Adr, "title" | "context" | "decision" | "consequences">>;

/** Changes the text of a record that is still proposed. A decided record is left as it is. */
export function updateAdr(ws: Workspace, id: string, patch: AdrPatch): Workspace {
  const adr = ws.adrs[id];
  if (!adr || adrLocked(adr)) return ws;
  const next: Adr = { ...adr, ...patch, title: (patch.title ?? adr.title).trim() || adr.title, updatedAt: nowIso() };
  if (sameValue({ ...adr, updatedAt: "" }, { ...next, updatedAt: "" })) return ws;
  return { ...ws, adrs: { ...ws.adrs, [id]: next }, updatedAt: next.updatedAt };
}

/** The objects a record is about can be corrected at any time: they are a pointer, not part of the decision. */
export function setAdrObjects(ws: Workspace, id: string, objectIds: string[]): Workspace {
  const adr = ws.adrs[id];
  if (!adr) return ws;
  const now = nowIso();
  return { ...ws, adrs: { ...ws.adrs, [id]: { ...adr, objectIds: clean(ws, objectIds), updatedAt: now } }, updatedAt: now };
}

export function decideAdr(ws: Workspace, id: string, status: "accepted" | "rejected"): Workspace {
  const adr = ws.adrs[id];
  if (!adr || adr.status !== "proposed") return ws;
  const now = nowIso();
  return { ...ws, adrs: { ...ws.adrs, [id]: { ...adr, status, decidedAt: now, updatedAt: now } }, updatedAt: now };
}

/** Writes a new proposed record that will replace an accepted one, carrying over what it was about. */
export function supersedeAdr(ws: Workspace, id: string, author: string): { ws: Workspace; adr: Adr | null } {
  const old = ws.adrs[id];
  if (!old || old.status !== "accepted") return { ws, adr: null };
  const made = createAdr(ws, {
    title: old.title,
    context: `Replaces ${adrLabel(old)}: ${old.title}.`,
    objectIds: old.objectIds,
    author,
  });
  const now = nowIso();
  return {
    ws: { ...made.ws, adrs: { ...made.ws.adrs, [old.id]: { ...old, status: "superseded", supersededBy: made.adr.id, updatedAt: now } } },
    adr: made.adr,
  };
}

/** Only a record nobody has decided yet can be thrown away. */
export function deleteAdr(ws: Workspace, id: string): Workspace {
  const adr = ws.adrs[id];
  if (!adr || adrLocked(adr)) return ws;
  const adrs = { ...ws.adrs };
  delete adrs[id];
  // A record this one was going to replace becomes the accepted one again.
  for (const other of Object.values(adrs)) {
    if (other.supersededBy === id) adrs[other.id] = { ...other, status: "accepted", supersededBy: null, updatedAt: nowIso() };
  }
  return { ...ws, adrs, updatedAt: nowIso() };
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/** One record in the usual ADR layout, as Markdown. */
export function adrMarkdown(ws: Pick<Workspace, "objects" | "adrs">, adr: Adr): string {
  const about = adr.objectIds.map((id) => ws.objects[id]?.name).filter(Boolean);
  const replacement = adr.supersededBy ? ws.adrs[adr.supersededBy] : undefined;
  const lines = [
    `# ${adrLabel(adr)}: ${adr.title}`,
    "",
    `- Status: ${ADR_STATUS_LABEL[adr.status]}${replacement ? ` by ${adrLabel(replacement)}` : ""}`,
    `- Date: ${day(adr.decidedAt ?? adr.createdAt)}`,
    `- Author: ${adr.author || "Unknown"}`,
    ...(adr.origin === "review" ? ["- Source: written when a review was closed"] : []),
    ...(about.length ? [`- About: ${about.join(", ")}`] : []),
    "",
    "## Context",
    "",
    adr.context || "Not written.",
    "",
    "## Decision",
    "",
    adr.decision || "Not written.",
    "",
    "## Consequences",
    "",
    adr.consequences || "Not written.",
    "",
  ];
  return lines.join("\n");
}

export const adrLogMarkdown = (ws: Pick<Workspace, "objects" | "adrs">): string =>
  sortedAdrs(ws)
    .reverse()
    .map((adr) => adrMarkdown(ws, adr))
    .join("\n---\n\n");

const counted = (added: number, changed: number, removed: number) => `${added} added, ${changed} changed, ${removed} removed`;

/**
 * The record written when a review closes, so that every approval and rejection leaves a
 * decision behind. The hosted database writes the same record with a trigger; this is what
 * the stand-in backend uses, and what the tests compare the trigger with.
 */
export function reviewAdr(
  review: Review,
  before: Pick<Tables, "objects" | "relationships"> | null,
  after: Pick<Tables, "objects" | "relationships">,
  nameOf: (userId: string | null) => string,
  number: number,
): Adr | null {
  if (review.status !== "approved" && review.status !== "rejected") return null;
  const differs = <T extends { updatedAt: string }>(a: T, b: T) => !sameValue({ ...a, updatedAt: "" }, { ...b, updatedAt: "" });
  const diff = <T extends { id: string; updatedAt: string }>(old: Record<string, T>, now: Record<string, T>) => {
    const added: T[] = [];
    const changed: T[] = [];
    for (const item of Object.values(now)) {
      if (!old[item.id]) added.push(item);
      else if (differs(old[item.id], item)) changed.push(item);
    }
    return { added, changed, removed: Object.keys(old).filter((id) => !now[id]).length };
  };
  const objects = diff<ModelObject>(before?.objects ?? {}, after.objects);
  const relationships = diff(before?.relationships ?? {}, after.relationships);
  const last = review.decisions.at(-1);
  const approvals = review.decisions.filter((d) => d.decision === "approved").map((d) => `${d.stageName}: ${nameOf(d.by)}`);
  const approved = review.status === "approved";
  const at = review.closedAt ?? nowIso();
  return {
    id: `adr_${review.id.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`,
    number,
    title: review.title,
    status: approved ? "accepted" : "rejected",
    context: review.note,
    decision: approved
      ? `Approved in review. ${approvals.join("; ")}.`
      : `Rejected in review at the stage "${last?.stageName ?? ""}" by ${nameOf(last?.by ?? null)}. Reason: ${last?.reason ?? ""}`,
    consequences:
      `Objects: ${counted(objects.added.length, objects.changed.length, objects.removed)}. ` +
      `Relationships: ${counted(relationships.added.length, relationships.changed.length, relationships.removed)}.` +
      (approved ? " The reviewed model became the published version." : " The published version stays as it was."),
    objectIds: [...objects.added, ...objects.changed]
      .map((o) => o.id)
      .sort()
      .slice(0, 200),
    supersededBy: null,
    origin: "review",
    reviewId: review.id,
    versionId: review.versionId,
    author: nameOf(review.submittedBy),
    decidedAt: at,
    createdAt: at,
    updatedAt: at,
  };
}
