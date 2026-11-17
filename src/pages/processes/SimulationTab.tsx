import { Copy, Play, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge, Button, CommitInput, EmptyState, Field, IconButton, Select, cx } from "@/components/ui";
import { newId } from "@/lib/model";
import { activitiesInOrder, type BpmnGraph } from "@/lib/bpm/bpmn";
import { baseScenario, rolesOf, simulate, type SimResult } from "@/lib/bpm/simulate";
import type { ProcessModel, SimScenario } from "@/lib/types";
import { hoursLabel, minutesLabel, percent } from "./shared";

interface Props {
  process: ProcessModel;
  graph: BpmnGraph;
  canEdit: boolean;
  results: Record<string, SimResult>;
  setResults: (r: Record<string, SimResult>) => void;
  setScenarios: (s: SimScenario[]) => void;
  onShow: (scenarioId: string) => void;
}

const money = (n: number) => (n ? n.toLocaleString(undefined, { maximumFractionDigits: n < 100 ? 2 : 0 }) : "–");

/** What-if: run the process with more or fewer people, faster steps or other choices, and compare. */
export function SimulationTab({ process, graph, canEdit, results, setResults, setScenarios, onShow }: Props) {
  const roles = useMemo(() => rolesOf(graph, process), [graph, process]);
  // Without a saved scenario there is still the process as it is, with one person per role.
  const scenarios = process.scenarios.length ? process.scenarios : [baseScenario(graph, process)];
  const [selectedId, setSelectedId] = useState(scenarios[0].id);
  const [running, setRunning] = useState(false);
  const selected = scenarios.find((s) => s.id === selectedId) ?? scenarios[0];
  const steps = useMemo(() => activitiesInOrder(graph), [graph]);
  const choices = useMemo(() => Object.values(graph.flows).filter((f) => f.type === "sequenceFlow" && /^(exclusiveGateway|inclusiveGateway)$/.test(graph.nodes[f.sourceId]?.type ?? "")), [graph]);

  const save = (next: SimScenario[]) => setScenarios(next);
  const change = (patch: Partial<SimScenario>) => save(scenarios.map((s) => (s.id === selected.id ? { ...s, ...patch } : s)));
  const copy = () => {
    const made: SimScenario = { ...structuredClone(selected), id: newId("sim"), name: `${selected.name} (changed)` };
    save([...scenarios, made]);
    setSelectedId(made.id);
  };
  const remove = () => {
    const next = scenarios.filter((s) => s.id !== selected.id);
    save(next);
    setSelectedId(next[0]?.id ?? "base");
  };
  const run = () => {
    setRunning(true);
    // Let the button show its state before the work.
    setTimeout(() => {
      const out: Record<string, SimResult> = {};
      for (const s of scenarios) out[s.id] = simulate(graph, process, { ...s, resources: Object.fromEntries(roles.map((r) => [r, s.resources[r] ?? { count: 1, costPerHour: 0 }])) });
      setResults(out);
      setRunning(false);
    }, 20);
  };

  const base = results[scenarios[0].id];
  const shown = results[selected.id];
  const delta = (value: number, of: number | undefined, lowerIsBetter = true) => {
    if (of === undefined || !of || value === of) return null;
    const change = (value - of) / of;
    const good = lowerIsBetter ? change < 0 : change > 0;
    return <span className={cx("ml-1 text-[12px]", good ? "text-ok" : "text-danger")}>{`${change > 0 ? "+" : ""}${Math.round(change * 100)}%`}</span>;
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[360px_1fr] items-start">
      <div className="rounded-lg border border-line bg-surface px-4 py-3 space-y-3" data-sim-editor>
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <Select value={selected.id} onChange={(e) => setSelectedId(e.target.value)} aria-label="Scenario" data-sim-scenario>
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
          {canEdit && (
            <>
              <IconButton label="Copy as a new scenario" onClick={copy} data-sim-copy>
                <Copy size={15} />
              </IconButton>
              <IconButton label="Delete this scenario" disabled={scenarios.length < 2 || !process.scenarios.length} onClick={remove}>
                <Trash2 size={15} />
              </IconButton>
            </>
          )}
        </div>
        <Field label="Name">
          <CommitInput value={selected.name} disabled={!canEdit} onCommit={(v) => change({ name: v.trim() || selected.name })} maxLength={80} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Cases to run">
            <CommitInput type="number" min={1} max={20000} disabled={!canEdit} value={String(selected.cases)} onCommit={(v) => change({ cases: Math.max(1, Math.min(20000, Math.round(Number(v) || 1))) })} />
          </Field>
          <Field label="A new case every" hint="minutes, on average">
            <CommitInput type="number" min={0.01} step="any" disabled={!canEdit} value={String(selected.arrivalMinutes)} onCommit={(v) => change({ arrivalMinutes: Math.max(0.01, Number(v) || 30) })} data-sim-arrival />
          </Field>
        </div>
        <fieldset>
          <legend className="text-[13px] font-medium text-ink-soft">People, by role</legend>
          {roles.length === 0 && <p className="text-[12px] text-ink-faint mt-1">Every step is automated, so no one waits for a person.</p>}
          <table className="mt-1 w-full text-[13px]">
            {roles.length > 0 && (
              <thead className="text-ink-faint text-[12px]">
                <tr>
                  <th className="text-left font-normal">Role</th>
                  <th className="text-left font-normal w-16">How many</th>
                  <th className="text-left font-normal w-20">Cost an hour</th>
                </tr>
              </thead>
            )}
            <tbody>
              {roles.map((r) => {
                const res = selected.resources[r] ?? { count: 1, costPerHour: 0 };
                return (
                  <tr key={r}>
                    <td className="pr-2 py-0.5 truncate max-w-[120px]" title={r}>
                      {r}
                    </td>
                    <td className="py-0.5 pr-1">
                      <CommitInput type="number" min={0} disabled={!canEdit} value={String(res.count)} onCommit={(v) => change({ resources: { ...selected.resources, [r]: { ...res, count: Math.max(0, Math.round(Number(v) || 0)) } } })} aria-label={`People in ${r}`} data-sim-people={r} />
                    </td>
                    <td className="py-0.5">
                      <CommitInput type="number" min={0} step="any" disabled={!canEdit} value={String(res.costPerHour)} onCommit={(v) => change({ resources: { ...selected.resources, [r]: { ...res, costPerHour: Math.max(0, Number(v) || 0) } } })} aria-label={`Cost an hour in ${r}`} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </fieldset>
        <details>
          <summary className="cursor-pointer text-[13px] font-medium text-ink-soft">Faster or slower steps</summary>
          <p className="mt-1 text-[12px] text-ink-faint">1 is as modelled; 0.5 takes half the time (automated, say); 0 skips the work.</p>
          <ul className="mt-1 space-y-1">
            {steps.map((n) => (
              <li key={n.id} className="flex items-center gap-2 text-[13px]">
                <span className="flex-1 truncate" title={n.name}>
                  {n.name || n.type}
                </span>
                <div className="w-16">
                  <CommitInput type="number" min={0} step="any" disabled={!canEdit} value={String(selected.changes[n.id]?.durationFactor ?? 1)} onCommit={(v) => change({ changes: { ...selected.changes, [n.id]: { ...selected.changes[n.id], durationFactor: Math.max(0, Number(v)) } } })} aria-label={`Time factor for ${n.name}`} />
                </div>
              </li>
            ))}
          </ul>
        </details>
        {choices.length > 0 && (
          <details>
            <summary className="cursor-pointer text-[13px] font-medium text-ink-soft">Other choices at decisions</summary>
            <ul className="mt-1 space-y-1">
              {choices.map((f) => (
                <li key={f.id} className="flex items-center gap-2 text-[13px]">
                  <span className="flex-1 truncate">
                    {graph.nodes[f.sourceId]?.name || "Decision"}: {f.name || graph.nodes[f.targetId]?.name || "a way"}
                  </span>
                  <div className="w-16">
                    <CommitInput
                      type="number"
                      min={0}
                      max={100}
                      disabled={!canEdit}
                      value={String(selected.changes[f.id]?.probability ?? process.elements[f.id]?.probability ?? "")}
                      placeholder="even"
                      onCommit={(v) => change({ changes: { ...selected.changes, [f.id]: { ...selected.changes[f.id], probability: v.trim() === "" ? undefined : Math.max(0, Math.min(100, Number(v))) } } })}
                      aria-label={`Percent of cases going ${f.name}`}
                    />
                  </div>
                  <span className="text-ink-faint">%</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="flex gap-2 pt-1">
          <Button variant="primary" icon={<Play size={15} />} onClick={run} disabled={running} data-sim-run>
            {running ? "Running…" : scenarios.length > 1 ? "Run all scenarios" : "Run"}
          </Button>
          {canEdit && !process.scenarios.length && (
            <Button icon={<Plus size={15} />} onClick={() => save([...scenarios])}>
              Keep this scenario
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-5 min-w-0">
        {!Object.keys(results).length ? (
          <div className="rounded-lg border border-dashed border-ink-faint bg-surface">
            <EmptyState title="Run the process to see how it performs" text="Each case goes through the model: steps take their time, people do one thing at a time, and decisions go each way as often as you said. Copy the scenario to try a change, then run both to compare." />
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-line bg-surface overflow-x-auto">
              <table className="w-full text-sm" data-sim-results>
                <thead className="text-left text-[13px] text-ink-soft">
                  <tr className="border-b border-line">
                    <th className="px-3 py-2 font-medium">Scenario</th>
                    <th className="px-3 py-2 font-medium text-right">Cases done</th>
                    <th className="px-3 py-2 font-medium text-right">Average time</th>
                    <th className="px-3 py-2 font-medium text-right">9 in 10 within</th>
                    <th className="px-3 py-2 font-medium text-right">Average wait</th>
                    <th className="px-3 py-2 font-medium text-right">Cost a case</th>
                    <th className="px-3 py-2 font-medium">Bottleneck</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {scenarios.map((s) => {
                    const r = results[s.id];
                    if (!r) return null;
                    const first = s.id === scenarios[0].id;
                    return (
                      <tr key={s.id} className={cx(s.id === selected.id && "bg-blueprint-soft/50")}>
                        <td className="px-3 py-2">
                          <button type="button" className="font-medium hover:underline text-left" onClick={() => setSelectedId(s.id)}>
                            {s.name}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.completed.toLocaleString()}
                          {r.completed < r.started && <span className="text-danger"> of {r.started.toLocaleString()}</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {hoursLabel(r.meanHours)}
                          {!first && delta(r.meanHours, base?.meanHours)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {hoursLabel(r.p90Hours)}
                          {!first && delta(r.p90Hours, base?.p90Hours)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {hoursLabel(r.meanWaitHours)}
                          {!first && delta(r.meanWaitHours, base?.meanWaitHours)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {money(r.costPerCase)}
                          {!first && delta(r.costPerCase, base?.costPerCase)}
                        </td>
                        <td className="px-3 py-2">{r.bottleneck ? <Badge tone="amber">{r.bottleneck}</Badge> : <span className="text-ink-faint">None</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {shown && (
              <>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">{selected.name}: step by step</h3>
                  <Button size="sm" className="ml-auto" onClick={() => onShow(selected.id)} data-sim-show>
                    Show the waits on the model
                  </Button>
                </div>
                <div className="grid gap-5 xl:grid-cols-[1fr_260px]">
                  <div className="rounded-lg border border-line bg-surface overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-[13px] text-ink-soft">
                        <tr className="border-b border-line">
                          <th className="px-3 py-2 font-medium">Step</th>
                          <th className="px-3 py-2 font-medium text-right">Done</th>
                          <th className="px-3 py-2 font-medium text-right">Waited</th>
                          <th className="px-3 py-2 font-medium text-right">Worked</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line-soft">
                        {shown.steps.map((s) => (
                          <tr key={s.id}>
                            <td className="px-3 py-1.5">{s.name || s.id}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{s.count.toLocaleString()}</td>
                            <td className={cx("px-3 py-1.5 text-right tabular-nums", s.name === shown.bottleneck && "text-danger font-medium")}>{minutesLabel(s.meanWaitMinutes)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{minutesLabel(s.meanWorkMinutes)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div>
                    <h4 className="text-[13px] font-medium text-ink-soft">How busy each role is</h4>
                    <ul className="mt-2 space-y-2">
                      {shown.resources.map((r) => (
                        <li key={r.role} className="text-[13px]">
                          <div className="flex justify-between">
                            <span>
                              {r.role} <span className="text-ink-faint">×{r.count}</span>
                            </span>
                            <span className={cx("tabular-nums", r.utilisation > 0.85 && "text-danger font-medium")}>{percent(r.utilisation)}</span>
                          </div>
                          <span className="mt-1 block h-1.5 rounded-full bg-line-soft overflow-hidden">
                            <span className={cx("block h-full", r.utilisation > 0.85 ? "bg-danger" : r.utilisation > 0.6 ? "bg-signal" : "bg-ok")} style={{ width: `${Math.min(100, r.utilisation * 100)}%` }} />
                          </span>
                        </li>
                      ))}
                    </ul>
                    {shown.notes.length > 0 && (
                      <ul className="mt-4 space-y-1 text-[12px] text-ink-soft list-disc pl-4">
                        {shown.notes.map((n, i) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
