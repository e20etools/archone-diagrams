import { RELATION_KIND_INFO } from "./catalog";
import { CATEGORY_INFO, viewCategory } from "./categories";
import { VIEW_TYPE_INFO } from "./catalog";
import { autoLayout } from "./layout";
import { protocolsOf, sortedDiagrams } from "./model";
import type { Category } from "./categories";
import type { Diagram, Workspace } from "./types";

/**
 * Every diagram on one map, and how they hang together. A diagram depends on another when one
 * of its components needs a component shown only on the other, or when it shows the other as a
 * box. Two diagrams share when the same component is on both.
 */

export interface MapNode {
  diagram: Diagram;
  category: Category;
  /** Boxes on the diagram. */
  objects: number;
  /** Components on it that take part in a link to another diagram. */
  linked: string[];
}

export interface MapReason {
  /** The component on the diagram that needs, or is the box. */
  from: string;
  /** The component on the other diagram, or the other diagram's box. */
  to: string;
  /** "Calls", "Depends on", "shown as a box". */
  kind: string;
  protocols: string[];
}

export interface MapLink {
  id: string;
  /** For a dependency, the diagram that needs; for sharing, the first of the two. */
  from: string;
  to: string;
  kind: "depends" | "shared";
  /** Dependencies: the relationships and boxes behind it. */
  reasons: MapReason[];
  /** Sharing: the components on both. */
  shared: string[];
  protocols: string[];
}

export interface DiagramMap {
  nodes: MapNode[];
  links: MapLink[];
}

export function diagramMap(ws: Workspace): DiagramMap {
  const diagrams = sortedDiagrams(ws);
  const on = new Map<string, Set<string>>(); // object -> diagrams showing it
  for (const d of diagrams) for (const id of Object.keys(d.nodes)) if (ws.objects[id]) (on.get(id) ?? on.set(id, new Set()).get(id)!).add(d.id);
  const shows = (d: string, o: string) => on.get(o)?.has(d) ?? false;
  const links = new Map<string, MapLink>();
  const linked = new Map<string, Set<string>>();
  const touch = (d: string, o: string) => (linked.get(d) ?? linked.set(d, new Set()).get(d)!).add(o);
  const depends = (a: string, b: string, reason: MapReason) => {
    const id = `dep:${a}>${b}`;
    const link =
      links.get(id) ??
      links
        .set(id, {
          id,
          from: a,
          to: b,
          kind: "depends",
          reasons: [],
          shared: [],
          protocols: [],
        })
        .get(id)!;
    link.reasons.push(reason);
    for (const p of reason.protocols) if (!link.protocols.includes(p)) link.protocols.push(p);
    touch(a, reason.from);
    touch(b, reason.to);
  };

  for (const r of Object.values(ws.relationships)) {
    const info = RELATION_KIND_INFO[r.kind];
    if (!info?.dependency) continue;
    const protocols = protocolsOf(r).map((p) => p.name);
    const pairs: [string, string][] = [[r.sourceId, r.targetId]];
    if (r.flow === "both") pairs.push([r.targetId, r.sourceId]);
    for (const [s, t] of pairs) {
      for (const a of on.get(s) ?? []) {
        // Within one diagram, it is that diagram's own business.
        if (shows(a, t)) continue;
        for (const b of on.get(t) ?? []) {
          if (b === a || shows(b, s)) continue;
          depends(a, b, { from: s, to: t, kind: info.label, protocols });
        }
      }
    }
  }
  // A box standing for another diagram.
  for (const o of Object.values(ws.objects)) {
    if (o.typeId !== "diagram" || !o.diagramId || !ws.diagrams[o.diagramId] || ws.diagrams[o.diagramId].archive?.archived) continue;
    for (const a of on.get(o.id) ?? [])
      if (a !== o.diagramId)
        depends(a, o.diagramId, {
          from: o.id,
          to: o.id,
          kind: "shown as a box",
          protocols: [],
        });
  }
  // The same component on two diagrams.
  for (const [objectId, set] of on) {
    const o = ws.objects[objectId];
    if (o.typeId === "diagram" || o.typeId === "zone") continue;
    const list = [...set].sort();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const id = `share:${list[i]}|${list[j]}`;
        const link =
          links.get(id) ??
          links
            .set(id, {
              id,
              from: list[i],
              to: list[j],
              kind: "shared",
              reasons: [],
              shared: [],
              protocols: [],
            })
            .get(id)!;
        link.shared.push(objectId);
        touch(list[i], objectId);
        touch(list[j], objectId);
      }
    }
  }

  const nodes = diagrams.map((d) => ({
    diagram: d,
    category: viewCategory(d.viewType),
    objects: Object.keys(d.nodes).filter((id) => ws.objects[id]).length,
    linked: [...(linked.get(d.id) ?? [])].filter((id) => ws.objects[id]).sort((a, b) => ws.objects[a].name.localeCompare(ws.objects[b].name)),
  }));
  return { nodes, links: [...links.values()] };
}

/** Diagrams reached from one, through dependencies, nearest first: what it needs, or what needs it. */
export function mapReach(map: DiagramMap, id: string, direction: "needs" | "neededBy", levels = 5): Map<string, number> {
  const out = new Map<string, number>();
  let frontier = [id];
  const seen = new Set([id]);
  for (let level = 1; level <= levels && frontier.length; level++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const l of map.links) {
        if (l.kind !== "depends") continue;
        const other = direction === "needs" ? (l.from === cur ? l.to : null) : l.to === cur ? l.from : null;
        if (!other || seen.has(other)) continue;
        seen.add(other);
        out.set(other, level);
        next.push(other);
      }
    }
    frontier = next;
  }
  return out;
}

/** The shortest way from one diagram to another over any link, up to five steps; empty when there is none. */
export function mapPath(map: DiagramMap, from: string, to: string, kinds: MapLink["kind"][] = ["depends", "shared"], max = 5): MapLink[] {
  if (from === to) return [];
  const prev = new Map<string, MapLink>();
  const seen = new Set([from]);
  let frontier = [from];
  for (let step = 0; step < max && frontier.length; step++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const l of map.links) {
        if (!kinds.includes(l.kind)) continue;
        const other = l.from === cur ? l.to : l.to === cur ? l.from : null;
        if (!other || seen.has(other)) continue;
        seen.add(other);
        prev.set(other, l);
        if (other === to) {
          const path: MapLink[] = [];
          for (let at = to; at !== from;) {
            const link = prev.get(at)!;
            path.unshift(link);
            at = link.from === at ? link.to : link.from;
          }
          return path;
        }
        next.push(other);
      }
    }
    frontier = next;
  }
  return [];
}

/** Links whose two ends are both among the diagrams given. */
export const linksAmong = (map: DiagramMap, ids: string[]) => map.links.filter((l) => ids.includes(l.from) && ids.includes(l.to));

/** A short label for a link: what it carries. */
export function linkLabel(ws: Workspace, l: MapLink): string {
  if (l.kind === "shared") return `${l.shared.length} shared`;
  const boxes = l.reasons.filter((r) => r.kind === "shown as a box").length;
  const lines = l.reasons.length - boxes;
  const parts = [lines ? `${lines} ${lines === 1 ? "link" : "links"}` : "", boxes ? "as a box" : "", l.protocols.slice(0, 2).join(", ")].filter(Boolean);
  return parts.join(" · ") || (ws.diagrams[l.to]?.name ?? "");
}

/** Where each diagram goes, from left to right in the order of what needs what. */
export function mapLayout(map: DiagramMap, direction: "LR" | "TB" = "LR") {
  return autoLayout({
    nodeIds: map.nodes.map((n) => n.diagram.id),
    edges: map.links.filter((l) => l.kind === "depends").map((l) => ({ sourceId: l.from, targetId: l.to })),
    direction,
    respectPinned: false,
  });
}

export const categoryColor: Record<Category, string> = {
  applications: "#2447D6",
  data: "#0E8A6A",
  infrastructure: "#B4620E",
  business: "#8B3FC7",
  custom: "#5B6779",
};

export const kindLabel = (d: Diagram) => VIEW_TYPE_INFO[d.viewType]?.label ?? d.viewType;
export const categoryLabel = (c: Category) => CATEGORY_INFO[c].label;

/** The links as rows, for a spreadsheet. */
export function mapRows(ws: Workspace, map: DiagramMap): string[][] {
  const name = (id: string) => ws.diagrams[id]?.name ?? id;
  const obj = (id: string) => ws.objects[id]?.name ?? id;
  return [
    ["From diagram", "To diagram", "Kind", "Count", "Through", "Protocols"],
    ...map.links.map((l) => [
      name(l.from),
      name(l.to),
      l.kind === "depends" ? "Depends on" : "Shares components",
      String(l.kind === "depends" ? l.reasons.length : l.shared.length),
      l.kind === "depends"
        ? l.reasons.map((r) => (r.kind === "shown as a box" ? `${obj(r.from)} (box)` : `${obj(r.from)} ${r.kind.toLowerCase()} ${obj(r.to)}`)).join("; ")
        : l.shared.map(obj).join("; "),
      l.protocols.join(", "),
    ]),
  ];
}

/** The map as a Mermaid flowchart. */
export function mapMermaid(ws: Workspace, map: DiagramMap): string {
  const key = new Map(map.nodes.map((n, i) => [n.diagram.id, `D${i + 1}`]));
  const quote = (s: string) => s.replace(/"/g, "'");
  const lines = ["flowchart LR"];
  for (const n of map.nodes) lines.push(`  ${key.get(n.diagram.id)}["${quote(n.diagram.name)}<br/><small>${quote(kindLabel(n.diagram))}</small>"]`);
  for (const l of map.links) {
    const a = key.get(l.from);
    const b = key.get(l.to);
    if (!a || !b) continue;
    lines.push(l.kind === "depends" ? `  ${a} -->|"${quote(linkLabel(ws, l))}"| ${b}` : `  ${a} -.-|"${quote(linkLabel(ws, l))}"| ${b}`);
  }
  return lines.join("\n") + "\n";
}
