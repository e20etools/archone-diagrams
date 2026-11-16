import { traverse } from "../graph";
import type { Workspace } from "../types";
import { compareTables, type Person } from "./collab";
import { fromTables, type Tables } from "./tables";

/**
 * Who a change touches: the owners of what it changes, and the owners of what depends on
 * that. A review's stages name fixed reviewers; this shows whether the people who will
 * feel the change are among them.
 */
export interface Stakeholder {
  /** The owner as written on the objects. */
  owner: string;
  /** The member with that name or email, when there is one. */
  person?: Person;
  /** Their objects that the change adds, changes or removes. */
  changed: string[];
  /** Their objects that depend on something the change touches, up to three steps away. */
  affected: string[];
}

export interface Reach {
  stakeholders: Stakeholder[];
  /** Touched objects nobody answers for. */
  unowned: string[];
}

const asWorkspace = (tables: Tables): Workspace => ({ version: 1, name: "", userName: "", updatedAt: "", ...fromTables(tables) });
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function personFor(owner: string, people: Person[]): Person | undefined {
  if (!owner.trim()) return undefined;
  return people.find((p) => same(p.name, owner) || same(p.email, owner) || same(p.email.split("@")[0], owner));
}

export function reachOf(before: Tables | null, after: Tables, people: Person[], maxDepth = 3): Reach {
  const from = before ?? { ...after, objects: {}, relationships: {}, diagrams: {}, nodes: {} };
  const diff = compareTables(from, after);
  // Every object the change touches, in the model that still has it.
  const touchedNow = new Set<string>();
  const touchedGone = new Set<string>();
  for (const o of diff.objects.added) touchedNow.add(o.id);
  for (const c of diff.objects.changed) touchedNow.add(c.after.id);
  for (const o of diff.objects.removed) touchedGone.add(o.id);
  for (const r of [...diff.relationships.added, ...diff.relationships.removed, ...diff.relationships.changed.map((c) => c.after)]) {
    for (const end of [r.sourceId, r.targetId]) {
      if (after.objects[end]) touchedNow.add(end);
      else if (from.objects[end]) touchedGone.add(end);
    }
  }

  const byOwner = new Map<string, { owner: string; changed: Set<string>; affected: Set<string> }>();
  const entry = (owner: string) => {
    const key = owner.trim().toLowerCase();
    let found = byOwner.get(key);
    if (!found) byOwner.set(key, (found = { owner: owner.trim(), changed: new Set(), affected: new Set() }));
    return found;
  };
  const unowned = new Set<string>();
  const note = (tables: Tables, ids: Set<string>) => {
    for (const id of ids) {
      const object = tables.objects[id];
      if (!object) continue;
      if (object.owner.trim()) entry(object.owner).changed.add(object.name);
      else unowned.add(object.name);
    }
  };
  note(after, touchedNow);
  note(from, touchedGone);

  // Whatever depends on a touched object feels the change. A removed object's dependents are read from the model that had it.
  const feel = (tables: Tables, ids: Set<string>) => {
    if (!ids.size) return;
    const ws = asWorkspace(tables);
    for (const id of ids) {
      for (const reached of traverse(ws, id, "downstream", { maxDepth, includeChildren: false })) {
        const object = after.objects[reached.id];
        if (!object || touchedNow.has(object.id) || !object.owner.trim()) continue;
        entry(object.owner).affected.add(object.name);
      }
    }
  };
  feel(after, touchedNow);
  feel(from, touchedGone);

  const stakeholders = [...byOwner.values()]
    .map((s) => ({ owner: s.owner, person: personFor(s.owner, people), changed: [...s.changed].sort(), affected: [...s.affected].filter((n) => !s.changed.has(n)).sort() }))
    .sort((a, b) => b.changed.length - a.changed.length || b.affected.length - a.affected.length || a.owner.localeCompare(b.owner));
  return { stakeholders, unowned: [...unowned].sort() };
}
