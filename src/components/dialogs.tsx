import { writeBpmn } from "@/lib/bpmn";
import { Check, ChevronDown, Copy, ImageUp, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { CanvasHandle } from "@/components/canvas/DiagramCanvas";
import { LiveLinks } from "@/components/cloud/LiveLinks";
import { Button, Field, Input, Modal, Select, Tabs, Textarea, cx } from "@/components/ui";
import { AiError, draftFromImage, draftFromPrompt, fetchAiStatus, getAccessCode, type AiStatus, type DraftResult } from "@/lib/ai/client";
import { draftToProposal, saveProposal } from "@/lib/ai/proposals";
import { VIEW_TYPE_INFO, objectType } from "@/lib/catalog";
import { cloudEnabled } from "@/lib/cloud/config";
import { useCategoryRank } from "@/lib/cloud/session";
import { CATEGORIES as AREAS, CATEGORY_INFO as AREA_INFO, VIEWS_BY_CATEGORY, viewCategory } from "@/lib/categories";
import {
  diagramJson,
  diagramObjects,
  diagramRelationships,
  downloadText,
  objectsCsv,
  relationshipsCsv,
  slugify,
  toMermaid,
  toPlantUml,
} from "@/lib/exporters";
import { transcriptToProposal } from "@/lib/ai/transcript";
import { calmJson } from "@/lib/calm";
import { exportPdf, exportPng, exportSvg, stampFor } from "@/lib/exportImage";
import { sortedObjects } from "@/lib/model";
import { buildSharePayload, encodeShare, shareUrl } from "@/lib/share";
import { addView, apply } from "@/lib/store";
import { type Diagram, type ViewType, type Workspace } from "@/lib/types";

/* ---------- new diagram ---------- */

export function NewDiagramDialog({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const rankIn = useCategoryRank();
  // The first kind the person may create, preferring a system landscape when the model has objects.
  const [viewType, setViewType] = useState<ViewType>(() => {
    const offered = AREAS.filter((a) => rankIn(a) >= 3).flatMap((a) => VIEWS_BY_CATEGORY[a]);
    const preferred: ViewType = Object.keys(ws.objects).length ? "landscape" : "custom";
    return offered.includes(preferred) ? preferred : (offered[0] ?? preferred);
  });
  const [scopeId, setScopeId] = useState("");
  const [direction, setDirection] = useState<"TB" | "LR">("TB");
  const needsScope = viewType === "context" || viewType === "container";
  const scopes = sortedObjects(ws).filter((o) => objectType(o.typeId).level <= 3);
  const ready = (!needsScope || !!scopeId) && rankIn(viewCategory(viewType)) >= 3;
  const create = () => {
    const fallback = needsScope && scopeId ? `${VIEW_TYPE_INFO[viewType].label}: ${ws.objects[scopeId].name}` : VIEW_TYPE_INFO[viewType].label;
    const diagram = addView({ name: name.trim() || fallback, viewType, scopeId: needsScope ? scopeId : null, direction });
    onClose();
    navigate(`/diagram/${diagram.id}`);
  };
  return (
    <Modal
      title="New diagram"
      width={640}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={create}>
            Create diagram
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="For example: Payments system context" onKeyDown={(e) => e.key === "Enter" && ready && create()} />
        </Field>
        <fieldset>
          <legend className="text-[13px] font-medium text-ink-soft mb-1.5">What it shows</legend>
          <div className="space-y-2.5">
            {AREAS.map((area) => {
              const allowed = rankIn(area) >= 3;
              return (
                <div key={area} data-view-category={area}>
                  <p className="text-xs font-semibold text-ink-soft mb-1">
                    {AREA_INFO[area].label}
                    {!allowed && <span className="ml-1.5 font-normal text-ink-faint">{rankIn(area) === 0 ? "no access" : "view only"}</span>}
                  </p>
                  <div className={cx("grid gap-1.5", VIEWS_BY_CATEGORY[area].length > 1 && "sm:grid-cols-3")}>
                    {VIEWS_BY_CATEGORY[area].map((type) => (
                      <label
                        key={type}
                        className={cx(
                          "flex items-start gap-2.5 rounded-md border px-3 py-2",
                          !allowed ? "opacity-50 cursor-not-allowed border-line" : "cursor-pointer",
                          allowed && (viewType === type ? "border-blueprint bg-blueprint-soft" : "border-line hover:border-ink-faint"),
                        )}
                      >
                        <input type="radio" name="view-type" data-view-type={type} className="mt-1 accent-blueprint" disabled={!allowed} checked={viewType === type} onChange={() => setViewType(type)} />
                        <span>
                          <span className="block font-medium">{VIEW_TYPE_INFO[type].label}</span>
                          <span className="block text-[13px] text-ink-soft">{VIEW_TYPE_INFO[type].hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </fieldset>
        {needsScope && (
          <Field label="Which object" hint={scopes.length ? "The diagram is filled with this object's surroundings from the model." : "Create an object first, or pick another kind of diagram."}>
            <Select value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
              <option value="">Choose an object</option>
              {scopes.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({objectType(o.typeId).label})
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Layout direction">
          <Select value={direction} onChange={(e) => setDirection(e.target.value as "TB" | "LR")}>
            <option value="TB">Top to bottom</option>
            <option value="LR">Left to right</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

/* ---------- AI draft ---------- */

const EXAMPLE =
  "Customers use the web portal, which calls the API gateway. The gateway routes requests to the order service and the payment service. The order service stores data in PostgreSQL and publishes events to Kafka. The payment service calls Stripe.";

export function AiDraftDialog({ ws, targetDiagram, onClose }: { ws: Workspace; targetDiagram?: Diagram; onClose: () => void }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"text" | "image" | "meeting">("text");
  const [transcript, setTranscript] = useState("");
  const [text, setText] = useState("");
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
      } else if (tab === "text") finish(await draftFromPrompt(text.trim()), "ai-prompt", text.trim());
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
      title="Draft with AI"
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
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  const file = slugify(diagram.name);
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
    if (!handle || !element) return;
    const stamp = stamped ? stampFor(diagram, ws.name, ws.userName, window.location.origin) : undefined;
    try {
      await handle.whole(true);
      if (kind === "png") await exportPng(element, handle.nodes(), file, stamp);
      if (kind === "svg") await exportSvg(element, handle.nodes(), file);
      if (kind === "pdf") await exportPdf(element, handle.nodes(), file, diagram.name, stamp);
      onNotice(`Exported ${file}.${kind}`);
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "The export failed.");
    } finally {
      void handle.whole(false);
    }
  };
  const items: { group: string; label: string; run: () => void }[] = [
    { group: "Picture", label: "PNG image", run: () => void picture("png") },
    { group: "Picture", label: "SVG image", run: () => void picture("svg") },
    { group: "Picture", label: "PDF document", run: () => void picture("pdf") },
    { group: "Data", label: "Objects (CSV)", run: () => downloadText(`${file}-objects.csv`, objectsCsv(ws, diagramObjects(ws, diagram)), "text/csv") },
    { group: "Data", label: "Relationships (CSV)", run: () => downloadText(`${file}-relationships.csv`, relationshipsCsv(ws, diagramRelationships(ws, diagram)), "text/csv") },
    { group: "Data", label: "Diagram (JSON)", run: () => downloadText(`${file}.json`, diagramJson(ws, diagram), "application/json") },
    { group: "Code", label: "Mermaid", run: () => downloadText(`${file}.mmd`, toMermaid(ws, diagram)) },
    { group: "Code", label: "PlantUML", run: () => downloadText(`${file}.puml`, toPlantUml(ws, diagram)) },
    { group: "Code", label: "FINOS CALM (JSON)", run: () => downloadText(`${file}.calm.json`, calmJson(ws, diagram), "application/json") },
    // Offered for a diagram drawn in BPMN: other diagrams hold nothing a BPMN tool would show.
    ...(diagram.notation === "bpmn" ? [{ group: "Code", label: "BPMN 2.0 (.bpmn)", run: () => downloadText(`${file}.bpmn`, writeBpmn(ws, diagram).xml, "application/xml") }] : []),
  ];
  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <div ref={root} className="relative">
      <Button aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Export <ChevronDown size={14} />
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1 z-30 w-52 rounded-md border border-line bg-surface py-1 shadow-[0_10px_30px_rgba(22,35,58,0.14)]">
          {groups.map((group) => (
            <div key={group} className="py-1 border-b border-line-soft last:border-b-0">
              <div className="px-3 pb-0.5 text-xs text-ink-faint">{group}</div>
              {items
                .filter((i) => i.group === group)
                .map((item) => (
                  <button
                    key={item.label}
                    role="menuitem"
                    type="button"
                    className="block w-full px-3 py-1.5 text-left hover:bg-line-soft"
                    onClick={() => {
                      setOpen(false);
                      item.run();
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              {group === "Picture" && (
                <label className="flex items-start gap-2 px-3 pt-1.5 pb-1 text-[13px] text-ink-soft" title="A strip under the picture with the date and a code. Scanning the code opens this diagram and says what has changed since.">
                  <input type="checkbox" className="mt-0.5" checked={stamped} onChange={(e) => toggleStamp(e.target.checked)} data-export-stamp />
                  <span>Stamp PNG and PDF with the date and a check code</span>
                </label>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
