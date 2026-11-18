import { parseCsv, decodeText } from "../import/csv";
import type { ImportedPage, ImportedShape } from "../import/diagramFile";
import { readDrawio } from "../import/drawio";
import { readVsdx } from "../import/visio";
import { parseXml, descendants, allText } from "../import/xml";
import { readXlsx } from "../import/xlsx";
import { readZip } from "../import/zip";
import { parseBpmn, type ProcessSpec, type SpecStep } from "./bpmn";

/**
 * A process from a file made before: a BPMN file as it is; a draw.io or Visio flowchart turned into
 * steps and flows by its shapes (diamonds are decisions, circles are events, bands are lanes); a Word
 * or PowerPoint document, a text or a spreadsheet of steps read as words for the drafter; a picture
 * or a PDF page for the AI model to read. Everything is read here, in the browser.
 */

export type FileKind = "bpmn" | "image" | "pdf" | "word" | "slides" | "text" | "sheet" | "drawio" | "visio";

export const PROCESS_FILE_ACCEPT = ".bpmn,.xml,.png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.pptx,.txt,.md,.csv,.xlsx,.drawio,.vsdx";

export function fileKind(name: string, type = ""): FileKind | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "bpmn" || ext === "xml") return "bpmn";
  if (/^image\/(png|jpeg|webp|gif)$/.test(type) || ["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "word";
  if (ext === "pptx") return "slides";
  if (ext === "txt" || ext === "md") return "text";
  if (ext === "csv" || ext === "xlsx") return "sheet";
  if (ext === "drawio") return "drawio";
  if (ext === "vsdx") return "visio";
  return null;
}

export class ProcessFileError extends Error {}

/* ---------- documents as words ---------- */

/** The paragraphs of a Word document, one per line. */
export async function wordText(bytes: Uint8Array): Promise<string> {
  const files = await readZip(bytes, (p) => p === "word/document.xml");
  const xml = files.get("word/document.xml");
  if (!xml) throw new ProcessFileError("This is not a Word document (.docx).");
  const root = parseXml(new TextDecoder().decode(xml));
  return descendants(root, "p")
    .map((p) => descendants(p, "t").map((t) => t.text).join("").trim())
    .filter(Boolean)
    .join("\n");
}

/** The text of a PowerPoint deck, slide by slide, one paragraph per line. */
export async function slidesText(bytes: Uint8Array): Promise<string> {
  const files = await readZip(bytes, (p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
  if (!files.size) throw new ProcessFileError("This is not a PowerPoint deck (.pptx).");
  const order = [...files.keys()].sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  return order
    .map((path) =>
      descendants(parseXml(new TextDecoder().decode(files.get(path)!)), "p")
        .map((p) => allText(p).replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n"),
    )
    .filter(Boolean)
    .join("\n\n");
}

const STEP_COLUMN = /^(step|activity|task|action|what|name|الخطوة|النشاط|المهمة)/i;
const ROLE_COLUMN = /^(role|lane|who|actor|owner|department|team|performer|الدور|المسؤول|القسم|الجهة)/i;

/**
 * A spreadsheet of steps as lines the drafter reads: "Role: step", one per row. Without a column
 * that says what the step is, each row's cells are joined.
 */
export function sheetLines(rows: string[][]): string {
  const filled = rows.filter((r) => r.some((c) => c.trim()));
  if (!filled.length) return "";
  const head = filled[0].map((c) => c.trim());
  const stepAt = head.findIndex((c) => STEP_COLUMN.test(c));
  const roleAt = head.findIndex((c) => ROLE_COLUMN.test(c));
  if (stepAt < 0) return filled.map((r) => r.map((c) => c.trim()).filter(Boolean).join(" – ")).join("\n");
  return filled
    .slice(1)
    .map((r) => {
      const step = (r[stepAt] ?? "").trim();
      const role = roleAt >= 0 ? (r[roleAt] ?? "").trim() : "";
      return step ? (role ? `${role}: ${step}` : step) : "";
    })
    .filter(Boolean)
    .join("\n");
}

/* ---------- flowcharts as steps and flows ---------- */

const DECISION = /rhombus|diamond|decision|gateway|condition/i;
const PARALLEL = /parallel|fork|join/i;
const EVENT = /ellipse|circle|oval|event|terminator|terminal|start|end\b|doublecircle/i;
const LANE = /swimlane|pool|lane|container|band/i;

/** A flowchart page as a process: lanes from the bands that hold shapes, steps from the shapes, flows from the arrows. */
export function specFromPage(page: ImportedPage, name: string): { spec: ProcessSpec; shapes: number; flows: number } {
  const byId = new Map(page.shapes.map((s) => [s.id, s]));
  const holds = new Set(page.shapes.map((s) => s.parentId).filter((id): id is string => !!id));
  const isLane = (s: ImportedShape) => holds.has(s.id) || (LANE.test(s.hint) && !page.connectors.some((c) => c.sourceId === s.id || c.targetId === s.id));
  const laneOf = (s: ImportedShape): string => {
    for (let p = s.parentId ? byId.get(s.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) if (p.text.trim()) return p.text.trim();
    // A band that holds a shape only by where it is drawn.
    const cx = s.x + s.width / 2;
    const cy = s.y + s.height / 2;
    const band = page.shapes.filter((b) => b.id !== s.id && isLane(b) && b.text.trim() && cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height).sort((a, b) => a.width * a.height - b.width * b.height)[0];
    return band?.text.trim() ?? "";
  };
  const connected = new Set(page.connectors.flatMap((c) => [c.sourceId, c.targetId]));
  const shapes = page.shapes.filter((s) => !isLane(s) && (s.text.trim() || connected.has(s.id)));
  const kept = new Set(shapes.map((s) => s.id));
  const connectors = page.connectors.filter((c) => kept.has(c.sourceId) && kept.has(c.targetId) && c.sourceId !== c.targetId);
  const lanes: string[] = [];
  const steps: SpecStep[] = shapes.map((s) => {
    const into = connectors.filter((c) => c.targetId === s.id).length;
    const out = connectors.filter((c) => c.sourceId === s.id).length;
    const text = s.text.trim();
    const lane = laneOf(s);
    if (lane && !lanes.includes(lane)) lanes.push(lane);
    const trigger = /timer|clock|wait|انتظار/i.test(`${s.hint} ${text}`) ? "timer" : /message|envelope|mail|رسالة/i.test(`${s.hint} ${text}`) ? "message" : undefined;
    let type: SpecStep["type"];
    if (DECISION.test(s.hint) || (/[?؟]$/.test(text) && out > 1)) type = PARALLEL.test(s.hint) || text === "+" ? "parallelGateway" : "exclusiveGateway";
    else if (EVENT.test(s.hint) && s.width <= 120 && s.height <= 120) type = into === 0 ? "startEvent" : out === 0 ? "endEvent" : "intermediateCatchEvent";
    else type = /send|إرسال/i.test(text) ? "sendTask" : /system|automatic|تلقائي/i.test(text) ? "serviceTask" : "userTask";
    return { id: `S_${s.id}`, name: type.endsWith("Gateway") && text === "+" ? "" : text, type, lane: lane || undefined, trigger: type.endsWith("Event") ? trigger : undefined };
  });
  const flows = connectors.map((c) => ({ from: `S_${c.sourceId}`, to: `S_${c.targetId}`, name: c.text.trim() || undefined }));
  // A chart drawn without its start or end gets them, so the model holds together.
  const ids = steps.map((s) => s.id);
  if (!steps.some((s) => s.type === "startEvent")) {
    const first = ids.filter((id) => !flows.some((f) => f.to === id));
    if (first.length) {
      steps.unshift({ id: "S_start", name: "Start", type: "startEvent", lane: steps.find((s) => s.id === first[0])?.lane });
      for (const id of first) flows.unshift({ from: "S_start", to: id, name: undefined });
    }
  }
  if (!steps.some((s) => s.type === "endEvent")) {
    const last = ids.filter((id) => !flows.some((f) => f.from === id) && !steps.find((s) => s.id === id)!.type.endsWith("Gateway"));
    last.forEach((id, i) => {
      steps.push({ id: `S_end_${i + 1}`, name: "Done", type: "endEvent", lane: steps.find((s) => s.id === id)?.lane });
      flows.push({ from: id, to: `S_end_${i + 1}`, name: undefined });
    });
  }
  return { spec: { name: name || page.name || "Process from a flowchart", lanes, steps, flows }, shapes: shapes.length, flows: connectors.length };
}

/* ---------- reading a chosen file ---------- */

export type ProcessFile =
  | { kind: "bpmn"; name: string; xml: string; title: string; steps: number }
  | { kind: "diagram"; name: string; source: "drawio" | "visio"; spec: ProcessSpec; shapes: number; flows: number; pages: number }
  | { kind: "words"; name: string; source: "word" | "slides" | "text" | "sheet"; text: string }
  | { kind: "image"; name: string; file: File }
  | { kind: "pdf"; name: string; file: File };

const title = (fileName: string) => fileName.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim();

export async function readProcessFile(file: File): Promise<ProcessFile> {
  const kind = fileKind(file.name, file.type);
  if (!kind) throw new ProcessFileError("Choose a BPMN file, a picture, a PDF, a Word or PowerPoint document, a text, a spreadsheet, or a draw.io or Visio flowchart.");
  if (file.size > 20 * 1024 * 1024) throw new ProcessFileError("The file is larger than 20 MB.");
  if (kind === "image") return { kind, name: file.name, file };
  if (kind === "pdf") return { kind, name: file.name, file };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (kind === "bpmn") {
    const xml = decodeText(bytes);
    const graph = parseBpmn(xml);
    if (!xml.includes("BPMNDiagram")) throw new ProcessFileError("This BPMN file has no diagram to show. Export it again with its diagram (most tools do so by default).");
    return { kind, name: file.name, xml, title: graph.processes[0]?.participant || graph.processes[0]?.name || title(file.name), steps: Object.values(graph.nodes).filter((n) => n.kind === "activity").length };
  }
  if (kind === "drawio" || kind === "visio") {
    const pages = kind === "drawio" ? await readDrawio(decodeText(bytes)) : await readVsdx(bytes);
    const page = [...pages].sort((a, b) => b.shapes.length - a.shapes.length)[0];
    if (!page || !page.shapes.length) throw new ProcessFileError("The file has no shapes to read.");
    const made = specFromPage(page, title(file.name));
    if (!made.spec.steps.length) throw new ProcessFileError("No step could be read from the shapes in this file.");
    return { kind: "diagram", name: file.name, source: kind, ...made, pages: pages.length };
  }
  let text = "";
  if (kind === "word") text = await wordText(bytes);
  else if (kind === "slides") text = await slidesText(bytes);
  else if (kind === "sheet") text = file.name.toLowerCase().endsWith(".xlsx") ? sheetLines((await readXlsx(bytes))[0]?.rows ?? []) : sheetLines(parseCsv(decodeText(bytes)));
  else text = decodeText(bytes);
  if (text.trim().length < 10) throw new ProcessFileError("The file holds too little text to draft a process from.");
  return { kind: "words", name: file.name, source: kind, text: text.trim().slice(0, 12000) };
}
