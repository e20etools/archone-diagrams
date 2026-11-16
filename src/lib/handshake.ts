import { RELATION_KIND_INFO } from "./catalog";
import { nowIso } from "./model";
import type { Relationship, Workspace } from "./types";

/**
 * A dependency is claimed by the side that needs it. The handshake is the other side saying
 * "yes, we know you depend on us": the owner of the target confirms the relationship. A
 * confirmation is for the relationship as it was; changing the relationship takes it back.
 */

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Only a dependency between two different, named owners needs the other side's word. */
export function needsHandshake(ws: Pick<Workspace, "objects">, r: Relationship): boolean {
  const source = ws.objects[r.sourceId];
  const target = ws.objects[r.targetId];
  if (!source || !target || !RELATION_KIND_INFO[r.kind].dependency) return false;
  return !!source.owner.trim() && !!target.owner.trim() && !same(source.owner, target.owner);
}

export type HandshakeState = "none" | "pending" | "confirmed";
export const handshakeState = (ws: Pick<Workspace, "objects">, r: Relationship): HandshakeState => (!needsHandshake(ws, r) ? "none" : r.acknowledgement ? "confirmed" : "pending");

/** The names a person may be written as in an owner field. */
export function namesOf(person: { name?: string; email?: string }, localName = ""): string[] {
  const email = person.email?.trim() ?? "";
  return [localName, person.name ?? "", email, email.split("@")[0]].map((n) => n.trim()).filter(Boolean);
}

export const ownsTarget = (ws: Pick<Workspace, "objects">, r: Relationship, names: string[]) => names.some((n) => same(n, ws.objects[r.targetId]?.owner ?? ""));

export function confirmDependency(ws: Workspace, relationshipId: string, by: string, at = nowIso()): Workspace {
  const r = ws.relationships[relationshipId];
  if (!r || !needsHandshake(ws, r) || r.acknowledgement) return ws;
  // The relationship did not change, so the time of its last change stays: a copy of a diagram is not made stale by a confirmation.
  return { ...ws, relationships: { ...ws.relationships, [r.id]: { ...r, acknowledgement: { by: by.trim() || "Unnamed", at } } }, updatedAt: at };
}

export function withdrawConfirmation(ws: Workspace, relationshipId: string): Workspace {
  const r = ws.relationships[relationshipId];
  if (!r?.acknowledgement) return ws;
  const { acknowledgement: _gone, ...rest } = r;
  return { ...ws, relationships: { ...ws.relationships, [r.id]: rest }, updatedAt: nowIso() };
}

const byNames = (ws: Pick<Workspace, "objects">) => (a: Relationship, b: Relationship) =>
  (ws.objects[a.targetId]?.name ?? "").localeCompare(ws.objects[b.targetId]?.name ?? "") || (ws.objects[a.sourceId]?.name ?? "").localeCompare(ws.objects[b.sourceId]?.name ?? "");

/** Dependencies still waiting for the other side, optionally only those waiting for these names. */
export function pendingHandshakes(ws: Pick<Workspace, "objects" | "relationships">, names?: string[]): Relationship[] {
  return Object.values(ws.relationships)
    .filter((r) => handshakeState(ws, r) === "pending" && (!names || ownsTarget(ws, r, names)))
    .sort(byNames(ws));
}

export function handshakeCounts(ws: Pick<Workspace, "objects" | "relationships">): { needed: number; confirmed: number } {
  let needed = 0;
  let confirmed = 0;
  for (const r of Object.values(ws.relationships)) {
    if (!needsHandshake(ws, r)) continue;
    needed += 1;
    if (r.acknowledgement) confirmed += 1;
  }
  return { needed, confirmed };
}
