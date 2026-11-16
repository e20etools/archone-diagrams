import type { Diagram, ModelObject, Relationship } from "../types";
import { fromRow, type Row } from "./rows";
import { emptyTables, fromTables, sameValue, splitNodeKey, type DiagramMeta, type Tables } from "./tables";

/** Comments, versions and review before publishing: the shapes the screens use, and the pure logic behind them. */

export type CommentTarget = "diagram" | "object" | "relationship";
export interface Comment {
  id: string;
  /** The diagram it was written on, or null when written from the model list. */
  diagramId: string | null;
  targetKind: CommentTarget;
  targetId: string;
  /** Replies carry the id of the first comment of their thread. */
  parentId: string | null;
  body: string;
  mentions: string[];
  resolved: boolean;
  authorId: string | null;
  createdAt: string;
  editedAt: string | null;
}
export interface CommentDraft {
  diagramId: string | null;
  targetKind: CommentTarget;
  targetId: string;
  parentId: string | null;
  body: string;
  mentions: string[];
}
export type CommentPatch = Partial<Pick<Comment, "body" | "mentions" | "resolved">> & { deleted?: true };

export type VersionKind = "manual" | "review" | "baseline" | "safety";
export interface VersionInfo {
  id: string;
  name: string;
  note: string;
  kind: VersionKind;
  objects: number;
  relationships: number;
  diagrams: number;
  createdBy: string | null;
  createdAt: string;
}

export interface ReviewStage {
  id: string;
  name: string;
  reviewerId: string;
  checklist: string[];
}
export interface ReviewSettings {
  required: boolean;
  stages: ReviewStage[];
  publishedVersionId: string | null;
}
export interface ReviewDecision {
  stageId: string;
  stageName: string;
  by: string;
  decision: "approved" | "rejected" | "delegated";
  reason: string;
  checklist: boolean[];
  to?: string;
  at: string;
}
export type ReviewStatus = "open" | "approved" | "rejected" | "withdrawn";
export interface Review {
  id: string;
  versionId: string;
  baseVersionId: string | null;
  title: string;
  note: string;
  status: ReviewStatus;
  stages: ReviewStage[];
  stageIndex: number;
  decisions: ReviewDecision[];
  submittedBy: string | null;
  submittedAt: string;
  closedAt: string | null;
}

export const VERSION_KIND_LABEL: Record<VersionKind, string> = {
  manual: "Saved by hand",
  review: "Submitted for review",
  baseline: "Baseline",
  safety: "Before a revert",
};
export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = { open: "In review", approved: "Approved", rejected: "Rejected", withdrawn: "Withdrawn" };

/** A version's stored copy of the model, in database columns, turned into the app's tables. AI drafts are not part of a version. */
export function snapshotToTables(snapshot: unknown): Tables {
  const tables = emptyTables();
  const source = (snapshot ?? {}) as Record<string, unknown>;
  for (const table of ["objects", "relationships", "diagrams", "nodes"] as const) {
    const rows = Array.isArray(source[table]) ? (source[table] as Row[]) : [];
    const target = tables[table] as Record<string, unknown>;
    for (const row of rows) {
      const { key, value } = fromRow(table, row);
      if (value !== null) target[key] = value;
    }
  }
  return tables;
}

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}
export interface Comparison {
  objects: { added: ModelObject[]; removed: ModelObject[]; changed: { before: ModelObject; after: ModelObject; fields: FieldChange[] }[] };
  relationships: { added: Relationship[]; removed: Relationship[]; changed: { before: Relationship; after: Relationship; fields: FieldChange[] }[] };
  diagrams: {
    added: DiagramMeta[];
    removed: DiagramMeta[];
    changed: { before: DiagramMeta; after: DiagramMeta; fields: FieldChange[]; boxesAdded: number; boxesRemoved: number; boxesMoved: number }[];
  };
  /** How many things differ, counting each object, relationship and diagram once. */
  total: number;
}

const OBJECT_FIELDS: [keyof ModelObject, string][] = [
  ["name", "Name"],
  ["typeId", "Type"],
  ["description", "Description"],
  ["owner", "Owner"],
  ["lifecycle", "Lifecycle"],
  ["technology", "Technology"],
  ["tags", "Tags"],
  ["parentId", "Inside"],
  ["fields", "Details"],
];
const RELATIONSHIP_FIELDS: [keyof Relationship, string][] = [
  ["sourceId", "From"],
  ["targetId", "To"],
  ["kind", "Kind"],
  ["label", "Label"],
  ["protocol", "Protocol"],
  ["port", "Port"],
  ["description", "Description"],
];
const DIAGRAM_FIELDS: [keyof DiagramMeta, string][] = [
  ["name", "Name"],
  ["description", "Description"],
  ["viewType", "View"],
  ["scopeId", "Scope"],
  ["direction", "Direction"],
  ["colorBy", "Colours"],
  ["notation", "Notation"],
  ["hiddenRelationshipIds", "Hidden arrows"],
  ["edgeKinds", "Arrow kinds shown"],
];

const show = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "nothing";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "nothing";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== "");
    return entries.length ? entries.map(([k, v]) => `${k}: ${String(v)}`).join(", ") : "nothing";
  }
  return String(value);
};

function fieldChanges<T>(before: T, after: T, fields: [keyof T, string][], name: (field: keyof T, value: unknown) => unknown): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [field, label] of fields) {
    if (sameValue(before[field], after[field])) continue;
    changes.push({ field: label, before: show(name(field, before[field])), after: show(name(field, after[field])) });
  }
  return changes;
}

/** What turning `before` into `after` adds, removes and changes. Timestamps and who-made-it records are ignored. */
export function compareTables(before: Tables, after: Tables): Comparison {
  const objectName = (tables: Tables) => (field: keyof ModelObject | keyof Relationship | keyof DiagramMeta, value: unknown) =>
    (field === "parentId" || field === "sourceId" || field === "targetId" || field === "scopeId") && typeof value === "string" ? (tables.objects[value]?.name ?? value) : value;
  // Names are looked up in whichever side holds the object, so a renamed parent still reads well.
  const both: Tables = { ...after, objects: { ...before.objects, ...after.objects } };
  const named = objectName(both);

  const result: Comparison = {
    objects: { added: [], removed: [], changed: [] },
    relationships: { added: [], removed: [], changed: [] },
    diagrams: { added: [], removed: [], changed: [] },
    total: 0,
  };

  for (const [id, object] of Object.entries(after.objects)) {
    const old = before.objects[id];
    if (!old) result.objects.added.push(object);
    else {
      const fields = fieldChanges(old, object, OBJECT_FIELDS, named);
      if (fields.length) result.objects.changed.push({ before: old, after: object, fields });
    }
  }
  for (const [id, object] of Object.entries(before.objects)) if (!after.objects[id]) result.objects.removed.push(object);

  for (const [id, relationship] of Object.entries(after.relationships)) {
    const old = before.relationships[id];
    if (!old) result.relationships.added.push(relationship);
    else {
      const fields = fieldChanges(old, relationship, RELATIONSHIP_FIELDS, named);
      if (fields.length) result.relationships.changed.push({ before: old, after: relationship, fields });
    }
  }
  for (const [id, relationship] of Object.entries(before.relationships)) if (!after.relationships[id]) result.relationships.removed.push(relationship);

  const boxes = (tables: Tables) => {
    const byDiagram = new Map<string, Map<string, { x: number; y: number }>>();
    for (const [key, placement] of Object.entries(tables.nodes)) {
      const [diagramId, objectId] = splitNodeKey(key);
      if (!byDiagram.has(diagramId)) byDiagram.set(diagramId, new Map());
      byDiagram.get(diagramId)!.set(objectId, placement);
    }
    return byDiagram;
  };
  const boxesBefore = boxes(before);
  const boxesAfter = boxes(after);
  for (const [id, diagram] of Object.entries(after.diagrams)) {
    const old = before.diagrams[id];
    if (!old) {
      result.diagrams.added.push(diagram);
      continue;
    }
    const fields = fieldChanges(old, diagram, DIAGRAM_FIELDS, named);
    const was = boxesBefore.get(id) ?? new Map();
    const now = boxesAfter.get(id) ?? new Map();
    let boxesAdded = 0;
    let boxesMoved = 0;
    for (const [objectId, placement] of now) {
      const previous = was.get(objectId);
      if (!previous) boxesAdded += 1;
      else if (previous.x !== placement.x || previous.y !== placement.y) boxesMoved += 1;
    }
    let boxesRemoved = 0;
    for (const objectId of was.keys()) if (!now.has(objectId)) boxesRemoved += 1;
    if (fields.length || boxesAdded || boxesRemoved || boxesMoved) result.diagrams.changed.push({ before: old, after: diagram, fields, boxesAdded, boxesRemoved, boxesMoved });
  }
  for (const [id, diagram] of Object.entries(before.diagrams)) if (!after.diagrams[id]) result.diagrams.removed.push(diagram);

  result.total = (["objects", "relationships", "diagrams"] as const).reduce((n, kind) => n + result[kind].added.length + result[kind].removed.length + result[kind].changed.length, 0);
  return result;
}

/** A diagram of a version, ready to draw. */
export function diagramsOf(tables: Tables): Diagram[] {
  return Object.values(fromTables(tables).diagrams).sort((a, b) => a.name.localeCompare(b.name));
}

/** "Maya → Billing" for a relationship, using whichever names are known. */
export function relationshipTitle(relationship: Relationship, objects: Record<string, ModelObject>): string {
  return `${objects[relationship.sourceId]?.name ?? "Removed object"} to ${objects[relationship.targetId]?.name ?? "Removed object"}`;
}

/* ---------- mentions ---------- */

export interface Person {
  userId: string;
  name: string;
  email: string;
}
export const personLabel = (person: Person | undefined) => (person ? person.name || person.email : "Former member");

/** The people whose "@Name" is written in the text. Longer names are matched first, so "@Ana Maria" is not read as "@Ana". */
export function mentionsIn(body: string, people: Person[]): string[] {
  const found: string[] = [];
  let rest = body;
  for (const person of [...people].sort((a, b) => personLabel(b).length - personLabel(a).length)) {
    const tag = `@${personLabel(person)}`;
    if (!rest.includes(tag)) continue;
    found.push(person.userId);
    rest = rest.split(tag).join(" ");
  }
  return found;
}

/** Splits a comment into plain text and mentions, for drawing. */
export function splitMentions(body: string, people: Person[], mentioned: string[]): { text: string; mention: boolean }[] {
  const tags = people
    .filter((p) => mentioned.includes(p.userId))
    .map((p) => `@${personLabel(p)}`)
    .sort((a, b) => b.length - a.length);
  const parts: { text: string; mention: boolean }[] = [];
  let i = 0;
  let plain = "";
  while (i < body.length) {
    const tag = body[i] === "@" ? tags.find((t) => body.startsWith(t, i)) : undefined;
    if (tag) {
      if (plain) parts.push({ text: plain, mention: false });
      plain = "";
      parts.push({ text: tag, mention: true });
      i += tag.length;
    } else {
      plain += body[i];
      i += 1;
    }
  }
  if (plain) parts.push({ text: plain, mention: false });
  return parts;
}

/** The "@text" being typed just before the caret, if any: what the people picker filters on. */
export function mentionQuery(body: string, caret: number): { start: number; query: string } | null {
  const before = body.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || query.includes("\n")) return null;
  return { start: at, query };
}

export interface Thread {
  root: Comment;
  replies: Comment[];
}
/** Comments grouped into threads, oldest thread first, replies in the order written. */
export function threadsOf(comments: Comment[]): Thread[] {
  const roots = comments.filter((c) => !c.parentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const byParent = new Map<string, Comment[]>();
  for (const comment of comments) {
    if (!comment.parentId) continue;
    byParent.set(comment.parentId, [...(byParent.get(comment.parentId) ?? []), comment]);
  }
  return roots.map((root) => ({ root, replies: (byParent.get(root.id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }));
}

/** Who has to act on an open review right now, or null when it is closed. */
export const currentStage = (review: Review): ReviewStage | null => (review.status === "open" ? (review.stages[review.stageIndex] ?? null) : null);
