import { DiagramFileError, plainLabel, shapeAt, type ImportedConnector, type ImportedPage, type ImportedShape } from "./diagramFile";
import { allText, child, children, parseXml, type XmlNode } from "./xml";
import { inflateRaw } from "./zip";

/** Reads draw.io (diagrams.net) files: .drawio and .xml, with plain or compressed pages. */

async function modelOf(diagram: XmlNode): Promise<XmlNode | null> {
  const direct = child(diagram, "mxGraphModel");
  if (direct) return direct;
  const packed = allText(diagram).trim();
  if (!packed) return null;
  // A compressed page is URL-encoded XML, deflated, then base64.
  try {
    const binary = atob(packed);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const inflated = new TextDecoder().decode(await inflateRaw(bytes));
    return parseXml(decodeURIComponent(inflated));
  } catch {
    throw new DiagramFileError(`The page "${diagram.attrs.name ?? "Page"}" could not be unpacked. In draw.io, choose File, Properties, switch off Compressed, save and try again.`);
  }
}

interface Cell {
  id: string;
  label: string;
  style: string;
  parent: string;
  vertex: boolean;
  edge: boolean;
  source: string;
  target: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Where an arrow starts and ends when it is not attached to a shape. */
  from: { x: number; y: number } | null;
  to: { x: number; y: number } | null;
}

function cellsOf(model: XmlNode): Cell[] {
  const cells: Cell[] = [];
  for (const node of child(model, "root")?.children ?? []) {
    // A cell with custom data is wrapped in <object> or <UserObject>, which then carries the id and label.
    const cell = node.name === "mxCell" ? node : child(node, "mxCell");
    if (!cell) continue;
    const geometry = child(cell, "mxGeometry");
    const number = (name: string) => Number(geometry?.attrs[name] ?? 0) || 0;
    const point = (as: string) => {
      const found = geometry?.children.find((c) => c.name === "mxPoint" && c.attrs.as === as);
      return found ? { x: Number(found.attrs.x ?? 0) || 0, y: Number(found.attrs.y ?? 0) || 0 } : null;
    };
    cells.push({
      id: node.attrs.id ?? cell.attrs.id ?? "",
      label: plainLabel(node === cell ? (cell.attrs.value ?? "") : (node.attrs.label ?? cell.attrs.value ?? "")),
      style: cell.attrs.style ?? "",
      parent: cell.attrs.parent ?? "",
      vertex: cell.attrs.vertex === "1",
      edge: cell.attrs.edge === "1",
      source: cell.attrs.source ?? "",
      target: cell.attrs.target ?? "",
      x: number("x"),
      y: number("y"),
      width: number("width"),
      height: number("height"),
      from: point("sourcePoint"),
      to: point("targetPoint"),
    });
  }
  return cells;
}

function pageOf(name: string, model: XmlNode): ImportedPage {
  const cells = cellsOf(model);
  const byId = new Map(cells.map((c) => [c.id, c]));
  const skipped = { unlabelled: 0, loose: 0, notes: 0 };
  const isText = (c: Cell) => /^text[;]|[;]text[;]|shape=note|shape=callout/.test(c.style);

  // Labels of arrows are small cells that belong to the arrow.
  const edgeLabels = new Map<string, string>();
  for (const c of cells) if (c.vertex && byId.get(c.parent)?.edge && c.label) edgeLabels.set(c.parent, [edgeLabels.get(c.parent), c.label].filter(Boolean).join(" "));


  // Positions inside a group are relative to it.
  const absolute = (c: Cell): { x: number; y: number } => {
    let x = c.x;
    let y = c.y;
    const seen = new Set<string>([c.id]);
    for (let p = byId.get(c.parent); p && p.vertex && !seen.has(p.id); p = byId.get(p.parent)) {
      seen.add(p.id);
      x += p.x;
      y += p.y;
    }
    return { x, y };
  };

  const shapesOnPage = cells.filter((c) => c.vertex && !byId.get(c.parent)?.edge);
  const hasShapesInside = (c: Cell) => cells.some((other) => other.parent === c.id && other.vertex);
  // An icon is often drawn with its name as a separate piece of text just beneath it.
  const captions = new Map<string, string>();
  const usedText = new Set<string>();
  const texts = shapesOnPage.filter((c) => isText(c) && c.label).map((c) => ({ cell: c, ...absolute(c) }));
  for (const c of shapesOnPage) {
    if (c.label || isText(c) || hasShapesInside(c)) continue;
    const at = absolute(c);
    const below = texts
      .filter((t) => !usedText.has(t.cell.id))
      .filter((t) => {
        const middle = t.x + t.cell.width / 2;
        const gap = t.y - (at.y + c.height);
        return middle >= at.x - 10 && middle <= at.x + c.width + 10 && gap >= -c.height / 2 && gap <= 36;
      })
      .sort((a, b) => a.y - b.y)[0];
    if (below) {
      captions.set(c.id, below.cell.label);
      usedText.add(below.cell.id);
    }
  }
  const labelOf = (c: Cell) => c.label || captions.get(c.id) || "";

  const kept = new Set<string>();
  for (const c of shapesOnPage) {
    if (usedText.has(c.id)) continue;
    if (isText(c)) skipped.notes += 1;
    else if (labelOf(c)) kept.add(c.id);
    // An unlabelled group only holds other shapes together and is not counted as something left out.
    else if (!hasShapesInside(c)) skipped.unlabelled += 1;
  }

  const keptAncestor = (id: string): string | null => {
    const seen = new Set<string>();
    for (let p = byId.get(id); p && !seen.has(p.id); p = byId.get(p.parent)) {
      seen.add(p.id);
      if (kept.has(p.id)) return p.id;
    }
    return null;
  };
  /** What an arrow attached to this cell is attached to: the cell, a shape around it, or the one labelled shape in an unlabelled group. */
  const endOf = (id: string): string | null => {
    const direct = keptAncestor(id);
    if (direct) return direct;
    const inside = cells.filter((c) => c.parent === id && kept.has(c.id));
    return inside.length === 1 ? inside[0].id : null;
  };

  const shapes: ImportedShape[] = cells
    .filter((c) => kept.has(c.id))
    .map((c) => ({ id: c.id, text: labelOf(c), ...absolute(c), width: c.width || 120, height: c.height || 60, parentId: keptAncestor(c.parent), hint: c.style }));

  const connectors: ImportedConnector[] = [];
  for (const c of cells) {
    if (!c.edge) continue;
    // An end that is not attached is matched to the shape it was drawn up to.
    const offset = byId.get(c.parent)?.vertex ? absolute({ ...c, x: 0, y: 0 }) : { x: 0, y: 0 };
    const near = (at: { x: number; y: number } | null) => (at ? (shapeAt(shapes, at.x + offset.x, at.y + offset.y, 12)?.id ?? null) : null);
    const sourceId = c.source ? endOf(c.source) : near(c.from);
    const targetId = c.target ? endOf(c.target) : near(c.to);
    if (!sourceId || !targetId || sourceId === targetId) {
      skipped.loose += 1;
      continue;
    }
    connectors.push({ id: c.id, sourceId, targetId, text: [c.label, edgeLabels.get(c.id)].filter(Boolean).join(" ") });
  }
  return { name, shapes, connectors, skipped };
}

export async function readDrawio(text: string): Promise<ImportedPage[]> {
  let root: XmlNode;
  try {
    root = parseXml(text);
  } catch {
    throw new DiagramFileError("This file could not be read as a draw.io diagram. Export it from draw.io with File, Save as, and choose the .drawio format.");
  }
  if (root.name === "mxGraphModel") return [pageOf("Page 1", root)];
  if (root.name !== "mxfile") throw new DiagramFileError("This XML file is not a draw.io diagram. A draw.io file starts with <mxfile>.");
  const pages: ImportedPage[] = [];
  for (const [i, diagram] of children(root, "diagram").entries()) {
    const model = await modelOf(diagram);
    if (model) pages.push(pageOf(diagram.attrs.name || `Page ${i + 1}`, model));
  }
  if (!pages.length) throw new DiagramFileError("This draw.io file holds no pages.");
  return pages;
}
