import { ArrowDown, ArrowUp, FileText, Presentation } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DiagramCanvas, type CanvasHandle } from "@/components/canvas/DiagramCanvas";
import { Button, EmptyState, Field, IconButton, Input, countOf } from "@/components/ui";
import { VIEW_TYPE_INFO } from "@/lib/catalog";
import { PACKS, type PackId } from "@/lib/checks/checks";
import { buildOutline, documentFileName, type DocImage, type DocOptions } from "@/lib/document/outline";
import { capturePng } from "@/lib/exportImage";
import { downloadBlob } from "@/lib/exporters";
import { useWorkspace } from "@/lib/store";

const DEFAULT_PACKS: PackId[] = ["practice", "security", "privacy"];
/** How long a diagram may take to draw before it is exported without its picture. */
const DRAW_TIMEOUT_MS = 6000;

/**
 * The architecture as a document: a Word file to read and sign off, or slides to present.
 * Both are written in the browser from the model as it is now; nothing is sent anywhere.
 */
export function DocumentPage() {
  const ws = useWorkspace();
  const all = useMemo(() => Object.values(ws.diagrams).sort((a, b) => a.name.localeCompare(b.name)), [ws.diagrams]);
  const [title, setTitle] = useState("");
  // The chosen diagrams in the order they will appear. null until the person changes the default: every diagram.
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [inventory, setInventory] = useState(true);
  const [decisions, setDecisions] = useState(true);
  const [data, setData] = useState(true);
  const [packs, setPacks] = useState<PackId[]>(DEFAULT_PACKS);
  const [busy, setBusy] = useState<"" | "word" | "slides">("");
  const [progress, setProgress] = useState("");
  const [problem, setProblem] = useState("");
  const [done, setDone] = useState("");

  const order = (chosen ?? all.map((d) => d.id)).filter((id) => ws.diagrams[id]);
  const rest = all.filter((d) => !order.includes(d.id));
  const options: DocOptions = { title, diagramIds: order, inventory, decisions, packs, data };

  // One diagram at a time is drawn off-screen and photographed.
  const [stage, setStage] = useState<string | null>(null);
  const canvas = useRef<CanvasHandle>(null);
  const taken = useRef<((image: DocImage | null) => void) | null>(null);
  useEffect(() => {
    if (!stage) return;
    const wanted = Object.keys(ws.diagrams[stage]?.nodes ?? {}).filter((id) => ws.objects[id]).length;
    const started = Date.now();
    let live = true;
    const finish = (image: DocImage | null) => {
      if (!live) return;
      live = false;
      taken.current?.(image);
    };
    const look = () => {
      if (!live) return;
      const nodes = canvas.current?.nodes() ?? [];
      const element = canvas.current?.element();
      // Zones are drawn at the size they are given, so React Flow never reports measuring them.
      const drawn = nodes.length >= wanted && nodes.every((n) => n.measured?.width || (n.type === "zone" && n.width));
      if (wanted === 0) finish(null);
      else if (element && drawn) capturePng(element, nodes).then(finish, () => finish(null));
      else if (Date.now() - started > DRAW_TIMEOUT_MS) finish(null);
      else setTimeout(look, 120);
    };
    const timer = setTimeout(look, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // The model does not change while an export runs: the buttons that start one are the only way in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);
  const photograph = (id: string) =>
    new Promise<DocImage | null>((resolve) => {
      taken.current = resolve;
      setStage(id);
    });

  const run = async (kind: "word" | "slides") => {
    if (busy) return;
    setBusy(kind);
    setProblem("");
    setDone("");
    try {
      const outline = buildOutline(ws, options);
      const images: Record<string, DocImage> = {};
      let missing = 0;
      for (const [i, d] of outline.diagrams.entries()) {
        setProgress(`Drawing diagram ${i + 1} of ${outline.diagrams.length}`);
        const image = await photograph(d.id);
        if (image) images[d.id] = image;
        else if (d.elements.length) missing += 1;
      }
      setStage(null);
      setProgress(kind === "word" ? "Writing the document" : "Writing the slides");
      const name = documentFileName(outline);
      if (kind === "word") downloadBlob(`${name}.docx`, await (await import("@/lib/document/word")).wordBlob(outline, images));
      else downloadBlob(`${name}.pptx`, await (await import("@/lib/document/slides")).slidesBlob(outline, images));
      setDone(`${kind === "word" ? "The Word document" : "The slide deck"} was downloaded as ${name}.${kind === "word" ? "docx" : "pptx"}.${missing ? ` ${countOf(missing, "diagram")} could not be drawn in time and ${missing === 1 ? "is" : "are"} in it without a picture.` : ""}`);
    } catch (error) {
      setStage(null);
      setProblem(error instanceof Error && error.message ? `The export failed: ${error.message}` : "The export failed. Try again.");
    } finally {
      setBusy("");
      setProgress("");
    }
  };

  const move = (id: string, by: number) => {
    const next = [...order];
    const at = next.indexOf(id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= next.length) return;
    [next[at], next[to]] = [next[to], next[at]];
    setChosen(next);
  };
  const toggle = (id: string) => setChosen(order.includes(id) ? order.filter((x) => x !== id) : [...order, id]);
  const togglePack = (id: PackId) => setPacks(packs.includes(id) ? packs.filter((p) => p !== id) : [...packs, id]);
  const tick = "size-4 accent-blueprint";
  const staged = stage ? ws.diagrams[stage] : undefined;

  if (!all.length && !Object.keys(ws.objects).length) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-7">
        <h1 className="text-xl font-semibold">Document</h1>
        <div className="mt-6 rounded-lg border border-dashed border-ink-faint bg-surface">
          <EmptyState title="Nothing to write up yet" text="Add objects and a diagram first. The document is written from the model." />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-7" data-document-page>
      <h1 className="text-xl font-semibold">Document</h1>
      <p className="text-ink-soft mt-0.5">The architecture as a Word document to read and sign off, or as slides to present. Both are written here in your browser from the model as it is now.</p>

      <div className="mt-6 rounded-lg border border-line bg-surface px-5 py-4 space-y-5">
        <Field label="Title" hint="Left empty, the workspace name is used.">
          <Input value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} placeholder={`${ws.name}: architecture`} data-document-title />
        </Field>

        <fieldset>
          <legend className="text-[13px] font-medium">Diagrams, in this order</legend>
          {order.length === 0 && <p className="mt-1 text-[13px] text-ink-soft">No diagram is included. The document will hold the tables only.</p>}
          <ol className="mt-1.5 divide-y divide-line-soft rounded-md border border-line empty:hidden" data-document-diagrams>
            {order.map((id, i) => (
              <li key={id} className="flex items-center gap-2 px-3 py-1.5">
                <label className="min-w-0 flex-1 flex items-center gap-2.5 cursor-pointer">
                  <input type="checkbox" className={tick} checked onChange={() => toggle(id)} />
                  <span className="truncate font-medium">{ws.diagrams[id].name}</span>
                  <span className="text-[13px] text-ink-soft shrink-0">{VIEW_TYPE_INFO[ws.diagrams[id].viewType].label}</span>
                </label>
                <IconButton label={`Move ${ws.diagrams[id].name} up`} disabled={i === 0} onClick={() => move(id, -1)}>
                  <ArrowUp size={15} />
                </IconButton>
                <IconButton label={`Move ${ws.diagrams[id].name} down`} disabled={i === order.length - 1} onClick={() => move(id, 1)}>
                  <ArrowDown size={15} />
                </IconButton>
              </li>
            ))}
          </ol>
          {rest.length > 0 && (
            <ul className="mt-2 space-y-1">
              {rest.map((d) => (
                <li key={d.id}>
                  <label className="flex items-center gap-2.5 px-3 cursor-pointer text-ink-soft">
                    <input type="checkbox" className={tick} checked={false} onChange={() => toggle(d.id)} />
                    <span className="truncate">{d.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <fieldset>
          <legend className="text-[13px] font-medium">Sections after the diagrams</legend>
          <div className="mt-1.5 space-y-1.5">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input type="checkbox" className={tick} checked={inventory} onChange={() => setInventory(!inventory)} />
              Inventory: every object, with its owner and lifecycle <span className="text-[13px] text-ink-soft">Word only</span>
            </label>
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input type="checkbox" className={tick} checked={decisions} onChange={() => setDecisions(!decisions)} />
              Decisions: {countOf(Object.keys(ws.adrs).length, "record")}
            </label>
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input type="checkbox" className={tick} checked={data} onChange={() => setData(!data)} />
              Personal data: where it is kept and who receives it
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-[13px] font-medium">Findings from these rule packs</legend>
          <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1.5">
            {PACKS.map((pack) => (
              <label key={pack.id} className="flex items-center gap-2 cursor-pointer" title={pack.about}>
                <input type="checkbox" className={tick} checked={packs.includes(pack.id)} onChange={() => togglePack(pack.id)} />
                {pack.name}
              </label>
            ))}
          </div>
          <p className="mt-1 text-[13px] text-ink-soft">With none ticked, the findings section is left out.</p>
        </fieldset>

        {problem && (
          <p role="alert" className="rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
            {problem}
          </p>
        )}
        {done && (
          <p role="status" className="rounded-md bg-ok-soft text-ok px-3 py-2 text-sm" data-document-done>
            {done}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={<FileText size={15} />} disabled={!!busy} onClick={() => void run("word")} data-document-word>
            {busy === "word" ? "Working" : "Download Word document"}
          </Button>
          <Button icon={<Presentation size={15} />} disabled={!!busy} onClick={() => void run("slides")} data-document-slides>
            {busy === "slides" ? "Working" : "Download PowerPoint slides"}
          </Button>
          {progress && (
            <span className="text-[13px] text-ink-soft" role="status">
              {progress}
            </span>
          )}
        </div>
        <p className="text-[13px] text-ink-soft">
          Each diagram gets its picture, its description and tables of what it shows and how the parts connect. In the slides, the description goes into the speaker notes. A long export of many diagrams takes a few seconds per diagram.
        </p>
      </div>

      {staged && (
        // Laid out at full size so the boxes are measured, and kept out of sight and out of reach.
        <div aria-hidden className="fixed left-0 top-0 w-[1600px] h-[1000px] opacity-0 pointer-events-none -z-10" data-document-stage>
          <DiagramCanvas key={staged.id} ws={ws} diagram={staged} readOnly renderAll canvasRef={canvas} />
        </div>
      )}
    </div>
  );
}
