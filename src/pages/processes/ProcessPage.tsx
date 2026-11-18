import { ArrowLeft, Download, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { BpmnCanvasApi } from "@/components/bpm/BpmnCanvas";
import { ProcessDiagramsTab } from "@/components/bpm/ProcessLinks";
import { Badge, Button, CommitInput, EmptyState, Field, IconButton, Input, Select, Tabs, cx, formatDate, formatDateTime, useNotice } from "@/components/ui";
import { useCanEdit } from "@/lib/cloud/session";
import { downloadText } from "@/lib/exporters";
import { allOwners, newId } from "@/lib/model";
import { blankBpmn, laneName } from "@/lib/bpm/bpmn";
import { CATEGORY_LABEL, LEVEL_LABEL, linksOf, backToDraft, childProcesses, compareModels, deleteProcess, graphOf, pathOf, publishProcess, raciMatrix, restoreVersion, sendForReview, syncProcessLinks, updateProcess, type ProcessPatch } from "@/lib/bpm/processes";
import type { SimResult } from "@/lib/bpm/simulate";
import { checkProcess } from "@/lib/bpm/validate";
import { apply, useStore, useWorkspace } from "@/lib/store";
import type { ProcessElementInfo, ProcessModel, Workspace } from "@/lib/types";
import { DecisionsTab, newDecisionTable } from "./DecisionsTab";
import { MiningTab } from "./MiningTab";
import { ModelTab, type ColourBy } from "./ModelTab";
import { SimulationTab } from "./SimulationTab";
import type { LoadedLog } from "./miningParts";
import { NewProcessDialog, ObjectPicker, StatusBadge, parentOptions, pathLabel, useAuthor } from "./shared";

type Tab = "model" | "details" | "raci" | "systems" | "simulation" | "decisions" | "mining" | "checks" | "versions" | "diagrams";

export default function ProcessPage() {
  const { id = "" } = useParams();
  const ws = useWorkspace();
  const process = ws.processes[id];
  if (!process) {
    return (
      <EmptyState title="This process no longer exists" text="It may have been deleted, or the link is mistyped.">
        <Link to="/processes" className="font-medium text-blueprint hover:underline">
          Go to the process landscape
        </Link>
      </EmptyState>
    );
  }
  return <ProcessView key={id} ws={ws} process={process} />;
}

function ProcessView({ ws, process }: { ws: Workspace; process: ProcessModel }) {
  const canEdit = useCanEdit();
  const author = useAuthor();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const modelled = !!process.xml;
  const [tab, setTab] = useState<Tab>(() => (params.get("tab") as Tab) || (modelled ? "model" : "details"));
  const [colourBy, setColourBy] = useState<ColourBy>("none");
  const [sim, setSim] = useState<Record<string, SimResult>>({});
  const [simShown, setSimShown] = useState<string | null>(null);
  const [log, setLog] = useState<LoadedLog | null>(null);
  const [decision, setDecision] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [adding, setAdding] = useState(false);
  const drafted = params.get("drafted");
  const api = useRef<BpmnCanvasApi | null>(null);
  const { notify, view: notice } = useNotice();

  const graph = useMemo(() => graphOf(process), [process.xml]); // eslint-disable-line react-hooks/exhaustive-deps
  const findings = useMemo(() => (graph ? checkProcess(graph, process) : []), [graph, process]);
  const patch = (p: ProcessPatch) => apply((w) => updateProcess(w, process.id, p));
  const patchElement = (elementId: string, p: Partial<ProcessElementInfo>) =>
    apply((w) => {
      const cur = w.processes[process.id];
      if (!cur) return w;
      const merged: ProcessElementInfo = { ...(cur.elements[elementId] ?? { objectIds: [], raci: {} }), ...p };
      for (const k of Object.keys(merged) as (keyof ProcessElementInfo)[]) if (merged[k] === undefined) delete merged[k];
      return updateProcess(w, process.id, { elements: { ...cur.elements, [elementId]: merged } });
    });
  const onXml = (xml: string) => apply((w) => (w.processes[process.id] && w.processes[process.id].xml !== xml ? updateProcess(w, process.id, { xml }) : w));

  useEffect(() => {
    if (params.get("tab")) setParams((p) => (p.delete("tab"), p), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const children = childProcesses(ws, process.id);
  const errors = findings.filter((f) => f.severity === "error").length;
  const tabs: { id: Tab; label: string; count?: number }[] = modelled
    ? [
        { id: "model", label: "Model" },
        { id: "details", label: "Details" },
        { id: "raci", label: "RACI" },
        { id: "systems", label: "Systems" },
        { id: "simulation", label: "Simulation" },
        { id: "decisions", label: "Decisions", count: Object.keys(process.decisions).length || undefined },
        { id: "mining", label: "Mining" },
        { id: "checks", label: "Checks", count: findings.length },
        { id: "versions", label: "Versions", count: process.versions.length || undefined },
        { id: "diagrams", label: "Diagrams", count: linksOf(process).filter((id) => ws.diagrams[id]).length || undefined },
      ]
    : [
        { id: "details", label: "Details" },
        { id: "diagrams", label: "Diagrams", count: linksOf(process).filter((id) => ws.diagrams[id]).length || undefined },
      ];
  const current = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  const path = pathOf(ws, process.id).slice(0, -1);

  return (
    <div className="max-w-[1500px] mx-auto px-6 py-5">
      <nav aria-label="Where this process sits" className="flex flex-wrap items-center gap-1 text-[13px] text-ink-soft">
        <Link to="/processes" className="inline-flex items-center gap-1 hover:text-ink">
          <ArrowLeft size={14} aria-hidden /> Process landscape
        </Link>
        {path.map((p) => (
          <span key={p.id}>
            <span className="text-ink-faint mx-1">/</span>
            <Link to={`/processes/${p.id}`} className="hover:text-ink">
              {p.name}
            </Link>
          </span>
        ))}
      </nav>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold" data-process-title>
          {process.name}
        </h1>
        <span className="text-[13px] text-ink-faint">
          L{process.level} · {LEVEL_LABEL[process.level]}
        </span>
        <StatusBadge process={process} />
        {process.owner && <span className="text-[13px] text-ink-soft">Owned by {process.owner}</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          {canEdit && <Governance process={process} author={author} errors={errors} onDone={notify} />}
          {canEdit && (
            <Button icon={<Plus size={15} />} onClick={() => setAdding(true)} disabled={process.level >= 4}>
              Add inside
            </Button>
          )}
          {canEdit &&
            (confirmDelete ? (
              <Button
                variant="danger"
                onClick={() => {
                  apply((w) => deleteProcess(w, process.id));
                  navigate(process.parentId ? `/processes/${process.parentId}` : "/processes");
                }}
                data-process-delete-confirm
              >
                Delete {process.name}
              </Button>
            ) : (
              <IconButton label="Delete this process" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={16} />
              </IconButton>
            ))}
        </div>
      </div>
      {drafted && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-blueprint/40 bg-blueprint-soft px-3 py-2 text-[13px]" role="status" data-process-drafted>
          <span className="flex-1">{drafted}</span>
          <IconButton label="Close" className="size-6" onClick={() => setParams((p) => (p.delete("drafted"), p), { replace: true })}>
            <X size={13} />
          </IconButton>
        </div>
      )}
      <div className="mt-4">
        <Tabs tabs={tabs} value={current} onChange={setTab} />
      </div>
      <div className="mt-4">
        {current === "model" && graph !== undefined && (
          <ModelTab
            ws={ws}
            process={process}
            graph={graph}
            canEdit={canEdit}
            findings={findings}
            sim={simShown ? sim[simShown] ?? null : Object.values(sim)[0] ?? null}
            colourBy={colourBy}
            setColourBy={setColourBy}
            apiRef={api}
            onXml={onXml}
            patchElement={patchElement}
            onDecision={(stepId) => {
              const t = newDecisionTable(`${graph?.nodes[stepId]?.name || "Decision"}`);
              apply((w) => updateProcess(w, process.id, { decisions: { ...w.processes[process.id].decisions, [t.id]: t } }));
              patchElement(stepId, { decisionId: t.id });
              setDecision(t.id);
              setTab("decisions");
            }}
          />
        )}
        {current === "details" && <Details ws={ws} process={process} canEdit={canEdit} patch={patch} children={children} onAddModel={() => patch({ xml: blankBpmn(process.name) })} />}
        {current === "raci" && graph && <Raci process={process} canEdit={canEdit} patchElement={patchElement} />}
        {current === "systems" && graph && <Systems ws={ws} process={process} canEdit={canEdit} patchElement={patchElement} onSync={() => {
          const r = syncProcessLinks(useStore.getState().ws, process.id);
          apply(() => r.ws);
          notify(r.added ? `${r.added} links added to the architecture model.` : "The architecture model already shows these links.");
        }} />}
        {current === "simulation" && graph && (
          <SimulationTab
            process={process}
            graph={graph}
            canEdit={canEdit}
            results={sim}
            setResults={setSim}
            setScenarios={(scenarios) => patch({ scenarios })}
            onShow={(scenarioId) => {
              setSimShown(scenarioId);
              setColourBy("simulation");
              setTab("model");
            }}
          />
        )}
        {current === "decisions" && <DecisionsTab process={process} graph={graph} canEdit={canEdit} selectedId={decision} setSelectedId={setDecision} save={(decisions) => patch({ decisions })} />}
        {current === "mining" && graph && (
          <MiningTab
            process={process}
            graph={graph}
            canEdit={canEdit}
            loaded={log}
            setLoaded={setLog}
            saveSummary={(mining) => patch({ mining })}
            applyTimes={(durations) => {
              apply((w) => {
                const cur = w.processes[process.id];
                const elements = { ...cur.elements };
                for (const [k, duration] of Object.entries(durations)) elements[k] = { ...(elements[k] ?? { objectIds: [], raci: {} }), duration };
                return updateProcess(w, process.id, { elements });
              });
              notify(`Times set for ${Object.keys(durations).length} steps from the log.`);
            }}
            replaceModel={(xml, chances) => {
              apply((w) => {
                const elements: Record<string, ProcessElementInfo> = {};
                for (const [k, probability] of Object.entries(chances)) elements[k] = { objectIds: [], raci: {}, probability };
                return updateProcess(w, process.id, { xml, elements });
              });
              setTab("model");
            }}
            showOnModel={() => {
              setColourBy("log");
              setTab("model");
            }}
          />
        )}
        {current === "checks" && (
          <Checks
            findings={findings}
            onShow={(elementId) => {
              setColourBy("checks");
              setTab("model");
              // The canvas needs a moment to be there again.
              setTimeout(() => api.current?.select(elementId), 350);
            }}
          />
        )}
        {current === "versions" && <Versions process={process} canEdit={canEdit} />}
        {current === "diagrams" && <ProcessDiagramsTab ws={ws} process={process} canEdit={canEdit} />}
      </div>
      {adding && <NewProcessDialog parentId={process.id} onClose={() => setAdding(false)} />}
      {notice}
    </div>
  );
}

/** Draft, in review, published, retired: the buttons that move a process along. */
function Governance({ process, author, errors, onDone }: { process: ProcessModel; author: string; errors: number; onDone: (s: string) => void }) {
  const [open, setOpen] = useState<"review" | "publish" | null>(null);
  const [reviewer, setReviewer] = useState(process.reviewer);
  const [note, setNote] = useState("");
  const act = (change: (w: Workspace) => Workspace, said: string) => {
    apply(change);
    setOpen(null);
    setNote("");
    onDone(said);
  };
  if (process.level < 2 && !process.xml) return null;
  return (
    <div className="relative">
      <div className="flex gap-2">
        {process.status === "draft" && (
          <Button onClick={() => setOpen(open === "review" ? null : "review")} data-process-review>
            Send for review
          </Button>
        )}
        {(process.status === "draft" || process.status === "review") && (
          <Button variant="primary" onClick={() => setOpen(open === "publish" ? null : "publish")} data-process-publish>
            Publish
          </Button>
        )}
        {(process.status === "review" || process.status === "published") && (
          <Button onClick={() => act((w) => backToDraft(w, process.id), "Back to draft.")} data-process-draft>
            {process.status === "published" ? "Change it" : "Back to draft"}
          </Button>
        )}
        {process.status === "published" && (
          <Button onClick={() => act((w) => updateProcess(w, process.id, { status: "retired" }), "Retired.")}>Retire</Button>
        )}
        {process.status === "retired" && <Button onClick={() => act((w) => backToDraft(w, process.id), "Back in use, as a draft.")}>Use it again</Button>}
      </div>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 rounded-lg border border-line bg-surface shadow-lg px-4 py-3 space-y-2" role="dialog" aria-label={open === "review" ? "Send for review" : "Publish"}>
          {open === "review" && (
            <Field label="Who reviews it">
              <Input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="The process owner" maxLength={120} autoFocus />
            </Field>
          )}
          {open === "publish" && errors > 0 && <p className="text-[13px] text-danger">The model has {errors === 1 ? "an error" : `${errors} errors`} (see Checks). You can still publish it.</p>}
          <Field label={open === "review" ? "What to look at" : "What changed"}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} data-process-note />
          </Field>
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setOpen(null)}>
              Cancel
            </Button>
            {open === "review" ? (
              <Button size="sm" variant="primary" onClick={() => act((w) => sendForReview(w, process.id, reviewer, note), `Sent to ${reviewer || "review"}.`)}>
                Send
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={() => act((w) => publishProcess(w, process.id, author, note), `Published as version ${process.version + 1}.`)} data-process-publish-confirm>
                Publish version {process.version + 1}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Details({ ws, process, canEdit, patch, children, onAddModel }: { ws: Workspace; process: ProcessModel; canEdit: boolean; patch: (p: ProcessPatch) => void; children: ProcessModel[]; onAddModel: () => void }) {
  const parents = parentOptions(ws, process.id, process.level);
  const owners = allOwners(ws);
  const row = <T extends { id: string }>(list: T[], id: string, change: Partial<T>) => list.map((x) => (x.id === id ? { ...x, ...change } : x));
  return (
    <div className="grid gap-5 lg:grid-cols-2 items-start">
      <section className="rounded-lg border border-line bg-surface px-4 py-3 space-y-3" data-process-details>
        <Field label="Name">
          <CommitInput value={process.name} disabled={!canEdit} onCommit={(v) => v.trim() && patch({ name: v.trim() })} maxLength={200} data-process-field="name" />
        </Field>
        <Field label="Purpose" hint="Why the process exists, where it starts and where it ends.">
          <CommitInput multiline rows={3} value={process.description} disabled={!canEdit} onCommit={(v) => patch({ description: v.trim() })} maxLength={4000} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Owner">
            <CommitInput value={process.owner} disabled={!canEdit} onCommit={(v) => patch({ owner: v.trim() })} list="process-owners" maxLength={120} data-process-field="owner" />
            <datalist id="process-owners">
              {owners.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          </Field>
          <Field label="How often it runs">
            <CommitInput value={process.frequency} disabled={!canEdit} onCommit={(v) => patch({ frequency: v.trim() })} placeholder="About 200 a day" maxLength={120} />
          </Field>
          <Field label="Level">
            <Select value={process.level} disabled={!canEdit} onChange={(e) => patch({ level: Number(e.target.value) })}>
              {LEVEL_LABEL.map((l, i) => (
                <option key={l} value={i}>{`L${i} · ${l}`}</option>
              ))}
            </Select>
          </Field>
          <Field label="Kind of process">
            <Select value={process.category} disabled={!canEdit} onChange={(e) => patch({ category: e.target.value as ProcessModel["category"] })}>
              {Object.entries(CATEGORY_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Inside" className="sm:col-span-2">
            <Select value={process.parentId ?? ""} disabled={!canEdit} onChange={(e) => patch({ parentId: e.target.value || null })}>
              <option value="">Nothing: at the top of the landscape</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {pathLabel(ws, p.id)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tags" className="sm:col-span-2" hint="Separated by commas.">
            <CommitInput value={process.tags.join(", ")} disabled={!canEdit} onCommit={(v) => patch({ tags: [...new Set(v.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))] })} maxLength={400} />
          </Field>
        </div>
        {!process.xml && canEdit && (
          <div className="rounded-md bg-paper px-3 py-2 text-[13px] flex items-center gap-2">
            <span className="flex-1 text-ink-soft">{process.level < 2 ? "An area or group is a box in the landscape; it can have a model of its own as well." : "This process has no model yet."}</span>
            <Button size="sm" onClick={onAddModel} data-process-add-model>
              Model it
            </Button>
          </div>
        )}
        {process.reviewNote && (
          <p className="text-[13px] text-ink-soft">
            {process.status === "review" && process.reviewer ? `With ${process.reviewer}: ` : ""}
            {process.reviewNote}
          </p>
        )}
      </section>
      <div className="space-y-5">
        <section className="rounded-lg border border-line bg-surface px-4 py-3" data-process-kpis>
          <h2 className="text-sm font-semibold">How it is measured</h2>
          {process.kpis.length === 0 && <p className="mt-1 text-[13px] text-ink-soft">No measures yet. Cycle time, first-time-right and cost per case are common ones.</p>}
          {process.kpis.length > 0 && (
            <table className="mt-2 w-full text-[13px]">
              <thead className="text-ink-faint text-[12px] text-left">
                <tr>
                  <th className="font-normal">Measure</th>
                  <th className="font-normal w-20">Unit</th>
                  <th className="font-normal w-20">Target</th>
                  <th className="font-normal w-20">Now</th>
                  <th className="font-normal w-24">Better when</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {process.kpis.map((k) => {
                  const target = Number(k.target);
                  const actual = Number(k.actual);
                  const met = k.target && k.actual && Number.isFinite(target) && Number.isFinite(actual) ? (k.better === "higher" ? actual >= target : actual <= target) : null;
                  return (
                    <tr key={k.id}>
                      <td className="py-0.5 pr-1">
                        <CommitInput value={k.name} disabled={!canEdit} onCommit={(v) => patch({ kpis: row(process.kpis, k.id, { name: v.trim() || k.name }) })} className="h-7" aria-label="Measure" />
                      </td>
                      <td className="py-0.5 pr-1">
                        <CommitInput value={k.unit} disabled={!canEdit} onCommit={(v) => patch({ kpis: row(process.kpis, k.id, { unit: v.trim() }) })} className="h-7" aria-label="Unit" />
                      </td>
                      <td className="py-0.5 pr-1">
                        <CommitInput value={k.target} disabled={!canEdit} onCommit={(v) => patch({ kpis: row(process.kpis, k.id, { target: v.trim() }) })} className="h-7" aria-label="Target" />
                      </td>
                      <td className="py-0.5 pr-1">
                        <CommitInput value={k.actual} disabled={!canEdit} onCommit={(v) => patch({ kpis: row(process.kpis, k.id, { actual: v.trim() }) })} className={cx("h-7", met === false && "border-danger text-danger", met === true && "border-ok")} aria-label="Now" />
                      </td>
                      <td className="py-0.5 pr-1">
                        <Select value={k.better} disabled={!canEdit} onChange={(e) => patch({ kpis: row(process.kpis, k.id, { better: e.target.value as "higher" | "lower" }) })} className="h-7" aria-label="Better when">
                          <option value="higher">Higher</option>
                          <option value="lower">Lower</option>
                        </Select>
                      </td>
                      <td>
                        {canEdit && (
                          <IconButton label={`Remove ${k.name}`} className="size-7" onClick={() => patch({ kpis: process.kpis.filter((x) => x.id !== k.id) })}>
                            <X size={13} />
                          </IconButton>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {canEdit && (
            <Button size="sm" className="mt-2" icon={<Plus size={14} />} onClick={() => patch({ kpis: [...process.kpis, { id: newId("kpi"), name: process.kpis.length ? "New measure" : "Cycle time", unit: process.kpis.length ? "" : "days", target: "", actual: "", better: "lower" }] })} data-process-add-kpi>
              Add a measure
            </Button>
          )}
        </section>
        <section className="rounded-lg border border-line bg-surface px-4 py-3" data-process-risks>
          <h2 className="text-sm font-semibold">Risks and controls</h2>
          {process.risks.length === 0 && <p className="mt-1 text-[13px] text-ink-soft">What could go wrong in the process, and what keeps it from happening.</p>}
          <ul className="mt-2 space-y-2">
            {process.risks.map((r) => (
              <li key={r.id} className="grid gap-1.5 sm:grid-cols-[1fr_110px_1fr_auto] items-center">
                <CommitInput value={r.name} disabled={!canEdit} onCommit={(v) => patch({ risks: row(process.risks, r.id, { name: v.trim() || r.name }) })} className="h-7 text-[13px]" aria-label="Risk" />
                <Select value={r.severity} disabled={!canEdit} onChange={(e) => patch({ risks: row(process.risks, r.id, { severity: e.target.value as "low" | "medium" | "high" }) })} className="h-7 text-[13px]" aria-label="Severity">
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </Select>
                <CommitInput value={r.control} disabled={!canEdit} onCommit={(v) => patch({ risks: row(process.risks, r.id, { control: v.trim() }) })} placeholder="The control" className="h-7 text-[13px]" aria-label="Control" />
                {canEdit && (
                  <IconButton label={`Remove ${r.name}`} className="size-7" onClick={() => patch({ risks: process.risks.filter((x) => x.id !== r.id) })}>
                    <X size={13} />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
          {canEdit && (
            <Button size="sm" className="mt-2" icon={<Plus size={14} />} onClick={() => patch({ risks: [...process.risks, { id: newId("risk"), name: "New risk", severity: "medium", control: "" }] })}>
              Add a risk
            </Button>
          )}
        </section>
        {children.length > 0 && (
          <section className="rounded-lg border border-line bg-surface px-4 py-3">
            <h2 className="text-sm font-semibold">Inside it</h2>
            <ul className="mt-1.5 space-y-1 text-[13px]">
              {children.map((c) => (
                <li key={c.id} className="flex items-center gap-2">
                  <Link to={`/processes/${c.id}`} className="hover:underline">
                    {c.name}
                  </Link>
                  <span className="text-ink-faint">L{c.level}</span>
                  {c.level >= 2 && <StatusBadge process={c} />}
                </li>
              ))}
            </ul>
          </section>
        )}
        {process.objectId && ws.objects[process.objectId] && (
          <p className="text-[13px] text-ink-soft">
            In the architecture model as{" "}
            <Link to={`/model?object=${process.objectId}`} className="text-blueprint hover:underline">
              {ws.objects[process.objectId].name}
            </Link>
            .
          </p>
        )}
      </div>
    </div>
  );
}

function Raci({ process, canEdit, patchElement }: { process: ProcessModel; canEdit: boolean; patchElement: (id: string, p: Partial<ProcessElementInfo>) => void }) {
  const m = raciMatrix(process);
  const [extra, setExtra] = useState<string[]>([]);
  const [role, setRole] = useState("");
  const roles = [...new Set([...m.roles, ...extra])];
  const csv = () => {
    const lines = [["Step", ...roles].join(","), ...m.rows.map((r) => [r.name, ...roles.map((x) => r.cells[x] ?? "")].map((v) => `"${v.replace(/"/g, '""')}"`).join(","))];
    downloadText(`${process.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-raci.csv`, lines.join("\n"), "text/csv");
  };
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-ink-soft max-w-3xl">Who is Responsible for doing each step, who is Accountable for it (one person or role), who is Consulted and who is Informed. A step's lane counts as Responsible until you say otherwise.</p>
      <div className="rounded-lg border border-line bg-surface overflow-x-auto">
        <table className="text-sm min-w-full" data-raci>
          <thead>
            <tr className="border-b border-line text-left text-[13px] text-ink-soft">
              <th className="px-3 py-2 font-medium">Step</th>
              {roles.map((r) => (
                <th key={r} className="px-2 py-2 font-medium text-center">
                  {r}
                </th>
              ))}
              <th className="px-3 py-2 font-medium">Check</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {m.rows.map((row) => {
              const a = Object.values(row.cells).filter((x) => x === "A").length;
              const r = Object.values(row.cells).filter((x) => x === "R").length;
              const problem = !r ? "No one does it" : a > 1 ? "More than one accountable" : "";
              return (
                <tr key={row.id}>
                  <td className="px-3 py-1.5">{row.name}</td>
                  {roles.map((x) => (
                    <td key={x} className="px-1 py-1 text-center">
                      <select
                        value={row.cells[x] ?? ""}
                        disabled={!canEdit}
                        aria-label={`${x} in ${row.name}`}
                        onChange={(e) => {
                          const raci = { ...row.cells } as Record<string, "R" | "A" | "C" | "I">;
                          if (e.target.value) raci[x] = e.target.value as "R" | "A" | "C" | "I";
                          else delete raci[x];
                          patchElement(row.id, { raci });
                        }}
                        className={cx("h-7 w-12 rounded border text-center text-[13px] font-semibold bg-surface", row.cells[x] === "A" ? "border-blueprint text-blueprint" : row.cells[x] === "R" ? "border-ok text-ok" : "border-line text-ink-soft")}
                      >
                        <option value="" />
                        <option>R</option>
                        <option>A</option>
                        <option>C</option>
                        <option>I</option>
                      </select>
                    </td>
                  ))}
                  <td className="px-3 py-1.5 text-[12px]">{problem ? <span className="text-signal">{problem}</span> : <span className="text-ink-faint">OK</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (role.trim()) setExtra([...extra, role.trim()]);
              setRole("");
            }}
          >
            <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Add a role" aria-label="Add a role" className="w-48" />
            <Button type="submit" disabled={!role.trim()}>
              Add
            </Button>
          </form>
        )}
        <Button icon={<Download size={15} />} onClick={csv} className="ml-auto">
          CSV
        </Button>
      </div>
    </div>
  );
}

function Systems({ ws, process, canEdit, patchElement, onSync }: { ws: Workspace; process: ProcessModel; canEdit: boolean; patchElement: (id: string, p: Partial<ProcessElementInfo>) => void; onSync: () => void }) {
  const graph = graphOf(process);
  const steps = graph ? Object.values(graph.nodes).filter((n) => n.kind === "activity") : [];
  const linked = new Set(Object.values(process.elements).flatMap((e) => e.objectIds));
  const automation = steps.reduce<Record<string, number>>((acc, n) => {
    const a = process.elements[n.id]?.automation ?? (/serviceTask|scriptTask|businessRuleTask|sendTask/.test(n.type) ? "automated" : "unknown");
    acc[a] = (acc[a] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[13px] text-ink-soft max-w-3xl flex-1">
          The applications, data and teams each step uses. {linked.size} objects from the architecture model are linked.{" "}
          {Object.entries(automation)
            .filter(([k]) => k !== "unknown")
            .map(([k, n]) => `${n} ${k === "partly" ? "partly automated" : k === "candidate" ? "candidates for automation" : k === "manual" ? "done by hand" : "automated"}`)
            .join(", ")}
        </p>
        {canEdit && (
          <Button variant="primary" onClick={onSync} disabled={!linked.size} data-process-sync title="Adds the process to the architecture model and links it to the systems its steps use">
            Update the architecture model
          </Button>
        )}
      </div>
      <ul className="rounded-lg border border-line bg-surface divide-y divide-line-soft" data-process-step-systems>
        {steps.map((n) => (
          <li key={n.id} className="grid gap-2 px-4 py-2.5 md:grid-cols-[260px_1fr] items-start">
            <div>
              <p className="font-medium text-sm">{n.name || n.type}</p>
              <p className="text-[12px] text-ink-faint">{laneName(graph!, n.id) || "No lane"}</p>
            </div>
            <ObjectPicker ws={ws} ids={process.elements[n.id]?.objectIds ?? []} canEdit={canEdit} onChange={(objectIds) => patchElement(n.id, { objectIds })} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Checks({ findings, onShow }: { findings: ReturnType<typeof checkProcess>; onShow: (id: string) => void }) {
  if (!findings.length) {
    return (
      <div className="rounded-lg border border-dashed border-ink-faint bg-surface">
        <EmptyState title="Nothing to check" text="The model has a start and an end, every step is connected and named, and every decision says when each way is taken." />
      </div>
    );
  }
  return (
    <ul className="rounded-lg border border-line bg-surface divide-y divide-line-soft" data-process-checks>
      {findings.map((f, i) => (
        <li key={i} className="flex items-start gap-3 px-4 py-2.5 text-sm">
          <Badge tone={f.severity === "error" ? "red" : f.severity === "warning" ? "amber" : "blue"}>{f.severity === "error" ? "Error" : f.severity === "warning" ? "Warning" : "Tip"}</Badge>
          <span className="flex-1">{f.message}</span>
          {f.elementId && (
            <button type="button" className="text-[13px] text-blueprint hover:underline shrink-0" onClick={() => onShow(f.elementId!)}>
              Show on the model
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function Versions({ process, canEdit }: { process: ProcessModel; canEdit: boolean }) {
  const [compare, setCompare] = useState<number | null>(null);
  if (!process.versions.length) {
    return (
      <div className="rounded-lg border border-dashed border-ink-faint bg-surface">
        <EmptyState title="Not published yet" text="Publishing keeps a copy of the model as a numbered version, so you can see what changed and go back to it. The ten latest are kept." />
      </div>
    );
  }
  const diff = compare !== null ? compareModels(process.versions.find((v) => v.version === compare)?.xml ?? "", process.xml) : null;
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px] items-start">
      <ul className="rounded-lg border border-line bg-surface divide-y divide-line-soft" data-process-versions>
        {process.versions.map((v) => (
          <li key={v.version} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
            <span className="font-semibold tabular-nums">v{v.version}</span>
            <span className="text-ink-soft">
              {formatDateTime(v.publishedAt)} by {v.publishedBy}
            </span>
            {v.note && <span className="text-[13px]">{v.note}</span>}
            <span className="ml-auto flex gap-1.5">
              <Button size="sm" onClick={() => setCompare(v.version)}>
                Compare with now
              </Button>
              <Button size="sm" icon={<Download size={13} />} onClick={() => downloadText(`${process.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-v${v.version}.bpmn`, v.xml, "application/xml")}>
                BPMN
              </Button>
              {canEdit && (
                <Button size="sm" onClick={() => apply((w) => restoreVersion(w, process.id, v.version))}>
                  Start again from it
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {diff && (
        <section className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px]" data-process-diff>
          <h3 className="text-sm font-semibold">Since version {compare}</h3>
          {!diff.added.length && !diff.removed.length && !diff.renamed ? (
            <p className="mt-1 text-ink-soft">No step was added, removed or renamed{process.updatedAt ? `; last changed ${formatDate(process.updatedAt)}` : ""}.</p>
          ) : (
            <div className="mt-1 space-y-1.5">
              {diff.added.length > 0 && <p><span className="text-ok font-medium">Added:</span> {diff.added.join(", ")}</p>}
              {diff.removed.length > 0 && <p><span className="text-danger font-medium">Removed:</span> {diff.removed.join(", ")}</p>}
              {diff.renamed > 0 && <p className="text-ink-soft">{diff.renamed === 1 ? "One step was renamed." : `${diff.renamed} steps were renamed.`}</p>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
