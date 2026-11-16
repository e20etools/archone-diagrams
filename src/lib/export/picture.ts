import { CATEGORY_INFO, LIFECYCLE_INFO, RELATION_KIND_INFO, objectType } from "../catalog";
import { NODE_H, NODE_W } from "../layout";
import { componentById } from "../library";
import type { Diagram, Workspace } from "../types";
import { visibleEdges } from "../views";
import { protocolsOf } from "../model";
import { protocolLabel } from "../library/protocols";
import { zonesOf } from "../zones";

/**
 * A diagram drawn from the model rather than from the screen: boxes where the diagram puts
 * them, lines between them, colours by category. The animated, interactive and PowerPoint
 * exports are made from this, so they look the same wherever they are opened.
 */

export interface PictureNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  subtitle: string;
  color: string;
  /** Shown in the interactive page when the box is picked. */
  details: { label: string; value: string }[];
}
export interface PictureEdge {
  id: string;
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label: string;
  kind: string;
  flow: "out" | "in" | "both";
}
export interface Picture {
  title: string;
  width: number;
  height: number;
  nodes: PictureNode[];
  edges: PictureEdge[];
  /** The system a C4 Level 1 or 2 diagram is about, drawn as a dashed boundary. */
  boundary: { x: number; y: number; w: number; h: number; label: string } | null;
  /** Network zones holding boxes, drawn around them, outer ones first. */
  zones: { id: string; x: number; y: number; w: number; h: number; label: string; color: string }[];
  flows: { name: string; steps: { from: string; to: string; text: string }[] }[];
}

const PAD = 40;

/** Where a line from the centre of a box towards a point leaves the box. */
function border(cx: number, cy: number, w: number, h: number, tx: number, ty: number): [number, number] {
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const scale = Math.min(Math.abs(w / 2 / (dx || 1e-9)), Math.abs(h / 2 / (dy || 1e-9)));
  return [cx + dx * scale, cy + dy * scale];
}

export function diagramPicture(ws: Workspace, diagram: Diagram): Picture {
  const zoneList = zonesOf(ws, diagram);
  const zoneIds = new Set(zoneList.map((z) => z.id));
  const placed = Object.entries(diagram.nodes).filter(([id]) => ws.objects[id] && !zoneIds.has(id));
  const minX = Math.min(0, ...placed.map(([, p]) => p.x));
  const minY = Math.min(0, ...placed.map(([, p]) => p.y));
  const nodes: PictureNode[] = placed.map(([id, p]) => {
    const o = ws.objects[id];
    const type = objectType(o.typeId);
    const component = componentById(o.componentId);
    const subtitle = [component && component.name !== o.name ? component.name : type.label, o.technology && o.technology !== component?.name ? o.technology : ""].filter(Boolean).join(" · ");
    const details = [
      { label: "Type", value: type.label },
      { label: "Component", value: component?.name ?? "" },
      { label: "Technology", value: o.technology },
      { label: "Owner", value: o.owner },
      { label: "Lifecycle", value: LIFECYCLE_INFO[o.lifecycle]?.label ?? o.lifecycle },
      { label: "Description", value: o.description },
      ...Object.entries(o.fields ?? {}).map(([label, value]) => ({ label, value: String(value) })),
      ...(o.links ?? []).map((l) => ({ label: l.label || "Link", value: l.url })),
    ].filter((d) => d.value.trim());
    return { id, x: p.x - minX + PAD, y: p.y - minY + PAD, w: NODE_W, h: NODE_H, name: o.name, subtitle, color: CATEGORY_INFO[type.category]?.color ?? "#2447D6", details };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: PictureEdge[] = [];
  for (const e of visibleEdges(ws, diagram)) {
    const a = byId.get(e.sourceId);
    const b = byId.get(e.targetId);
    if (!a || !b) continue;
    const [x1, y1] = border(a.x + a.w / 2, a.y + a.h / 2, a.w + 8, a.h + 8, b.x + b.w / 2, b.y + b.h / 2);
    const [x2, y2] = border(b.x + b.w / 2, b.y + b.h / 2, b.w + 12, b.h + 12, a.x + a.w / 2, a.y + a.h / 2);
    const rel = e.implied ? undefined : ws.relationships[e.relationshipIds[0]];
    const carried = rel ? protocolsOf(rel).slice(0, 2).map(protocolLabel).join(", ") : "";
    const label = [e.label || RELATION_KIND_INFO[e.kind]?.label || "", carried].filter(Boolean).join(" · ");
    edges.push({ id: e.id, from: e.sourceId, to: e.targetId, x1, y1, x2, y2, label, kind: e.kind, flow: rel?.flow ?? "out" });
  }
  // Zones around their boxes, inner ones first so an outer zone can take in an inner one.
  const zoneFrames = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const z of [...zoneList].sort((a, b) => b.depth - a.depth)) {
    const rects = z.members.map((m) => zoneFrames.get(m) ?? (byId.get(m) ? { x: byId.get(m)!.x, y: byId.get(m)!.y, w: NODE_W, h: NODE_H } : null)).filter((r): r is { x: number; y: number; w: number; h: number } => !!r);
    if (!rects.length) continue;
    const x = Math.min(...rects.map((r) => r.x)) - 26;
    const y = Math.min(...rects.map((r) => r.y)) - 42;
    zoneFrames.set(z.id, { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) + 26 - x, h: Math.max(...rects.map((r) => r.y + r.h)) + 26 - y });
  }
  const zones = zoneList.filter((z) => zoneFrames.has(z.id)).map((z) => ({ id: z.id, ...zoneFrames.get(z.id)!, label: z.name, color: z.color }));
  let boundary: Picture["boundary"] = null;
  const scope = diagram.scopeId ? ws.objects[diagram.scopeId] : null;
  if (scope) {
    const inside = (id: string) => {
      for (let cur = ws.objects[id]?.parentId, n = 0; cur && n < 12; cur = ws.objects[cur]?.parentId, n++) if (cur === scope.id) return true;
      return false;
    };
    const members = nodes.filter((n) => inside(n.id));
    if (members.length) {
      const x = Math.min(...members.map((n) => n.x)) - 24;
      const y = Math.min(...members.map((n) => n.y)) - 40;
      boundary = { x, y, w: Math.max(...members.map((n) => n.x + n.w)) + 24 - x, h: Math.max(...members.map((n) => n.y + n.h)) + 24 - y, label: scope.name };
    }
  }
  const right = Math.max(400, ...nodes.map((n) => n.x + n.w), boundary ? boundary.x + boundary.w : 0, ...zones.map((z) => z.x + z.w));
  const bottom = Math.max(240, ...nodes.map((n) => n.y + n.h), boundary ? boundary.y + boundary.h : 0, ...zones.map((z) => z.y + z.h));
  return {
    title: diagram.name,
    width: Math.ceil(right + PAD),
    height: Math.ceil(bottom + PAD),
    nodes,
    edges,
    boundary,
    zones,
    flows: (diagram.flows ?? []).filter((f) => f.steps.length).map((f) => ({ name: f.name, steps: f.steps.map((s) => ({ from: s.fromId, to: s.toId, text: s.text })) })),
  };
}

export const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Text cut to fit a box, with an ellipsis. */
function fit(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export interface SvgOptions {
  /** Lines to draw highlighted, for a step of a flow. */
  highlight?: Set<string>;
  /** Boxes to draw highlighted. */
  lit?: Set<string>;
  /** Moves the dashes along every line, for traffic. */
  dash?: number;
  /** A caption across the bottom, such as the step being shown. */
  caption?: string;
  scale?: number;
}

/** The picture as an SVG document. */
export function pictureSvg(p: Picture, options: SvgOptions = {}): string {
  const scale = options.scale ?? 1;
  const extra = options.caption ? 44 : 0;
  const w = p.width;
  const h = p.height + extra;
  const font = "font-family=\"IBM Plex Sans, Segoe UI, Arial, sans-serif\"";
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * scale)}" height="${Math.round(h * scale)}" viewBox="0 0 ${w} ${h}">`);
  out.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#8A95A8"/></marker><marker id="arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#E0662B"/></marker></defs>`);
  out.push(`<rect width="${w}" height="${h}" fill="#FFFFFF"/>`);
  if (p.boundary) {
    const b = p.boundary;
    out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" fill="#F5F7FC" stroke="#2447D6" stroke-dasharray="6 4"/>`);
    out.push(`<text x="${b.x + 12}" y="${b.y + 22}" ${font} font-size="13" font-weight="600" fill="#2447D6">${escapeXml(fit(b.label, 60))}</text>`);
  }
  for (const z of p.zones ?? []) {
    out.push(`<rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="10" fill="${z.color}" fill-opacity="0.06" stroke="${z.color}" stroke-width="1.5" stroke-dasharray="6 4"/>`);
    out.push(`<text x="${z.x + z.w / 2}" y="${z.y + 24}" ${font} font-size="13" font-weight="600" fill="${z.color}" text-anchor="middle">${escapeXml(fit(z.label, 60))}</text>`);
  }
  for (const e of p.edges) {
    const on = options.highlight?.has(e.id);
    const marker = `url(#${on ? "arrow-on" : "arrow"})`;
    const ends = `${e.flow !== "in" ? ` marker-end="${marker}"` : ""}${e.flow !== "out" ? ` marker-start="${marker}"` : ""}`;
    // Inbound traffic moves from the target back to the source.
    const moving = options.dash !== undefined ? ` stroke-dasharray="7 6" stroke-dashoffset="${e.flow === "in" ? options.dash : -options.dash}"` : "";
    out.push(`<line x1="${e.x1.toFixed(1)}" y1="${e.y1.toFixed(1)}" x2="${e.x2.toFixed(1)}" y2="${e.y2.toFixed(1)}" stroke="${on ? "#E0662B" : "#8A95A8"}" stroke-width="${on ? 3 : 1.4}"${on ? "" : moving}${ends}/>`);
    if (e.label) {
      const mx = (e.x1 + e.x2) / 2;
      const my = (e.y1 + e.y2) / 2;
      const label = escapeXml(fit(e.label, 28));
      out.push(`<rect x="${(mx - label.length * 3.2 - 5).toFixed(1)}" y="${(my - 9).toFixed(1)}" width="${(label.length * 6.4 + 10).toFixed(1)}" height="16" rx="3" fill="#FFFFFF" opacity="0.9"/>`);
      out.push(`<text x="${mx.toFixed(1)}" y="${(my + 3).toFixed(1)}" ${font} font-size="10.5" fill="${on ? "#B04A17" : "#5B6779"}" text-anchor="middle">${label}</text>`);
    }
  }
  for (const n of p.nodes) {
    const on = options.lit?.has(n.id);
    out.push(`<g>`);
    out.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="8" fill="#FFFFFF" stroke="${on ? "#E0662B" : "#D5DBE6"}" stroke-width="${on ? 2.5 : 1}"/>`);
    out.push(`<rect x="${n.x}" y="${n.y}" width="5" height="${n.h}" rx="2" fill="${n.color}"/>`);
    out.push(`<text x="${n.x + 16}" y="${n.y + 33}" ${font} font-size="14" font-weight="600" fill="#16233A">${escapeXml(fit(n.name, 26))}</text>`);
    out.push(`<text x="${n.x + 16}" y="${n.y + 53}" ${font} font-size="11.5" fill="#5B6779">${escapeXml(fit(n.subtitle, 34))}</text>`);
    out.push(`</g>`);
  }
  if (options.caption) {
    out.push(`<rect x="0" y="${p.height}" width="${w}" height="${extra}" fill="#16233A"/>`);
    out.push(`<text x="${PAD}" y="${p.height + 28}" ${font} font-size="15" fill="#FFFFFF">${escapeXml(fit(options.caption, 140))}</text>`);
  }
  out.push(`</svg>`);
  return out.join("");
}

/** One frame of an animation: what is lit and what the caption says. */
export interface Frame {
  svg: string;
  /** How long it stays, in milliseconds. */
  hold: number;
}

/**
 * The frames of a diagram in motion. With flows, each step of each flow is shown in turn, its
 * line and boxes lit and its words in the caption. Without, the lines carry moving dashes.
 */
export function pictureFrames(p: Picture, scale = 1): Frame[] {
  const frames: Frame[] = [];
  if (p.flows.length) {
    for (const flow of p.flows) {
      frames.push({ svg: pictureSvg(p, { caption: flow.name, scale }), hold: 1400 });
      flow.steps.forEach((step, i) => {
        const edges = new Set(p.edges.filter((e) => (e.from === step.from && e.to === step.to) || (e.from === step.to && e.to === step.from)).map((e) => e.id));
        frames.push({ svg: pictureSvg(p, { highlight: edges, lit: new Set([step.from, step.to]), caption: `${flow.name}: ${i + 1}. ${step.text || "Step"}`, scale }), hold: 1600 });
      });
    }
    return frames;
  }
  for (let i = 0; i < 16; i++) frames.push({ svg: pictureSvg(p, { dash: i * (13 / 16) * 2, caption: p.title, scale }), hold: 90 });
  return frames;
}
