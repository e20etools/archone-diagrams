import { DiagramFileError, plainLabel, shapeAt, type ImportedConnector, type ImportedPage, type ImportedShape } from "./diagramFile";
import { allText, child, children, parseXml, type XmlNode } from "./xml";
import { ZipError, readZip } from "./zip";

/** Reads Visio drawings saved as .vsdx (Visio 2013 and later). The older binary .vsd format is not read. */

const PX_PER_INCH = 96;
const px = (value: number) => Math.round(value * 100) / 100;
const text = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : "");
const cellValue = (shape: XmlNode, name: string): number | null => {
  const cell = shape.children.find((c) => c.name === "Cell" && c.attrs.N === name);
  if (!cell || cell.attrs.V === undefined) return null;
  const value = Number(cell.attrs.V);
  return Number.isFinite(value) ? value : null;
};
const hasCell = (shape: XmlNode, name: string) => shape.children.some((c) => c.name === "Cell" && c.attrs.N === name);
const shapeText = (shape: XmlNode | undefined) => (shape && child(shape, "Text") ? plainLabel(allText(child(shape, "Text")!)) : "");

/** What a shape on a page takes from the stencil it was dropped from, unless the page says otherwise. */
interface MasterShape {
  width: number | null;
  height: number | null;
  pinX: number | null;
  pinY: number | null;
  text: string;
  oneD: boolean;
}
interface Master {
  name: string;
  top: MasterShape | undefined;
  /** Every shape inside the stencil by its ID; the parts of a grouped stencil refer to these. */
  shapes: Map<string, MasterShape>;
}

/** Follows a part's relationships file: "rId3" to the path of the part it points at. */
function relationships(files: Map<string, Uint8Array>, part: string): Map<string, string> {
  const folder = part.slice(0, part.lastIndexOf("/"));
  const xml = files.get(`${folder}/_rels/${part.slice(folder.length + 1)}.rels`);
  const map = new Map<string, string>();
  if (!xml) return map;
  for (const r of children(parseXml(text(xml)), "Relationship")) {
    const target = r.attrs.Target ?? "";
    map.set(r.attrs.Id ?? "", target.startsWith("/") ? target.slice(1) : `${folder}/${target}`);
  }
  return map;
}

interface Placed {
  node: XmlNode;
  id: string;
  /** Centre in page inches, y growing upwards as Visio has it. */
  cx: number;
  cy: number;
  width: number;
  height: number;
  text: string;
  hint: string;
  oneD: boolean;
  /** The two ends of a line or connector, in page inches. */
  begin: { x: number; y: number } | null;
  end: { x: number; y: number } | null;
  parent: Placed | null;
  children: Placed[];
}

function pageOf(name: string, page: XmlNode, masters: Map<string, Master>): ImportedPage {
  const all: Placed[] = [];
  const walk = (shapes: XmlNode | undefined, parent: Placed | null, inherited: Master | undefined) => {
    for (const node of children(shapes, "Shape")) {
      const master = masters.get(node.attrs.Master ?? "") ?? inherited;
      const from = node.attrs.Master ? master?.top : node.attrs.MasterShape ? master?.shapes.get(node.attrs.MasterShape) : undefined;
      const width = cellValue(node, "Width") ?? from?.width ?? 1;
      const height = cellValue(node, "Height") ?? from?.height ?? 0.75;
      const pinX = cellValue(node, "PinX") ?? from?.pinX ?? 0;
      const pinY = cellValue(node, "PinY") ?? from?.pinY ?? 0;
      const locX = cellValue(node, "LocPinX") ?? width / 2;
      const locY = cellValue(node, "LocPinY") ?? height / 2;
      // A sub-shape is placed inside its group, whose origin is the group's bottom-left corner.
      const originX = parent ? parent.cx - parent.width / 2 : 0;
      const originY = parent ? parent.cy - parent.height / 2 : 0;
      const end = (x: string, y: string) => {
        const px = cellValue(node, x);
        const py = cellValue(node, y);
        return px === null || py === null ? null : { x: originX + px, y: originY + py };
      };
      const placed: Placed = {
        node,
        id: node.attrs.ID ?? "",
        cx: originX + pinX - locX + width / 2,
        cy: originY + pinY - locY + height / 2,
        width: Math.abs(width),
        height: Math.abs(height),
        text: shapeText(node) || (from?.text ?? ""),
        hint: [master?.name, node.attrs.NameU, node.attrs.Name].filter(Boolean).join(" "),
        oneD: hasCell(node, "BeginX") || !!from?.oneD || (!!node.attrs.Master && /connector/i.test(master?.name ?? "")),
        begin: end("BeginX", "BeginY"),
        end: end("EndX", "EndY"),
        parent,
        children: [],
      };
      all.push(placed);
      parent?.children.push(placed);
      walk(child(node, "Shapes"), placed, master);
    }
  };
  walk(child(page, "Shapes"), null, undefined);

  // What each connector is glued to at its two ends.
  const ends = new Map<string, { begin?: string; end?: string }>();
  for (const connect of children(child(page, "Connects"), "Connect")) {
    const from = connect.attrs.FromSheet ?? "";
    const entry = ends.get(from) ?? {};
    if (/^Begin/i.test(connect.attrs.FromCell ?? "")) entry.begin = connect.attrs.ToSheet;
    else if (/^End/i.test(connect.attrs.FromCell ?? "")) entry.end = connect.attrs.ToSheet;
    ends.set(from, entry);
  }
  const isConnector = (p: Placed) => p.oneD || ends.has(p.id);

  const skipped = { unlabelled: 0, loose: 0, notes: 0 };
  const labelled = (p: Placed): Placed[] => (isConnector(p) ? [] : [...(p.text ? [p] : []), ...p.children.flatMap(labelled)]);
  // Which Visio shape stands for an object: a labelled shape, or a group that is an icon with one label inside it.
  const objectOf = new Map<Placed, { text: string }>();
  const decide = (p: Placed) => {
    if (isConnector(p)) return;
    const inside = p.children.flatMap(labelled);
    if (p.text) objectOf.set(p, { text: p.text });
    else if (p.children.length && inside.length === 1) objectOf.set(p, { text: inside[0].text });
    else if (p.children.length) p.children.forEach(decide);
    else skipped.unlabelled += 1;
  };
  all.filter((p) => !p.parent).forEach(decide);

  const objectFor = (id: string | undefined): Placed | null => {
    for (let p = all.find((s) => s.id === id) ?? null; p; p = p.parent) if (objectOf.has(p)) return p;
    return null;
  };
  const top = Math.max(0, ...[...objectOf.keys()].map((p) => p.cy + p.height / 2));
  const shapes: ImportedShape[] = [...objectOf.entries()].map(([p, { text: label }]) => ({
    id: p.id,
    text: label,
    x: px((p.cx - p.width / 2) * PX_PER_INCH),
    y: px((top - (p.cy + p.height / 2)) * PX_PER_INCH),
    width: px(p.width * PX_PER_INCH),
    height: px(p.height * PX_PER_INCH),
    parentId: null,
    hint: p.hint,
  }));

  const connectors: ImportedConnector[] = [];
  for (const p of all) {
    if (!isConnector(p)) continue;
    const glued = ends.get(p.id) ?? {};
    // An end that is not glued is matched to the shape it was drawn up to.
    const near = (at: { x: number; y: number } | null): Placed | null => {
      const hit = at ? shapeAt(shapes, at.x * PX_PER_INCH, (top - at.y) * PX_PER_INCH, 0.15 * PX_PER_INCH) : null;
      return hit ? ([...objectOf.keys()].find((o) => o.id === hit.id) ?? null) : null;
    };
    const source = glued.begin ? objectFor(glued.begin) : near(p.begin);
    const target = glued.end ? objectFor(glued.end) : near(p.end);
    if (!source || !target || source === target) {
      skipped.loose += 1;
      continue;
    }
    connectors.push({ id: p.id, sourceId: source.id, targetId: target.id, text: p.text });
  }
  return { name, shapes, connectors, skipped };
}

export async function readVsdx(bytes: Uint8Array): Promise<ImportedPage[]> {
  let files: Map<string, Uint8Array>;
  try {
    files = await readZip(bytes, (path) => path.startsWith("visio/") && path.endsWith(path.includes("_rels") ? ".rels" : ".xml"));
  } catch (error) {
    if (error instanceof ZipError && /password/.test(error.message)) throw new DiagramFileError(error.message);
    throw new DiagramFileError("This file could not be opened as a Visio drawing. Older .vsd files have to be saved as .vsdx in Visio first.");
  }
  const pagesXml = files.get("visio/pages/pages.xml");
  if (!pagesXml) throw new DiagramFileError("This file is not a Visio drawing (.vsdx). Older .vsd files have to be saved as .vsdx in Visio first.");

  const masters = new Map<string, Master>();
  const mastersXml = files.get("visio/masters/masters.xml");
  if (mastersXml) {
    const rels = relationships(files, "visio/masters/masters.xml");
    for (const master of children(parseXml(text(mastersXml)), "Master")) {
      const part = files.get(rels.get(child(master, "Rel")?.attrs.id ?? "") ?? "");
      const shapes = new Map<string, MasterShape>();
      let top: MasterShape | undefined;
      const collect = (holder: XmlNode | undefined) => {
        for (const node of children(holder, "Shape")) {
          const shape: MasterShape = { width: cellValue(node, "Width"), height: cellValue(node, "Height"), pinX: cellValue(node, "PinX"), pinY: cellValue(node, "PinY"), text: shapeText(node), oneD: hasCell(node, "BeginX") };
          top ??= shape;
          shapes.set(node.attrs.ID ?? "", shape);
          collect(child(node, "Shapes"));
        }
      };
      if (part) collect(child(parseXml(text(part)), "Shapes"));
      masters.set(master.attrs.ID ?? "", { name: master.attrs.NameU ?? master.attrs.Name ?? "", top, shapes });
    }
  }

  const rels = relationships(files, "visio/pages/pages.xml");
  const pages: ImportedPage[] = [];
  for (const [i, page] of children(parseXml(text(pagesXml)), "Page").entries()) {
    if (page.attrs.Background === "1") continue;
    const part = files.get(rels.get(child(page, "Rel")?.attrs.id ?? "") ?? `visio/pages/page${i + 1}.xml`);
    if (!part) continue;
    pages.push(pageOf(page.attrs.NameU ?? page.attrs.Name ?? `Page ${i + 1}`, parseXml(text(part)), masters));
  }
  if (!pages.length) throw new DiagramFileError("This Visio drawing holds no pages.");
  return pages;
}
