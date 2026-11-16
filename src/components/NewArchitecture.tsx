import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Copy,
  FileUp,
  ImageUp,
  LayoutTemplate,
  ListOrdered,
  Mic,
  MicOff,
  PencilLine,
  Plus,
  Sparkles,
  Trash2,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { AiDraftDialog } from "@/components/dialogs";
import { ImportDialog, type DiagramStart } from "@/components/ImportDialog";
import { TemplatePicker, TemplatePreview } from "@/components/TemplatePicker";
import { Button, Field, Input, Modal, Select, Textarea, cx, formatDate } from "@/components/ui";
import { CATEGORIES as AREAS, CATEGORY_INFO as AREA_INFO, VIEWS_BY_CATEGORY, viewCategory } from "@/lib/categories";
import { VIEW_TYPE_INFO, objectType } from "@/lib/catalog";
import { useCanEdit, useCategoryRank } from "@/lib/cloud/session";
import { useMe } from "@/lib/cloud/me";
import { componentById } from "@/lib/library";
import { archiveDiagram, archivedDiagrams, copyDiagram, restoreDiagram, sortedObjects } from "@/lib/model";
import { addView, apply } from "@/lib/store";
import { allTemplates, applyTemplateValue, type Perspective } from "@/lib/templates";
import type { Diagram, ViewType, Workspace } from "@/lib/types";
import { componentFor, stepComponents, wizardProblem, wizardSteps, wizardTemplate, type WizardAnswers } from "@/lib/wizard";

/**
 * Starting a new diagram: first what it shows (its kind, within a category), then how to build
 * it. Every way ends in a diagram of that kind and name; the ways that bring in something new
 * (AI, voice, files) go through a draft that is reviewed before anything is saved.
 */

type Way = "manual" | "wizard" | "existing" | "template" | "text" | "voice" | "import" | "drawio" | "archived";

const WAYS: { group: string; items: { id: Way; n: string; title: string; text: string; icon: ReactNode }[] }[] = [
  {
    group: "Start from scratch",
    items: [
      { id: "manual", n: "01", title: "Create manually", text: "Open the diagram and place library components yourself.", icon: <PencilLine size={18} /> },
      { id: "wizard", n: "02", title: "Wizard steps", text: "Answer a few questions for this kind of diagram and get it connected.", icon: <ListOrdered size={18} /> },
    ],
  },
  {
    group: "Reuse existing work",
    items: [
      { id: "existing", n: "03", title: "From an existing diagram", text: "Copy a diagram into a new one. The original stays as it is.", icon: <Copy size={18} /> },
      { id: "template", n: "04", title: "From a template", text: "Start from a template of this category, built in or saved here.", icon: <LayoutTemplate size={18} /> },
    ],
  },
  {
    group: "Generate with AI",
    items: [
      { id: "text", n: "05", title: "Text to architecture", text: "Describe the system and review the draft before it is saved.", icon: <Sparkles size={18} /> },
      { id: "voice", n: "06", title: "Voice to architecture", text: "Speak in Arabic or English; component names are written in English.", icon: <Mic size={18} /> },
    ],
  },
  {
    group: "Import and archive",
    items: [
      { id: "import", n: "07", title: "Import architecture", text: "From a file (Excel, Visio, Mermaid, Structurizr, ArchiMate) or a picture.", icon: <FileUp size={18} /> },
      { id: "drawio", n: "08", title: "Import draw.io file", text: "Convert a .drawio diagram using exact library matches. No AI.", icon: <Workflow size={18} /> },
      { id: "archived", n: "09", title: "Archived diagrams", text: "See archived diagrams and restore one, with a reason.", icon: <Archive size={18} /> },
    ],
  },
];

const PERSPECTIVE_OF: Record<string, Perspective | null> = { applications: "applications", data: "data", infrastructure: "infrastructure", business: "business", custom: null };

export function NewArchitectureDialog({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const navigate = useNavigate();
  const rankIn = useCategoryRank();
  const [stage, setStage] = useState<"kind" | "ways">("kind");
  const [way, setWay] = useState<Way | "image" | null>(null);
  const [name, setName] = useState("");
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
  const fallbackName = needsScope && scopeId && ws.objects[scopeId] ? `${VIEW_TYPE_INFO[viewType].label}: ${ws.objects[scopeId].name}` : VIEW_TYPE_INFO[viewType].label;
  const start: DiagramStart = { name: name.trim(), viewType, scopeId: needsScope ? scopeId : null };
  const named: DiagramStart = { ...start, name: start.name || fallbackName };
  const back = () => setWay(null);
  const open = (id: string) => {
    onClose();
    navigate(`/diagram/${id}`);
  };

  if (way === "wizard") return <WizardDialog ws={ws} start={named} onBack={back} onDone={open} />;
  if (way === "existing") return <CopyFromDiagram ws={ws} start={start} onBack={back} onDone={open} />;
  if (way === "template")
    return (
      <TemplatePicker
        templates={allTemplates(ws)}
        initialPerspective={PERSPECTIVE_OF[viewCategory(viewType)]}
        useLabel="Use for the new diagram"
        onClose={back}
        onUse={(t) => {
          let made = "";
          apply((w) => {
            const result = applyTemplateValue(w, t, { name: start.name || t.name, viewType });
            made = result.diagramId;
            return result.ws;
          });
          open(made);
        }}
      />
    );
  if (way === "text") return <AiDraftDialog ws={ws} start={{ ...named, tab: "text" }} onClose={onClose} />;
  if (way === "image") return <AiDraftDialog ws={ws} start={{ ...named, tab: "image" }} onClose={onClose} />;
  if (way === "voice") return <VoiceDialog ws={ws} start={named} onBack={back} onClose={onClose} />;
  if (way === "import") return <ImportDialog start={start} onClose={onClose} />;
  if (way === "drawio") return <ImportDialog start={start} only="drawio" onClose={onClose} />;
  if (way === "archived") return <ArchivedDialog ws={ws} onClose={back} onRestored={open} />;

  if (stage === "kind")
    return (
      <Modal
        title="New diagram"
        width={660}
        onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!ready} data-new-next onClick={() => setStage("ways")}>
              Next: how to build it
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={`For example: ${fallbackName}`} onKeyDown={(e) => e.key === "Enter" && ready && setStage("ways")} />
          </Field>
          <KindPicker viewType={viewType} onChange={setViewType} />
          {needsScope && (
            <Field label="Which system" hint={scopes.length ? "The diagram shows this system and what surrounds it, or what is inside it." : "Create an object first, or pick another kind of diagram."}>
              <Select value={scopeId} onChange={(e) => setScopeId(e.target.value)} aria-label="Which system">
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

  const archivedCount = archivedDiagrams(ws).length;
  const others = Object.values(ws.diagrams).filter((d) => !d.archive?.archived).length;
  return (
    <Modal
      title="How do you want to build it?"
      width={700}
      onClose={onClose}
      footer={
        <>
          <Button icon={<ArrowLeft size={15} />} onClick={() => setStage("kind")}>
            Back
          </Button>
          <span className="mr-auto" />
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <p className="text-ink-soft -mt-1 mb-3">
        <span className="font-medium text-ink">{named.name}</span>, a {AREA_INFO[viewCategory(viewType)].label} diagram ({VIEW_TYPE_INFO[viewType].label}). The ways that bring in something new
        make a draft you review before anything is saved.
      </p>
      <div className="space-y-4" data-new-ways>
        {WAYS.map((group) => (
          <section key={group.group}>
            <h3 className="text-[13px] font-semibold text-ink-soft mb-1.5">{group.group}</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {group.items.map((item) => {
                const unavailable = item.id === "existing" && others === 0;
                const note = item.id === "archived" ? `${archivedCount} archived` : unavailable ? "No diagrams yet" : null;
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-way={item.id}
                    disabled={unavailable}
                    onClick={() => {
                      if (item.id === "manual") {
                        const diagram = addView({ name: named.name, viewType, scopeId: needsScope ? scopeId : null, direction });
                        open(diagram.id);
                      } else if (item.id === "import") setWay("import");
                      else setWay(item.id);
                    }}
                    className="group flex items-start gap-3 rounded-md border border-line bg-surface px-3 py-2.5 text-left hover:border-blueprint hover:bg-blueprint-soft disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-line disabled:hover:bg-surface"
                  >
                    <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-md bg-blueprint-soft text-blueprint group-hover:bg-blueprint group-hover:text-white">{item.icon}</span>
                    <span className="min-w-0">
                      <span className="block font-medium">
                        <span className="mr-1.5 tabular-nums text-ink-faint">{item.n}</span>
                        {item.title}
                      </span>
                      <span className="block text-[13px] text-ink-soft">{item.text}</span>
                      {note && <span className="mt-0.5 block text-xs text-ink-faint">{note}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <p className="mt-3 text-xs text-ink-faint">
        A picture instead of a file?{" "}
        <button type="button" className="text-blueprint hover:underline" data-way="image" onClick={() => setWay("image")}>
          <ImageUp size={12} className="inline -mt-0.5 mr-0.5" />
          Turn a screenshot or whiteboard photo into a draft
        </button>
      </p>
    </Modal>
  );
}

/** The kinds of diagram, by category; the ones the member may not create are shown but not offered. */
export function KindPicker({ viewType, onChange }: { viewType: ViewType; onChange: (v: ViewType) => void }) {
  const rankIn = useCategoryRank();
  return (
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
                    <input type="radio" name="view-type" data-view-type={type} className="mt-1 accent-blueprint" disabled={!allowed} checked={viewType === type} onChange={() => onChange(type)} />
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
  );
}

/* ---------- 02 wizard ---------- */

function WizardDialog({ ws, start, onBack, onDone }: { ws: Workspace; start: DiagramStart; onBack: () => void; onDone: (diagramId: string) => void }) {
  const steps = wizardSteps(start.viewType);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<WizardAnswers>((): WizardAnswers => {
    // A diagram of one system starts from that system.
    const scope = start.scopeId ? ws.objects[start.scopeId] : null;
    return scope && steps[0]?.id === "system" ? { system: [{ name: scope.name, componentId: scope.componentId }] } : {};
  });
  const review = index === steps.length;
  const step = steps[index];
  const template = useMemo(() => wizardTemplate(start.viewType, start.name, answers), [start, answers]);
  const problem = wizardProblem(start.viewType, answers);
  const items = step ? (answers[step.id] ?? []) : [];
  const setItems = (next: typeof items) => setAnswers((a) => ({ ...a, [step.id]: next }));
  const listId = step ? `wizard-${step.id}-components` : "";
  const options = useMemo(() => (step ? stepComponents(step).slice(0, 600) : []), [step]);
  const known = sortedObjects(ws).filter((o) => !step || !step.kinds.length || step.kinds.includes(o.typeId));

  return (
    <Modal
      title={`Wizard: ${start.name}`}
      width={680}
      onClose={onBack}
      footer={
        <>
          <Button icon={<ArrowLeft size={15} />} onClick={() => (index === 0 ? onBack() : setIndex(index - 1))}>
            Back
          </Button>
          <span className="mr-auto text-[13px] text-ink-soft">{review ? "Review" : `Step ${index + 1} of ${steps.length}`}</span>
          {review ? (
            <Button
              variant="primary"
              data-wizard-create
              disabled={!!problem}
              onClick={() => {
                let made = "";
                apply((w) => {
                  const result = applyTemplateValue(w, template, { name: start.name, viewType: start.viewType, scopeId: start.scopeId });
                  made = result.diagramId;
                  return result.ws;
                });
                onDone(made);
              }}
            >
              Create diagram
            </Button>
          ) : (
            <Button variant="primary" data-wizard-next disabled={!!step.required && !items.some((i) => i.name.trim())} onClick={() => setIndex(index + 1)}>
              {index === steps.length - 1 ? "Review" : "Next"}
            </Button>
          )}
        </>
      }
    >
      <ol className="flex flex-wrap gap-1 mb-4" aria-label="Steps">
        {[...steps.map((s) => s.title), "Review"].map((title, i) => (
          <li key={title} className={cx("rounded-full px-2.5 py-0.5 text-xs", i === index ? "bg-blueprint text-white" : i < index ? "bg-blueprint-soft text-blueprint" : "bg-paper text-ink-faint")}>
            {title}
          </li>
        ))}
      </ol>
      {review ? (
        <div className="grid gap-4 sm:grid-cols-[1fr_240px]" data-wizard-review>
          <div>
            <p className="text-ink-soft">
              {template.objects.length} boxes and {template.relationships.length} lines, each box a component of the library. Names the model already has are reused, not copied.
            </p>
            <ul className="mt-2 max-h-64 overflow-auto space-y-0.5 text-[13px]">
              {template.objects.map((o) => (
                <li key={o.key}>
                  {o.name} <span className="text-ink-faint">· {componentById(o.componentId)?.name}</span>
                </li>
              ))}
            </ul>
            {problem && <p className="mt-2 text-[13px] text-danger">{problem}</p>}
          </div>
          <div className="aspect-square rounded-md border border-line-soft bg-paper p-2">
            <TemplatePreview template={template} />
          </div>
        </div>
      ) : (
        <div data-wizard-step={step.id}>
          <p className="font-medium">{step.question}</p>
          <p className="text-[13px] text-ink-soft">{step.single ? "One name." : "One per line; add as many as you need."} Each becomes a library component; pick one, or the name decides.</p>
          <datalist id={listId}>
            {options.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
          <datalist id={`${listId}-names`}>
            {known.map((o) => (
              <option key={o.id} value={o.name} />
            ))}
          </datalist>
          <div className="mt-2 space-y-1.5">
            {(items.length ? items : [{ name: "" }]).map((item, i) => {
              const c = item.name.trim() ? componentFor(step, item) : null;
              const update = (patch: Partial<typeof item>) => {
                const next = [...(items.length ? items : [{ name: "" }])];
                next[i] = { ...next[i], ...patch };
                setItems(next);
              };
              return (
                <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-1.5 items-start">
                  <Input value={item.name} list={`${listId}-names`} aria-label={`${step.title} ${i + 1}`} placeholder={step.placeholder} onChange={(e) => update({ name: e.target.value })} />
                  <div>
                    <Input
                      list={listId}
                      aria-label={`Library component for ${step.title} ${i + 1}`}
                      placeholder={c ? c.name : "Library component"}
                      defaultValue={componentById(item.componentId)?.name ?? ""}
                      onChange={(e) => update({ componentId: options.find((o) => o.name === e.target.value)?.id })}
                    />
                    {c && <span className="block text-xs text-ink-faint mt-0.5">Saved as {c.name}</span>}
                  </div>
                  <Button size="sm" variant="ghost" aria-label="Remove" icon={<Trash2 size={14} />} disabled={items.length <= 1} onClick={() => setItems(items.filter((_, j) => j !== i))} />
                </div>
              );
            })}
          </div>
          {!step.single && (
            <Button size="sm" className="mt-2" icon={<Plus size={14} />} onClick={() => setItems([...(items.length ? items : [{ name: "" }]), { name: "" }])}>
              Add another
            </Button>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ---------- 03 from an existing diagram ---------- */

function CopyFromDiagram({ ws, start, onBack, onDone }: { ws: Workspace; start: DiagramStart; onBack: () => void; onDone: (diagramId: string) => void }) {
  const rankIn = useCategoryRank();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Diagram | null>(null);
  const [separate, setSeparate] = useState(false);
  const [label, setLabel] = useState("target");
  const shown = Object.values(ws.diagrams)
    .filter((d) => !d.archive?.archived && rankIn(viewCategory(d.viewType)) >= 1)
    .filter((d) => `${d.name} ${d.description}`.toLowerCase().includes(query.toLowerCase().trim()))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Modal
      title="From an existing diagram"
      width={620}
      onClose={onBack}
      footer={
        <>
          <Button icon={<ArrowLeft size={15} />} onClick={onBack}>
            Back
          </Button>
          <span className="mr-auto" />
          <Button
            variant="primary"
            data-copy-create
            disabled={!picked}
            onClick={() => {
              if (!picked) return;
              let made = "";
              apply((w) => {
                const result = copyDiagram(w, picked.id, { name: start.name || `${picked.name} (copy)`, viewType: start.viewType, separate, label });
                made = result.diagram?.id ?? "";
                return result.ws;
              });
              if (made) onDone(made);
            }}
          >
            Make the copy
          </Button>
        </>
      }
    >
      <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search diagrams" aria-label="Search diagrams" />
      <ul className="mt-2 max-h-64 overflow-auto rounded-md border border-line divide-y divide-line-soft" data-copy-list>
        {shown.map((d) => (
          <li key={d.id}>
            <button type="button" data-copy-source={d.id} onClick={() => setPicked(d)} className={cx("w-full text-left px-3 py-2 hover:bg-paper", picked?.id === d.id && "bg-blueprint-soft")}>
              <span className="font-medium">{d.name}</span>
              <span className="ml-2 text-xs text-ink-faint">
                {VIEW_TYPE_INFO[d.viewType].label} · {Object.keys(d.nodes).length} boxes · changed {formatDate(d.updatedAt)}
              </span>
            </button>
          </li>
        ))}
        {!shown.length && <li className="px-3 py-3 text-ink-soft">No diagram matches.</li>}
      </ul>
      <fieldset className="mt-3 space-y-1.5 text-[13px]">
        <label className="flex items-start gap-2">
          <input type="radio" className="mt-0.5 accent-blueprint" checked={!separate} onChange={() => setSeparate(false)} />
          <span>
            <span className="font-medium">Same objects.</span> The copy draws the same objects of the model; renaming one renames it everywhere. Good for another view of the same thing.
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" className="mt-0.5 accent-blueprint" data-copy-separate checked={separate} onChange={() => setSeparate(true)} />
          <span>
            <span className="font-medium">Separate objects.</span> Every box gets an object of its own, named with a label, so the copy can change freely. Good for a target state or an option.
          </span>
        </label>
        {separate && (
          <Field label="Label added to each name">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label added to each name" maxLength={30} />
          </Field>
        )}
      </fieldset>
    </Modal>
  );
}

/* ---------- 06 voice ---------- */

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function speechRecognition(): (new () => Recognition) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function VoiceDialog({ ws, start, onBack, onClose }: { ws: Workspace; start: DiagramStart; onBack: () => void; onClose: () => void }) {
  const [lang, setLang] = useState<"ar-SA" | "en-US">("ar-SA");
  const [text, setText] = useState("");
  const [interim, setInterim] = useState("");
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState("");
  const [drafting, setDrafting] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const Supported = speechRecognition();
  // Recording stops when the window closes.
  useEffect(() => () => recognition.current?.stop(), []);

  if (drafting) return <AiDraftDialog ws={ws} start={{ ...start, tab: "text", text, voice: true }} onClose={onClose} />;

  const toggle = () => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    if (!Supported) return;
    const r = new Supported();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let finalText = "";
      let pending = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else pending += result[0].transcript;
      }
      if (finalText) setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}${finalText.trim()}`);
      setInterim(pending);
    };
    r.onerror = (e) => setProblem(e.error === "not-allowed" || e.error === "service-not-allowed" ? "The browser was not allowed to use the microphone. Allow it in the address bar, or type instead." : `Dictation stopped: ${e.error}. You can type instead.`);
    r.onend = () => {
      setListening(false);
      setInterim("");
    };
    recognition.current = r;
    setProblem("");
    try {
      r.start();
      setListening(true);
    } catch {
      setProblem("Dictation could not start. Type instead.");
    }
  };

  return (
    <Modal
      title="Voice to architecture"
      width={600}
      onClose={onBack}
      footer={
        <>
          <Button icon={<ArrowLeft size={15} />} onClick={onBack}>
            Back
          </Button>
          <span className="mr-auto" />
          <Button
            variant="primary"
            data-voice-continue
            icon={<Sparkles size={15} />}
            disabled={text.trim().length < 3 || listening}
            onClick={() => {
              recognition.current?.stop();
              setDrafting(true);
            }}
          >
            Make a draft from this
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[13px] text-ink-soft">
          Recording starts only when you press the button. Your browser turns speech into text, and some browsers send the audio to their maker's service to do so. You can correct the text before
          the draft is made; component names come out in English.
        </p>
        <div className="flex items-end gap-2">
          <Field label="Language you speak">
            <Select value={lang} onChange={(e) => setLang(e.target.value as "ar-SA" | "en-US")} disabled={listening} aria-label="Language you speak">
              <option value="ar-SA">العربية (Arabic)</option>
              <option value="en-US">English</option>
            </Select>
          </Field>
          <Button variant={listening ? "danger" : "primary"} data-voice-toggle icon={listening ? <MicOff size={15} /> : <Mic size={15} />} disabled={!Supported} onClick={toggle}>
            {listening ? "Stop" : "Start speaking"}
          </Button>
          {listening && <span className="mb-2 text-[13px] text-danger animate-pulse">Listening</span>}
        </div>
        {!Supported && (
          <p className="rounded-md bg-signal-soft px-3 py-2 text-[13px]" data-voice-unsupported>
            This browser cannot take dictation. Chrome and Edge can; here, type the description instead.
          </p>
        )}
        <Field label="What you said">
          <Textarea
            rows={7}
            dir="auto"
            value={text + (interim ? ` ${interim}` : "")}
            onChange={(e) => setText(e.target.value)}
            aria-label="What you said"
            placeholder="For example: the customers use the mobile app, which calls the payments gateway; the gateway stores transactions in the core banking database."
          />
        </Field>
        {problem && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {problem}
          </p>
        )}
      </div>
    </Modal>
  );
}

/* ---------- 09 archive ---------- */

/** The archived diagrams; each can be restored, with a reason that is kept. */
export function ArchivedDialog({ ws, onClose, onRestored }: { ws: Workspace; onClose: () => void; onRestored?: (diagramId: string) => void }) {
  const me = useMe();
  const canEdit = useCanEdit();
  const rankIn = useCategoryRank();
  const [restoring, setRestoring] = useState<Diagram | null>(null);
  const [reason, setReason] = useState("");
  const list = archivedDiagrams(ws);
  if (restoring)
    return (
      <Modal
        title={`Restore "${restoring.name}"`}
        onClose={() => setRestoring(null)}
        footer={
          <>
            <Button onClick={() => setRestoring(null)}>Cancel</Button>
            <Button
              variant="primary"
              data-restore-confirm
              icon={<ArchiveRestore size={15} />}
              disabled={!reason.trim()}
              onClick={() => {
                apply((w) => restoreDiagram(w, restoring.id, me.name, reason));
                const id = restoring.id;
                setRestoring(null);
                setReason("");
                onRestored?.(id);
              }}
            >
              Restore
            </Button>
          </>
        }
      >
        <Field label="Why is it coming back?" hint="Kept with the diagram, next to why it was archived.">
          <Textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason for restoring" maxLength={500} />
        </Field>
      </Modal>
    );
  return (
    <Modal title="Archived diagrams" width={640} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {list.length === 0 ? (
        <p className="text-ink-soft" data-archived-empty>
          No diagram is archived. Archive one from its row in the list or from its settings; it leaves the lists but nothing is deleted.
        </p>
      ) : (
        <ul className="divide-y divide-line-soft" data-archived-list>
          {list.map((d) => {
            const last = d.archive!.history.filter((h) => h.action === "archived").at(-1);
            return (
              <li key={d.id} className="py-2.5 flex items-start gap-3" data-archived={d.id}>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{d.name}</span>
                  <span className="ml-2 text-xs text-ink-faint">{VIEW_TYPE_INFO[d.viewType].label}</span>
                  {last && (
                    <span className="block text-[13px] text-ink-soft">
                      Archived by {last.by} on {formatDate(last.at)}: {last.reason}
                    </span>
                  )}
                </span>
                {canEdit && rankIn(viewCategory(d.viewType)) >= 3 && (
                  <Button size="sm" icon={<ArchiveRestore size={14} />} data-restore={d.id} onClick={() => setRestoring(d)}>
                    Restore
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

/** Archiving a diagram: it leaves the lists, nothing is deleted, and the reason is kept. */
export function ArchiveDialog({ diagram, onClose, onDone }: { diagram: Diagram; onClose: () => void; onDone?: () => void }) {
  const me = useMe();
  const [reason, setReason] = useState("");
  return (
    <Modal
      title={`Archive "${diagram.name}"`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            data-archive-confirm
            icon={<Archive size={15} />}
            disabled={!reason.trim()}
            onClick={() => {
              apply((w) => archiveDiagram(w, diagram.id, me.name, reason));
              onClose();
              onDone?.();
            }}
          >
            Archive
          </Button>
        </>
      }
    >
      <p className="text-ink-soft mb-3">The diagram leaves the lists and search. Its objects stay in the model, and it can be restored from New diagram, Archived diagrams.</p>
      <Field label="Why is it being archived?">
        <Textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason for archiving" maxLength={500} />
      </Field>
    </Modal>
  );
}
