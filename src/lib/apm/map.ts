import { IMPORT_ENGINE } from "../import/draft";
import { findByName, newId, normalizeName, nowIso } from "../model";
import type { Lifecycle, Proposal, ProposedObject, ProposedRelationship, RelationKind, Workspace } from "../types";
import type { ApmData } from "./http";

/**
 * Turns what APM & Landscape publishes into a draft for review. APM is the record of which
 * applications exist, who sells them, in what version and what is planned for them; this
 * model is the record of how they connect. So an import brings each application's facts as
 * fields and its integrations as relationships, and never deletes anything here.
 */

/** Fields an import from APM writes on an object. "APM id" ties the object to its application, so a rename in either place does not break the link. */
export const APM_FIELDS = { id: "APM id", number: "APM number", vendor: "Vendor", version: "Version", category: "Category", time: "TIME", hosting: "Hosting", capability: "Business capability", license: "License" } as const;

/** APM's TIME assessment as this model's lifecycle. The assessment itself is kept in the TIME field. */
const LIFECYCLE: Record<string, Lifecycle> = { invest: "active", tolerate: "active", migrate: "deprecated", eliminate: "deprecated" };
const KIND: Record<string, RelationKind> = { api: "calls", database: "reads_writes", event: "flows_to", file: "flows_to", sso: "depends_on" };

const text = (value: unknown, limit = 4000) => (typeof value === "string" ? value.trim().slice(0, limit) : typeof value === "number" ? String(value) : "");
/** "on_premise" as "On premise". */
const words = (value: unknown) => {
  const t = text(value, 200).replace(/_/g, " ");
  return t ? t[0].toUpperCase() + t.slice(1) : "";
};

export interface ApmDraft {
  proposal: Proposal;
  counts: { applications: number; fresh: number; matched: number; relationships: number; skippedRelationships: number };
  /** Objects tied to an APM application that APM no longer lists as active. They are left as they are. */
  gone: string[];
}

export function apmToProposal(ws: Workspace, data: ApmData): ApmDraft {
  const lifecycleOf = new Map(data.lifecycle.map((row) => [text(row.id, 80), text(row.lifecycle_status, 40)]));
  const classOf = new Map(data.classifications.map((row) => [text(row.id, 80), (row.classifications && typeof row.classifications === "object" ? row.classifications : {}) as Record<string, unknown>]));
  const tied = new Map<string, string>();
  for (const o of Object.values(ws.objects)) if (o.fields[APM_FIELDS.id]) tied.set(o.fields[APM_FIELDS.id], o.id);

  const objects: ProposedObject[] = [];
  const keyByName = new Map<string, string>();
  const seenIds = new Set<string>();
  for (const row of data.applications) {
    const id = text(row.id, 80);
    const name = text(row.name, 200).replace(/\s+/g, " ");
    if (!id || !name || keyByName.has(normalizeName(name))) continue;
    seenIds.add(id);
    const time = lifecycleOf.get(id) ?? "";
    const c = classOf.get(id) ?? {};
    const fields: Record<string, string> = {};
    const put = (key: string, value: string) => {
      if (value) fields[key] = value;
    };
    put(APM_FIELDS.id, id);
    put(APM_FIELDS.number, text(row.number, 20));
    put(APM_FIELDS.vendor, text(row.vendor, 200));
    put(APM_FIELDS.version, text(row.version, 100));
    put(APM_FIELDS.category, text(row.category, 200));
    put(APM_FIELDS.time, time);
    put(APM_FIELDS.hosting, words(c.hosting));
    put(APM_FIELDS.capability, text(c.business_capability, 200));
    put(APM_FIELDS.license, [words(c.license), words(c.license_model)].filter(Boolean).join(", "));
    const description = text(row.description);
    const lifecycle = LIFECYCLE[time.toLowerCase()];
    // An object already tied to this application is matched by that tie, so a rename in APM renames nothing here by accident.
    const matchId = tied.get(id) ?? findByName(ws, name)?.id ?? null;
    const key = `a${objects.length + 1}`;
    keyByName.set(normalizeName(name), key);
    objects.push({
      key,
      name,
      // A matched object keeps the kind it was given here; APM does not say whether something is a service, a database or a gateway.
      typeId: matchId ? ws.objects[matchId].typeId : "application",
      description,
      technology: "",
      parentKey: null,
      decision: "pending",
      matchId,
      ...(lifecycle ? { lifecycle } : {}),
      fields,
      provided: [...(description ? ["description"] : []), ...(lifecycle ? ["lifecycle"] : []), "fields"],
    });
  }

  const idOfKey = new Map(objects.map((o) => [o.key, o.matchId]));
  const existing = new Set(Object.values(ws.relationships).map((r) => `${r.sourceId}>${r.targetId}>${r.kind}`));
  const relationships: ProposedRelationship[] = [];
  const seen = new Set<string>();
  let skippedRelationships = 0;
  for (const row of data.integrations) {
    const sourceKey = keyByName.get(normalizeName(text(row.source, 200)));
    const targetKey = keyByName.get(normalizeName(text(row.target, 200)));
    const type = text(row.type, 40);
    const kind = KIND[type.toLowerCase()] ?? "depends_on";
    const signature = `${sourceKey}>${targetKey}>${kind}`;
    const already = !!sourceKey && !!targetKey && existing.has(`${idOfKey.get(sourceKey)}>${idOfKey.get(targetKey)}>${kind}`);
    if (!sourceKey || !targetKey || sourceKey === targetKey || seen.has(signature) || already) {
      skippedRelationships += 1;
      continue;
    }
    seen.add(signature);
    relationships.push({ key: `r${relationships.length + 1}`, sourceKey, targetKey, kind, label: type, decision: "pending", description: text(row.description) || undefined });
  }

  const gone = Object.values(ws.objects).filter((o) => o.fields[APM_FIELDS.id] && !seenIds.has(o.fields[APM_FIELDS.id])).map((o) => o.name).sort((a, b) => a.localeCompare(b));
  const matched = objects.filter((o) => o.matchId).length;
  const counts = { applications: objects.length, fresh: objects.length - matched, matched, relationships: relationships.length, skippedRelationships };
  const notes = [
    `${counts.applications} applications and ${data.integrations.length} integrations read from APM at ${data.host}.`,
    matched ? `${matched} match an object already in the model and update its description, lifecycle and APM fields; its kind, owner, tags and place stay as they are.` : "",
    skippedRelationships ? `${skippedRelationships} integrations were left out: the relationship is already in the model, is listed twice, or names an application APM did not send.` : "",
    gone.length ? `No longer active in APM, and left untouched here: ${gone.slice(0, 12).join(", ")}${gone.length > 12 ? `, and ${gone.length - 12} more` : ""}.` : "",
    "TIME is APM's assessment: Invest and Tolerate are imported as active, Migrate and Eliminate as deprecated.",
  ]
    .filter(Boolean)
    .join(" ");
  const proposal: Proposal = {
    id: newId("prop"),
    origin: "import",
    importKind: "apm",
    source: `APM at ${data.host}`,
    engine: IMPORT_ENGINE.apm,
    notes,
    createdAt: nowIso(),
    status: "pending",
    targetDiagramId: null,
    objects,
    relationships,
    withoutDiagram: true,
  };
  return { proposal, counts, gone };
}
