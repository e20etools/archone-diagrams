import { z } from "zod";
import { DEFAULT_TYPE_ID, isKnownType } from "../catalog";
import { RELATION_KINDS, type RelationKind } from "../types";

/** The shape every drafting engine returns, whether an AI model or the built-in rules. */

export interface DraftObject {
  key: string;
  name: string;
  typeId: string;
  description: string;
  technology: string;
  parentKey: string | null;
}

export interface DraftRelationship {
  sourceKey: string;
  targetKey: string;
  kind: RelationKind;
  label: string;
}

export interface Draft {
  objects: DraftObject[];
  relationships: DraftRelationship[];
  notes: string;
}

// Models sometimes answer with numbers for keys or null for empty text; accept both.
const key = z.union([z.string(), z.number()]).transform((v) => String(v));
const text = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (typeof v === "string" ? v : ""));

const rawDraftSchema = z.object({
  objects: z
    .array(
      z.object({
        key,
        name: z.string(),
        typeId: text,
        type: text,
        description: text,
        technology: text,
        parentKey: z.union([key, z.null(), z.undefined()]).transform((v) => v ?? null),
      }),
    )
    .max(150),
  relationships: z
    .array(z.object({ sourceKey: key, targetKey: key, kind: text, label: text }))
    .max(500)
    .optional(),
  notes: text,
});

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const clip = (s: string, max: number) => s.trim().replace(/\s+/g, " ").slice(0, max);

/**
 * Validates and tidies a raw draft: unknown types fall back to the default type, objects with the
 * same name merge, and relationships that point nowhere are dropped. Returns null for unusable input.
 */
export function normalizeDraft(raw: unknown): Draft | null {
  const parsed = rawDraftSchema.safeParse(raw);
  if (!parsed.success) return null;

  const objects: DraftObject[] = [];
  const keyAlias = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const o of parsed.data.objects) {
    const name = clip(o.name, 120);
    if (!name) continue;
    const existing = byName.get(norm(name));
    if (existing) {
      keyAlias.set(o.key, existing);
      continue;
    }
    let finalKey = o.key || `o${objects.length + 1}`;
    while (objects.some((x) => x.key === finalKey)) finalKey = `${finalKey}_`;
    keyAlias.set(o.key, finalKey);
    byName.set(norm(name), finalKey);
    const typeId = (o.typeId || o.type).trim().toLowerCase();
    objects.push({
      key: finalKey,
      name,
      typeId: isKnownType(typeId) ? typeId : DEFAULT_TYPE_ID,
      description: clip(o.description, 600),
      technology: clip(o.technology, 80),
      parentKey: o.parentKey,
    });
  }
  const keys = new Set(objects.map((o) => o.key));
  for (const o of objects) {
    const parent = o.parentKey === null ? null : (keyAlias.get(o.parentKey) ?? null);
    o.parentKey = parent && parent !== o.key && keys.has(parent) ? parent : null;
  }

  const relationships: DraftRelationship[] = [];
  const seen = new Set<string>();
  for (const r of parsed.data.relationships ?? []) {
    const sourceKey = keyAlias.get(r.sourceKey);
    const targetKey = keyAlias.get(r.targetKey);
    if (!sourceKey || !targetKey || sourceKey === targetKey) continue;
    const wanted = r.kind.trim().toLowerCase().replace(/[\s-]+/g, "_");
    const kind = (RELATION_KINDS as readonly string[]).includes(wanted) ? (wanted as RelationKind) : "calls";
    const id = `${sourceKey}>${targetKey}>${kind}`;
    if (seen.has(id)) continue;
    seen.add(id);
    relationships.push({ sourceKey, targetKey, kind, label: clip(r.label, 80) });
  }
  return { objects, relationships, notes: clip(parsed.data.notes, 500) };
}
