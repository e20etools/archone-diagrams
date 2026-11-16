import { startSet, traverse } from "./graph";
import type { ModelObject, Workspace } from "./types";

/**
 * What happens when something stops, and how available a thing can be given what it needs.
 *
 * Both read the dependency relationships as they are drawn, and both assume the plain case:
 * every dependency is needed, and failures do not come together. Standby copies, fallbacks
 * and retries are not modelled, so the numbers are a floor to argue from, not a forecast.
 */

export const AVAILABILITY_FIELD = "Availability %";

/** The availability an object promises on its own, in percent, or null when none is written. */
export function declaredAvailability(o: Pick<ModelObject, "fields">): number | null {
  const raw = (o.fields[AVAILABILITY_FIELD] ?? "").replace("%", "").replace(",", ".").trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= 100 ? value : null;
}

const HOURS_PER_YEAR = 8766;
export const downtimeHours = (availability: number) => Math.round((1 - availability / 100) * HOURS_PER_YEAR * 10) / 10;

export function formatDowntime(hours: number): string {
  if (hours <= 0) return "none";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes a year`;
  if (hours < 48) return `${Math.round(hours * 10) / 10} hours a year`;
  return `${Math.round(hours / 24)} days a year`;
}

export interface Resilience {
  object: ModelObject;
  declared: number | null;
  /** Own availability times that of everything it depends on, each counted once. */
  effective: number;
  /** Everything it depends on, directly or through something else. */
  dependsOn: number;
  /** How many of those, itself included, have no availability written and were counted as always up. */
  undeclared: number;
  /** The least available thing in its chain, itself included. */
  weakest: { object: ModelObject; availability: number } | null;
  downtimeHours: number;
}

export function resilienceOf(ws: Workspace, id: string): Resilience | null {
  const object = ws.objects[id];
  if (!object) return null;
  const chain = [...new Set([...startSet(ws, id), ...traverse(ws, id, "upstream").map((r) => r.id)])].map((member) => ws.objects[member]).filter(Boolean);
  let effective = 1;
  let undeclared = 0;
  let weakest: Resilience["weakest"] = null;
  for (const member of chain) {
    const availability = declaredAvailability(member);
    if (availability === null) {
      undeclared += 1;
      continue;
    }
    effective *= availability / 100;
    if (!weakest || availability < weakest.availability) weakest = { object: member, availability };
  }
  const percent = Math.round(effective * 100 * 10_000) / 10_000;
  return { object, declared: declaredAvailability(object), effective: percent, dependsOn: chain.length - 1, undeclared, weakest, downtimeHours: downtimeHours(percent) };
}

export interface Casualty {
  object: ModelObject;
  /** Steps from the nearest thing that stopped. */
  distance: number;
  /** The names from what stopped to this object. */
  path: string[];
}

export interface FailureReport {
  /** What was switched off, with everything inside it. */
  failed: ModelObject[];
  affected: Casualty[];
  owners: { owner: string; count: number }[];
  /** Affected or failed objects tagged tier-1. */
  tier1: string[];
  /** People and teams who use something that stops. */
  people: string[];
}

/** Everything that stops working when the given objects stop. */
export function simulateFailure(ws: Workspace, failedIds: string[]): FailureReport {
  const down = new Set(failedIds.flatMap((id) => startSet(ws, id)));
  const best = new Map<string, Casualty>();
  for (const id of failedIds) {
    if (!ws.objects[id]) continue;
    const reaches = traverse(ws, id, "downstream");
    const byId = new Map(reaches.map((r) => [r.id, r]));
    for (const reach of reaches) {
      if (down.has(reach.id)) continue;
      const known = best.get(reach.id);
      if (known && known.distance <= reach.distance) continue;
      // Walk back to the thing that stopped, collecting names on the way.
      const path: string[] = [];
      let at = reach.id;
      while (byId.has(at)) {
        path.unshift(ws.objects[at].name);
        at = byId.get(at)!.from;
      }
      path.unshift(ws.objects[at].name);
      best.set(reach.id, { object: ws.objects[reach.id], distance: reach.distance, path });
    }
  }
  const affected = [...best.values()].sort((a, b) => a.distance - b.distance || a.object.name.localeCompare(b.object.name));
  const failed = [...down].map((id) => ws.objects[id]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const counts = new Map<string, number>();
  for (const c of affected) counts.set(c.object.owner.trim(), (counts.get(c.object.owner.trim()) ?? 0) + 1);
  return {
    failed,
    affected,
    owners: [...counts].map(([owner, count]) => ({ owner, count })).sort((a, b) => b.count - a.count || a.owner.localeCompare(b.owner)),
    tier1: [...failed, ...affected.map((c) => c.object)].filter((o) => o.tags.includes("tier-1")).map((o) => o.name).sort(),
    people: affected.filter((c) => c.object.typeId === "actor").map((c) => c.object.name).sort(),
  };
}

export interface SinglePoint {
  object: ModelObject;
  /** How many other objects stop when this one does. */
  dependents: number;
  tier1: number;
  people: number;
}

/** The objects whose failure takes the most with it. */
export function singlePoints(ws: Workspace, limit = 10): SinglePoint[] {
  return Object.values(ws.objects)
    .filter((o) => o.typeId !== "actor" && o.typeId !== "domain")
    .map((object) => {
      const inside = new Set(startSet(ws, object.id));
      const hit = traverse(ws, object.id, "downstream")
        .map((r) => ws.objects[r.id])
        .filter((o) => o && !inside.has(o.id));
      return { object, dependents: hit.filter((o) => o.typeId !== "actor").length, tier1: hit.filter((o) => o.tags.includes("tier-1")).length, people: hit.filter((o) => o.typeId === "actor").length };
    })
    .filter((s) => s.dependents + s.people > 0)
    .sort((a, b) => b.dependents - a.dependents || b.tier1 - a.tier1 || b.people - a.people || a.object.name.localeCompare(b.object.name))
    .slice(0, limit);
}
