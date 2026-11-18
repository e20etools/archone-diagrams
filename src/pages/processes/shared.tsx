import { FileUp, GraduationCap, LayoutTemplate, Mic, MicOff, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { TypeIcon } from "@/components/icons";
import { Badge, Button, Field, IconButton, Input, Modal, Select, Tabs, Textarea, cx } from "@/components/ui";
import { AiError, draftProcess, draftProcessFromImage, imageFromFile } from "@/lib/ai/client";
import { objectType } from "@/lib/catalog";
import { useSession } from "@/lib/cloud/session";
import { buildBpmn } from "@/lib/bpm/bpmn";
import { draftElements, type ProcessDraft } from "@/lib/bpm/draft";
import { PROCESS_FILE_ACCEPT, readProcessFile, type ProcessFile } from "@/lib/bpm/fromFile";
import { TRAINING_EXAMPLES, TRAINING_TAG, exampleDescription, fromExample } from "@/lib/bpm/training";
import { DICTATION_LANGUAGES, useDictation } from "@/lib/dictation";
import { CATEGORY_LABEL, LEVEL_LABEL, STATUS_LABEL, createProcess, descendantsOf, pathOf } from "@/lib/bpm/processes";
import { PROCESS_TEMPLATES, fromTemplate } from "@/lib/bpm/templates";
import { sortedObjects } from "@/lib/model";
import { apply, useStore, useWorkspace } from "@/lib/store";
import type { ProcessModel, Workspace } from "@/lib/types";

const STATUS_TONE = { draft: "neutral", review: "amber", published: "green", retired: "neutral" } as const;

export function StatusBadge({ process }: { process: Pick<ProcessModel, "status" | "version"> }) {
  return (
    <Badge tone={STATUS_TONE[process.status]} title={process.version ? `Last published as version ${process.version}` : "Not published yet"}>
      {STATUS_LABEL[process.status]}
      {process.status === "published" && process.version ? ` v${process.version}` : ""}
    </Badge>
  );
}

export function useAuthor(): string {
  const local = useWorkspace().userName.trim();
  const user = useSession((s) => s.user);
  return local || user?.name || user?.email || "Unnamed";
}

/** Processes a process may sit inside: any above its level that is not itself or inside it. */
export function parentOptions(ws: Workspace, id: string | null, level: number): ProcessModel[] {
  const blocked = new Set(id ? [id, ...descendantsOf(ws, id)] : []);
  return Object.values(ws.processes)
    .filter((p) => p.level < level && !blocked.has(p.id))
    .sort((a, b) => pathLabel(ws, a.id).localeCompare(pathLabel(ws, b.id)));
}

export const pathLabel = (ws: Workspace, id: string) =>
  pathOf(ws, id)
    .map((p) => p.name)
    .join(" / ");

export const minutesLabel = (m: number | null | undefined) => {
  if (m === null || m === undefined || !Number.isFinite(m)) return "–";
  if (m < 1) return `${Math.round(m * 60)} s`;
  if (m < 90) return `${Math.round(m)} min`;
  if (m < 60 * 36) return `${(m / 60).toFixed(m < 600 ? 1 : 0)} h`;
  return `${(m / 1440).toFixed(1)} days`;
};
export const hoursLabel = (h: number | null | undefined) => (h === null || h === undefined ? "–" : minutesLabel(h * 60));
export const percent = (x: number) => `${Math.round(x * 100)}%`;

type Way = "blank" | "template" | "describe" | "import";

const FILE_SAYS: Record<string, string> = {
  word: "a Word document",
  slides: "a PowerPoint deck",
  text: "a text",
  sheet: "a spreadsheet of steps",
};

/** The ways to start a process: blank, from a template or a training example, from words (typed or spoken), or from a file or a picture. */
export function NewProcessDialog({ onClose, parentId, start = "blank" }: { onClose: () => void; parentId?: string | null; start?: Way }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [way, setWay] = useState<Way>(start);
  const parent = parentId ? ws.processes[parentId] : undefined;
  const [name, setName] = useState("");
  const [level, setLevel] = useState(parent ? Math.min(4, parent.level + 1) : 2);
  const [parentChoice, setParentChoice] = useState(parent?.id ?? "");
  const [category, setCategory] = useState<ProcessModel["category"]>(parent?.category ?? "core");
  const [template, setTemplate] = useState(PROCESS_TEMPLATES[0].id);
  const [description, setDescription] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [file, setFile] = useState<ProcessFile | null>(null);
  const [preview, setPreview] = useState("");
  const [lang, setLang] = useState<string>(DICTATION_LANGUAGES[0].id);
  const dictation = useDictation((text) => setDescription((d) => `${d}${d && !/\s$/.test(d) ? " " : ""}${text}`));
  const input = useRef<HTMLInputElement>(null);
  const parents = useMemo(() => parentOptions(ws, null, level), [ws, level]);
  const example = template.startsWith("training:") ? TRAINING_EXAMPLES.find((t) => `training:${t.id}` === template) : undefined;
  const chosen = example ?? PROCESS_TEMPLATES.find((t) => t.id === template);

  useEffect(() => () => (preview ? URL.revokeObjectURL(preview) : undefined), [preview]);

  const finish = (made: { ws: Workspace; process: ProcessModel }, said?: string) => {
    apply(() => made.ws);
    onClose();
    navigate(`/processes/${made.process.id}${said ? `?drafted=${encodeURIComponent(said.slice(0, 600))}` : ""}`);
  };
  const base = () => ({ parentId: parentChoice || null, category, level: Math.max(2, level) });
  /** A drafted process, made and opened, with a word on how it was drafted. */
  const drafted = (draft: ProcessDraft, from: string, how: string) => {
    const spec = { ...draft.spec, name: name.trim() || draft.spec.name };
    finish(createProcess(useStore.getState().ws, { ...base(), name: spec.name, description: from.trim().slice(0, 1500), xml: buildBpmn(spec), elements: draftElements(draft) }), how);
  };
  const byWords = async (text: string, source: string) => {
    const { draft, engine, usedRules } = await draftProcess(text);
    drafted(draft, source, usedRules ? draft.notes || "Drafted with the built-in rules. Check the steps, who does them and the decisions." : `Drafted by ${engine}. ${draft.notes || "Check the steps, who does them and the decisions."}`);
  };

  const create = async () => {
    setProblem("");
    const current = useStore.getState().ws;
    if (way === "blank") return finish(createProcess(current, { ...base(), level, name }));
    if (way === "template") {
      if (example) {
        const made = fromExample(example);
        return finish(createProcess(current, { ...base(), name: name.trim() || example.name, description: exampleDescription(example), category: parentChoice ? category : "support", tags: [TRAINING_TAG, example.id], ...made }));
      }
      const t = PROCESS_TEMPLATES.find((x) => x.id === template)!;
      return finish(createProcess(current, { ...base(), name: name.trim() || t.name, description: t.description, category: parentChoice ? category : t.category, ...fromTemplate(t) }));
    }
    setBusy(true);
    try {
      if (way === "describe") {
        if (description.trim().length < 10) return setProblem("Describe the process in a few sentences or one step per line, or speak it.");
        return await byWords(description, description);
      }
      if (!file) return setProblem("Choose a file or a picture first.");
      if (file.kind === "bpmn") return finish(createProcess(current, { ...base(), name: name.trim() || file.title, xml: file.xml }));
      if (file.kind === "diagram") {
        const spec = { ...file.spec, name: name.trim() || file.spec.name };
        return finish(createProcess(current, { ...base(), name: spec.name, description: `Read from the flowchart ${file.name}.`, xml: buildBpmn(spec) }), `Read from ${file.name}: ${file.shapes} shapes became steps and ${file.flows} arrows became flows. Diamonds became decisions and circles events; check the kinds of the steps.`);
      }
      if (file.kind === "words") return await byWords(`${note.trim() ? `${note.trim()}\n\n` : ""}${file.text}`, `Drafted from ${file.name}.`);
      if (file.kind === "image") {
        const image = await imageFromFile(file.file);
        const { draft, engine } = await draftProcessFromImage(image, note);
        return drafted(draft, `Read from the picture ${file.name}.`, `Read from ${file.name} by ${engine}. ${draft.notes || "Check the steps, who does them and the decisions."}`);
      }
      // A PDF: its first page as a picture, with its text, for the AI model; without one, its text alone.
      const { readPdf } = await import("@/lib/bpm/pdf");
      const pdf = await readPdf(file.file);
      const words = `${note.trim() ? `${note.trim()}\n\n` : ""}${pdf.text}`;
      if (pdf.image) {
        try {
          const { draft, engine } = await draftProcessFromImage(pdf.image, words);
          return drafted(draft, `Read from ${file.name}.`, `Read from ${file.name} (${pdf.pages} ${pdf.pages === 1 ? "page" : "pages"}) by ${engine}. ${draft.notes || "Check the steps, who does them and the decisions."}`);
        } catch (error) {
          if (!(error instanceof AiError && error.code === "not_configured") || pdf.text.trim().length < 10) throw error;
        }
      }
      if (pdf.text.trim().length < 10) return setProblem("This PDF holds no text to read, and reading its pages as pictures needs an AI model.");
      return await byWords(words, `Drafted from the text of ${file.name}.`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The draft failed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const readFile = async (f: File) => {
    setProblem("");
    setFile(null);
    setPreview("");
    try {
      const read = await readProcessFile(f);
      setFile(read);
      if (read.kind === "image") setPreview(URL.createObjectURL(f));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The file could not be read.");
    }
  };

  const ways: { id: Way; label: string }[] = [
    { id: "blank", label: "Blank" },
    { id: "template", label: "From a template" },
    { id: "describe", label: "Describe or speak it" },
    { id: "import", label: "From a file or picture" },
  ];
  const drafting = way === "describe" || (way === "import" && !!file && file.kind !== "bpmn" && file.kind !== "diagram");
  const action = busy ? "Drafting…" : drafting ? "Draft the process" : way === "import" ? "Import" : "Create";

  return (
    <Modal
      title="New process"
      onClose={onClose}
      width={680}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || (way === "import" && !file)} onClick={() => void create()} data-process-create>
            {action}
          </Button>
        </>
      }
    >
      <Tabs tabs={ways} value={way} onChange={setWay} />
      <div className="mt-4 space-y-3">
        {way === "template" && (
          <>
            <ul className="grid gap-2 sm:grid-cols-2" data-process-templates>
              {PROCESS_TEMPLATES.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setTemplate(t.id)}
                    aria-pressed={template === t.id}
                    className={cx("w-full h-full text-left rounded-md border px-3 py-2", template === t.id ? "border-blueprint bg-blueprint-soft" : "border-line hover:border-ink-faint")}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <LayoutTemplate size={14} className="text-ink-faint" aria-hidden />
                      {t.name}
                    </span>
                    <span className="block mt-0.5 text-[13px] text-ink-soft leading-snug">{t.description}</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="flex items-center gap-1.5 pt-1 text-[13px] font-medium">
              <GraduationCap size={14} className="text-blueprint" aria-hidden /> Training examples: one part of BPMN each
            </p>
            <ul className="grid gap-2 sm:grid-cols-2" data-process-training>
              {TRAINING_EXAMPLES.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setTemplate(`training:${t.id}`)}
                    aria-pressed={template === `training:${t.id}`}
                    className={cx("w-full h-full text-left rounded-md border px-3 py-1.5", template === `training:${t.id}` ? "border-blueprint bg-blueprint-soft" : "border-line hover:border-ink-faint")}
                    data-process-training-example={t.id}
                  >
                    <span className="block font-medium">{t.name}</span>
                    <span className="block text-[13px] text-ink-soft leading-snug">{t.topic}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {way === "describe" && (
          <Field label="What happens, step by step" hint={'Type or speak it. One step per line works best. Say who does a step with "Role: step" or "step (Role)", and a decision with "If ..., ...; otherwise ...". With an AI model, plain prose in any language works too.'}>
            <Textarea
              rows={7}
              dir="auto"
              value={description}
              maxLength={12000}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={"Customer service: register the complaint\nIf it can be answered at once, answer the customer; otherwise investigate it (Specialist team)\nClose the complaint"}
              data-process-description
            />
            {dictation.supported && (
              <div className="mt-2 flex flex-wrap items-center gap-2" data-process-dictation>
                <Button size="sm" variant={dictation.listening ? "danger" : "secondary"} icon={dictation.listening ? <MicOff size={14} /> : <Mic size={14} />} onClick={() => dictation.toggle(lang)} data-process-speak>
                  {dictation.listening ? "Stop" : "Speak it"}
                </Button>
                <div className="w-32">
                  <Select value={lang} disabled={dictation.listening} onChange={(e) => setLang(e.target.value)} aria-label="Language spoken">
                    {DICTATION_LANGUAGES.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.label}
                      </option>
                    ))}
                  </Select>
                </div>
                {dictation.listening && (
                  <span className="text-[13px] text-ink-soft" dir="auto">
                    {dictation.hearing || "Listening…"}
                  </span>
                )}
              </div>
            )}
            {dictation.problem && <p className="mt-1 text-[13px] text-danger">{dictation.problem}</p>}
          </Field>
        )}
        {way === "import" && (
          <div className="space-y-2">
            <input ref={input} type="file" accept={PROCESS_FILE_ACCEPT} className="sr-only" onChange={(e) => e.target.files?.[0] && void readFile(e.target.files[0])} data-process-file />
            <Button icon={<FileUp size={15} />} onClick={() => input.current?.click()}>
              Choose a file or a picture
            </Button>
            {file ? (
              <div className="rounded-md border border-line bg-paper px-3 py-2 text-[13px]" data-process-file-read={file.kind}>
                {file.kind === "bpmn" && (
                  <p>
                    <span className="font-medium">{file.title}</span> <span className="text-ink-soft">from {file.name}, with {file.steps} steps: imported as it is.</span>
                  </p>
                )}
                {file.kind === "diagram" && (
                  <p>
                    A {file.source === "drawio" ? "draw.io" : "Visio"} flowchart: <span className="font-medium">{file.shapes} shapes</span> become steps and <span className="font-medium">{file.flows} arrows</span> flows
                    {file.spec.lanes?.length ? `, in ${file.spec.lanes.length} lanes (${file.spec.lanes.join(", ")})` : ""}. Diamonds become decisions and circles events.
                  </p>
                )}
                {file.kind === "words" && (
                  <p>
                    {FILE_SAYS[file.source]} with {file.text.split(/\s+/).length} words. They go to the AI model set up for this workspace, or the built-in rules, to draft the process.
                  </p>
                )}
                {file.kind === "image" && (
                  <div className="flex items-start gap-3">
                    {preview && <img src={preview} alt="" className="h-24 w-auto max-w-[180px] rounded border border-line object-contain bg-surface" />}
                    <p>A picture. The AI model reads its boxes, arrows and lanes and drafts the process: a BPMN diagram, a flowchart, a whiteboard or a hand drawing.</p>
                  </div>
                )}
                {file.kind === "pdf" && <p>A PDF. Its first page goes to the AI model as a picture, with the text of its pages; without an AI model, its text is drafted by the built-in rules.</p>}
              </div>
            ) : (
              <p className="text-[13px] text-ink-soft">
                A BPMN file from Camunda, Signavio, ARIS, Bizagi or Visio; a draw.io or Visio flowchart; a picture or a PDF of a process; a Word or PowerPoint document, a text or a spreadsheet of steps. The file is read here, in the browser.
              </p>
            )}
            {file && file.kind !== "bpmn" && file.kind !== "diagram" && (
              <Field label="Anything the AI model should know" hint="The lanes, what to leave out, the language of the names.">
                <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} dir="auto" data-process-note />
              </Field>
            )}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={way === "template" ? chosen?.name : way === "import" ? (file?.kind === "bpmn" ? file.title : file?.kind === "diagram" ? file.spec.name : "From the file") : "Handle a customer complaint"}
              maxLength={200}
              data-process-name
            />
          </Field>
          <Field label="Level">
            <Select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
              {LEVEL_LABEL.map((l, i) => (
                <option key={l} value={i} disabled={way !== "blank" && i < 2}>
                  {`L${i} · ${l}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Kind of process">
            <Select value={category} onChange={(e) => setCategory(e.target.value as ProcessModel["category"])}>
              {Object.entries(CATEGORY_LABEL).map(([id, l]) => (
                <option key={id} value={id}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Inside" className="sm:col-span-2">
            <Select value={parentChoice} onChange={(e) => setParentChoice(e.target.value)}>
              <option value="">Nothing: at the top of the landscape</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {pathLabel(ws, p.id)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {drafting && (
          <p className="flex items-center gap-1.5 text-[13px] text-ink-soft">
            <Sparkles size={14} aria-hidden /> {way === "describe" ? "The description goes" : "What the file holds goes"} to the AI model set up for this workspace, if there is one; otherwise the built-in rules draft it here. Pictures need the AI model.
          </p>
        )}
        {problem && (
          <p className="text-[13px] text-danger" role="alert">
            {problem}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** Model objects linked to a step, and a way to link more. */
export function ObjectPicker({ ws, ids, onChange, canEdit, label = "Link a system, data or team" }: { ws: Workspace; ids: string[]; onChange: (ids: string[]) => void; canEdit: boolean; label?: string }) {
  const [query, setQuery] = useState("");
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return sortedObjects(ws)
      .filter((o) => !ids.includes(o.id) && o.typeId !== "process" && o.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [ws, ids, query]);
  return (
    <div>
      {ids.filter((id) => ws.objects[id]).length > 0 && (
        <ul className="flex flex-wrap gap-1.5 mb-2">
          {ids
            .filter((id) => ws.objects[id])
            .map((id) => (
              <li key={id} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface pl-2 pr-1 h-7 text-[13px]">
                <TypeIcon typeId={ws.objects[id].typeId} componentId={ws.objects[id].componentId} size={14} />
                <span title={objectType(ws.objects[id].typeId).label}>{ws.objects[id].name}</span>
                {canEdit && (
                  <IconButton label={`Unlink ${ws.objects[id].name}`} className="size-6" onClick={() => onChange(ids.filter((x) => x !== id))}>
                    <X size={13} />
                  </IconButton>
                )}
              </li>
            ))}
        </ul>
      )}
      {canEdit && (
        <div className="relative">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={label} aria-label={label} data-step-object-search />
          {candidates.length > 0 && (
            <ul className="absolute z-20 mt-1 w-full rounded-md border border-line bg-surface shadow-lg py-1">
              {candidates.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-line-soft"
                    onClick={() => {
                      onChange([...ids, o.id]);
                      setQuery("");
                    }}
                  >
                    <TypeIcon typeId={o.typeId} componentId={o.componentId} size={14} />
                    <span className="truncate">{o.name}</span>
                    <span className="ml-auto text-xs text-ink-faint">{objectType(o.typeId).label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

