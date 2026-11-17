import { objectType } from "../catalog";
import type { LibraryComponent } from "../library";
import type { RelationKind } from "../types";
import { classify, cleanLinks, linkKind, type Inventory, type InventoryItem, type InventoryLink } from "./model";

/**
 * Turns resources and the references between them into an inventory. What makes it a picture
 * rather than a dump:
 *  - minor resources (policies, attachments, interfaces, rules) are not drawn, and the things
 *    they join are joined directly: a target group attachment joins the target group's load
 *    balancer to the instance;
 *  - networks become zones, and a resource that refers to a subnet or network sits inside it;
 *  - a reference becomes a relationship whose kind follows from the two ends.
 */

export interface RawResource {
  id: string;
  name: string;
  resourceType: string;
  component?: LibraryComponent;
  role?: "zone" | "minor";
  /** Ids of resources it refers to. */
  refs: string[];
  /** Relationships the source states with their kind, such as a CMDB's "Runs on". */
  links?: { targetId: string; kind: RelationKind; label: string; port?: string; protocol?: string }[];
  /** Put inside this zone when the source says so. */
  parentId?: string | null;
  technology?: string;
  description?: string;
  tags?: string[];
  fields?: Record<string, string>;
  /** A type to fall back on when no component is known. */
  typeHint?: string;
}

/** Which end of a link through a minor resource comes first: callers before what they call. */
const RANK: Record<string, number> = { actor: 0, "web-app": 1, "mobile-app": 1, gateway: 2, application: 3, service: 3, system: 3, "external-system": 3, cluster: 4, server: 4, queue: 5, cache: 6, database: 6, storage: 6, network: 7, zone: 8 };
const rank = (typeId: string) => RANK[typeId] ?? 3;

const MAX_THROUGH = 6;
const DATA_TYPES = new Set(["database", "queue", "cache", "storage"]);
/** Minor resources that group things (security groups, roles, policies) say nothing about who talks to whom. */
const GROUPING = /secur|polic|iam|role|permission|acl|nsg|keypair|key_pair|loggroup|alarm|subnet_?group|subnetgroup/i;

export function buildInventory(format: string, title: string, raw: RawResource[], skipped: string[] = []): Inventory {
  const byId = new Map(raw.map((r) => [r.id, r]));
  const kept = raw.filter((r) => r.role !== "minor");
  const items: InventoryItem[] = kept.map((r) => {
    const classified = r.role === "zone" ? { typeId: "zone", componentId: r.component?.id ?? "zones.cloud-vpc-subnet" } : r.typeHint && !r.component ? { typeId: r.typeHint } : classify(r.component, `${r.resourceType} ${r.name}`, r.typeHint ?? "application");
    // A workload whose image says it is a database, a queue or a cache is drawn as one, keeping its component.
    const { typeId, componentId } = r.typeHint && DATA_TYPES.has(r.typeHint) && r.component ? { typeId: r.typeHint, componentId: r.component.id } : classified;
    return {
      id: r.id,
      name: r.name,
      resourceType: r.resourceType,
      typeId,
      ...(componentId ? { componentId } : {}),
      technology: r.technology ?? "",
      description: r.description ?? "",
      tags: r.tags ?? [],
      fields: { type: r.resourceType, ...(r.fields ?? {}) },
    };
  });
  const itemById = new Map(items.map((i) => [i.id, i]));

  // References in both directions, so a minor resource can be crossed from either side.
  const neighbours = new Map<string, Set<string>>();
  const touch = (a: string, b: string) => {
    if (!byId.has(a) || !byId.has(b) || a === b) return;
    (neighbours.get(a) ?? neighbours.set(a, new Set()).get(a)!).add(b);
    (neighbours.get(b) ?? neighbours.set(b, new Set()).get(b)!).add(a);
  };
  for (const r of raw) for (const ref of r.refs) touch(r.id, ref);

  const links: InventoryLink[] = [];
  const add = (sourceId: string, targetId: string, label = "", kind?: RelationKind, extra: Partial<InventoryLink> = {}) => {
    const s = itemById.get(sourceId);
    const t = itemById.get(targetId);
    if (!s || !t || s === t) return;
    // Two networks refer to each other (a subnet and its network); neither draws a line.
    if (s.typeId === "zone" && t.typeId === "zone") return;
    // Settings and secrets a workload reads: it depends on them.
    const own = kind ?? (t.typeId === "component" && !label ? "depends_on" : linkKind(label, s, t));
    links.push({ sourceId, targetId, kind: own, label, ...extra });
  };
  // Stated relationships first: they carry their own kind.
  for (const r of raw) for (const l of r.links ?? []) add(r.id, l.targetId, l.label, l.kind, { ...(l.port ? { port: l.port } : {}), ...(l.protocol ? { protocol: l.protocol } : {}) });
  // A direct reference: the one that refers needs the one it refers to.
  for (const r of kept) for (const ref of r.refs) if (itemById.has(ref)) add(r.id, ref);
  // Through minor resources: the kept resources one minor resource reaches, within a few steps, are joined.
  for (const m of raw) {
    if (m.role !== "minor") continue;
    const reached = new Set<string>();
    const seen = new Set([m.id]);
    let frontier = [m.id];
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier)
        for (const n of neighbours.get(id) ?? []) {
          if (seen.has(n)) continue;
          seen.add(n);
          if (itemById.has(n)) reached.add(n);
          else next.push(n);
        }
      frontier = next;
    }
    const ends = [...reached];
    if (ends.length < 2) continue;
    const grouping = GROUPING.test(m.resourceType);
    // A group joins its members to the network it belongs to, not to each other.
    if (grouping || ends.length > MAX_THROUGH) {
      const zones = ends.filter((id) => itemById.get(id)!.typeId === "zone");
      if (zones.length === 1 && ends.length <= 60) for (const id of ends) if (id !== zones[0]) add(id, zones[0], "");
      continue;
    }
    for (let i = 0; i < ends.length; i++)
      for (let j = i + 1; j < ends.length; j++) {
        const [a, b] = [itemById.get(ends[i])!, itemById.get(ends[j])!];
        const [source, target] = rank(a.typeId) <= rank(b.typeId) ? [a, b] : [b, a];
        add(source.id, target.id, "");
      }
  }

  // A resource that refers to a zone sits inside it: the most specific zone (a subnet before its network).
  const parents = new Map<string, string>();
  const zoneDepth = (id: string) => (/subnet/i.test(itemById.get(id)?.resourceType ?? "") ? 2 : 1);
  for (const r of raw) if (r.parentId && itemById.get(r.parentId)?.typeId === "zone") parents.set(r.id, r.parentId);
  for (const link of links) {
    const source = itemById.get(link.sourceId)!;
    const target = itemById.get(link.targetId)!;
    if (source.typeId === "zone" || target.typeId !== "zone" || objectType(source.typeId).level <= objectType("zone").level) continue;
    const known = parents.get(source.id);
    if (!known || zoneDepth(target.id) > zoneDepth(known)) parents.set(source.id, target.id);
  }
  const placed = links.filter((l) => !(parents.has(l.sourceId) && itemById.get(l.targetId)?.typeId === "zone"));
  const { links: clean, loose } = cleanLinks(items, placed);
  const withParents = items.map((i) => (parents.has(i.id) ? { ...i, fields: { ...i.fields }, parentId: parents.get(i.id)! } : i));
  const minor = raw.length - kept.length;
  return {
    format,
    title,
    items: withParents,
    links: clean,
    skipped: [
      ...skipped,
      ...(minor ? [`${minor} minor ${minor === 1 ? "resource" : "resources"} (policies, rules, attachments, interfaces and the like) not drawn; what they join is joined`] : []),
      ...(loose ? [`${loose} ${loose === 1 ? "reference" : "references"} to something not in the file`] : []),
    ],
  };
}
