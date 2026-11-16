import type { Workspace } from "../types";

/**
 * An editor limited to domains (PRD NFR-02) changes only what sits inside them. The database
 * enforces this; the same rule is applied here first, so a change that would be refused is
 * never made on screen, instead of being made and then failing to save.
 */

const inside = (ws: Workspace, objectId: string, domains: string[]): boolean => {
  let id = ws.objects[objectId]?.parentId ?? null;
  for (let depth = 0; id && depth < 12; depth++) {
    if (domains.includes(id)) return true;
    id = ws.objects[id]?.parentId ?? null;
  }
  return false;
};

/** Why a change is outside the limit, or null when it is allowed. Diagrams and their layout are never limited. */
export function scopeRefusal(before: Workspace, after: Workspace, domains: string[] | null): string | null {
  if (!domains) return null;
  const names = domains.map((id) => after.objects[id]?.name ?? before.objects[id]?.name).filter(Boolean);
  const reason = `You can only change what is inside ${names.length ? names.join(", ") : "the domains you were given"}. Ask an owner if this needs changing.`;
  if (before.objects !== after.objects) {
    for (const id of new Set([...Object.keys(before.objects), ...Object.keys(after.objects)])) {
      const [was, is] = [before.objects[id], after.objects[id]];
      if (was === is) continue;
      // Only what a person can set counts; a timestamp refreshed along the way does not.
      if (was && is && JSON.stringify({ ...was, updatedAt: "" }) === JSON.stringify({ ...is, updatedAt: "" })) continue;
      if ((was && !inside(before, id, domains)) || (is && !inside(after, id, domains))) return reason;
    }
  }
  if (before.relationships !== after.relationships) {
    for (const id of new Set([...Object.keys(before.relationships), ...Object.keys(after.relationships)])) {
      const [was, is] = [before.relationships[id], after.relationships[id]];
      if (was === is) continue;
      if (was && !inside(before, was.sourceId, domains) && !inside(before, was.targetId, domains)) return reason;
      if (is && !inside(after, is.sourceId, domains) && !inside(after, is.targetId, domains)) return reason;
    }
  }
  return null;
}
