import { objectType } from "../catalog";
import { canSetParent, createDiagram, createObject, createRelationship, findByName, newId, nowIso, placeNodes, updateDiagram, updateObject, type ObjectPatch } from "../model";
import type { Decision, NodePlacement, Proposal, ProposedObject, Provenance, Workspace } from "../types";
import { addObjectsToDiagram } from "../views";
import type { Draft } from "./schema";

/**
 * A draft becomes a proposal: a list of suggestions that a person accepts, edits or rejects.
 * Only applyProposal writes to the model, and it stamps every item with where it came from
 * and who approved it (PRD AI-06, AI-07).
 */

export interface ProposalMeta {
  origin: "ai-prompt" | "ai-image";
  /** The prompt text or the uploaded file name. */
  source: string;
  engine: string;
  targetDiagramId: string | null;
}

export function draftToProposal(ws: Workspace, draft: Draft, meta: ProposalMeta): Proposal {
  return {
    id: newId("prop"),
    origin: meta.origin,
    source: meta.source,
    engine: meta.engine,
    notes: draft.notes,
    createdAt: nowIso(),
    status: "pending",
    targetDiagramId: meta.targetDiagramId && ws.diagrams[meta.targetDiagramId] ? meta.targetDiagramId : null,
    objects: draft.objects.map((o) => ({
      key: o.key,
      name: o.name,
      typeId: o.typeId,
      description: o.description,
      technology: o.technology,
      parentKey: o.parentKey,
      decision: "pending" as const,
      matchId: findByName(ws, o.name)?.id ?? null,
    })),
    relationships: draft.relationships.map((r, i) => ({
      key: `r${i + 1}`,
      sourceKey: r.sourceKey,
      targetKey: r.targetKey,
      kind: r.kind,
      label: r.label,
      decision: "pending" as const,
    })),
  };
}

export function saveProposal(ws: Workspace, proposal: Proposal): Workspace {
  return { ...ws, proposals: { ...ws.proposals, [proposal.id]: proposal }, updatedAt: nowIso() };
}

export function updateProposal(ws: Workspace, id: string, change: (p: Proposal) => Proposal): Workspace {
  const current = ws.proposals[id];
  if (!current || current.status !== "pending") return ws;
  return saveProposal(ws, change(current));
}

export function setAllDecisions(ws: Workspace, id: string, decision: Decision): Workspace {
  return updateProposal(ws, id, (p) => ({
    ...p,
    objects: p.objects.map((o) => ({ ...o, decision })),
    relationships: p.relationships.map((r) => ({ ...r, decision })),
  }));
}

export function dismissProposal(ws: Workspace, id: string, user: string): Workspace {
  return updateProposal(ws, id, (p) => ({
    ...p,
    status: "dismissed",
    decidedBy: user,
    decidedAt: nowIso(),
    objects: p.objects.map((o) => ({ ...o, decision: "rejected" })),
    relationships: p.relationships.map((r) => ({ ...r, decision: "rejected" })),
  }));
}

/** A relationship can only be saved when both of its ends are accepted. */
export function relationshipReady(p: Proposal, relationshipKey: string): boolean {
  const r = p.relationships.find((x) => x.key === relationshipKey);
  if (!r) return false;
  const accepted = new Set(p.objects.filter((o) => o.decision === "accepted").map((o) => o.key));
  return accepted.has(r.sourceKey) && accepted.has(r.targetKey);
}

export function proposalCounts(p: Proposal) {
  const count = (items: { decision: Decision }[], d: Decision) => items.filter((i) => i.decision === d).length;
  return {
    objects: p.objects.length,
    relationships: p.relationships.length,
    accepted: count(p.objects, "accepted") + count(p.relationships, "accepted"),
    pending: count(p.objects, "pending") + count(p.relationships, "pending"),
    rejected: count(p.objects, "rejected") + count(p.relationships, "rejected"),
  };
}

function diagramName(p: Proposal): string {
  if (p.origin === "api") return p.source.slice(0, 60) || "Proposed through the API";
  if (p.origin !== "ai-prompt") return p.source.replace(/\.[a-z0-9]+$/i, "") || "Imported diagram";
  const firstLine = p.source.trim().split(/\n/)[0].replace(/\s+/g, " ");
  if (firstLine.length <= 34) return firstLine || "AI draft";
  // Cut at a word so the name does not end mid-word; the person can rename it on the diagram.
  const cut = firstLine.slice(0, 34);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 16)).replace(/[\s,;:.]+$/, "")}…`;
}

export interface ApplyResult {
  ws: Workspace;
  diagramId: string | null;
  createdObjects: number;
  reusedObjects: number;
  /** Existing objects that an import changed. */
  updatedObjects: number;
  createdRelationships: number;
}

/** The labels of the fields an imported row would change on the object it matches. */
export function importUpdates(ws: Workspace, o: ProposedObject): string[] {
  const match = o.matchId ? ws.objects[o.matchId] : undefined;
  if (!match || !o.provided?.length) return [];
  const gives = new Set(o.provided);
  const changes: string[] = [];
  if (gives.has("type") && o.typeId !== match.typeId) changes.push("Type");
  if (gives.has("description") && o.description !== match.description) changes.push("Description");
  if (gives.has("owner") && (o.owner ?? "") !== match.owner) changes.push("Owner");
  if (gives.has("lifecycle") && o.lifecycle && o.lifecycle !== match.lifecycle) changes.push("Lifecycle");
  if (gives.has("technology") && o.technology !== match.technology) changes.push("Technology");
  if (gives.has("tags") && [...(o.tags ?? [])].sort().join("|") !== [...match.tags].sort().join("|")) changes.push("Tags");
  if (gives.has("fields") && Object.entries(o.fields ?? {}).some(([key, value]) => (match.fields[key] ?? "") !== value)) changes.push("Details");
  return changes;
}

/** Saves the accepted suggestions to the model. Anything not accepted is discarded with the proposal. */
export function applyProposal(ws: Workspace, id: string, user: string): ApplyResult {
  const proposal = ws.proposals[id];
  const nothing: ApplyResult = { ws, diagramId: null, createdObjects: 0, reusedObjects: 0, updatedObjects: 0, createdRelationships: 0 };
  if (!proposal || proposal.status !== "pending") return nothing;

  const stamp = nowIso();
  const reviewer = user.trim() || "Unnamed reviewer";
  const provenance: Provenance = {
    origin: proposal.origin,
    source: proposal.source,
    engine: proposal.engine,
    proposalId: proposal.id,
    proposedAt: proposal.createdAt,
    approvedBy: reviewer,
    approvedAt: stamp,
  };

  let next = ws;
  const keyToId = new Map<string, string>();
  let createdObjects = 0;
  let reusedObjects = 0;
  let updatedObjects = 0;
  // Parents first, so a child can be attached as soon as it is created.
  const accepted = proposal.objects
    .filter((o) => o.decision === "accepted")
    .sort((a, b) => objectType(a.typeId).level - objectType(b.typeId).level);
  for (const o of accepted) {
    if (o.matchId && next.objects[o.matchId]) {
      keyToId.set(o.key, o.matchId);
      reusedObjects++;
      // An imported row updates the object it matches, but only in the fields the file gave a value for.
      const gives = new Set(proposal.origin === "import" || proposal.origin === "api" ? (o.provided ?? []) : []);
      const patch: ObjectPatch = {};
      if (importUpdates(next, o).length) {
        if (gives.has("type")) patch.typeId = o.typeId;
        if (gives.has("description")) patch.description = o.description;
        if (gives.has("owner")) patch.owner = o.owner ?? "";
        if (gives.has("lifecycle") && o.lifecycle) patch.lifecycle = o.lifecycle;
        if (gives.has("technology")) patch.technology = o.technology;
        if (gives.has("tags")) patch.tags = o.tags ?? [];
        // Fields the import brings are written over the same fields; the object's other fields stay.
        if (gives.has("fields")) patch.fields = { ...next.objects[o.matchId].fields, ...(o.fields ?? {}) };
      }
      const parentId = gives.has("parent") && o.parentKey ? keyToId.get(o.parentKey) : undefined;
      if (parentId && parentId !== next.objects[o.matchId].parentId && canSetParent(next, o.matchId, patch.typeId ?? next.objects[o.matchId].typeId, parentId)) patch.parentId = parentId;
      if (Object.keys(patch).length) {
        next = updateObject(next, o.matchId, patch);
        updatedObjects++;
      }
      continue;
    }
    const parentId = o.parentKey ? keyToId.get(o.parentKey) : undefined;
    const made = createObject(next, {
      typeId: o.typeId,
      name: o.name,
      description: o.description,
      technology: o.technology,
      owner: o.owner,
      lifecycle: o.lifecycle,
      tags: o.tags,
      fields: o.fields,
      parentId: parentId && canSetParent(next, null, o.typeId, parentId) ? parentId : null,
      provenance,
    });
    next = made.ws;
    keyToId.set(o.key, made.object.id);
    createdObjects++;
  }

  let createdRelationships = 0;
  for (const r of proposal.relationships) {
    if (r.decision !== "accepted") continue;
    const sourceId = keyToId.get(r.sourceKey);
    const targetId = keyToId.get(r.targetKey);
    if (!sourceId || !targetId) continue;
    const made = createRelationship(next, { sourceId, targetId, kind: r.kind, label: r.label, protocol: r.protocol, port: r.port, description: r.description, provenance });
    next = made.ws;
    if (made.created) createdRelationships++;
  }

  let diagramId: string | null = null;
  const objectIds = [...new Set(keyToId.values())];
  // A diagram file is redrawn as it was: only the shapes that had a place on the page become boxes.
  const drawn = new Map<string, NodePlacement>();
  if (proposal.placeAsDrawn) {
    for (const o of accepted) {
      const objectId = keyToId.get(o.key);
      if (objectId && o.x !== undefined && o.y !== undefined && !drawn.has(objectId)) drawn.set(objectId, { x: o.x, y: o.y, pinned: true });
    }
  }
  const onDiagram = proposal.placeAsDrawn ? [...drawn.keys()] : objectIds;
  if (onDiagram.length && !proposal.withoutDiagram) {
    const isNew = !(proposal.targetDiagramId && next.diagrams[proposal.targetDiagramId]);
    if (!isNew) {
      diagramId = proposal.targetDiagramId;
    } else {
      const made = createDiagram(next, { name: diagramName(proposal), viewType: "custom" });
      next = made.ws;
      diagramId = made.diagram.id;
    }
    next = addObjectsToDiagram(next, diagramId!, onDiagram);
    // Onto a diagram that already has boxes, the imported ones are laid out around them instead.
    if (isNew && drawn.size) {
      next = placeNodes(next, diagramId!, Object.fromEntries(drawn));
      // Arrows leave boxes downwards or sideways; pick whichever way most of the drawing runs.
      let across = 0;
      let down = 0;
      for (const r of proposal.relationships) {
        const from = drawn.get(keyToId.get(r.sourceKey) ?? "");
        const to = drawn.get(keyToId.get(r.targetKey) ?? "");
        if (r.decision !== "accepted" || !from || !to) continue;
        if (Math.abs(to.x - from.x) > Math.abs(to.y - from.y)) across += 1;
        else down += 1;
      }
      if (across > down) next = updateDiagram(next, diagramId!, { direction: "LR" });
    }
  }

  const decided: Proposal = {
    ...proposal,
    status: objectIds.length ? "applied" : "dismissed",
    decidedBy: reviewer,
    decidedAt: stamp,
    resultDiagramId: diagramId ?? undefined,
    objects: proposal.objects.map((o) => (o.decision === "accepted" ? o : { ...o, decision: "rejected" })),
    relationships: proposal.relationships.map((r) =>
      r.decision === "accepted" && keyToId.has(r.sourceKey) && keyToId.has(r.targetKey) ? r : { ...r, decision: "rejected" },
    ),
  };
  next = { ...next, proposals: { ...next.proposals, [decided.id]: decided }, updatedAt: stamp };
  return { ws: next, diagramId, createdObjects, reusedObjects, updatedObjects, createdRelationships };
}
