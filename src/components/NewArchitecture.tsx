import {
  AppWindow,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Check,
  CircleCheck,
  Database,
  Lock,
  Search,
  Server,
  Shapes,
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
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { AiDraftDialog } from "@/components/dialogs";
import { ImportDialog, type DiagramStart } from "@/components/ImportDialog";
import { TemplatePicker, TemplatePreview } from "@/components/TemplatePicker";
import { Button, Field, Input, Modal, Select, Textarea, cx, formatDate } from "@/components/ui";
import { CATEGORIES as AREAS, CATEGORY_INFO as AREA_INFO, VIEWS_BY_CATEGORY, viewCategory, type Category } from "@/lib/categories";
import { VIEW_TYPE_INFO, objectType } from "@/lib/catalog";
import { useCanEdit, useCategoryRank } from "@/lib/cloud/session";
import { useMe } from "@/lib/cloud/me";
import { componentById } from "@/lib/library";
import { archiveDiagram, archivedDiagrams, copyDiagram, restoreDiagram, sortedObjects } from "@/lib/model";
import { addView, apply } from "@/lib/store";
import { allTemplates, applyTemplateValue, type Perspective } from "@/lib/templates";
import { VIEW_TYPES, type Diagram, type ViewType, type Workspace } from "@/lib/types";
import { suggestObjects } from "@/lib/views";
import { componentFor, stepComponents, wizardProblem, wizardSteps, wizardTemplate, type WizardAnswers } from "@/lib/wizard";

/**
 * Starting a new diagram: first what it shows (its kind, within a category), then how to build
 * it. Every way ends in a diagram of that kind and name; the ways that bring in something new
 * (AI, voice, files) go through a draft that is reviewed before anything is saved.
 */

type Way = "manual" | "wizard" | "existing" | "template" | "text" | "voice" | "import" | "archived";

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
      {
        id: "import",
        n: "07",
        title: "Import architecture",
        text: "draw.io, Visio, Excel, Mermaid, Structurizr or ArchiMate. Shapes that are exactly a library component become it; no AI.",
        icon: <FileUp size={18} />,
      },
      { id: "archived", n: "08", title: "Archived diagrams", text: "See archived diagrams and restore one, with a reason.", icon: <Archive size={18} /> },
    ],
  },
];

const PERSPECTIVE_OF: Record<string, Perspective | null> = { applications: "applications", data: "data", infrastructure: "infrastructure", business: "business", custom: null };

export function NewArchitectureDialog({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const navigate = useNavigate();
  const rankIn = useCategoryRank();
  const [stage, setStage] = useState<"kind" | "ways">("kind");
  const [way, setWay] = useState<Way | "image" | null>(null);
  const [viewType, setViewTypeState] = useState<ViewType>(() => {
    const offered = AREAS.filter((a) => rankIn(a) >= 3).flatMap((a) => VIEWS_BY_CATEGORY[a]);
    // The kind chosen last time comes first, when the person may still create it.
    const remembered = rememberedKind();
    const preferred: ViewType = remembered ?? (Object.keys(ws.objects).length ? "landscape" : "custom");
    return offered.includes(preferred) ? preferred : (offered[0] ?? preferred);
  });
  const [area, setArea] = useState<Category>(() => viewCategory(viewType));
  const [scopeId, setScopeId] = useState("");
  const [typedName, setTypedName] = useState<string | null>(null);
  const [chosenDirection, setChosenDirection] = useState<"TB" | "LR" | null>(null);
  const needsScope = viewType === "context" || viewType === "container";
  const scopes = sortedObjects(ws).filter((o) => objectType(o.typeId).level <= 3);
  const scopeName = needsScope && scopeId ? ws.objects[scopeId]?.name : undefined;
  // The name follows the kind and the system until the person types one of their own.
  const suggestedName = suggestName(viewType, scopeName);
  const name = typedName ?? suggestedName;
  // A diagram is not made without a name.
  const ready = (!needsScope || !!scopeId) && rankIn(viewCategory(viewType)) >= 3 && name.trim().length > 0;
  const direction = chosenDirection ?? (viewType === "business" || viewType === "deployment" ? "LR" : "TB");
  const fallbackName = suggestedName;
  const setViewType = (next: ViewType) => {
    setViewTypeState(next);
    setArea(viewCategory(next));
  };
  const start: DiagramStart = { name: name.trim(), viewType, scopeId: needsScope ? scopeId : null };
  const named: DiagramStart = { ...start, name: start.name.trim() };
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
  if (way === "archived") return <ArchivedDialog ws={ws} onClose={back} onRestored={open} />;

  const next = () => {
    if (!ready) return;
    rememberKind(viewType);
    setStage("ways");
  };

  if (stage === "kind") {
    const allowedHere = rankIn(area) >= 3;
    const startsWith = !ready ? null : viewType === "custom" ? 0 : suggestObjects(ws, viewType, needsScope ? scopeId : null).length;
    const moveKind = (step: number) => {
      const kinds = VIEWS_BY_CATEGORY[area];
      const at = kinds.indexOf(viewType);
      const target = kinds[(Math.max(at, 0) + step + kinds.length) % kinds.length];
      if (allowedHere && target) {
        setViewType(target);
        document.querySelector<HTMLElement>(`[data-view-type="${target}"]`)?.focus();
      }
    };
    const moveArea = (step: number) => {
      const target = AREAS[(AREAS.indexOf(area) + step + AREAS.length) % AREAS.length];
      pickArea(target);
      document.querySelector<HTMLElement>(`[data-view-category="${target}"]`)?.focus();
    };
    const pickArea = (target: Category) => {
      setArea(target);
      if (rankIn(target) >= 3 && viewCategory(viewType) !== target) setViewTypeState(VIEWS_BY_CATEGORY[target][0]);
    };
    return (
      <Modal
        title="New diagram"
        width={760}
        onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!ready} data-new-next onClick={next}>
              Next: how to build it
            </Button>
          </>
        }
      >
        <div
          onKeyDown={(e) => {
            if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
              e.preventDefault();
              next();
            }
          }}
        >
          <Steps at={1} />
          <div className="mt-3 grid grid-cols-[176px_minmax(0,1fr)] rounded-lg border border-line overflow-hidden" data-new-kind>
            <div className="border-r border-line bg-paper p-1.5 space-y-0.5" role="tablist" aria-label="Category" aria-orientation="vertical">
              {AREAS.map((a) => {
                const rank = rankIn(a);
                const Icon = AREA_ICON[a];
                return (
                  <button
                    key={a}
                    type="button"
                    role="tab"
                    aria-selected={area === a}
                    tabIndex={area === a ? 0 : -1}
                    data-view-category={a}
                    data-allowed={rank >= 3}
                    onClick={() => pickArea(a)}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown") (e.preventDefault(), moveArea(1));
                      if (e.key === "ArrowUp") (e.preventDefault(), moveArea(-1));
                      if (e.key === "ArrowRight") (e.preventDefault(), document.querySelector<HTMLElement>(`[data-view-type="${viewCategory(viewType) === a ? viewType : VIEWS_BY_CATEGORY[a][0]}"]`)?.focus());
                    }}
                    className={cx(
                      "w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm",
                      area === a ? "bg-blueprint-soft text-blueprint font-medium" : rank >= 3 ? "text-ink hover:bg-surface" : "text-ink-faint hover:bg-surface",
                    )}
                  >
                    <Icon size={16} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{AREA_INFO[a].label}</span>
                    {rank >= 3 ? (
                      <span className="text-xs tabular-nums text-ink-faint">{VIEWS_BY_CATEGORY[a].length}</span>
                    ) : (
                      <span className="flex items-center gap-0.5 text-[11px] text-ink-faint">
                        <Lock size={11} />
                        {rank === 0 ? "no access" : "view only"}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="p-3.5 min-w-0">
              <p className="text-[13px] text-ink-soft">
                {AREA_INFO[area].hint}
              </p>
              {!allowedHere && (
                <p className="mt-2 flex items-start gap-1.5 rounded-md bg-paper border border-line px-3 py-2 text-[13px] text-ink-soft" data-category-locked={area}>
                  <Lock size={14} className="mt-0.5 shrink-0" />
                  {rankIn(area) === 0
                    ? `You have no access to ${AREA_INFO[area].label} diagrams in this workspace.`
                    : `You can view ${AREA_INFO[area].label} diagrams but not create them.`}{" "}
                  Ask an owner if you need to.
                </p>
              )}
              <div role="radiogroup" aria-label="Kind of diagram" className={cx("mt-2.5 grid gap-2", VIEWS_BY_CATEGORY[area].length > 1 ? "grid-cols-3" : "grid-cols-1 max-w-[260px]")}>
                {VIEWS_BY_CATEGORY[area].map((type) => {
                  const on = viewType === type && allowedHere;
                  return (
                    <button
                      key={type}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-disabled={!allowedHere}
                      tabIndex={on || (!allowedHere && type === VIEWS_BY_CATEGORY[area][0]) ? 0 : -1}
                      autoFocus={on}
                      data-view-type={type}
                      disabled={!allowedHere}
                      onClick={() => setViewType(type)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          e.stopPropagation();
                          if (viewType !== type) setViewType(type);
                          else next();
                        }
                        if (e.key === "ArrowRight") (e.preventDefault(), moveKind(1));
                        if (e.key === "ArrowLeft") {
                          e.preventDefault();
                          if (VIEWS_BY_CATEGORY[area].indexOf(type) === 0) document.querySelector<HTMLElement>(`[data-view-category="${area}"]`)?.focus();
                          else moveKind(-1);
                        }
                      }}
                      className={cx(
                        "rounded-lg border bg-surface p-2.5 text-left disabled:cursor-not-allowed disabled:opacity-50",
                        on ? "border-blueprint ring-1 ring-blueprint" : "border-line hover:border-ink-faint",
                      )}
                    >
                      <span className="mb-2 flex h-16 items-center justify-center rounded-md bg-paper">
                        <KindThumb viewType={type} />
                      </span>
                      <span className="block text-[13px] font-medium leading-tight">{KIND_TITLE[type]}</span>
                      <span className="mt-0.5 block text-xs text-ink-soft leading-snug">{VIEW_TYPE_INFO[type].hint}</span>
                    </button>
                  );
                })}
              </div>
              <div className={cx("mt-3.5 grid gap-2.5", needsScope ? "grid-cols-2" : "grid-cols-1")}>
                {needsScope && (
                  <SystemField
                    ws={ws}
                    options={scopes}
                    value={scopeId}
                    onChange={setScopeId}
                  />
                )}
                <label className="block min-w-0">
                  <span className="block text-xs text-ink-soft mb-1">
                    Name <span className="text-danger">*</span>
                  </span>
                  <Input value={name} onChange={(e) => setTypedName(e.target.value)} aria-label="Diagram name" aria-required="true" aria-invalid={!name.trim()} placeholder={fallbackName} maxLength={300} />
                  {!name.trim() && (
                    <span className="mt-0.5 block text-xs text-danger" data-name-required>
                      Enter a name for the diagram.
                    </span>
                  )}
                </label>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2.5">
                <span className="text-xs text-ink-soft">Direction</span>
                <span className="inline-flex rounded-md border border-line overflow-hidden" role="radiogroup" aria-label="Layout direction">
                  {(
                    [
                      ["TB", "Down", ArrowDown],
                      ["LR", "Across", ArrowRight],
                    ] as const
                  ).map(([value, label, Icon]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={direction === value}
                      data-direction={value}
                      onClick={() => setChosenDirection(value)}
                      className={cx("flex items-center gap-1 px-3 py-1.5 text-[13px]", direction === value ? "bg-blueprint-soft text-blueprint font-medium" : "text-ink-soft hover:bg-paper")}
                    >
                      <Icon size={13} />
                      {label}
                    </button>
                  ))}
                </span>
                <span
                  className={cx(
                    "ml-auto flex items-center gap-1 rounded-md px-2.5 py-1 text-xs",
                    startsWith === null ? "bg-paper text-ink-soft" : startsWith > 0 ? "bg-ok-soft text-ok" : "bg-paper text-ink-soft",
                  )}
                  data-starts-with={startsWith ?? ""}
                >
                  {startsWith === null ? (
                    needsScope && !scopeId ? "Choose a system first" : "Pick a kind you may create"
                  ) : startsWith > 0 ? (
                    <>
                      <CircleCheck size={13} />
                      Starts with {startsWith} {startsWith === 1 ? "object" : "objects"} from your model
                    </>
                  ) : (
                    "Starts empty: you add the components"
                  )}
                </span>
              </div>
            </div>
          </div>
        </div>
      </Modal>
    );
  }

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
      <Steps at={2} />
      <p className="text-ink-soft mt-3 mb-3">
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

const AREA_ICON: Record<Category, typeof AppWindow> = { applications: AppWindow, data: Database, infrastructure: Server, business: Briefcase, custom: Shapes };

/** Titles on the cards: the category names the C4 views, so the card can be short. */
const KIND_TITLE: Record<ViewType, string> = {
  landscape: "System landscape",
  context: "Level 1: System context",
  container: "Level 2: Containers",
  dataflow: "Data flows",
  deployment: "Infrastructure and hosting",
  business: "Business process",
  custom: "Free canvas",
};

export function suggestName(viewType: ViewType, scopeName?: string): string {
  if (scopeName && viewType === "context") return `${scopeName}: system context`;
  if (scopeName && viewType === "container") return `${scopeName}: containers`;
  return { landscape: "System landscape", context: "System context", container: "Containers", dataflow: "Data flows", deployment: "Infrastructure", business: "Business process", custom: "New diagram" }[viewType];
}

const KIND_KEY = "archone.lastKind";
function rememberedKind(): ViewType | null {
  try {
    const v = localStorage.getItem(KIND_KEY);
    return VIEW_TYPES.includes(v as ViewType) ? (v as ViewType) : null;
  } catch {
    return null;
  }
}
function rememberKind(v: ViewType) {
  try {
    localStorage.setItem(KIND_KEY, v);
  } catch {
    // Not remembered; the next dialog starts from the usual kind.
  }
}

function Steps({ at }: { at: 1 | 2 }) {
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label="Steps" data-new-steps={at}>
      {["What it shows", "How to build it"].map((label, i) => (
        <li key={label} className={cx("flex items-center gap-1.5 rounded-full px-2.5 py-1", i + 1 === at ? "bg-blueprint-soft text-blueprint font-medium" : "text-ink-faint")} aria-current={i + 1 === at ? "step" : undefined}>
          <span className={cx("grid h-4 w-4 place-items-center rounded-full text-[10px]", i + 1 === at ? "bg-blueprint text-white" : i + 1 < at ? "bg-blueprint-soft text-blueprint" : "border border-line")}>
            {i + 1 < at ? <Check size={10} /> : i + 1}
          </span>
          {label}
        </li>
      ))}
    </ol>
  );
}

/** A picture of what each kind of diagram looks like, so the choice is made by eye. */
function KindThumb({ viewType }: { viewType: ViewType }) {
  const main = "stroke-blueprint";
  const quiet = "stroke-ink-faint";
  const data = "stroke-ok";
  const box = (x: number, y: number, w: number, h: number, cls: string, extra = {}) => <rect x={x} y={y} width={w} height={h} rx={3} fill="none" className={cls} strokeWidth={1.3} {...extra} />;
  const line = (d: string) => <path d={d} fill="none" className={quiet} strokeWidth={1.1} />;
  const shapes: Record<ViewType, ReactNode> = {
    landscape: (
      <>
        {box(4, 6, 26, 13, main)}
        {box(37, 6, 26, 13, main)}
        {box(70, 6, 26, 13, main)}
        <circle cx={50} cy={36} r={5} fill="none" className={quiet} strokeWidth={1.3} />
        {line("M47 31 L22 19 M50 31 L50 19 M53 31 L78 19")}
      </>
    ),
    context: (
      <>
        {box(34, 15, 32, 15, main, { strokeWidth: 2 })}
        {box(3, 4, 22, 11, quiet)}
        {box(75, 4, 22, 11, quiet)}
        {box(75, 30, 22, 11, quiet)}
        {line("M25 10 L34 19 M66 19 L75 10 M66 26 L75 35")}
      </>
    ),
    container: (
      <>
        <rect x={4} y={3} width={92} height={38} rx={4} fill="none" className={main} strokeWidth={1.2} strokeDasharray="3 2" />
        {box(12, 15, 20, 12, main)}
        {box(40, 15, 20, 12, main)}
        {box(68, 15, 20, 12, data)}
        {line("M32 21 L40 21 M60 21 L68 21")}
      </>
    ),
    dataflow: (
      <>
        {box(6, 14, 22, 14, main)}
        <ellipse cx={74} cy={13} rx={12} ry={4} fill="none" className={data} strokeWidth={1.3} />
        <path d="M62 13 V31 A12 4 0 0 0 86 31 V13" fill="none" className={data} strokeWidth={1.3} />
        {line("M28 21 L62 21")}
        <path d="M58 18 L62 21 L58 24" fill="none" className={quiet} strokeWidth={1.1} />
      </>
    ),
    deployment: (
      <>
        <rect x={34} y={4} width={62} height={36} rx={4} fill="none" className={quiet} strokeWidth={1.3} />
        {box(42, 12, 20, 11, main)}
        {box(68, 12, 20, 11, main)}
        {box(55, 27, 20, 9, data)}
        {box(4, 16, 18, 12, quiet)}
        {line("M22 22 L34 22")}
      </>
    ),
    business: (
      <>
        <circle cx={9} cy={22} r={5} fill="none" className={quiet} strokeWidth={1.3} />
        {box(20, 15, 22, 14, main, { rx: 6 })}
        <path d="M54 14 L62 22 L54 30 L46 22 Z" fill="none" className={main} strokeWidth={1.3} />
        {box(68, 15, 18, 14, main, { rx: 6 })}
        <circle cx={93} cy={22} r={4.5} fill="none" className={quiet} strokeWidth={2} />
        {line("M14 22 L20 22 M42 22 L46 22 M62 22 L68 22 M86 22 L88 22")}
      </>
    ),
    custom: (
      <>
        <rect x={6} y={4} width={88} height={36} rx={4} fill="none" className={quiet} strokeWidth={1.1} strokeDasharray="2 3" />
        <path d="M50 15 V29 M43 22 H57" fill="none" className={main} strokeWidth={1.6} />
      </>
    ),
  };
  return (
    <svg width={100} height={44} viewBox="0 0 100 44" aria-hidden="true">
      {shapes[viewType]}
    </svg>
  );
}

/** The system a C4 Level 1 or 2 diagram is about, found by typing part of its name. */
function SystemField({ ws, options, value, onChange }: { ws: Workspace; options: ReturnType<typeof sortedObjects>; value: string; onChange: (id: string) => void }) {
  const [text, setText] = useState(value ? (ws.objects[value]?.name ?? "") : "");
  const listId = "new-diagram-systems";
  return (
    <label className="block min-w-0">
      <span className="block text-xs text-ink-soft mb-1">Which system</span>
      <span className="relative block">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
        <Input
          className="pl-8"
          list={listId}
          value={text}
          aria-label="Which system"
          placeholder={options.length ? "Type to find a system" : "Create an object first"}
          onChange={(e) => {
            setText(e.target.value);
            const exact = options.find((o) => o.name.toLowerCase() === e.target.value.trim().toLowerCase());
            onChange(exact?.id ?? "");
          }}
        />
      </span>
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o.id} value={o.name}>
            {objectType(o.typeId).label}
          </option>
        ))}
      </datalist>
      {text && !value && <span className="mt-0.5 block text-xs text-danger">No object with that name. Pick one from the list.</span>}
    </label>
  );
}

/* ---------- 02 wizard ---------- */

function WizardDialog({ ws, start, onBack, onDone }: { ws: Workspace; start: DiagramStart; onBack: () => void; onDone: (diagramId: string) => void }) {
  const steps = wizardSteps(start.viewType, ws);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<WizardAnswers>((): WizardAnswers => {
    // A diagram of one system starts from that system.
    const scope = start.scopeId ? ws.objects[start.scopeId] : null;
    return scope && steps[0]?.id === "system" ? { system: [{ name: scope.name, componentId: scope.componentId }] } : {};
  });
  const review = index === steps.length;
  const step = steps[index];
  const template = useMemo(() => wizardTemplate(start.viewType, start.name, answers, ws), [start, answers, ws]);
  const problem = wizardProblem(start.viewType, answers, ws);
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
