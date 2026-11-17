import PptxGenJS from "pptxgenjs";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { objectType } from "../catalog";
import { componentById } from "../library";
import type { Diagram, Workspace } from "../types";
import { diagramObjects, diagramRelationships, slugify } from "../exporters";
import { escapeXml, pictureFrames, pictureSvg, type Picture } from "./picture";

/* ---------- the diagram alone, for exports that take a model ---------- */

/** A workspace holding only what one diagram shows: its objects, the lines between them, and the diagram. */
export function diagramWorkspace(ws: Workspace, diagram: Diagram): Workspace {
  const objects = Object.fromEntries(diagramObjects(ws, diagram).map((o) => [o.id, { ...o, parentId: o.parentId && diagram.nodes[o.parentId] ? o.parentId : null }]));
  const relationships = Object.fromEntries(diagramRelationships(ws, diagram).map((r) => [r.id, r]));
  return { ...ws, objects, relationships, diagrams: { [diagram.id]: diagram }, proposals: {}, adrs: {}, templates: {}, wizards: {}, reports: {}, branding: {} };
}

/* ---------- pictures in the browser ---------- */

/** Draws an SVG document onto a canvas of its own size. */
export async function rasterize(svg: string, canvas?: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.decoding = "sync";
    await new Promise<void>((ok, fail) => {
      img.onload = () => ok();
      img.onerror = () => fail(new Error("The picture could not be drawn."));
      img.src = url;
    });
    const c = canvas ?? document.createElement("canvas");
    if (c.width !== img.width || c.height !== img.height) {
      c.width = img.width;
      c.height = img.height;
    }
    const g = c.getContext("2d")!;
    g.fillStyle = "#FFFFFF";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A scale that keeps the longer side within a limit, so files stay a sensible size. */
const fitScale = (p: Picture, longest: number, prefer = 1) => Math.min(prefer, longest / Math.max(p.width, p.height + 44));

/** An animated GIF: the flows step by step, or moving dashes along the lines. */
export async function gifBlob(p: Picture): Promise<Blob> {
  const frames = pictureFrames(p, fitScale(p, 1400));
  const gif = GIFEncoder();
  const canvas = document.createElement("canvas");
  for (const frame of frames) {
    await rasterize(frame.svg, canvas);
    const { data, width, height } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
    const palette = quantize(data, 128);
    gif.writeFrame(applyPalette(data, palette), width, height, { palette, delay: frame.hold });
  }
  gif.finish();
  return new Blob([gif.bytes() as BlobPart], { type: "image/gif" });
}

/** The video type this browser can record: MP4 where it can, otherwise WebM. */
export function videoType(): { mime: string; extension: "mp4" | "webm" } | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const [mime, extension] of [
    ["video/mp4;codecs=avc1", "mp4"],
    ["video/mp4", "mp4"],
    ["video/webm;codecs=vp9", "webm"],
    ["video/webm", "webm"],
  ] as const) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, extension };
  }
  return null;
}

/** A video of the same animation, recorded in the browser. */
export async function videoBlob(p: Picture): Promise<{ blob: Blob; extension: "mp4" | "webm" }> {
  const type = videoType();
  if (!type) throw new Error("This browser cannot record video. Chrome, Edge and Firefox can.");
  const frames = pictureFrames(p, fitScale(p, 1920, 1.5));
  const canvas = document.createElement("canvas");
  await rasterize(frames[0].svg, canvas);
  // Video encoders want even sizes.
  canvas.width -= canvas.width % 2;
  canvas.height -= canvas.height % 2;
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: type.mime, videoBitsPerSecond: 4_000_000 });
  const parts: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const done = new Promise<void>((ok) => (recorder.onstop = () => ok()));
  recorder.start(250);
  // The dashes loop a few times; flow steps play once.
  const rounds = p.flows.length ? 1 : 4;
  for (let r = 0; r < rounds; r++) {
    for (const frame of frames) {
      await rasterize(frame.svg, canvas);
      await new Promise((ok) => setTimeout(ok, frame.hold));
    }
  }
  recorder.stop();
  await done;
  stream.getTracks().forEach((t) => t.stop());
  return { blob: new Blob(parts, { type: type.mime.split(";")[0] }), extension: type.extension };
}

/* ---------- PowerPoint ---------- */

const FACE = "Calibri";
const INK = "16233A";
const SOFT = "5B6779";

/**
 * A deck: the diagram as a picture, the same diagram as shapes that can be edited in PowerPoint,
 * then the objects and the relationships as tables.
 */
export async function powerPointBlob(ws: Workspace, diagram: Diagram, p: Picture): Promise<Blob> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = diagram.name;
  pptx.company = ws.name;
  const W = 13.333;
  const H = 7.5;
  const footer = `${ws.name}, exported ${new Date().toLocaleDateString()}`;
  const titled = (title: string, subtitle = "") => {
    const slide = pptx.addSlide();
    slide.addText(title, { x: 0.5, y: 0.3, w: W - 1, h: 0.6, fontFace: FACE, fontSize: 24, bold: true, color: INK, fit: "shrink" });
    if (subtitle) slide.addText(subtitle, { x: 0.5, y: 0.85, w: W - 1, h: 0.35, fontFace: FACE, fontSize: 13, color: SOFT });
    slide.addText(footer, { x: 0.5, y: H - 0.45, w: W - 1, h: 0.3, fontFace: FACE, fontSize: 9, color: SOFT });
    return slide;
  };
  // The fitted area for a drawing.
  const area = { x: 0.5, y: 1.3, w: W - 1, h: H - 2 };
  const scale = Math.min(area.w / p.width, area.h / p.height);
  const left = area.x + (area.w - p.width * scale) / 2;
  const top = area.y + (area.h - p.height * scale) / 2;

  // 1. The picture.
  const canvas = await rasterize(pictureSvg(p, { scale: 2 }));
  titled(diagram.name, diagram.description).addImage({ data: canvas.toDataURL("image/png"), x: left, y: top, w: p.width * scale, h: p.height * scale });

  // 2. The same, as shapes and lines.
  const shapes = titled(`${diagram.name}: editable`, "Boxes and lines you can move and change in PowerPoint.");
  if (p.boundary) {
    const b = p.boundary;
    shapes.addShape(pptx.ShapeType.roundRect, { x: left + b.x * scale, y: top + b.y * scale, w: b.w * scale, h: b.h * scale, fill: { color: "F5F7FC" }, line: { color: "2447D6", dashType: "dash", width: 1 }, rectRadius: 0.1 });
    shapes.addText(b.label, { x: left + b.x * scale + 0.1, y: top + b.y * scale + 0.02, w: 3, h: 0.3, fontFace: FACE, fontSize: 10, bold: true, color: "2447D6" });
  }
  for (const e of p.edges) {
    const x = left + Math.min(e.x1, e.x2) * scale;
    const y = top + Math.min(e.y1, e.y2) * scale;
    shapes.addShape(pptx.ShapeType.line, {
      x,
      y,
      w: Math.max(Math.abs(e.x2 - e.x1) * scale, 0.001),
      h: Math.max(Math.abs(e.y2 - e.y1) * scale, 0.001),
      flipH: e.x2 < e.x1,
      flipV: e.y2 < e.y1,
      line: { color: "8A95A8", width: 1.25, endArrowType: "triangle" },
    });
    if (e.label) shapes.addText(e.label, { x: left + ((e.x1 + e.x2) / 2) * scale - 0.8, y: top + ((e.y1 + e.y2) / 2) * scale - 0.12, w: 1.6, h: 0.24, fontFace: FACE, fontSize: 8, color: SOFT, align: "center", fill: { color: "FFFFFF" } });
  }
  for (const n of p.nodes) {
    shapes.addText(
      [
        { text: n.name, options: { bold: true, fontSize: 10, color: INK, breakLine: true } },
        { text: n.subtitle, options: { fontSize: 8, color: SOFT } },
      ],
      { shape: pptx.ShapeType.roundRect, x: left + n.x * scale, y: top + n.y * scale, w: n.w * scale, h: n.h * scale, fill: { color: "FFFFFF" }, line: { color: n.color.replace("#", ""), width: 1.5 }, rectRadius: 0.08, fontFace: FACE, valign: "middle", margin: 4 },
    );
  }

  // 3. The objects and relationships.
  const rows = (headings: string[], data: string[][], title: string) => {
    for (let i = 0; i < Math.max(data.length, 1); i += 12) {
      const page = data.slice(i, i + 12);
      const slide = titled(data.length > 12 ? `${title} (${i / 12 + 1} of ${Math.ceil(data.length / 12)})` : title);
      slide.addTable(
        [headings.map((h) => ({ text: h, options: { bold: true, fill: { color: "EEF1F7" } } })), ...page.map((r) => r.map((v) => ({ text: v.length > 140 ? `${v.slice(0, 139)}…` : v })))],
        { x: 0.5, y: 1.3, w: W - 1, fontFace: FACE, fontSize: 11, color: INK, border: { type: "solid", pt: 0.75, color: "D5DBE6" }, margin: [3, 6, 3, 6] },
      );
    }
  };
  const objects = diagramObjects(ws, diagram);
  rows(["Name", "Type", "Component", "Owner", "Description"], objects.map((o) => [o.name, objectType(o.typeId).label, componentById(o.componentId)?.name ?? "", o.owner, o.description]), "Objects");
  const name = (id: string) => ws.objects[id]?.name ?? "";
  rows(["From", "To", "Kind", "Label", "Protocol"], diagramRelationships(ws, diagram).map((r) => [name(r.sourceId), name(r.targetId), r.kind.replace(/_/g, " "), r.label, r.protocol]), "Relationships");
  return (await pptx.write({ outputType: "blob" })) as Blob;
}

/* ---------- interactive HTML ---------- */

/**
 * One self-contained page: the diagram to pan and zoom, a search box, every box's details on a
 * click, and the flows to step through. Opens in any browser, offline, with nothing to install.
 */
export function interactiveHtml(ws: Workspace, diagram: Diagram, p: Picture): string {
  const data = JSON.stringify({ title: diagram.name, description: diagram.description, workspace: ws.name, exportedAt: new Date().toISOString(), picture: p, svg: pictureSvg(p) }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeXml(diagram.name)}</title>
<style>
*{box-sizing:border-box}body{margin:0;font:14px/1.45 "IBM Plex Sans","Segoe UI",Arial,sans-serif;color:#16233A;background:#F4F6FA;display:grid;grid-template-rows:auto 1fr;height:100vh}
header{display:flex;gap:12px;align-items:center;padding:10px 16px;background:#fff;border-bottom:1px solid #D5DBE6}
header h1{font-size:16px;margin:0;font-weight:600}header p{margin:0;color:#5B6779;font-size:12px}
header input{margin-left:auto;padding:6px 10px;border:1px solid #C7CFDC;border-radius:6px;min-width:220px;font:inherit}
button{font:inherit;padding:5px 10px;border:1px solid #C7CFDC;border-radius:6px;background:#fff;cursor:pointer}button:hover{border-color:#2447D6}
main{display:grid;grid-template-columns:1fr 320px;min-height:0}#stage{overflow:hidden;position:relative;cursor:grab;background:#fff}#stage.drag{cursor:grabbing}
#stage svg{position:absolute;left:0;top:0;transform-origin:0 0}aside{background:#fff;border-left:1px solid #D5DBE6;padding:14px;overflow:auto}
aside h2{font-size:15px;margin:0 0 4px}dl{margin:8px 0}dt{font-size:11px;color:#5B6779;margin-top:8px}dd{margin:0;white-space:pre-wrap;word-break:break-word}
.hint{color:#5B6779;font-size:12px}.zoom{position:absolute;right:12px;bottom:12px;display:flex;gap:4px}.flow{margin-top:14px;border-top:1px solid #E3E8F0;padding-top:10px}
.found rect:first-child{stroke:#2447D6!important;stroke-width:3!important}.dim{opacity:.25}
</style></head><body>
<header><div><h1 id="t"></h1><p id="d"></p></div><input id="q" type="search" placeholder="Find a box" aria-label="Find a box"></header>
<main><div id="stage" aria-label="Diagram"><div class="zoom"><button id="zin" aria-label="Zoom in">+</button><button id="zout" aria-label="Zoom out">−</button><button id="fit">Fit</button></div></div>
<aside id="side"><p class="hint">Click a box to see its details. Drag to move around; scroll to zoom.</p></aside></main>
<script type="application/json" id="data">${data}</script>
<script>
(function(){
var D=JSON.parse(document.getElementById("data").textContent),P=D.picture;
document.getElementById("t").textContent=D.title;
document.getElementById("d").textContent=D.workspace+" · exported "+new Date(D.exportedAt).toLocaleString()+(D.description?" · "+D.description:"");
var stage=document.getElementById("stage");stage.insertAdjacentHTML("afterbegin",D.svg);var svg=stage.querySelector("svg");
var groups=[].slice.call(svg.querySelectorAll("g"));var lines=[].slice.call(svg.querySelectorAll("line"));
var s=1,x=0,y=0;function apply(){svg.style.transform="translate("+x+"px,"+y+"px) scale("+s+")"}
function fit(){var r=stage.getBoundingClientRect();s=Math.min(r.width/P.width,r.height/P.height,1.5)*0.95;x=(r.width-P.width*s)/2;y=(r.height-P.height*s)/2;apply()}
fit();addEventListener("resize",fit);
stage.addEventListener("wheel",function(e){e.preventDefault();var r=stage.getBoundingClientRect(),k=e.deltaY<0?1.12:1/1.12,mx=e.clientX-r.left,my=e.clientY-r.top;x=mx-(mx-x)*k;y=my-(my-y)*k;s*=k;apply()},{passive:false});
var drag=null;stage.addEventListener("pointerdown",function(e){if(e.target.closest("button"))return;drag={x:e.clientX-x,y:e.clientY-y,moved:false};stage.classList.add("drag")});
addEventListener("pointermove",function(e){if(!drag)return;drag.moved=true;x=e.clientX-drag.x;y=e.clientY-drag.y;apply()});
addEventListener("pointerup",function(e){var was=drag;drag=null;stage.classList.remove("drag");if(was&&!was.moved){var pt=toModel(e);var n=P.nodes.find(function(n){return pt.x>=n.x&&pt.x<=n.x+n.w&&pt.y>=n.y&&pt.y<=n.y+n.h});if(n)show(n)}});
function toModel(e){var r=stage.getBoundingClientRect();return{x:(e.clientX-r.left-x)/s,y:(e.clientY-r.top-y)/s}}
document.getElementById("zin").onclick=function(){s*=1.2;apply()};document.getElementById("zout").onclick=function(){s/=1.2;apply()};document.getElementById("fit").onclick=fit;
var side=document.getElementById("side");
function esc(t){var d=document.createElement("div");d.textContent=t;return d.innerHTML}
function name(id){var n=P.nodes.find(function(n){return n.id===id});return n?n.name:""}
function show(n){var i=P.nodes.indexOf(n);groups.forEach(function(g,j){g.classList.toggle("found",j===i)});
var out=P.edges.filter(function(e){return e.from===n.id}).map(function(e){return "→ "+esc(name(e.to))+(e.label?" ("+esc(e.label)+")":"")});
var inn=P.edges.filter(function(e){return e.to===n.id}).map(function(e){return "← "+esc(name(e.from))+(e.label?" ("+esc(e.label)+")":"")});
side.innerHTML="<h2>"+esc(n.name)+"</h2><p class='hint'>"+esc(n.subtitle)+"</p><dl>"+n.details.map(function(d){var v=/^https?:\\/\\//.test(d.value)?"<a href='"+esc(d.value)+"' target='_blank' rel='noopener'>"+esc(d.value)+"</a>":esc(d.value);return "<dt>"+esc(d.label)+"</dt><dd>"+v+"</dd>"}).join("")+(out.length+inn.length?"<dt>Connections</dt><dd>"+out.concat(inn).join("<br>")+"</dd>":"")+"</dl>"+flowsHtml()}
function flowsHtml(){if(!P.flows.length)return"";return"<div class='flow'><h2>Flows</h2>"+P.flows.map(function(f,i){return"<p><button data-flow='"+i+"'>Play</button> "+esc(f.name)+"</p>"}).join("")+"<p id='step' class='hint'></p></div>"}
side.insertAdjacentHTML("beforeend",flowsHtml());
side.addEventListener("click",function(e){var b=e.target.closest("[data-flow]");if(b)play(P.flows[+b.dataset.flow])});
var timer=null;function play(f){clearInterval(timer);var i=0;function step(){if(i>=f.steps.length){clearInterval(timer);lines.forEach(function(l){l.classList.remove("dim")});groups.forEach(function(g){g.classList.remove("dim","found")});var el=document.getElementById("step");if(el)el.textContent="";return}
var st=f.steps[i];lines.forEach(function(l,j){var e=P.edges[j];var on=e&&((e.from===st.from&&e.to===st.to)||(e.from===st.to&&e.to===st.from));l.classList.toggle("dim",!on)});
groups.forEach(function(g,j){var n=P.nodes[j];var on=n&&(n.id===st.from||n.id===st.to);g.classList.toggle("dim",!on);g.classList.toggle("found",on)});
var el=document.getElementById("step");if(el)el.textContent=(i+1)+". "+(st.text||"");i++}step();timer=setInterval(step,1800)}
document.getElementById("q").addEventListener("input",function(e){var q=e.target.value.trim().toLowerCase();groups.forEach(function(g,j){var hit=q&&P.nodes[j].name.toLowerCase().indexOf(q)>=0;g.classList.toggle("found",!!hit);g.classList.toggle("dim",!!q&&!hit)})});
})();
</script></body></html>
`;
}

/* ---------- draw.io ---------- */

/** The diagram as a draw.io file: boxes where they stand, connectors between them. Opens in draw.io and diagrams.net. */
export function drawioXml(diagram: Diagram, p: Picture): string {
  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  const ids = new Map(p.nodes.map((n, i) => [n.id, `n${i + 1}`]));
  if (p.boundary) {
    const b = p.boundary;
    cells.push(`<mxCell id="boundary" value="${escapeXml(b.label)}" style="rounded=1;dashed=1;fillColor=#F5F7FC;strokeColor=#2447D6;verticalAlign=top;align=left;spacingLeft=10;fontStyle=1;fontColor=#2447D6;" vertex="1" parent="1"><mxGeometry x="${Math.round(b.x)}" y="${Math.round(b.y)}" width="${Math.round(b.w)}" height="${Math.round(b.h)}" as="geometry"/></mxCell>`);
  }
  for (const n of p.nodes) {
    const label = `${escapeXml(n.name)}&lt;br&gt;&lt;font style=&quot;font-size:10px&quot; color=&quot;#5B6779&quot;&gt;${escapeXml(n.subtitle)}&lt;/font&gt;`;
    cells.push(`<mxCell id="${ids.get(n.id)}" value="${label}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=${n.color};strokeWidth=2;fontColor=#16233A;" vertex="1" parent="1"><mxGeometry x="${Math.round(n.x)}" y="${Math.round(n.y)}" width="${n.w}" height="${n.h}" as="geometry"/></mxCell>`);
  }
  p.edges.forEach((e, i) => {
    cells.push(`<mxCell id="e${i + 1}" value="${escapeXml(e.label)}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=${e.color ?? "#8A95A8"};${e.color ? "strokeWidth=2;" : ""}fontColor=#5B6779;fontSize=10;${e.kind === "shared" ? "dashed=1;startArrow=none;endArrow=none;" : e.flow === "in" ? "startArrow=classic;endArrow=none;" : e.flow === "both" ? "startArrow=classic;endArrow=classic;" : ""}" edge="1" parent="1" source="${ids.get(e.from)}" target="${ids.get(e.to)}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
  });
  return `<mxfile host="ArchONE Diagrams" modified="${new Date().toISOString()}" type="device">
  <diagram id="${escapeXml(diagram.id)}" name="${escapeXml(diagram.name)}">
    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0">
      <root>
        ${cells.join("\n        ")}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;
}

/* ---------- Structurizr DSL ---------- */

/** The diagram as a Structurizr workspace: people, software systems and their containers, with one view. */
export function structurizrDsl(ws: Workspace, diagram: Diagram): string {
  // The system a C4 diagram is about holds the boxes drawn inside it, even when it is not a box itself.
  const scopeObject = diagram.scopeId ? ws.objects[diagram.scopeId] : undefined;
  const drawnObjects = diagramObjects(ws, diagram);
  const objects = scopeObject && !drawnObjects.some((o) => o.id === scopeObject.id) ? [scopeObject, ...drawnObjects] : drawnObjects;
  const on = new Set(objects.map((o) => o.id));
  const idOf = new Map<string, string>();
  const used = new Set<string>();
  for (const o of objects) {
    let base = slugify(o.name).replace(/-/g, "_").replace(/^(\d)/, "_$1") || "element";
    if (["workspace", "model", "views", "person", "softwaresystem", "container", "component"].includes(base)) base = `${base}_1`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    idOf.set(o.id, id);
  }
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const people = objects.filter((o) => o.typeId === "actor");
  const systems = objects.filter((o) => o.typeId !== "actor" && !(o.parentId && on.has(o.parentId)));
  const childrenOf = (id: string) => objects.filter((o) => o.parentId === id && o.typeId !== "actor");
  const lines: string[] = [`workspace ${q(diagram.name)} ${q(diagram.description || `Exported from ${ws.name}`)} {`, "", "    model {"];
  for (const o of people) lines.push(`        ${idOf.get(o.id)} = person ${q(o.name)} ${q(o.description)}`);
  for (const o of systems) {
    if (o.typeId === "actor") continue;
    const parts = childrenOf(o.id);
    if (!parts.length) {
      lines.push(`        ${idOf.get(o.id)} = softwareSystem ${q(o.name)} ${q(o.description)}${o.typeId === "external-system" ? ` {\n            tags "External"\n        }` : ""}`);
      continue;
    }
    lines.push(`        ${idOf.get(o.id)} = softwareSystem ${q(o.name)} ${q(o.description)} {`);
    for (const c of parts) lines.push(`            ${idOf.get(c.id)} = container ${q(c.name)} ${q(c.description)} ${q([objectType(c.typeId).label, c.technology].filter(Boolean).join(", "))}`);
    lines.push("        }");
  }
  lines.push("");
  for (const r of diagramRelationships(ws, diagram)) {
    const a = idOf.get(r.sourceId);
    const b = idOf.get(r.targetId);
    if (a && b) lines.push(`        ${a} -> ${b} ${q(r.label || r.kind.replace(/_/g, " "))}${r.protocol ? ` ${q(r.protocol)}` : ""}`);
  }
  lines.push("    }", "", "    views {");
  const scope = diagram.scopeId && idOf.get(diagram.scopeId);
  if (scope && diagram.viewType === "container") lines.push(`        container ${scope} ${q(slugify(diagram.name) || "view")} {`);
  else if (scope && diagram.viewType === "context") lines.push(`        systemContext ${scope} ${q(slugify(diagram.name) || "view")} {`);
  else lines.push(`        systemLandscape ${q(slugify(diagram.name) || "view")} {`);
  lines.push("            include *", "            autoLayout", "        }", "        styles {", '            element "Person" {', "                shape person", "            }", '            element "External" {', "                background #6B7686", "                color #ffffff", "            }", "        }", "    }", "}", "");
  return lines.join("\n");
}

