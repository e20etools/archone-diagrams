import { writeBpmn } from "@/lib/bpmn";
import { Check, Copy, Download, ImageUp, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { CanvasHandle } from "@/components/canvas/DiagramCanvas";
import { LiveLinks } from "@/components/cloud/LiveLinks";
import type { DiagramStart } from "@/components/ImportDialog";
import { Button, Field, Input, Modal, Select, Tabs, Textarea, cx } from "@/components/ui";
import { AiError, draftFromImage, draftFromPrompt, fetchAiStatus, getAccessCode, type AiStatus, type DraftResult } from "@/lib/ai/client";
import { draftToProposal, saveProposal } from "@/lib/ai/proposals";
import { cloudEnabled } from "@/lib/cloud/config";
import {
  diagramJson,
  diagramObjects,
  diagramRelationships,
  downloadBlob,
  downloadText,
  objectsCsv,
  relationshipsCsv,
  slugify,
  toMermaid,
  toPlantUml,
} from "@/lib/exporters";
import { transcriptToProposal } from "@/lib/ai/transcript";
import { calmJson } from "@/lib/calm";
import { diagramPicture } from "@/lib/export/picture";
import { diagramWorkspace, drawioXml, gifBlob, interactiveHtml, powerPointBlob, structurizrDsl, videoBlob } from "@/lib/export/formats";
import { writeXlsx } from "@/lib/import/xlsx";
import { modelSheets } from "@/lib/import/draft";
import { writeArchimate } from "@/lib/import/archimate";
import { exportPdf, exportPng, exportSvg, stampFor } from "@/lib/exportImage";
import { buildSharePayload, encodeShare, shareUrl } from "@/lib/share";
import { apply } from "@/lib/store";
import { type Diagram, type Workspace } from "@/lib/types";

/* ---------- AI draft ---------- */

const EXAMPLE =
  "Customers use the web portal, which calls the API gateway. The gateway routes requests to the order service and the payment service. The order service stores data in PostgreSQL and publishes events to Kafka. The payment service calls Stripe.";

export interface DraftStart extends DiagramStart {
  tab?: "text" | "image";
  text?: string;
  /** The text was spoken; the names in the draft are asked for in English. */
  voice?: boolean;
}

export function AiDraftDialog({ ws, targetDiagram, onClose, start }: { ws: Workspace; targetDiagram?: Diagram; onClose: () => void; start?: DraftStart }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"text" | "image" | "meeting">(start?.tab ?? "text");
  const [transcript, setTranscript] = useState("");
  const [text, setText] = useState(start?.text ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [into, setInto] = useState<"new" | "current">(targetDiagram ? "current" : "new");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<AiStatus | null>(null);
  useEffect(() => {
    let live = true;
    fetchAiStatus().then((s) => live && setStatus(s));
    return () => {
      live = false;
    };
  }, []);

  const finish = (result: DraftResult, origin: "ai-prompt" | "ai-image", source: string) => {
    if (!result.draft.objects.length) {
      setError(result.draft.notes || "Nothing was recognised. Name the components and how they connect, then try again.");
      return;
    }
    const proposal = draftToProposal(ws, result.draft, {
      origin,
      source,
      engine: result.engine,
      targetDiagramId: into === "current" && targetDiagram ? targetDiagram.id : null,
      ...(start ? { diagram: { name: start.name, viewType: start.viewType, scopeId: start.scopeId } } : {}),
      ...(start?.voice ? { sourceKind: "voice" as const } : {}),
    });
    apply((w) => saveProposal(w, proposal));
    onClose();
    navigate(`/ai/${proposal.id}`);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (tab === "meeting") {
        const proposal = transcriptToProposal(ws, transcript, into === "current" && targetDiagram ? targetDiagram.id : null);
        if (!proposal.objects.length) {
          setError("Nothing was recognised. The rules look for sentences that name systems and say how they connect, such as 'the portal will call the billing service'.");
          return;
        }
        apply((w) => saveProposal(w, proposal));
        onClose();
        navigate(`/ai/${proposal.id}`);
      } else if (tab === "text") finish(await draftFromPrompt(start?.voice ? `${text.trim()}\n\nName every component in English, even where the description is in another language.` : text.trim()), "ai-prompt", text.trim());
      else if (file) finish(await draftFromImage(file, note.trim()), "ai-image", file.name);
    } catch (e) {
      setError(e instanceof AiError ? e.message : "The draft failed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const ready = tab === "text" ? text.trim().length >= 3 : tab === "meeting" ? transcript.trim().length >= 20 : !!file;
  return (
    <Modal
      title={start?.voice ? "Voice to Architecture" : start ? (start.tab === "image" ? "Image to Architecture" : "Text to Architecture") : "Draft with AI"}
      width={620}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-[13px] text-ink-soft">You review every suggestion before anything is saved.</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready || busy} icon={<Sparkles size={15} />} onClick={run}>
            {busy ? "Drafting" : "Create draft"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Tabs
          tabs={[
            { id: "text", label: "Describe it" },
            { id: "image", label: "Upload a picture" },
            { id: "meeting", label: "From a meeting" },
          ]}
          value={tab}
          onChange={(t) => {
            setTab(t);
            setError(null);
          }}
        />
        {tab === "text" ? (
          <div>
            <Textarea
              autoFocus
              rows={7}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Name the parts and how they connect. For example: The mobile app calls the API gateway, which routes to the booking service. The booking service stores data in PostgreSQL."
            />
            <div className="mt-1.5 flex items-center justify-between gap-3">
              <span className="text-xs text-ink-faint">Arrows work too: Browser -&gt; Checkout API -&gt; Orders DB</span>
              <Button size="sm" variant="ghost" onClick={() => setText(EXAMPLE)}>
                Use an example
              </Button>
            </div>
          </div>
        ) : tab === "meeting" ? (
          <div>
            <Textarea
              autoFocus
              rows={9}
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              aria-label="Meeting transcript"
              placeholder={"Paste the transcript or your notes, one speaker per line. For example:\nOlivia: The partner portal will call the billing service over HTTPS.\nSam: Billing stores invoices in the ledger database."}
            />
            <p className="mt-1.5 text-xs text-ink-faint">
              Read in this browser by the built-in rules, sentence by sentence; nothing is sent to an AI model. Each suggestion shows the sentence it came from and who said it.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <label className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-ink-faint bg-paper px-4 py-7 text-center cursor-pointer hover:border-blueprint">
              <ImageUp size={22} className="text-ink-soft" />
              <span className="font-medium">{file ? file.name : "Choose a screenshot, a whiteboard photo or an exported diagram"}</span>
              <span className="text-[13px] text-ink-soft">PNG, JPEG, WebP or GIF, up to 5 MB</span>
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            <Field label="Note for the AI (optional)">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: the grey boxes are external systems" />
            </Field>
          </div>
        )}

        {targetDiagram && (
          <Field label="Put the result">
            <Select value={into} onChange={(e) => setInto(e.target.value as "new" | "current")}>
              <option value="current">On this diagram ({targetDiagram.name})</option>
              <option value="new">On a new diagram</option>
            </Select>
          </Field>
        )}

        {status && (
          <p className={cx("rounded-md px-3 py-2 text-[13px]", status.configured ? "bg-paper text-ink-soft" : "bg-signal-soft text-ink")}>
            {status.configured
              ? `AI model in use: ${status.engine}.${status.needsCode && !getAccessCode() ? " This server asks for an access code: enter it in Settings first." : ""}`
              : tab === "text"
                ? "No AI model is configured on this server, so the built-in rules will read your text. They recognise common products and phrases such as \"order service\" or \"API gateway\", and nothing else."
                : "Reading a picture needs an AI model, and none is configured on this server yet. Add an AI key in the hosting settings, or describe the diagram in text."}
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/* ---------- share ---------- */

export function ShareDialog({ ws, diagram, onClose }: { ws: Workspace; diagram: Diagram; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // With accounts, a link that stays current and can be switched off is the usual choice.
  const [kind, setKind] = useState<"live" | "snapshot">(cloudEnabled ? "live" : "snapshot");
  const create = async () => {
    setBusy(true);
    try {
      const token = await encodeShare(buildSharePayload(ws, diagram), password || undefined);
      setLink(shareUrl(window.location.origin, token));
      setCopied(false);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Modal title={`Share "${diagram.name}"`} onClose={onClose} width={600} footer={<Button onClick={onClose}>Done</Button>}>
      {cloudEnabled && (
        <div className="mb-4">
          <Tabs
            tabs={[
              { id: "live", label: "Live link" },
              { id: "snapshot", label: "Snapshot link" },
            ]}
            value={kind}
            onChange={setKind}
          />
        </div>
      )}
      {kind === "live" ? (
        <LiveLinks diagram={diagram} />
      ) : (
      <div className="space-y-4">
        <p className="text-ink-soft">
          Anyone with the link can view this diagram and its component details. They cannot edit, and they need no account.
        </p>
        <Field label="Password (optional)" hint="With a password, the diagram inside the link is encrypted. Send the password separately.">
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setLink(null);
            }}
            placeholder="Leave empty for an open link"
          />
        </Field>
        <Button variant="primary" disabled={busy} onClick={create}>
          {link ? "Create the link again" : "Create link"}
        </Button>
        {link && (
          <div>
            <div className="flex gap-2">
              <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
              <Button icon={copied ? <Check size={15} /> : <Copy size={15} />} onClick={copy}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            {link.length > 8000 && (
              <p className="mt-1.5 text-xs text-signal">This link is {link.length.toLocaleString()} characters long. Some chat tools cut long links; test it before you rely on it.</p>
            )}
          </div>
        )}
        <p className="text-[13px] text-ink-faint border-t border-line-soft pt-3">
          The link holds a snapshot of the diagram as it is now. Later changes do not appear in it, and it cannot be switched off once sent. The
          diagram travels inside the link itself and is not stored on the server.
        </p>
      </div>
      )}
    </Modal>
  );
}

/* ---------- export ---------- */

const STAMP_KEY = "archone.export.stamp";

export function ExportMenu({ ws, diagram, canvas, onNotice }: { ws: Workspace; diagram: Diagram; canvas: React.RefObject<CanvasHandle | null>; onNotice: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={<Download size={15} />} onClick={() => setOpen(true)} data-export-open>
        Export
      </Button>
      {open && <ExportDialog ws={ws} diagram={diagram} canvas={canvas} onNotice={onNotice} onClose={() => setOpen(false)} />}
    </>
  );
}

type ExportId =
  | "png"
  | "svg"
  | "pdf"
  | "pptx"
  | "html"
  | "gif"
  | "video"
  | "json"
  | "xlsx"
  | "csv-objects"
  | "csv-relationships"
  | "mermaid"
  | "plantuml"
  | "drawio"
  | "structurizr"
  | "archimate"
  | "calm"
  | "bpmn";

/** Every way a diagram can leave the app, in one window, grouped by what the file is for. */
function ExportDialog({ ws, diagram, canvas, onNotice, onClose }: { ws: Workspace; diagram: Diagram; canvas: React.RefObject<CanvasHandle | null>; onNotice: (text: string) => void; onClose: () => void }) {
  const file = slugify(diagram.name) || "diagram";
  const [busy, setBusy] = useState<ExportId | null>(null);
  const [done, setDone] = useState("");
  // PNG and PDF carry a strip saying when they were exported, with a code to check them against the model.
  const [stamped, setStamped] = useState(() => {
    try {
      return localStorage.getItem(STAMP_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const toggleStamp = (on: boolean) => {
    setStamped(on);
    try {
      localStorage.setItem(STAMP_KEY, on ? "on" : "off");
    } catch {
      // Not remembered; it still applies to this visit.
    }
  };
  const picture = async (kind: "png" | "svg" | "pdf") => {
    const handle = canvas.current;
    const element = handle?.element();
    if (!handle || !element) throw new Error("Open the diagram to export its picture.");
    const stamp = stamped ? stampFor(diagram, ws.name, ws.userName, window.location.origin) : undefined;
    try {
      await handle.whole(true);
      if (kind === "png") await exportPng(element, handle.nodes(), file, stamp);
      if (kind === "svg") await exportSvg(element, handle.nodes(), file);
      if (kind === "pdf") await exportPdf(element, handle.nodes(), file, diagram.name, stamp);
    } finally {
      void handle.whole(false);
    }
    return `${file}.${kind}`;
  };
  const drawn = () => diagramPicture(ws, diagram);
  const run: Record<ExportId, () => Promise<string> | string> = {
    png: () => picture("png"),
    svg: () => picture("svg"),
    pdf: () => picture("pdf"),
    pptx: async () => {
      downloadBlob(`${file}.pptx`, await powerPointBlob(ws, diagram, drawn()));
      return `${file}.pptx`;
    },
    html: () => {
      downloadText(`${file}.html`, interactiveHtml(ws, diagram, drawn()), "text/html");
      return `${file}.html`;
    },
    gif: async () => {
      downloadBlob(`${file}.gif`, await gifBlob(drawn()));
      return `${file}.gif`;
    },
    video: async () => {
      const { blob, extension } = await videoBlob(drawn());
      downloadBlob(`${file}.${extension}`, blob);
      return `${file}.${extension}`;
    },
    json: () => (downloadText(`${file}.json`, diagramJson(ws, diagram), "application/json"), `${file}.json`),
    xlsx: () => {
      downloadBlob(`${file}.xlsx`, new Blob([writeXlsx(modelSheets(diagramWorkspace(ws, diagram))) as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      return `${file}.xlsx`;
    },
    "csv-objects": () => (downloadText(`${file}-objects.csv`, objectsCsv(ws, diagramObjects(ws, diagram)), "text/csv"), `${file}-objects.csv`),
    "csv-relationships": () => (downloadText(`${file}-relationships.csv`, relationshipsCsv(ws, diagramRelationships(ws, diagram)), "text/csv"), `${file}-relationships.csv`),
    mermaid: () => (downloadText(`${file}.mmd`, toMermaid(ws, diagram)), `${file}.mmd`),
    plantuml: () => (downloadText(`${file}.puml`, toPlantUml(ws, diagram)), `${file}.puml`),
    drawio: () => (downloadText(`${file}.drawio`, drawioXml(diagram, drawn()), "application/xml"), `${file}.drawio`),
    structurizr: () => (downloadText(`${file}.dsl`, structurizrDsl(ws, diagram)), `${file}.dsl`),
    archimate: () => (downloadText(`${file}-archimate.xml`, writeArchimate(diagramWorkspace(ws, diagram)), "application/xml"), `${file}-archimate.xml`),
    calm: () => (downloadText(`${file}.calm.json`, calmJson(ws, diagram), "application/json"), `${file}.calm.json`),
    bpmn: () => (downloadText(`${file}.bpmn`, writeBpmn(ws, diagram).xml, "application/xml"), `${file}.bpmn`),
  };
  const go = async (id: ExportId) => {
    if (busy) return;
    setBusy(id);
    setDone("");
    try {
      const name = await run[id]();
      setDone(`Downloaded ${name}`);
      onNotice(`Exported ${name}`);
    } catch (e) {
      setDone(e instanceof Error ? e.message : "The export failed. Try again.");
    } finally {
      setBusy(null);
    }
  };
  const hasFlows = (diagram.flows ?? []).some((f) => f.steps.length);
  const groups: { title: string; note?: string; items: { id: ExportId; label: string; hint: string }[] }[] = [
    {
      title: "Pictures and slides",
      items: [
        { id: "png", label: "PNG", hint: "An image, as on the screen" },
        { id: "svg", label: "SVG", hint: "Sharp at any size" },
        { id: "pdf", label: "PDF", hint: "A page to print or send" },
        { id: "pptx", label: "PowerPoint", hint: "The picture, an editable copy and tables" },
      ],
    },
    {
      title: "Moving and interactive",
      note: hasFlows ? "The GIF and the video play the diagram's flows step by step." : "With no flows on the diagram, the GIF and the video show traffic moving along the lines.",
      items: [
        { id: "html", label: "Interactive HTML", hint: "Zoom, search, details and flows, offline" },
        { id: "gif", label: "GIF", hint: "An animation for chats and slides" },
        { id: "video", label: "Video", hint: "MP4 or WebM, as the browser can" },
      ],
    },
    {
      title: "Data",
      items: [
        { id: "json", label: "JSON", hint: "The diagram and its objects" },
        { id: "xlsx", label: "Excel", hint: "Objects and relationships sheets" },
        { id: "csv-objects", label: "Objects (CSV)", hint: "One row per object" },
        { id: "csv-relationships", label: "Relationships (CSV)", hint: "One row per line" },
      ],
    },
    {
      title: "For other tools",
      items: [
        { id: "mermaid", label: "Mermaid", hint: "For Markdown, GitHub and wikis" },
        { id: "plantuml", label: "PlantUML", hint: "Diagrams as text" },
        { id: "drawio", label: "draw.io", hint: "Opens in draw.io and diagrams.net" },
        { id: "structurizr", label: "Structurizr DSL", hint: "C4 model as code" },
        { id: "archimate", label: "ArchiMate", hint: "Exchange file for Archi, Sparx, Bizzdesign" },
        { id: "calm", label: "FINOS CALM", hint: "Architecture as code, JSON" },
        // A BPMN file holds only process boxes, so it is offered for diagrams drawn in BPMN.
        ...(diagram.notation === "bpmn" ? [{ id: "bpmn" as const, label: "BPMN 2.0", hint: "For Camunda, Signavio and other BPMN tools" }] : []),
      ],
    },
  ];
  return (
    <Modal title="Export" width={640} onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <div className="space-y-4" data-export-window>
        {groups.map((group) => (
          <section key={group.title}>
            <h3 className="text-[13px] font-semibold text-ink-soft mb-1.5">{group.title}</h3>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-export={item.id}
                  disabled={!!busy}
                  onClick={() => void go(item.id)}
                  title={item.hint}
                  className={cx(
                    "flex flex-col items-start gap-0.5 rounded-md border px-2.5 py-2 text-left hover:border-blueprint hover:bg-blueprint-soft disabled:cursor-wait",
                    busy === item.id ? "border-blueprint bg-blueprint-soft" : "border-line",
                  )}
                >
                  <span className="flex items-center gap-1.5 font-medium">
                    <Download size={14} className="text-blueprint" />
                    {busy === item.id ? (item.id === "video" ? "Recording…" : "Making…") : item.label}
                  </span>
                  <span className="text-xs text-ink-soft leading-snug">{item.hint}</span>
                </button>
              ))}
            </div>
            {group.title === "Pictures and slides" && (
              <label className="mt-1.5 flex items-start gap-2 text-[13px] text-ink-soft" title="A strip under the picture with the date and a code. Scanning the code opens this diagram and says what has changed since.">
                <input type="checkbox" className="mt-0.5 accent-blueprint" checked={stamped} onChange={(e) => toggleStamp(e.target.checked)} data-export-stamp />
                Add the date and a check code under PNG and PDF
              </label>
            )}
            {group.note && <p className="mt-1.5 text-xs text-ink-faint">{group.note}</p>}
          </section>
        ))}
        {done && (
          <p role="status" className="rounded-md bg-paper px-3 py-2 text-[13px]" data-export-done>
            {done}
          </p>
        )}
      </div>
    </Modal>
  );
}
