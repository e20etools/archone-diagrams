import { toCsv } from "../exporters";

/**
 * The audit log (PRD NFR-03) as the app reads it. The entries are written by the database;
 * this file only names and formats them.
 */

export interface AuditEntry {
  id: number;
  at: string;
  actorId: string | null;
  actorName: string;
  via: "app" | "api" | "system";
  entity: string;
  entityId: string;
  entityName: string;
  action: string;
  /** { field: [before, after] }, or { field: value } for a note such as the object put on a diagram. */
  changes: Record<string, unknown>;
}

export interface AuditQuery {
  entity?: string;
  /** Matches the person, the action or the name of the thing changed. */
  search?: string;
  /** Local dates, YYYY-MM-DD, both included. */
  from?: string;
  to?: string;
  /** Only entries older than this id. */
  before?: number;
  limit?: number;
}
export interface AuditPage {
  entries: AuditEntry[];
  more: boolean;
}

/**
 * What walking the chain of hashes found. Each entry carries a hash of itself and of the
 * entry before it, so a changed or removed entry breaks the chain from there on.
 */
export interface AuditCheck {
  ok: boolean;
  /** Entries that followed correctly from the one before, counted from the first. */
  entries: number;
  /** The first entry that does not follow, when the chain is broken. */
  brokenAt: number | null;
  /** The newest entry of an unbroken chain. Its number and hash, kept elsewhere, pin the log down as it is now. */
  head: { id: number; hash: string; at: string } | null;
  /** Against a saved code: still there and the same, changed, or gone. Null when none was given. */
  anchor: "match" | "mismatch" | "missing" | null;
}

/** The code to keep outside the system: the newest entry's number and hash. */
export const anchorCode = (head: { id: number; hash: string }) => `${head.id}-${head.hash}`;
export function parseAnchor(text: string): { id: number; hash: string } | null {
  const found = /^\s*(\d{1,15})-([0-9a-f]{64})\s*$/i.exec(text);
  return found ? { id: Number(found[1]), hash: found[2].toLowerCase() } : null;
}

export const AUDIT_PAGE_SIZE = 100;
export const AUDIT_ENTITIES = ["object", "relationship", "diagram", "member", "invitation", "workspace", "version", "review", "scenario", "proposal", "decision", "API key", "webhook", "live link"] as const;

const FIELD_LABELS: Record<string, string> = {
  type_id: "Type",
  parent_id: "Inside",
  source_id: "From",
  target_id: "To",
  view_type: "View",
  scope_id: "Scope",
  color_by: "Colour by",
  edge_kinds: "Relationship kinds shown",
  hidden_relationship_ids: "Hidden relationships",
  review_required: "Review before publishing",
  review_stages: "Review stages",
  published_version_id: "Published version",
  provenance: "Origin",
  acknowledged: "Confirmed by the owner of what is depended on",
  fields: "Custom fields",
  diagram_id: "Diagram",
};
export const fieldLabel = (field: string) => FIELD_LABELS[field] ?? field.charAt(0).toUpperCase() + field.slice(1).replace(/_/g, " ");

/** A value from the log as a short piece of text. `nameOf` turns an object id into its name when it is still known. */
export function auditValue(field: string, value: unknown, nameOf: (id: string) => string | undefined = () => undefined): string {
  if (value === null || value === undefined || value === "") return "nothing";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") {
    if (["parent_id", "source_id", "target_id", "scope_id"].includes(field)) return nameOf(value) ?? value;
    return value;
  }
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (field === "review_stages") return value.length ? value.map((s) => String((s as { name?: unknown })?.name ?? "stage")).join(", ") : "none";
    return value.length ? value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ") : "none";
  }
  if (field === "provenance") return String((value as { origin?: unknown }).origin ?? "unknown");
  return JSON.stringify(value);
}

export interface AuditChange {
  label: string;
  before: string | null;
  after: string;
}
/** The changed fields of an entry, ready to show. A plain note has no "before". */
export function auditChanges(entry: AuditEntry, nameOf?: (id: string) => string | undefined): AuditChange[] {
  return Object.entries(entry.changes ?? {})
    .map(([field, value]): AuditChange => {
      if (Array.isArray(value) && value.length === 2) {
        return { label: fieldLabel(field), before: entry.action === "created" || entry.action === "added" || entry.action === "sent" ? null : auditValue(field, value[0], nameOf), after: auditValue(field, value[1], nameOf) };
      }
      return { label: fieldLabel(field), before: null, after: auditValue(field, value, nameOf) };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** "created object", "role changed for member": what happened, without who and to what. */
export function auditAction(entry: AuditEntry): string {
  if (entry.entity === "diagram" && entry.action.startsWith("object ")) {
    const object = typeof entry.changes?.object === "string" ? `"${entry.changes.object}"` : "an object";
    return entry.action === "object added" ? `added ${object} to diagram` : `removed ${object} from diagram`;
  }
  if (entry.entity === "member" && entry.action === "role changed") return "changed the role of member";
  if (entry.entity === "review" && entry.action.startsWith("stage ")) return `${entry.action.slice(6)} a stage of review`;
  return `${entry.action} ${entry.entity}`;
}

export function auditCsv(entries: AuditEntry[]): string {
  return toCsv([
    ["When (UTC)", "Who", "Through", "Action", "What", "Name", "Id", "Changes"],
    ...entries.map((e) => [
      e.at,
      e.actorName,
      e.via,
      e.action,
      e.entity,
      e.entityName,
      e.entityId,
      auditChanges(e)
        .map((c) => (c.before === null ? `${c.label}: ${c.after}` : `${c.label}: ${c.before} -> ${c.after}`))
        .join("; "),
    ]),
  ]);
}

/** The start of a local day and of the day after, as instants, for a date filter. */
export function dayBounds(from?: string, to?: string): { since?: string; until?: string } {
  const start = from ? new Date(`${from}T00:00:00`) : null;
  const end = to ? new Date(`${to}T00:00:00`) : null;
  if (end) end.setDate(end.getDate() + 1);
  return { since: start && !Number.isNaN(start.getTime()) ? start.toISOString() : undefined, until: end && !Number.isNaN(end.getTime()) ? end.toISOString() : undefined };
}

/** Search text made safe to put in a filter: letters, digits, spaces and a few marks. */
export const cleanSearch = (text: string) => text.replace(/[^\p{L}\p{N} @._\-/:]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);

export function matchesQuery(entry: AuditEntry, query: AuditQuery): boolean {
  const { since, until } = dayBounds(query.from, query.to);
  const search = cleanSearch(query.search ?? "").toLowerCase();
  return (
    (!query.entity || entry.entity === query.entity) &&
    (!since || entry.at >= since) &&
    (!until || entry.at < until) &&
    (query.before === undefined || entry.id < query.before) &&
    (!search || [entry.actorName, entry.action, entry.entityName].some((v) => v.toLowerCase().includes(search)))
  );
}
