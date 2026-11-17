import { Download, FileUp, Plus, Trash2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Badge, Button, CommitInput, EmptyState, Field, IconButton, Input, Select, cx } from "@/components/ui";
import { downloadText } from "@/lib/exporters";
import { newId } from "@/lib/model";
import { evaluate, fromDmn, tableFindings, toDmn } from "@/lib/bpm/dmn";
import type { BpmnGraph } from "@/lib/bpm/bpmn";
import type { DecisionTable, ProcessModel } from "@/lib/types";

const HIT_POLICIES: { id: DecisionTable["hitPolicy"]; label: string }[] = [
  { id: "UNIQUE", label: "Unique: only one rule may apply" },
  { id: "FIRST", label: "First: the first rule that applies" },
  { id: "PRIORITY", label: "Priority: the rule listed highest" },
  { id: "ANY", label: "Any: rules that apply agree" },
  { id: "COLLECT", label: "Collect: every rule that applies" },
  { id: "RULE ORDER", label: "Rule order: all, in rule order" },
  { id: "OUTPUT ORDER", label: "Output order: all, by answer" },
];
const TYPES = ["string", "number", "boolean", "date"] as const;

export function newDecisionTable(name = "New decision"): DecisionTable {
  return {
    id: newId("dmn"),
    name,
    hitPolicy: "FIRST",
    inputs: [{ id: newId("in"), label: "Amount", type: "number" }],
    outputs: [{ id: newId("out"), label: "Approval", type: "string" }],
    rules: [
      { id: newId("rule"), inputs: ["> 10000"], outputs: ['"Manager"'], note: "" },
      { id: newId("rule"), inputs: ["-"], outputs: ['"Automatic"'], note: "" },
    ],
  };
}

interface Props {
  process: ProcessModel;
  graph: BpmnGraph | null;
  canEdit: boolean;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  save: (decisions: Record<string, DecisionTable>) => void;
}

/** DMN decision tables: the rules a business rule step applies, tested here and saved as DMN 1.3. */
export function DecisionsTab({ process, graph, canEdit, selectedId, setSelectedId, save }: Props) {
  const tables = Object.values(process.decisions).sort((a, b) => a.name.localeCompare(b.name));
  const table = (selectedId && process.decisions[selectedId]) || tables[0];
  const file = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState("");

  const put = (t: DecisionTable) => save({ ...process.decisions, [t.id]: t });
  const add = () => {
    const t = newDecisionTable();
    put(t);
    setSelectedId(t.id);
  };
  const importDmn = async (f: File) => {
    setProblem("");
    try {
      const found = fromDmn(await f.text());
      if (!found.length) return setProblem("The file has no decision tables.");
      const next = { ...process.decisions };
      for (const t of found) next[t.id] = { ...t, id: next[t.id] ? newId("dmn") : t.id };
      save(next);
      setSelectedId(found[0].id);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The file could not be read.");
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[240px_1fr] items-start">
      <div>
        <ul className="rounded-lg border border-line bg-surface divide-y divide-line-soft" data-dmn-list>
          {tables.length === 0 && <li className="px-3 py-2.5 text-[13px] text-ink-soft">No decision tables yet.</li>}
          {tables.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => setSelectedId(t.id)} className={cx("w-full text-left px-3 py-2 hover:bg-line-soft", t.id === table?.id && "bg-blueprint-soft hover:bg-blueprint-soft")}>
                <span className="block font-medium text-sm">{t.name}</span>
                <span className="block text-[12px] text-ink-soft">{t.rules.length} rules</span>
              </button>
            </li>
          ))}
        </ul>
        {canEdit && (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" icon={<Plus size={14} />} onClick={add} data-dmn-new>
              New table
            </Button>
            <input ref={file} type="file" accept=".dmn,.xml" className="sr-only" onChange={(e) => e.target.files?.[0] && void importDmn(e.target.files[0])} />
            <Button size="sm" icon={<FileUp size={14} />} onClick={() => file.current?.click()}>
              Import DMN
            </Button>
          </div>
        )}
        {problem && (
          <p className="mt-2 text-[13px] text-danger" role="alert">
            {problem}
          </p>
        )}
      </div>
      {table ? (
        <TableEditor
          key={table.id}
          table={table}
          canEdit={canEdit}
          usedBy={Object.entries(process.elements)
            .filter(([, e]) => e.decisionId === table.id)
            .map(([id]) => graph?.nodes[id]?.name || id)}
          onChange={put}
          onDelete={() => {
            const next = { ...process.decisions };
            delete next[table.id];
            save(next);
            setSelectedId(null);
          }}
        />
      ) : (
        <div className="rounded-lg border border-dashed border-ink-faint bg-surface">
          <EmptyState title="Decisions kept as rules" text="When a step decides by rules (a discount, an approval limit, a risk class), write the rules in a decision table. Each row is a rule; the first columns say when it applies and the last what it answers. Any DMN tool can open the table you export." />
        </div>
      )}
    </div>
  );
}

function TableEditor({ table, canEdit, usedBy, onChange, onDelete }: { table: DecisionTable; canEdit: boolean; usedBy: string[]; onChange: (t: DecisionTable) => void; onDelete: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const result = useMemo(() => (Object.values(values).some((v) => v.trim()) ? evaluate(table, values) : null), [table, values]);
  const findings = useMemo(() => tableFindings(table), [table]);
  const set = (patch: Partial<DecisionTable>) => onChange({ ...table, ...patch });
  const cell = (ri: number, side: "inputs" | "outputs", ci: number, v: string) =>
    set({ rules: table.rules.map((r, i) => (i === ri ? { ...r, [side]: Object.assign([...r[side]], { [ci]: v }) } : r)) });
  const column = (side: "inputs" | "outputs", add: boolean, index = -1) => {
    if (add) {
      const col = { id: newId(side === "inputs" ? "in" : "out"), label: side === "inputs" ? "New input" : "New answer", type: "string" as const };
      return set({ [side]: [...table[side], col], rules: table.rules.map((r) => ({ ...r, [side]: [...r[side], side === "inputs" ? "-" : ""] })) });
    }
    set({ [side]: table[side].filter((_, i) => i !== index), rules: table.rules.map((r) => ({ ...r, [side]: r[side].filter((_, i) => i !== index) })) });
  };

  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3 space-y-4 min-w-0" data-dmn-table={table.id}>
      <div className="grid gap-3 sm:grid-cols-[1fr_280px_auto] items-end">
        <Field label="Decision">
          <CommitInput value={table.name} disabled={!canEdit} onCommit={(v) => set({ name: v.trim() || table.name })} maxLength={120} />
        </Field>
        <Field label="When several rules apply">
          <Select value={table.hitPolicy} disabled={!canEdit} onChange={(e) => set({ hitPolicy: e.target.value as DecisionTable["hitPolicy"] })} data-dmn-policy>
            {HIT_POLICIES.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex gap-1.5">
          <Button size="sm" icon={<Download size={14} />} onClick={() => downloadText(`${table.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "decision"}.dmn`, toDmn(table), "application/xml")} data-dmn-export>
            DMN
          </Button>
          {canEdit &&
            (confirm ? (
              <Button size="sm" variant="danger" onClick={onDelete}>
                Delete it
              </Button>
            ) : (
              <IconButton label="Delete this table" onClick={() => setConfirm(true)}>
                <Trash2 size={15} />
              </IconButton>
            ))}
        </div>
      </div>
      <p className="text-[13px] text-ink-soft">
        {usedBy.length ? `Applied by ${usedBy.join(", ")}.` : "No step applies it yet: select a business rule step on the model and choose this table."} In a condition, <code>-</code> means anything; write <code>&gt;= 18</code>, <code>[1..5]</code>, <code>"gold","silver"</code> or <code>not("closed")</code>.
      </p>
      <div className="overflow-x-auto">
        <table className="text-sm border-separate border-spacing-0 min-w-full">
          <thead>
            <tr>
              <th className="w-8" />
              {table.inputs.map((c, i) => (
                <th key={c.id} className="px-1 pb-1 text-left align-bottom min-w-[150px] border-b-2 border-blueprint">
                  <div className="flex items-center gap-1">
                    <CommitInput value={c.label} disabled={!canEdit} onCommit={(v) => set({ inputs: table.inputs.map((x, j) => (j === i ? { ...x, label: v.trim() || x.label } : x)) })} aria-label="Input" className="h-7 font-medium" />
                    {canEdit && table.inputs.length > 1 && (
                      <IconButton label={`Remove ${c.label}`} className="size-6 shrink-0" onClick={() => column("inputs", false, i)}>
                        <X size={13} />
                      </IconButton>
                    )}
                  </div>
                  <Select value={c.type} disabled={!canEdit} onChange={(e) => set({ inputs: table.inputs.map((x, j) => (j === i ? { ...x, type: e.target.value as (typeof TYPES)[number] } : x)) })} className="mt-1 h-6 text-[12px]" aria-label={`Type of ${c.label}`}>
                    {TYPES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </Select>
                </th>
              ))}
              {table.outputs.map((c, i) => (
                <th key={c.id} className={cx("px-1 pb-1 text-left align-bottom min-w-[150px] border-b-2 border-ok", i === 0 && "border-l-2 border-l-line")}>
                  <div className="flex items-center gap-1">
                    <CommitInput value={c.label} disabled={!canEdit} onCommit={(v) => set({ outputs: table.outputs.map((x, j) => (j === i ? { ...x, label: v.trim() || x.label } : x)) })} aria-label="Answer" className="h-7 font-medium" />
                    {canEdit && table.outputs.length > 1 && (
                      <IconButton label={`Remove ${c.label}`} className="size-6 shrink-0" onClick={() => column("outputs", false, i)}>
                        <X size={13} />
                      </IconButton>
                    )}
                  </div>
                  <Select value={c.type} disabled={!canEdit} onChange={(e) => set({ outputs: table.outputs.map((x, j) => (j === i ? { ...x, type: e.target.value as (typeof TYPES)[number] } : x)) })} className="mt-1 h-6 text-[12px]" aria-label={`Type of ${c.label}`}>
                    {TYPES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </Select>
                </th>
              ))}
              <th className="px-1 pb-1 text-left align-bottom min-w-[140px] text-[13px] font-medium text-ink-soft border-b-2 border-line">Note</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {table.rules.map((r, ri) => (
              <tr key={r.id} className={cx(result?.chosen.includes(ri) ? "bg-ok-soft" : result?.matched.includes(ri) && "bg-paper")} data-dmn-rule={ri + 1}>
                <td className="px-1 text-[12px] text-ink-faint tabular-nums text-right border-b border-line-soft">{ri + 1}</td>
                {table.inputs.map((c, ci) => (
                  <td key={c.id} className="px-1 py-1 border-b border-line-soft">
                    <CommitInput value={r.inputs[ci] ?? "-"} disabled={!canEdit} onCommit={(v) => cell(ri, "inputs", ci, v.trim() || "-")} aria-label={`Rule ${ri + 1}, ${c.label}`} className="h-7 font-mono text-[13px]" />
                  </td>
                ))}
                {table.outputs.map((c, ci) => (
                  <td key={c.id} className={cx("px-1 py-1 border-b border-line-soft", ci === 0 && "border-l-2 border-l-line")}>
                    <CommitInput value={r.outputs[ci] ?? ""} disabled={!canEdit} onCommit={(v) => cell(ri, "outputs", ci, v.trim())} aria-label={`Rule ${ri + 1}, ${c.label}`} className="h-7 font-mono text-[13px]" />
                  </td>
                ))}
                <td className="px-1 py-1 border-b border-line-soft">
                  <CommitInput value={r.note} disabled={!canEdit} onCommit={(v) => set({ rules: table.rules.map((x, i) => (i === ri ? { ...x, note: v.trim() } : x)) })} aria-label={`Rule ${ri + 1} note`} className="h-7 text-[13px]" />
                </td>
                <td className="border-b border-line-soft">
                  {canEdit && (
                    <IconButton label={`Delete rule ${ri + 1}`} className="size-7" onClick={() => set({ rules: table.rules.filter((_, i) => i !== ri) })}>
                      <Trash2 size={13} />
                    </IconButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<Plus size={14} />} onClick={() => set({ rules: [...table.rules, { id: newId("rule"), inputs: table.inputs.map(() => "-"), outputs: table.outputs.map(() => ""), note: "" }] })} data-dmn-add-rule>
            Add a rule
          </Button>
          <Button size="sm" onClick={() => column("inputs", true)}>
            Add an input
          </Button>
          <Button size="sm" onClick={() => column("outputs", true)}>
            Add an answer
          </Button>
        </div>
      )}
      {findings.length > 0 && (
        <ul className="space-y-1 text-[13px]">
          {findings.map((f) => (
            <li key={f} className="rounded-md bg-signal-soft text-signal px-2.5 py-1.5">
              {f}
            </li>
          ))}
        </ul>
      )}
      <section className="rounded-md border border-line bg-paper px-3 py-3" data-dmn-test>
        <h3 className="text-sm font-semibold">Try it</h3>
        <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(4, table.inputs.length)}, minmax(0, 1fr))` }}>
          {table.inputs.map((c) => (
            <Field key={c.id} label={c.label}>
              {c.type === "boolean" ? (
                <Select value={values[c.id] ?? ""} onChange={(e) => setValues({ ...values, [c.id]: e.target.value })}>
                  <option value="" />
                  <option value="true">true</option>
                  <option value="false">false</option>
                </Select>
              ) : (
                <Input type={c.type === "number" ? "number" : c.type === "date" ? "date" : "text"} value={values[c.id] ?? ""} onChange={(e) => setValues({ ...values, [c.id]: e.target.value })} data-dmn-try={c.label} />
              )}
            </Field>
          ))}
        </div>
        {result && (
          <div className="mt-2 text-[13px]" data-dmn-answer>
            {result.outputs.length ? (
              result.outputs.map((o, i) => (
                <p key={i}>
                  {Object.entries(o).map(([k, v]) => (
                    <span key={k} className="mr-3">
                      {k}: <span className="font-semibold">{v || "(empty)"}</span>
                    </span>
                  ))}
                </p>
              ))
            ) : (
              <p className="text-ink-soft">No answer.</p>
            )}
            <p className="mt-1 text-ink-soft">
              {result.chosen.length ? `Rule${result.chosen.length > 1 ? "s" : ""} ${result.chosen.map((i) => i + 1).join(", ")} ${result.chosen.length > 1 ? "apply" : "applies"}.` : ""}
              {result.matched.length > result.chosen.length ? ` Rules ${result.matched.map((i) => i + 1).join(", ")} match; the table takes the ${table.hitPolicy === "PRIORITY" ? "one listed highest" : "first"}.` : ""}{" "}
              {result.problem && <Badge tone="red">{result.problem}</Badge>}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
