import { Blocks, GraduationCap, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { BpmnSymbol, blockElement, useLibrarySearch } from "@/components/bpm/BpmnLibrary";
import { Badge, Button, Field, IconButton, Input, Modal, Select, Textarea } from "@/components/ui";
import { useCanEdit } from "@/lib/cloud/session";
import { BPMN_ELEMENTS, BPMN_GROUPS, bpmnBlockSchema, ownBlocks, removeBlock, saveBlock, type BpmnBlock } from "@/lib/bpm/elements";
import { TRAINING_EXAMPLES, TRAINING_TAG, addTrainingExamples } from "@/lib/bpm/training";
import { apply, useStore, useWorkspace } from "@/lib/store";
import type { Workspace } from "@/lib/types";
import { ObjectPicker } from "./shared";

/** Elements a building block can be: the activities and the events in the flow. */
const BLOCK_KINDS = BPMN_ELEMENTS.filter((e) => e.create && (e.group === "activities" || (e.group === "events" && e.family !== "boundary")));

/** Where each element is shown in the training examples that are in the workspace. */
function examplesShowing(ws: Workspace) {
  const present = new Map(Object.values(ws.processes).filter((p) => p.tags.includes(TRAINING_TAG)).flatMap((p) => p.tags.filter((t) => t !== TRAINING_TAG).map((t) => [t, p.id] as const)));
  return (elementId: string) => TRAINING_EXAMPLES.filter((t) => t.teaches.includes(elementId)).map((t) => ({ example: t, processId: present.get(t.id) ?? null }));
}

function BlockDialog({ ws, id, onClose }: { ws: Workspace; id: string | null; onClose: () => void }) {
  const known = id ? ws.library[id]?.bpmn : undefined;
  const [block, setBlock] = useState<BpmnBlock>(known ?? { name: "", element: "user-task", description: "", role: "", info: { objectIds: [] } });
  const [problem, setProblem] = useState("");
  const d = block.info.duration;
  const minutes = (key: "min" | "mode" | "max", raw: string) => {
    const v = raw.trim() === "" ? undefined : Math.max(0, Number(raw));
    const next = { min: d?.min ?? 0, mode: d?.mode ?? 0, max: d?.max ?? 0, [key]: v ?? 0 };
    setBlock({ ...block, info: { ...block.info, duration: next.min || next.mode || next.max ? { min: Math.min(next.min, next.mode || next.min), mode: next.mode, max: Math.max(next.max, next.mode) } : undefined } });
  };
  const save = () => {
    const parsed = bpmnBlockSchema.safeParse(block);
    if (!parsed.success) return setProblem("Give the building block a name.");
    apply((w) => saveBlock(w, parsed.data, id ?? undefined).ws);
    onClose();
  };
  return (
    <Modal
      title={id ? "Change the building block" : "New building block"}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} data-block-save>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[13px] text-ink-soft">A step your processes use again and again. Placed in a model, it brings its name, the role that does it, its time and the systems it uses.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2">
            <Input value={block.name} onChange={(e) => setBlock({ ...block, name: e.target.value })} placeholder="Approve the invoice in the ERP" maxLength={120} autoFocus data-block-name />
          </Field>
          <Field label="Kind of element">
            <Select value={block.element} onChange={(e) => setBlock({ ...block, element: e.target.value })} data-block-element>
              {BLOCK_KINDS.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Role that does it">
            <Input value={block.role} onChange={(e) => setBlock({ ...block, role: e.target.value })} placeholder="Finance" maxLength={120} data-block-role />
          </Field>
        </div>
        <fieldset>
          <legend className="text-[13px] font-medium text-ink-soft mb-1">Time it takes, in minutes</legend>
          <div className="grid grid-cols-3 gap-2">
            {(["min", "mode", "max"] as const).map((k) => (
              <Field key={k} label={{ min: "Least", mode: "Usually", max: "Most" }[k]}>
                <Input type="number" min={0} value={d?.[k] ?? ""} onChange={(e) => minutes(k, e.target.value)} data-block-minutes={k} />
              </Field>
            ))}
          </div>
        </fieldset>
        <div>
          <p className="text-[13px] font-medium text-ink-soft mb-1">Systems and data it uses</p>
          <ObjectPicker ws={ws} ids={block.info.objectIds} canEdit onChange={(objectIds) => setBlock({ ...block, info: { ...block.info, objectIds } })} />
        </div>
        <Field label="What it is for">
          <Textarea rows={2} value={block.description} onChange={(e) => setBlock({ ...block, description: e.target.value })} maxLength={600} />
        </Field>
        {problem && (
          <p role="alert" className="text-[13px] text-danger">
            {problem}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** The BPMN library: the elements of BPMN 2.0, the workspace's own building blocks, and the training examples. */
export default function BpmnLibraryPage() {
  const ws = useWorkspace();
  const canEdit = useCanEdit();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const groups = useLibrarySearch(query);
  const blocks = ownBlocks(ws);
  const showing = examplesShowing(ws);
  const area = Object.values(ws.processes).find((p) => p.level === 0 && p.tags.includes(TRAINING_TAG));
  const trainingIn = Object.values(ws.processes).filter((p) => p.parentId === area?.id).length;

  return (
    <div className="max-w-6xl mx-auto px-6 py-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">BPMN library</h1>
          <p className="text-ink-soft mt-0.5 max-w-3xl">
            The elements business processes are modelled with in BPMN 2.0: what each one means and when to use it, in English and Arabic, and the building blocks this workspace uses again and again. It is separate from the component library of diagrams.
          </p>
        </div>
        <div className="relative w-72">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search: gateway, timer, بوابة" aria-label="Search the BPMN library" className="pl-8" data-bpmn-library-search />
        </div>
      </div>

      <section className="mt-6 rounded-lg border border-line bg-surface px-5 py-4" data-bpmn-training>
        <div className="flex flex-wrap items-start gap-3">
          <GraduationCap size={20} className="text-blueprint mt-0.5" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">Training examples</h2>
            <p className="text-[13px] text-ink-soft">Ten small processes, each showing one part of BPMN, with what to notice in English and Arabic. They can be simulated at once.</p>
            <p className="text-[13px] text-ink-soft" dir="rtl">
              عشر عمليات صغيرة، كل واحدة تشرح جزءاً من BPMN، مع ما يجب ملاحظته بالعربية والإنجليزية، ويمكن محاكاتها مباشرة.
            </p>
          </div>
          {canEdit && trainingIn < TRAINING_EXAMPLES.length && (
            <Button
              variant="primary"
              icon={<Plus size={15} />}
              onClick={() => apply(() => addTrainingExamples(useStore.getState().ws).ws)}
              data-training-add
            >
              {trainingIn ? "Add the missing examples" : "Add the training examples"}
            </Button>
          )}
        </div>
        <ol className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {TRAINING_EXAMPLES.map((t) => {
            const processId = Object.values(ws.processes).find((p) => p.parentId === area?.id && p.tags.includes(t.id))?.id;
            return (
              <li key={t.id} className="rounded-md border border-line-soft bg-paper px-3 py-2" data-training-example={t.id}>
                {processId ? (
                  <Link to={`/processes/${processId}`} className="font-medium text-blueprint hover:underline">
                    {t.name}
                  </Link>
                ) : (
                  <span className="font-medium">{t.name}</span>
                )}
                <p className="text-[12.5px] text-ink-soft">{t.topic}</p>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="mt-6" data-bpmn-own>
        <div className="flex items-center gap-2">
          <Blocks size={18} className="text-ink-soft" aria-hidden />
          <h2 className="font-semibold">Your building blocks</h2>
          <Badge>{blocks.length}</Badge>
          {canEdit && (
            <Button size="sm" icon={<Plus size={14} />} className="ml-auto" onClick={() => setEditing(null)} data-block-new>
              New building block
            </Button>
          )}
        </div>
        {blocks.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-soft">Steps your processes use again and again, such as "Approve the invoice in the ERP". Make one here, or select a step in a process model and save it to the library. In the modeler they are at the top of the library panel.</p>
        ) : (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {blocks.map((b) => (
              <li key={b.id} className="flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5" data-block={b.id}>
                <BpmnSymbol element={blockElement(b.bpmn)} size={28} />
                <div className="min-w-0 flex-1 text-[13px]">
                  <p className="font-medium text-sm">{b.bpmn.name}</p>
                  <p className="text-ink-soft">
                    {blockElement(b.bpmn).name}
                    {b.bpmn.role ? ` · ${b.bpmn.role}` : ""}
                    {b.bpmn.info.duration ? ` · about ${b.bpmn.info.duration.mode} min` : ""}
                  </p>
                  {b.bpmn.info.objectIds.length > 0 && <p className="text-ink-faint truncate">Uses {b.bpmn.info.objectIds.map((id) => ws.objects[id]?.name).filter(Boolean).join(", ")}</p>}
                  {b.bpmn.description && <p className="text-ink-soft mt-0.5">{b.bpmn.description}</p>}
                </div>
                {canEdit && (
                  <div className="flex shrink-0">
                    <IconButton label={`Change ${b.bpmn.name}`} onClick={() => setEditing(b.id)}>
                      <Pencil size={14} />
                    </IconButton>
                    <IconButton label={`Remove ${b.bpmn.name} from the library`} onClick={() => apply((w) => removeBlock(w, b.id))}>
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {groups.map(({ group, elements }) => (
        <section key={group.id} className="mt-8" data-bpmn-group={group.id}>
          <h2 className="font-semibold">
            {group.name} <span className="font-normal text-ink-soft">·</span>{" "}
            <span className="font-normal text-ink-soft" dir="rtl">
              {group.nameAr}
            </span>
          </h2>
          <p className="text-[13px] text-ink-soft">{BPMN_GROUPS.find((g) => g.id === group.id)?.about}</p>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {elements.map((e) => (
              <li key={e.id} className="rounded-lg border border-line bg-surface px-4 py-3" data-bpmn-entry={e.id}>
                <div className="flex items-start gap-3">
                  <span className="grid size-12 shrink-0 place-items-center rounded-md bg-paper">
                    <BpmnSymbol element={e} size={34} />
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium">{e.name}</p>
                    <p className="text-[13px] text-ink-soft" dir="rtl">
                      {e.nameAr}
                    </p>
                  </div>
                </div>
                <p className="mt-2 text-[13px]">{e.meaning}</p>
                <p className="mt-1 text-[13px] text-ink-soft" dir="rtl">
                  {e.meaningAr}
                </p>
                <p className="mt-1.5 text-[12.5px] text-ink-soft">{e.how ?? e.use}</p>
                {showing(e.id).length > 0 && (
                  <p className="mt-1.5 text-[12.5px]">
                    <span className="text-ink-faint">See it in </span>
                    {showing(e.id).map(({ example, processId }, i) => (
                      <span key={example.id}>
                        {i > 0 && ", "}
                        {processId ? (
                          <Link to={`/processes/${processId}`} className="text-blueprint hover:underline">
                            {example.name}
                          </Link>
                        ) : (
                          example.name
                        )}
                      </span>
                    ))}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {groups.length === 0 && <p className="mt-8 text-ink-soft">Nothing in the library matches "{query.trim()}".</p>}
      {editing !== undefined && <BlockDialog ws={ws} id={editing} onClose={() => setEditing(undefined)} />}
    </div>
  );
}
