import { exactComponent, LIBRARY, normalizeComponentName, type LibraryComponent } from "../library";
import { isKnownType } from "../catalog";
import type { RelationKind } from "../types";
import { guessKind, guessType } from "../import/diagramFile";

/**
 * What an infrastructure-as-code file, a cloud inventory or a discovery tool says exists: the
 * resources, what each one is, and which refers to which. Every reader in this folder produces
 * one of these; it then becomes a draft for review like any other import.
 */

export interface InventoryItem {
  /** Unique within the inventory: a Terraform address, an ARN, a CI's sys_id. */
  id: string;
  name: string;
  /** The source's own type, kept as a field: aws_instance, AWS::S3::Bucket, cmdb_ci_linux_server. */
  resourceType: string;
  typeId: string;
  componentId?: string;
  technology: string;
  description: string;
  tags: string[];
  /** Facts worth keeping on the object: region, account, IP address, image, namespace. */
  fields: Record<string, string>;
  /** The zone it sits in, when it sits in one. */
  parentId?: string;
}

export interface InventoryLink {
  sourceId: string;
  targetId: string;
  kind: RelationKind;
  label: string;
  protocol?: string;
  port?: string;
}

export interface Inventory {
  /** What was read, in words: "A Terraform configuration". */
  format: string;
  title: string;
  items: InventoryItem[];
  links: InventoryLink[];
  /** What was left out, in words, for the person to read before importing. */
  skipped: string[];
}

export class InventoryError extends Error {}

/** The cloud providers whose services the library knows, by the names their tools use. */
export type Cloud = "aws" | "azure" | "gcp" | "oci" | "ibm" | "alibaba" | "huawei";

const byProvider = new Map<string, Map<string, LibraryComponent>>();
/** A library component of a provider, by its name as the library has it ("EC2", "Virtual Machine"). */
export function providerComponent(provider: Cloud, name: string): LibraryComponent | undefined {
  let names = byProvider.get(provider);
  if (!names) {
    names = new Map();
    for (const c of LIBRARY) if (c.provider === provider) names.set(normalizeComponentName(c.name), c);
    byProvider.set(provider, names);
  }
  return names.get(normalizeComponentName(name));
}

/** A general library component by name or short form ("PostgreSQL", "Kubernetes service"). */
export const generalComponent = (name: string): LibraryComponent | undefined => {
  const c = exactComponent(name);
  return c && !c.provider ? c : undefined;
};

/** What a resource becomes: the library component when one is known, else a type guessed from its words. */
export function classify(component: LibraryComponent | undefined, words: string, fallback = "application"): { typeId: string; componentId?: string } {
  if (component && isKnownType(component.kind)) return { typeId: component.kind, componentId: component.id };
  const guessed = guessType(words, words);
  return { typeId: guessed ?? fallback, ...(component ? { componentId: component.id } : {}) };
}

/** A readable name from an identifier: "aws_lb.public" stays, an ARN keeps its last part. */
export function shortName(id: string): string {
  const arn = /^arn:[^:]*:[^:]*:[^:]*:[^:]*:(.+)$/.exec(id);
  const tail = (arn ? arn[1] : id).split(/[/:]/).filter(Boolean).pop() ?? id;
  return tail.length > 90 ? `${tail.slice(0, 88)}…` : tail;
}

/** The relationship kind between two resources: from words when they say, else from what the ends are. */
export function linkKind(label: string, source: InventoryItem | undefined, target: InventoryItem | undefined): RelationKind {
  return guessKind(label, source?.typeId ?? "application", target?.typeId ?? "application");
}

/** Keeps the first of each source, target and kind; drops links to things not in the inventory and to itself. */
export function cleanLinks(items: InventoryItem[], links: InventoryLink[]): { links: InventoryLink[]; loose: number } {
  const ids = new Set(items.map((i) => i.id));
  const seen = new Set<string>();
  const out: InventoryLink[] = [];
  let loose = 0;
  for (const link of links) {
    if (!ids.has(link.sourceId) || !ids.has(link.targetId)) {
      loose += 1;
      continue;
    }
    if (link.sourceId === link.targetId) continue;
    const key = `${link.sourceId}>${link.targetId}>${link.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return { links: out, loose };
}

/** Every string inside a value, with the path of keys that leads to it. */
export function* stringsIn(value: unknown, path = ""): Generator<[string, string]> {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* stringsIn(value[i], path);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) yield* stringsIn(v, path ? `${path}.${k}` : k);
}

/** The fields worth keeping from a flat record: short text values under names people read. */
export function keepFields(record: Record<string, unknown>, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = record[name];
    if (value === undefined || value === null || value === "") continue;
    const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
    if (text && text.length <= 300) out[name] = text;
  }
  return out;
}

export const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
