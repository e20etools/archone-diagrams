import { ArrowLeft, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import BpmnCanvas from "@/components/bpm/BpmnCanvas";
import { Button, Field, Select } from "@/components/ui";
import { useCanEdit } from "@/lib/cloud/session";
import { buildBpmn, parseBpmn } from "@/lib/bpm/bpmn";
import { checkConformance, discoverProcess, stepCounts } from "@/lib/bpm/mining";
import { createProcess, graphOf } from "@/lib/bpm/processes";
import { apply, useStore, useWorkspace } from "@/lib/store";
import type { ProcessElementInfo } from "@/lib/types";
import { ActivityTable, LogLoader, LogSummary, SlowHandovers, VariantList, miningSummary, type LoadedLog } from "./miningParts";
import { pathLabel, percent } from "./shared";

/** Process mining: the process as it really runs, drawn from an event log. */
export default function MiningPage() {
  const ws = useWorkspace();
  const canEdit = useCanEdit();
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState<LoadedLog | null>(null);
  const [detail, setDetail] = useState(0.15);
  const [against, setAgainst] = useState("");

  const discovered = useMemo(() => {
    if (!loaded) return null;
    const found = discoverProcess(loaded.log, loaded.analysis, detail);
    const xml = buildBpmn(found.spec);
    const graph = parseBpmn(xml);
    const counts = stepCounts(graph, loaded.analysis);
    const top = Math.max(1, ...Object.values(counts));
    return {
      ...found,
      xml,
      overlays: Object.fromEntries(Object.entries(counts).map(([id, n]) => [id, { text: `${n.toLocaleString()}×`, tone: "blue" as const, title: `Done ${n.toLocaleString()} times` }])),
      heat: Object.fromEntries(Object.entries(counts).map(([id, n]) => [id, n / top])),
    };
  }, [loaded, detail]);

  const modelled = Object.values(ws.processes).filter((p) => p.xml);
  const conformance = useMemo(() => {
    const p = against ? ws.processes[against] : undefined;
    const graph = p ? graphOf(p) : null;
    return loaded && graph ? checkConformance(loaded.log, graph) : null;
  }, [loaded, against, ws.processes]);

  const create = () => {
    if (!loaded || !discovered) return;
    const elements: Record<string, ProcessElementInfo> = {};
    for (const [flowId, probability] of Object.entries(discovered.probabilities)) elements[flowId] = { objectIds: [], raci: {}, probability };
    const graph = parseBpmn(discovered.xml);
    for (const n of Object.values(graph.nodes)) {
      const m = loaded.analysis.activities.find((a) => a.name === n.name)?.medianMinutes;
      if (n.kind === "activity" && m) elements[n.id] = { objectIds: [], raci: {}, duration: { min: Math.round(m * 0.5 * 10) / 10, mode: Math.round(m * 10) / 10, max: Math.round(m * 2 * 10) / 10 } };
    }
    const made = createProcess(useStore.getState().ws, {
      name: discovered.spec.name.replace(/[-_]+/g, " ").replace(/\b\w/, (c) => c.toUpperCase()) || "Discovered process",
      description: `Discovered from ${loaded.fileName}: ${loaded.analysis.cases.toLocaleString()} cases. Step times are the medians between events, so they include waiting.`,
      xml: discovered.xml,
      elements,
    });
    made.ws.processes[made.process.id] = { ...made.ws.processes[made.process.id], mining: miningSummary(loaded, 1) };
    apply(() => made.ws);
    navigate(`/processes/${made.process.id}`);
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-7">
      <Link to="/processes" className="inline-flex items-center gap-1 text-[13px] text-ink-soft hover:text-ink">
        <ArrowLeft size={14} aria-hidden /> Process landscape
      </Link>
      <h1 className="mt-1 text-xl font-semibold">Process mining</h1>
      <p className="text-ink-soft mt-0.5 max-w-2xl">See how the work really runs from the events your systems record: the paths cases take and how often, where they wait, where work is done twice, and how far it keeps to the process as modelled.</p>
      <div className="mt-5">
        <LogLoader onLoaded={setLoaded} compact={!!loaded} />
      </div>
      {loaded && discovered && (
        <div className="mt-6 space-y-6">
          <LogSummary loaded={loaded} />
          <section>
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <h2 className="text-base font-semibold">The process as it runs</h2>
                <p className="text-[13px] text-ink-soft">Each step shows how often it was done; the darker, the busier. Decisions show the share of cases going each way.</p>
              </div>
              <div className="ml-auto w-64">
                <Field label={`Paths shown: ${detail === 0 ? "all" : `those taken ${percent(detail)} as often as the busiest`}`}>
                  <input type="range" min={0} max={0.6} step={0.05} value={detail} onChange={(e) => setDetail(Number(e.target.value))} className="w-full accent-[var(--color-blueprint)]" aria-label="Paths shown" data-mining-detail />
                </Field>
              </div>
            </div>
            <div className="mt-2 h-[520px] rounded-lg border border-line overflow-hidden" data-mining-map>
              <BpmnCanvas xml={discovered.xml} editable={false} overlays={discovered.overlays} heat={discovered.heat} label="The process discovered from the log" />
            </div>
            {canEdit && (
              <div className="mt-2">
                <Button variant="primary" icon={<Plus size={15} />} onClick={create} data-mining-create>
                  Make it a process to model
                </Button>
              </div>
            )}
          </section>
          <div className="grid gap-6 lg:grid-cols-2">
            <VariantList analysis={loaded.analysis} />
            <div className="space-y-6">
              <SlowHandovers analysis={loaded.analysis} />
              <section>
                <h3 className="text-sm font-semibold">Compare with a modelled process</h3>
                {modelled.length ? (
                  <div className="mt-2 max-w-sm">
                    <Select value={against} onChange={(e) => setAgainst(e.target.value)} aria-label="Process to compare with" data-mining-against>
                      <option value="">Choose a process</option>
                      {modelled.map((p) => (
                        <option key={p.id} value={p.id}>
                          {pathLabel(ws, p.id)}
                        </option>
                      ))}
                    </Select>
                  </div>
                ) : (
                  <p className="mt-1 text-[13px] text-ink-soft">No process has a model yet.</p>
                )}
                {conformance && (
                  <div className="mt-3 text-[13px] space-y-1.5" data-mining-conformance>
                    <p>
                      <span className="text-lg font-semibold tabular-nums">{percent(conformance.fitness)}</span> of cases follow the model from start to end ({conformance.conformingCases.toLocaleString()} of {loaded.analysis.cases.toLocaleString()}).
                    </p>
                    {conformance.deviations.slice(0, 5).map((d) => (
                      <p key={`${d.from}>${d.to}`} className="text-ink-soft">
                        {d.count.toLocaleString()}× {d.from} → {d.to}, which the model does not allow
                      </p>
                    ))}
                    {conformance.unknown.length > 0 && <p className="text-ink-soft">Not in the model: {conformance.unknown.slice(0, 6).join(", ")}.</p>}
                    <Link to={`/processes/${against}?tab=mining`} className="inline-block font-medium text-blueprint hover:underline">
                      Open the process to see it on the model
                    </Link>
                  </div>
                )}
              </section>
            </div>
          </div>
          <ActivityTable analysis={loaded.analysis} />
        </div>
      )}
    </div>
  );
}
