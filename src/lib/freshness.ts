import { nowIso, updateObject } from "./model";
import type { Diagram, ModelObject, Workspace } from "./types";
import { visibleEdges } from "./views";

/**
 * A model is only worth what is still true in it. Every object carries the day someone last
 * confirmed its facts, and that confirmation wears off: the longer ago, the less it counts.
 * The same idea answers a printed diagram: is the copy in your hand still what the model says?
 */

export const TRUTH_FIELDS = { on: "Verified on", by: "Verified by" } as const;

const DAY = 86_400_000;

/** How often an object's facts are due for a look. What the business leans on hardest is checked twice as often. */
export const reviewIntervalDays = (o: Pick<ModelObject, "tags">) => (o.tags.includes("tier-1") ? 90 : 180);

/** Planned things are not facts yet, and retired things no longer change. */
export const truthMatters = (o: Pick<ModelObject, "lifecycle">) => o.lifecycle === "active" || o.lifecycle === "deprecated";

export type TruthState = "fresh" | "aging" | "stale";
export const TRUTH_STATE_LABEL: Record<TruthState, string> = { fresh: "Fresh", aging: "Ageing", stale: "Stale" };

export interface Truth {
  /** When its facts were last confirmed, or when it was added if nobody has confirmed them since. */
  since: string;
  confirmed: boolean;
  by: string;
  ageDays: number;
  intervalDays: number;
  state: TruthState;
  /** From 1 down towards 0, halving every interval. */
  confidence: number;
}

const time = (value: string | undefined) => {
  const at = value ? Date.parse(value) : NaN;
  return Number.isNaN(at) ? null : at;
};

export function truthOf(o: ModelObject, now = Date.now()): Truth {
  const confirmedAt = time(o.fields[TRUTH_FIELDS.on]);
  const since = confirmedAt ?? time(o.createdAt) ?? now;
  const ageDays = Math.max(0, Math.floor((now - since) / DAY));
  const intervalDays = reviewIntervalDays(o);
  const ratio = ageDays / intervalDays;
  return {
    since: new Date(since).toISOString(),
    confirmed: confirmedAt !== null,
    by: confirmedAt !== null ? (o.fields[TRUTH_FIELDS.by] ?? "") : "",
    ageDays,
    intervalDays,
    state: ratio < 0.5 ? "fresh" : ratio < 1 ? "aging" : "stale",
    confidence: Math.round(0.5 ** ratio * 100) / 100,
  };
}

/** Records that someone looked and the object's facts are still true. */
export function confirmTruth(ws: Workspace, objectId: string, by: string, at = nowIso()): Workspace {
  const object = ws.objects[objectId];
  if (!object) return ws;
  return updateObject(ws, objectId, { fields: { ...object.fields, [TRUTH_FIELDS.on]: at, [TRUTH_FIELDS.by]: by.trim() || "Unnamed" } });
}

export const staleObjects = (ws: Workspace, now = Date.now()): ModelObject[] => Object.values(ws.objects).filter((o) => truthMatters(o) && truthOf(o, now).state === "stale");

/* ---------- a copy of a diagram, against the model as it is now ---------- */

export interface CopyCheck {
  /** False when the date on the copy cannot be read. */
  valid: boolean;
  asOf: string;
  /** The diagram itself was edited: boxes added, removed or moved, or its settings changed. */
  diagramEdited: boolean;
  /** Objects on the diagram whose details changed since. */
  objects: string[];
  /** Relationships drawn on it that changed or were added since. */
  relationships: number;
  current: boolean;
}

export function checkCopy(ws: Workspace, diagram: Diagram, asOf: string): CopyCheck {
  const at = time(asOf);
  if (at === null) return { valid: false, asOf, diagramEdited: false, objects: [], relationships: 0, current: false };
  const after = (value: string) => (time(value) ?? 0) > at;
  const objects = Object.keys(diagram.nodes)
    .map((id) => ws.objects[id])
    .filter((o) => o && after(o.updatedAt))
    .map((o) => o.name)
    .sort();
  const relationshipIds = new Set(visibleEdges(ws, diagram).flatMap((e) => e.relationshipIds));
  const relationships = [...relationshipIds].filter((id) => ws.relationships[id] && after(ws.relationships[id].updatedAt)).length;
  const diagramEdited = after(diagram.updatedAt);
  return { valid: true, asOf: new Date(at).toISOString(), diagramEdited, objects, relationships, current: !diagramEdited && !objects.length && !relationships };
}
