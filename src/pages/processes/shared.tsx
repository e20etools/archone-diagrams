import { FileUp, LayoutTemplate, Sparkles, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { TypeIcon } from "@/components/icons";
import { Badge, Button, Field, IconButton, Input, Modal, Select, Tabs, Textarea, cx } from "@/components/ui";
import { draftProcess } from "@/lib/ai/client";
import { objectType } from "@/lib/catalog";
import { useSession } from "@/lib/cloud/session";
import { buildBpmn, parseBpmn } from "@/lib/bpm/bpmn";
import { draftElements } from "@/lib/bpm/draft";
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

/** The ways to start a process: blank, from a template, from a description, or from a BPMN file. */
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
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [file, setFile] = useState<{ name: string; xml: string; title: string; steps: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const parents = useMemo(() => parentOptions(ws, null, level), [ws, level]);

  const finish = (made: { ws: Workspace; process: ProcessModel }) => {
    apply(() => made.ws);
    onClose();
    navigate(`/processes/${made.process.id}`);
  };
  const base = () => ({ parentId: parentChoice || null, category, level });

  const create = async () => {
    setProblem("");
    const current = useStore.getState().ws;
    if (way === "blank") return finish(createProcess(current, { ...base(), name }));
    if (way === "template") {
      const t = PROCESS_TEMPLATES.find((x) => x.id === template)!;
      return finish(createProcess(current, { ...base(), level: Math.max(2, level), name: name.trim() || t.name, description: t.description, category: parentChoice ? category : t.category, ...fromTemplate(t) }));
    }
    if (way === "import") {
      if (!file) return setProblem("Choose a BPMN file first.");
      return finish(createProcess(current, { ...base(), level: Math.max(2, level), name: name.trim() || file.title, xml: file.xml }));
    }
    if (description.trim().length < 10) return setProblem("Describe the process in a few sentences or one step per line.");
    setBusy(true);
    try {
      const { draft, engine, usedRules } = await draftProcess(description);
      const spec = { ...draft.spec, name: name.trim() || draft.spec.name };
      const made = createProcess(useStore.getState().ws, { ...base(), level: Math.max(2, level), name: spec.name, description: description.trim().slice(0, 1500), xml: buildBpmn(spec), elements: draftElements(draft) });
      apply(() => made.ws);
      onClose();
      const said = usedRules ? draft.notes : `Drafted by ${engine}. ${draft.notes || "Check the steps, who does them and the decisions."}`;
      navigate(`/processes/${made.process.id}?drafted=${encodeURIComponent(said.slice(0, 600))}`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The draft failed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const readFile = async (f: File) => {
    setProblem("");
    if (f.size > 3_000_000) return setProblem("The file is larger than 3 MB.");
    const xml = await f.text();
    try {
      const graph = parseBpmn(xml);
      const title = graph.processes[0]?.participant || graph.processes[0]?.name || f.name.replace(/\.(bpmn|xml)$/i, "");
      const steps = Object.values(graph.nodes).filter((n) => n.kind === "activity").length;
      if (!xml.includes("BPMNDiagram")) return setProblem("This BPMN file has no diagram to show. Export it again with its diagram (most tools do so by default).");
      setFile({ name: f.name, xml, title, steps });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The file could not be read.");
    }
  };

  const ways: { id: Way; label: string }[] = [
    { id: "blank", label: "Blank" },
    { id: "template", label: "From a template" },
    { id: "describe", label: "Describe it" },
    { id: "import", label: "Import BPMN" },
  ];
  const action = way === "describe" ? (busy ? "Drafting…" : "Draft the process") : way === "import" ? "Import" : "Create";

  return (
    <Modal
      title="New process"
      onClose={onClose}
      width={640}
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
        )}
        {way === "describe" && (
          <Field label="What happens, step by step" hint={'One step per line works best. Say who does a step with "Role: step" or "step (Role)", and a decision with "If ..., ...; otherwise ...". With an AI model on the server, plain prose works too.'}>
            <Textarea
              rows={7}
              value={description}
              maxLength={12000}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={"Customer service: register the complaint\nIf it can be answered at once, answer the customer; otherwise investigate it (Specialist team)\nClose the complaint"}
              data-process-description
            />
          </Field>
        )}
        {way === "import" && (
          <div>
            <input ref={input} type="file" accept=".bpmn,.xml,application/xml,text/xml" className="sr-only" onChange={(e) => e.target.files?.[0] && void readFile(e.target.files[0])} data-process-file />
            <Button icon={<FileUp size={15} />} onClick={() => input.current?.click()}>
              Choose a BPMN 2.0 file
            </Button>
            {file ? (
              <p className="mt-2 text-[13px]">
                <span className="font-medium">{file.title}</span> <span className="text-ink-soft">from {file.name}, with {file.steps} steps.</span>
              </p>
            ) : (
              <p className="mt-2 text-[13px] text-ink-soft">From Camunda, Signavio, ARIS, Bizagi, Visio or any tool that saves BPMN 2.0. The file is read here, in the browser.</p>
            )}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={way === "template" ? PROCESS_TEMPLATES.find((t) => t.id === template)?.name : way === "import" ? file?.title || "From the file" : "Handle a customer complaint"} maxLength={200} data-process-name />
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
        {way === "describe" && (
          <p className="flex items-center gap-1.5 text-[13px] text-ink-soft">
            <Sparkles size={14} aria-hidden /> The description goes to the AI model set up for this workspace, if there is one; otherwise the built-in rules draft it here.
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

