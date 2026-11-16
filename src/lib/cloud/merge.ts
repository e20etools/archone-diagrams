import type { ModelObject } from "../types";
import { compareTables, relationshipTitle, type FieldChange } from "./collab";
import { diffTables, patchTables, splitNodeKey, withoutDangling, type ChangeSet, type Tables } from "./tables";

/**
 * Bringing a scenario's changes into the model it was copied from.
 *
 * A scenario and its main model drift apart from both ends, and no copy of the starting point
 * is kept. The time each thing was last changed stands in for it: a difference that the
 * scenario's side changed after the scenario was created is the scenario's work; one that only
 * the main model changed since is the main model moving on, and bringing it over would undo
 * that; one that both changed is for a person to decide.
 */

export type MergeTable = "objects" | "relationships" | "diagrams";
export type MergeSide = "scenario" | "main" | "both";
export interface MergeItem {
  /** `${table}:${id}`, the handle the person ticks. */
  key: string;
  table: MergeTable;
  id: string;
  /** What bringing it over does to the main model. */
  kind: "added" | "changed" | "removed";
  side: MergeSide;
  title: string;
  detail: string;
  fields: FieldChange[];
}

const after = (stamp: string | undefined, since: string | null) => !!since && !!stamp && stamp > since;

/** Which side a difference comes from. Without a starting time everything counts as the scenario's. */
function sideOf(since: string | null, kind: MergeItem["kind"], main?: { createdAt: string; updatedAt: string }, scenario?: { createdAt: string; updatedAt: string }): MergeSide {
  if (!since) return "scenario";
  // Only in the scenario: made there, or deleted from the main model since.
  if (kind === "added") return after(scenario?.createdAt, since) ? "scenario" : "main";
  // Only in the main model: made there since, or deleted in the scenario.
  if (kind === "removed") return after(main?.createdAt, since) ? "main" : after(main?.updatedAt, since) ? "both" : "scenario";
  const here = after(scenario?.updatedAt, since);
  const there = after(main?.updatedAt, since);
  return here && there ? "both" : there ? "main" : "scenario";
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Everything that differs, with the side each difference comes from. */
export function mergeItems(main: Tables, scenario: Tables, since: string | null): MergeItem[] {
  const c = compareTables(main, scenario);
  const names: Record<string, ModelObject> = { ...main.objects, ...scenario.objects };
  const items: MergeItem[] = [];
  const add = (table: MergeTable, id: string, kind: MergeItem["kind"], title: string, detail: string, fields: FieldChange[] = []) =>
    items.push({ key: `${table}:${id}`, table, id, kind, side: sideOf(since, kind, main[table][id], scenario[table][id]), title, detail, fields });

  for (const o of c.objects.added) add("objects", o.id, "added", o.name, "");
  for (const o of c.objects.changed) add("objects", o.after.id, "changed", o.after.name, "", o.fields);
  for (const o of c.objects.removed) add("objects", o.id, "removed", o.name, "");
  for (const r of c.relationships.added) add("relationships", r.id, "added", relationshipTitle(r, names), r.label);
  for (const r of c.relationships.changed) add("relationships", r.after.id, "changed", relationshipTitle(r.after, names), r.after.label, r.fields);
  for (const r of c.relationships.removed) add("relationships", r.id, "removed", relationshipTitle(r, names), r.label);
  for (const d of c.diagrams.added) add("diagrams", d.id, "added", d.name, "");
  for (const d of c.diagrams.changed) {
    const boxes = [d.boxesAdded && `${plural(d.boxesAdded, "box")} added`, d.boxesRemoved && `${plural(d.boxesRemoved, "box")} removed`, d.boxesMoved && `${plural(d.boxesMoved, "box")} moved`].filter(Boolean).join(", ");
    add("diagrams", d.after.id, "changed", d.after.name, boxes, d.fields);
    // Moving a box does not stamp the diagram, so a layout-only difference cannot be dated: it is offered, not assumed.
    if (since && !d.fields.length) items[items.length - 1].side = after(main.diagrams[d.after.id]?.updatedAt, since) ? "both" : "scenario";
  }
  for (const d of c.diagrams.removed) add("diagrams", d.id, "removed", d.name, "");
  return items;
}

export interface MergeResult {
  /** What to save into the main model. */
  change: ChangeSet;
  /** Objects that were not ticked but come along, because something ticked cannot exist without them. */
  brought: string[];
  /** Things of the main model that go because a ticked removal leaves them with nothing to point at. */
  dropped: { relationships: number; boxes: number };
}

/** The change that brings the ticked differences into the main model, kept whole: nothing in it points at something missing. */
export function mergeChange(main: Tables, scenario: Tables, picked: Iterable<string>): MergeResult {
  const keys = new Set(picked);
  const change: Required<Pick<ChangeSet, "objects" | "relationships" | "diagrams" | "nodes">> = { objects: {}, relationships: {}, diagrams: {}, nodes: {} };
  const alongside = new Set<string>();

  // An object comes with the objects it sits inside, when the main model does not have them.
  const bringObject = (id: string, asked: boolean) => {
    const object = scenario.objects[id];
    if (!object) return;
    if (!asked) {
      if (main.objects[id] || id in change.objects) return;
      alongside.add(id);
    } else alongside.delete(id);
    change.objects[id] = object;
    if (object.parentId && !(main.objects[object.parentId] && change.objects[object.parentId] !== null)) bringObject(object.parentId, false);
  };
  const need = (id: string) => {
    if (!main.objects[id] || change.objects[id] === null) bringObject(id, false);
  };

  for (const key of keys) {
    const at = key.indexOf(":");
    const table = key.slice(0, at) as MergeTable;
    const id = key.slice(at + 1);
    if (table === "objects" && !scenario.objects[id] && main.objects[id]) change.objects[id] = null;
    if (table === "relationships" && !scenario.relationships[id] && main.relationships[id]) change.relationships[id] = null;
    if (table === "diagrams" && !scenario.diagrams[id] && main.diagrams[id]) change.diagrams[id] = null;
  }
  for (const key of keys) {
    const at = key.indexOf(":");
    const table = key.slice(0, at) as MergeTable;
    const id = key.slice(at + 1);
    if (table === "objects" && scenario.objects[id]) bringObject(id, true);
    if (table === "relationships" && scenario.relationships[id]) {
      const r = scenario.relationships[id];
      change.relationships[id] = r;
      need(r.sourceId);
      need(r.targetId);
    }
    if (table === "diagrams" && scenario.diagrams[id]) {
      const d = scenario.diagrams[id];
      change.diagrams[id] = d;
      if (d.scopeId) need(d.scopeId);
      // The diagram's boxes become the scenario's: placed as there, and gone where the scenario took them off.
      for (const [nodeId, placement] of Object.entries(scenario.nodes)) {
        const [diagramId, objectId] = splitNodeKey(nodeId);
        if (diagramId !== id) continue;
        change.nodes[nodeId] = placement;
        need(objectId);
      }
      for (const nodeId of Object.keys(main.nodes)) if (splitNodeKey(nodeId)[0] === id && !scenario.nodes[nodeId]) change.nodes[nodeId] = null;
    }
  }

  // Whatever a removal leaves pointing nowhere goes with it, and is counted so the person is told.
  const patched = patchTables(main, change);
  const whole = withoutDangling(patched);
  const dropped = {
    relationships: Object.keys(patched.relationships).length - Object.keys(whole.relationships).length,
    boxes: Object.keys(patched.nodes).filter((key) => !whole.nodes[key] && patched.diagrams[splitNodeKey(key)[0]]).length,
  };
  const { objects, relationships, diagrams, nodes } = diffTables(main, { ...whole, proposals: main.proposals, adrs: main.adrs });
  const brought = [...alongside].filter((id) => !keys.has(`objects:${id}`)).map((id) => scenario.objects[id].name);
  return { change: { ...(objects && { objects }), ...(relationships && { relationships }), ...(diagrams && { diagrams }), ...(nodes && { nodes }) }, brought, dropped };
}
