import { Download } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { DiagramCanvas, type Highlight } from "@/components/canvas/DiagramCanvas";
import { TypeIcon } from "@/components/icons";
import { Badge, Button, EmptyState, Select, Tabs } from "@/components/ui";
import { RELATION_KIND_INFO, objectType } from "@/lib/catalog";
import { downloadText, slugify, toCsv } from "@/lib/exporters";
import { impactOf, pathTo, traverse, type ChangeKind, type Reach } from "@/lib/graph";
import { autoLayout } from "@/lib/layout";
import { childrenOf, sortedObjects } from "@/lib/model";
import { useWorkspace } from "@/lib/store";
import { RELATION_KINDS, type Diagram, type Workspace } from "@/lib/types";
import { visibleEdges } from "@/lib/views";

type Mode = "needs" | "neededBy" | "impact";
const DEPENDENCY_KINDS = RELATION_KINDS.filter((k) => RELATION_KIND_INFO[k].dependency);
/** More boxes than this stop being readable; the table still lists everything. */
const MAP_LIMIT = 60;

/** A throwaway diagram of the focus object and what was reached. It is drawn, never saved. */
export function analysisDiagram(ws: Workspace, key: string, ids: string[]): Diagram {
  const stamp = ws.updatedAt;
  const base: Diagram = {
    id: `analysis:${key}`,
    name: "Dependency map",
    description: "",
    viewType: "custom",
    scopeId: null,
    direction: "LR",
    nodes: Object.fromEntries(ids.map((id) => [id, { x: 0, y: 0, pinned: false }])),
    hiddenRelationshipIds: [],
    edgeKinds: DEPENDENCY_KINDS,
    colorBy: "type",
    createdAt: stamp,
    updatedAt: stamp,
  };
  const positions = autoLayout({ nodeIds: ids, edges: visibleEdges(ws, base), direction: "LR", respectPinned: false });
  return { ...base, nodes: Object.fromEntries(ids.map((id) => [id, { ...positions[id], pinned: false }])) };
}

function ReachTable({ ws, reaches, onFocus, empty }: { ws: Workspace; reaches: Reach[]; onFocus: (id: string) => void; empty: string }) {
  if (!reaches.length) return <p className="px-4 py-6 text-center text-ink-soft">{empty}</p>;
  const rows = [...reaches].sort((a, b) => a.distance - b.distance || ws.objects[a.id].name.localeCompare(ws.objects[b.id].name));
  return (
    <table className="w-full text-left">
      <thead className="text-[13px] text-ink-soft bg-paper border-b border-line">
        <tr>
          <th className="font-medium px-4 py-2.5">Object</th>
          <th className="font-medium px-3 py-2.5">Owner</th>
          <th className="font-medium px-3 py-2.5 text-right">Steps away</th>
          <th className="font-medium px-3 py-2.5">Path</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const o = ws.objects[r.id];
          return (
            <tr key={r.id} className="border-b border-line-soft last:border-b-0">
              <td className="px-4 py-2.5">
                <button type="button" className="flex items-center gap-2 text-left font-medium text-blueprint hover:underline" onClick={() => onFocus(o.id)}>
                  <span className="text-ink-soft">
                    <TypeIcon typeId={o.typeId} size={15} />
                  </span>
                  {o.name}
                </button>
              </td>
              <td className="px-3 py-2.5 text-ink-soft">{o.owner || <span className="text-ink-faint">None</span>}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{r.distance}</td>
              <td className="px-3 py-2.5 text-[13px] text-ink-soft">{pathTo(ws, reaches, r.id).join(" > ")}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function AnalysisPage() {
  const ws = useWorkspace();
  const [params, setParams] = useSearchParams();
  const focusId = params.get("object") ?? "";
  const focus = ws.objects[focusId];
  const [mode, setMode] = useState<Mode>("neededBy");
  const [includeChildren, setIncludeChildren] = useState(true);
  const [depth, setDepth] = useState("all");
  const [change, setChange] = useState<ChangeKind>("changing");
  const objects = useMemo(() => sortedObjects(ws), [ws]);
  const setFocus = (id: string) => setParams(id ? { object: id } : {}, { replace: true });

  const options = useMemo(() => ({ includeChildren, maxDepth: depth === "all" ? undefined : Number(depth) }), [includeChildren, depth]);
  const upstream = useMemo(() => (focus ? traverse(ws, focus.id, "upstream", options) : []), [ws, focus, options]);
  const downstream = useMemo(() => (focus ? traverse(ws, focus.id, "downstream", options) : []), [ws, focus, options]);
  const report = useMemo(() => (focus ? impactOf(ws, focus.id, change, options) : null), [ws, focus, change, options]);

  const shown = mode === "needs" ? upstream : downstream;
  const map = useMemo(() => {
    if (!focus) return null;
    const nearest = [...shown].sort((a, b) => a.distance - b.distance).slice(0, MAP_LIMIT);
    const ids = [focus.id, ...nearest.map((r) => r.id)];
    const diagram = analysisDiagram(ws, `${focus.id}:${mode}:${depth}:${includeChildren}`, ids);
    const highlight: Record<string, Highlight> = { [focus.id]: "focus" };
    for (const r of nearest) highlight[r.id] = mode === "needs" ? "up" : "down";
    return { diagram, highlight, cut: shown.length - nearest.length };
  }, [ws, focus, shown, mode, depth, includeChildren]);

  if (objects.length === 0) {
    return (
      <EmptyState title="Nothing to analyse yet" text="Dependencies are read from the model. Add objects and relationships first.">
        <Link to="/" className="font-medium text-blueprint hover:underline">
          Go to diagrams
        </Link>
      </EmptyState>
    );
  }

  const nested = focus ? childrenOf(ws, focus.id).length : 0;
  const exportCsv = () => {
    if (!focus) return;
    if (mode === "impact" && report) {
      const rows = [
        ["Affected object", "Type", "Owner", "Steps away", "Path", "Part of", "Diagrams"],
        ...report.affected.map((a) => [
          a.object.name,
          objectType(a.object.typeId).label,
          a.object.owner,
          String(a.distance),
          a.path.join(" > "),
          a.partOf.join(" > "),
          a.diagrams.map((d) => d.name).join("; "),
        ]),
      ];
      downloadText(`impact-${slugify(focus.name)}.csv`, toCsv(rows), "text/csv");
      return;
    }
    const rows = [
      ["Object", "Type", "Owner", "Steps away", "Path"],
      ...shown.map((r) => [ws.objects[r.id].name, objectType(ws.objects[r.id].typeId).label, ws.objects[r.id].owner, String(r.distance), pathTo(ws, shown, r.id).join(" > ")]),
    ];
    downloadText(`${mode === "needs" ? "needs" : "needed-by"}-${slugify(focus.name)}.csv`, toCsv(rows), "text/csv");
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-7">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Dependencies</h1>
          <p className="text-ink-soft mt-0.5">Follow what an object needs, what needs it, and who to tell before it changes. Read from the whole model, not one diagram.</p>
        </div>
        {focus && (
          <Button icon={<Download size={15} />} onClick={exportCsv} disabled={mode === "impact" ? !report?.affected.length : !shown.length}>
            Export CSV
          </Button>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="block text-[13px] font-medium mb-1">Object</span>
          <Select className="!w-72" value={focus ? focus.id : ""} onChange={(e) => setFocus(e.target.value)}>
            <option value="">Choose an object</option>
            {objects.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} ({objectType(o.typeId).label})
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="block text-[13px] font-medium mb-1">How far</span>
          <Select className="!w-40" value={depth} onChange={(e) => setDepth(e.target.value)}>
            <option value="1">1 step</option>
            <option value="2">2 steps</option>
            <option value="3">3 steps</option>
            <option value="all">All the way</option>
          </Select>
        </label>
        {nested > 0 && (
          <label className="flex items-center gap-2 h-9 text-sm cursor-pointer">
            <input type="checkbox" className="accent-blueprint" checked={includeChildren} onChange={(e) => setIncludeChildren(e.target.checked)} />
            Count the {nested} {nested === 1 ? "object" : "objects"} inside it
          </label>
        )}
      </div>

      {!focus ? (
        <div className="mt-6 rounded-lg border border-dashed border-ink-faint bg-surface">
          <EmptyState title="Choose an object to analyse" text="Pick one above, or open any object on a diagram and choose Dependencies." />
        </div>
      ) : (
        <>
          <div className="mt-5">
            <Tabs
              tabs={[
                { id: "neededBy", label: "What needs it", count: downstream.length },
                { id: "needs", label: "What it needs", count: upstream.length },
                { id: "impact", label: "Impact of a change" },
              ]}
              value={mode}
              onChange={setMode}
            />
          </div>

          {mode === "impact" && report && (
            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
              <span className="text-sm font-medium">The change</span>
              {(["changing", "retiring"] as const).map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="change" className="accent-blueprint" checked={change === c} onChange={() => setChange(c)} />
                  {c === "changing" ? `${focus.name} changes` : `${focus.name} is retired`}
                </label>
              ))}
            </div>
          )}

          {mode === "impact" && report && (
            <dl className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: "Objects affected", value: report.affected.length },
                { label: "Owners to tell", value: report.owners.filter((o) => o.owner).length },
                { label: "Diagrams that show them", value: report.diagrams.length },
                { label: "Relationships that break", value: change === "retiring" ? report.brokenRelationships.length : 0, muted: change !== "retiring" },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-line bg-surface px-4 py-3">
                  <dt className="text-[13px] text-ink-soft">{s.label}</dt>
                  <dd className={`text-2xl font-semibold tabular-nums mt-0.5 ${s.muted ? "text-ink-faint" : ""}`}>{s.muted ? "n/a" : s.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {map && (
            <div className="mt-4 rounded-lg border border-line bg-surface overflow-hidden">
              <div className="h-[380px]">
                <DiagramCanvas ws={ws} diagram={map.diagram} readOnly highlight={map.highlight} onOpen={setFocus} />
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 border-t border-line-soft text-[13px] text-ink-soft">
                <span>An arrow points from an object to what it needs.</span>
                <span>Double-click a box to analyse it instead.</span>
                {map.cut > 0 && (
                  <span className="text-signal">
                    The map shows the nearest {MAP_LIMIT}. The table below lists all {shown.length}.
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="mt-4 rounded-lg border border-line bg-surface overflow-hidden">
            {mode !== "impact" ? (
              <ReachTable
                ws={ws}
                reaches={shown}
                onFocus={setFocus}
                empty={mode === "needs" ? `${focus.name} does not depend on anything in the model.` : `Nothing in the model depends on ${focus.name}.`}
              />
            ) : report && report.affected.length ? (
              <table className="w-full text-left">
                <thead className="text-[13px] text-ink-soft bg-paper border-b border-line">
                  <tr>
                    <th className="font-medium px-4 py-2.5">Affected object</th>
                    <th className="font-medium px-3 py-2.5">Owner</th>
                    <th className="font-medium px-3 py-2.5">How it is reached</th>
                    <th className="font-medium px-3 py-2.5">Shown on</th>
                  </tr>
                </thead>
                <tbody>
                  {report.affected.map((a) => (
                    <tr key={a.object.id} className="border-b border-line-soft last:border-b-0 align-top">
                      <td className="px-4 py-2.5">
                        <button type="button" className="font-medium text-blueprint hover:underline text-left" onClick={() => setFocus(a.object.id)}>
                          {a.object.name}
                        </button>
                        <span className="ml-2">
                          <Badge tone={a.distance === 1 ? "red" : "neutral"}>{a.distance === 1 ? "Direct" : `${a.distance} steps`}</Badge>
                        </span>
                        {a.partOf.length > 0 && <span className="block text-xs text-ink-faint">in {a.partOf[0]}</span>}
                      </td>
                      <td className="px-3 py-2.5 text-ink-soft">{a.object.owner || <span className="text-ink-faint">None</span>}</td>
                      <td className="px-3 py-2.5 text-[13px] text-ink-soft">{a.path.join(" > ")}</td>
                      <td className="px-3 py-2.5 text-[13px]">
                        {a.diagrams.length ? (
                          a.diagrams.map((d, i) => (
                            <span key={d.id}>
                              {i > 0 && ", "}
                              <Link to={`/diagram/${d.id}`} className="text-blueprint hover:underline">
                                {d.name}
                              </Link>
                            </span>
                          ))
                        ) : (
                          <span className="text-ink-faint">No diagram</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="px-4 py-6 text-center text-ink-soft">Nothing in the model depends on {focus.name}, so this change affects nothing else.</p>
            )}
          </div>

          {mode === "impact" && report && (report.owners.length > 0 || report.brokenRelationships.length > 0) && (
            <div className="mt-4 grid md:grid-cols-2 gap-4">
              {report.owners.length > 0 && (
                <section className="rounded-lg border border-line bg-surface px-4 py-3.5">
                  <h2 className="text-sm font-semibold">Owners to tell</h2>
                  <ul className="mt-2 space-y-1 text-sm">
                    {report.owners.map((o) => (
                      <li key={o.owner || "none"} className="flex justify-between gap-3">
                        <span className={o.owner ? "" : "text-signal"}>{o.owner || "No owner recorded"}</span>
                        <span className="text-ink-soft tabular-nums">
                          {o.count} {o.count === 1 ? "object" : "objects"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {report.brokenRelationships.length > 0 && (
                <section className="rounded-lg border border-line bg-surface px-4 py-3.5">
                  <h2 className="text-sm font-semibold">Relationships that break</h2>
                  <ul className="mt-2 space-y-1 text-sm">
                    {report.brokenRelationships.map((r) => (
                      <li key={r.id}>
                        <span className="font-medium">{ws.objects[r.sourceId]?.name}</span>{" "}
                        <span className="text-ink-soft">{r.label || RELATION_KIND_INFO[r.kind].verb}</span>{" "}
                        <span className="font-medium">{ws.objects[r.targetId]?.name}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
