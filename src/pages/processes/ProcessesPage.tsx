import { ChevronRight, FileUp, GraduationCap, LayoutTemplate, LibraryBig, Pickaxe, Plus, Sparkles, Workflow } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Badge, Button, EmptyState, Input, Select, Tabs, cx, formatDate } from "@/components/ui";
import { useCanEdit } from "@/lib/cloud/session";
import { CATEGORY_LABEL, LEVEL_LABEL, STATUS_LABEL, childProcesses, repositoryStats, stepCount, systemsMatrix } from "@/lib/bpm/processes";
import { sampleLandscape } from "@/lib/bpm/templates";
import { TRAINING_EXAMPLES, TRAINING_TAG, addTrainingExamples } from "@/lib/bpm/training";
import { apply, useStore, useWorkspace } from "@/lib/store";
import type { ProcessModel, Workspace } from "@/lib/types";
import { NewProcessDialog, StatusBadge, pathLabel } from "./shared";

type View = "house" | "tree" | "list" | "systems";
type Start = { way: "blank" | "template" | "describe" | "import"; parentId?: string | null } | null;

/** The process landscape: every process, from the areas at the top to the sub-processes below. */
export default function ProcessesPage() {
  const ws = useWorkspace();
  const canEdit = useCanEdit();
  const [view, setView] = useState<View>("house");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ProcessModel["status"] | "all">("all");
  const [start, setStart] = useState<Start>(null);
  const all = useMemo(() => Object.values(ws.processes), [ws.processes]);
  const stats = repositoryStats(ws);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return new Set(all.filter((p) => (status === "all" || p.status === status) && (!q || `${p.name} ${p.owner} ${p.description} ${p.tags.join(" ")}`.toLowerCase().includes(q))).map((p) => p.id));
  }, [all, query, status]);
  const filtering = !!query.trim() || status !== "all";
  const navigate = useNavigate();
  const trainingArea = all.find((p) => p.level === 0 && p.tags.includes(TRAINING_TAG));
  const trainingDone = !!trainingArea && TRAINING_EXAMPLES.every((t) => all.some((p) => p.parentId === trainingArea.id && p.tags.includes(t.id)));
  const training = () => {
    if (trainingDone) return navigate(`/processes/${trainingArea!.id}`);
    const made = addTrainingExamples(useStore.getState().ws);
    apply(() => made.ws);
    navigate(`/processes/${made.areaId}`);
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Process landscape</h1>
          <p className="text-ink-soft mt-0.5 max-w-2xl">
            The work the organisation does, from its process areas down to each step. Model a process in BPMN 2.0, see who does what and which systems it runs on, try a change in a simulation before making it, and compare the model with how the work really runs.
          </p>
        </div>
        {canEdit && (
          <div className="flex gap-2 shrink-0">
            <Link to="/bpmn-library" className="inline-flex items-center gap-1.5 h-8.5 px-3 rounded-md border border-line text-sm font-medium hover:border-ink-faint">
              <LibraryBig size={15} aria-hidden /> BPMN library
            </Link>
            <Button icon={<GraduationCap size={15} />} onClick={training} data-process-training-add>
              {trainingDone ? "Training examples" : "Add training examples"}
            </Button>
            <Button icon={<FileUp size={15} />} onClick={() => setStart({ way: "import" })}>
              From a file or picture
            </Button>
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => setStart({ way: "blank" })} data-process-new>
              New process
            </Button>
          </div>
        )}
      </div>

      {all.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-ink-faint bg-surface">
          <EmptyState title="No processes yet" text={canEdit ? "Start from a common process and change it to fit, describe one in your own words, or bring a BPMN file from another tool." : "An owner or editor can add the first process."}>
            {canEdit && (
              <>
                <Button icon={<LayoutTemplate size={15} />} onClick={() => setStart({ way: "template" })}>
                  From a template
                </Button>
                <Button icon={<Sparkles size={15} />} onClick={() => setStart({ way: "describe" })}>
                  Describe it
                </Button>
                <Button variant="primary" icon={<Workflow size={15} />} onClick={() => apply((w) => sampleLandscape(w))} data-process-sample>
                  Start with a sample landscape
                </Button>
              </>
            )}
          </EmptyState>
        </div>
      ) : (
        <>
          <dl className="mt-5 grid grid-cols-2 sm:grid-cols-5 gap-px rounded-lg border border-line bg-line overflow-hidden" data-process-stats>
            {[
              ["Processes", stats.total],
              ["Modelled", stats.modelled],
              ["Published", stats.published],
              ["In review", stats.inReview],
              ["Without an owner", stats.withoutOwner],
            ].map(([label, n]) => (
              <div key={label} className="bg-surface px-4 py-2.5">
                <dt className="text-[13px] text-ink-soft">{label}</dt>
                <dd className={cx("text-lg font-semibold tabular-nums", label === "Without an owner" && Number(n) > 0 && "text-signal")}>{n}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Tabs
              tabs={[
                { id: "house", label: "Process house" },
                { id: "tree", label: "Hierarchy" },
                { id: "list", label: "List" },
                { id: "systems", label: "Processes and systems" },
              ]}
              value={view}
              onChange={setView}
            />
            <div className="ml-auto flex gap-2">
              <div className="w-56">
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search processes" aria-label="Search processes" />
              </div>
              <div className="w-36">
                <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status">
                  <option value="all">Any status</option>
                  {Object.entries(STATUS_LABEL).map(([id, l]) => (
                    <option key={id} value={id}>
                      {l}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          </div>
          <div className="mt-4">
            {view === "house" && <House ws={ws} matches={matches} filtering={filtering} canEdit={canEdit} onAdd={(parentId) => setStart({ way: "blank", parentId })} />}
            {view === "tree" && <Tree ws={ws} matches={matches} filtering={filtering} canEdit={canEdit} onAdd={(parentId) => setStart({ way: "blank", parentId })} />}
            {view === "list" && <List ws={ws} matches={matches} />}
            {view === "systems" && <SystemsMatrix ws={ws} />}
          </div>
          <p className="mt-6 text-[13px] text-ink-soft flex items-center gap-1.5">
            <Pickaxe size={14} aria-hidden /> Have an export from an ERP, CRM or ticketing system?{" "}
            <Link to="/process-mining" className="font-medium text-blueprint hover:underline">
              Discover the process from its event log
            </Link>
            .
          </p>
        </>
      )}
      {start && <NewProcessDialog start={start.way} parentId={start.parentId} onClose={() => setStart(null)} />}
    </div>
  );
}

function ProcessLink({ p, className }: { p: ProcessModel; className?: string }) {
  return (
    <Link to={`/processes/${p.id}`} className={cx("hover:underline", className)} data-process-link={p.id}>
      {p.name}
    </Link>
  );
}

/** Kept when it matches, or anything inside it does. */
function visible(ws: Workspace, p: ProcessModel, matches: Set<string>, filtering: boolean): boolean {
  if (!filtering || matches.has(p.id)) return true;
  return childProcesses(ws, p.id).some((c) => visible(ws, c, matches, filtering));
}

/** Management on top, the core processes in the middle, support underneath: the usual process house. */
function House({ ws, matches, filtering, canEdit, onAdd }: { ws: Workspace; matches: Set<string>; filtering: boolean; canEdit: boolean; onAdd: (parentId: string | null) => void }) {
  const tops = childProcesses(ws, null);
  return (
    <div className="space-y-3" data-process-house>
      {(Object.keys(CATEGORY_LABEL) as ProcessModel["category"][]).map((category) => {
        const areas = tops.filter((p) => p.category === category && visible(ws, p, matches, filtering));
        return (
          <section key={category} className={cx("rounded-lg border px-4 py-3", category === "core" ? "border-blueprint/40 bg-blueprint-soft/50" : "border-line bg-surface")} data-house-band={category}>
            <h2 className="text-sm font-semibold">{CATEGORY_LABEL[category]}</h2>
            {areas.length === 0 ? (
              <p className="mt-1 text-[13px] text-ink-soft">None yet.</p>
            ) : (
              <ul className="mt-2 grid gap-2.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(210px, 1fr))` }}>
                {areas.map((area) => (
                  <li key={area.id} className="rounded-md border border-line bg-surface px-3 py-2">
                    <div className="flex items-start gap-2">
                      <ProcessLink p={area} className="font-medium leading-snug" />
                      <span className="ml-auto shrink-0 text-[11px] text-ink-faint">L{area.level}</span>
                    </div>
                    <ul className="mt-1.5 space-y-1">
                      {childProcesses(ws, area.id)
                        .filter((c) => visible(ws, c, matches, filtering))
                        .map((c) => (
                          <li key={c.id} className="text-[13px]">
                            <div className="flex items-center gap-1.5">
                              <span className={cx("size-1.5 rounded-full shrink-0", c.status === "published" ? "bg-ok" : c.status === "review" ? "bg-signal" : "bg-ink-faint")} aria-hidden />
                              <ProcessLink p={c} />
                            </div>
                            {childProcesses(ws, c.id).length > 0 && (
                              <ul className="ml-3 mt-0.5 space-y-0.5 text-ink-soft">
                                {childProcesses(ws, c.id)
                                  .filter((g) => visible(ws, g, matches, filtering))
                                  .map((g) => (
                                    <li key={g.id}>
                                      <ProcessLink p={g} />
                                    </li>
                                  ))}
                              </ul>
                            )}
                          </li>
                        ))}
                    </ul>
                    {canEdit && area.level < 4 && (
                      <button type="button" className="mt-1.5 text-[12px] text-blueprint hover:underline" onClick={() => onAdd(area.id)}>
                        Add inside
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {canEdit && (
        <Button size="sm" icon={<Plus size={14} />} onClick={() => onAdd(null)}>
          Add a process area
        </Button>
      )}
    </div>
  );
}

function Tree({ ws, matches, filtering, canEdit, onAdd }: { ws: Workspace; matches: Set<string>; filtering: boolean; canEdit: boolean; onAdd: (parentId: string) => void }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const rows: { p: ProcessModel; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const p of childProcesses(ws, parent)) {
      if (!visible(ws, p, matches, filtering)) continue;
      rows.push({ p, depth });
      if (!closed.has(p.id)) walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  return (
    <ul className="rounded-lg border border-line bg-surface divide-y divide-line-soft" data-process-tree>
      {rows.map(({ p, depth }) => {
        const kids = childProcesses(ws, p.id).length;
        return (
          <li key={p.id} className="flex items-center gap-2 pr-3 h-10" style={{ paddingLeft: 12 + depth * 22 }}>
            <button
              type="button"
              className={cx("size-5 grid place-items-center rounded text-ink-faint hover:bg-line-soft", !kids && "invisible")}
              aria-label={closed.has(p.id) ? `Open ${p.name}` : `Close ${p.name}`}
              aria-expanded={!closed.has(p.id)}
              onClick={() => setClosed((s) => (s.has(p.id) ? new Set([...s].filter((x) => x !== p.id)) : new Set([...s, p.id])))}
            >
              <ChevronRight size={14} className={cx("transition-transform", !closed.has(p.id) && "rotate-90")} />
            </button>
            <span className="w-7 text-[11px] text-ink-faint tabular-nums">L{p.level}</span>
            <ProcessLink p={p} className={cx(p.level <= 1 && "font-medium")} />
            {p.level >= 2 && <StatusBadge process={p} />}
            <span className="ml-auto text-[13px] text-ink-soft truncate max-w-[180px]">{p.owner}</span>
            {canEdit && p.level < 4 && (
              <button type="button" className="text-[12px] text-blueprint hover:underline" onClick={() => onAdd(p.id)}>
                Add inside
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function List({ ws, matches }: { ws: Workspace; matches: Set<string> }) {
  const rows = Object.values(ws.processes)
    .filter((p) => matches.has(p.id))
    .sort((a, b) => pathLabel(ws, a.id).localeCompare(pathLabel(ws, b.id)));
  return (
    <div className="rounded-lg border border-line bg-surface overflow-x-auto">
      <table className="w-full text-sm" data-process-list>
        <thead className="text-left text-[13px] text-ink-soft">
          <tr className="border-b border-line">
            <th className="px-4 py-2 font-medium">Process</th>
            <th className="px-3 py-2 font-medium">Level</th>
            <th className="px-3 py-2 font-medium">Owner</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Steps</th>
            <th className="px-3 py-2 font-medium">Changed</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">
          {rows.map((p) => (
            <tr key={p.id}>
              <td className="px-4 py-2">
                <ProcessLink p={p} className="font-medium" />
                {p.parentId && <span className="block text-[12px] text-ink-faint">{pathLabel(ws, p.parentId)}</span>}
              </td>
              <td className="px-3 py-2 text-ink-soft whitespace-nowrap">{LEVEL_LABEL[p.level]}</td>
              <td className="px-3 py-2">{p.owner || <span className="text-ink-faint">No owner</span>}</td>
              <td className="px-3 py-2">
                <StatusBadge process={p} />
              </td>
              <td className="px-3 py-2 tabular-nums text-ink-soft">{p.xml ? stepCount(p.xml) : "–"}</td>
              <td className="px-3 py-2 text-ink-soft whitespace-nowrap">{formatDate(p.updatedAt)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-3 text-ink-soft">
                Nothing matches.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Which systems each process runs on, from the systems linked to its steps. */
function SystemsMatrix({ ws }: { ws: Workspace }) {
  const m = useMemo(() => systemsMatrix(ws), [ws]);
  if (!m.systems.length) {
    return (
      <div className="rounded-lg border border-dashed border-ink-faint bg-surface">
        <EmptyState title="No systems are linked to steps yet" text="Open a process, select a step, and link the applications and data it uses. This matrix then shows which processes depend on each system." />
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-line bg-surface overflow-auto max-h-[70vh]" data-process-systems>
      <table className="text-sm border-separate border-spacing-0">
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-10 bg-surface px-4 py-2 text-left font-medium text-ink-soft border-b border-line">Process</th>
            {m.systems.map((s) => (
              <th key={s.id} className="sticky top-0 bg-surface px-2 py-2 border-b border-line font-medium text-[12px] align-bottom">
                <Link to={`/model?object=${s.id}`} className="block max-w-[110px] truncate hover:underline" title={s.name}>
                  {s.name}
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {m.processes.map((p) => (
            <tr key={p.id}>
              <th className="sticky left-0 bg-surface px-4 py-1.5 text-left font-normal border-b border-line-soft whitespace-nowrap">
                <ProcessLink p={p} />
              </th>
              {m.systems.map((s) => {
                const steps = m.cells[p.id]?.[s.id];
                return (
                  <td key={s.id} className="px-2 py-1.5 text-center border-b border-line-soft">
                    {steps ? (
                      <span title={steps.join(", ")}>
                        <Badge tone="blue">{steps.length}</Badge>
                      </span>
                    ) : (
                      ""
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
