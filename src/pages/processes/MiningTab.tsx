import { useMemo, useState } from "react";
import { Button, cx } from "@/components/ui";
import { buildBpmn, type BpmnGraph } from "@/lib/bpm/bpmn";
import { checkConformance, discoverProcess } from "@/lib/bpm/mining";
import type { ProcessElementInfo, ProcessModel } from "@/lib/types";
import { ActivityTable, LogLoader, LogSummary, SlowHandovers, VariantList, miningSummary, type LoadedLog } from "./miningParts";
import { formatDate } from "@/components/ui";
import { hoursLabel, percent } from "./shared";

interface Props {
  process: ProcessModel;
  graph: BpmnGraph;
  canEdit: boolean;
  loaded: LoadedLog | null;
  setLoaded: (l: LoadedLog | null) => void;
  saveSummary: (summary: NonNullable<ProcessModel["mining"]>) => void;
  applyTimes: (durations: Record<string, NonNullable<ProcessElementInfo["duration"]>>) => void;
  replaceModel: (xml: string, chances: Record<string, number>) => void;
  showOnModel: () => void;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** How the work really runs, compared with this model. */
export function MiningTab({ process, graph, canEdit, loaded, setLoaded, saveSummary, applyTimes, replaceModel, showOnModel }: Props) {
  const conformance = useMemo(() => (loaded ? checkConformance(loaded.log, graph) : null), [loaded, graph]);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const saved = process.mining;

  const times = () => {
    if (!loaded) return;
    const byName = new Map(loaded.analysis.activities.map((a) => [norm(a.name), a.medianMinutes]));
    const out: Record<string, NonNullable<ProcessElementInfo["duration"]>> = {};
    for (const n of Object.values(graph.nodes)) {
      const m = n.kind === "activity" ? byName.get(norm(n.name)) : null;
      if (m) out[n.id] = { min: Math.round(m * 5) / 10, mode: Math.round(m * 10) / 10, max: Math.round(m * 20) / 10 };
    }
    applyTimes(out);
  };

  const discover = () => {
    if (!loaded) return;
    const found = discoverProcess(loaded.log, loaded.analysis, 0.1);
    replaceModel(buildBpmn({ ...found.spec, name: process.name }), found.probabilities);
    setConfirmReplace(false);
  };

  return (
    <div className="space-y-6">
      {saved && !loaded && (
        <p className="text-[13px] text-ink-soft" data-mining-saved>
          Last compared with {saved.source} on {formatDate(saved.importedAt)}: {saved.cases.toLocaleString()} cases, {saved.fitness === null ? "" : `${percent(saved.fitness)} following the model, `}median {hoursLabel(saved.medianHours)}.{" "}
          <button type="button" className="text-blueprint hover:underline" onClick={showOnModel}>
            See it on the model
          </button>
        </p>
      )}
      <LogLoader onLoaded={setLoaded} compact={!!loaded} />
      {loaded && conformance && (
        <>
          <LogSummary loaded={loaded} />
          <section className="rounded-lg border border-line bg-surface px-4 py-3" data-conformance>
            <div className="flex flex-wrap items-baseline gap-3">
              <h3 className="text-sm font-semibold">Does the work follow the model?</h3>
              <span className={cx("text-2xl font-semibold tabular-nums", conformance.fitness >= 0.8 ? "text-ok" : conformance.fitness >= 0.5 ? "text-signal" : "text-danger")} data-fitness>
                {percent(conformance.fitness)}
              </span>
              <span className="text-[13px] text-ink-soft">
                of cases go from start to end the way the model allows ({conformance.conformingCases.toLocaleString()} of {loaded.analysis.cases.toLocaleString()}).
              </span>
            </div>
            <div className="mt-3 grid gap-4 md:grid-cols-3 text-[13px]">
              <div>
                <h4 className="font-medium">Steps the model does not allow</h4>
                {conformance.deviations.length ? (
                  <ul className="mt-1 space-y-0.5">
                    {conformance.deviations.slice(0, 8).map((d) => (
                      <li key={`${d.from}>${d.to}`}>
                        <span className="tabular-nums text-ink-soft">{d.count.toLocaleString()}×</span> {d.from} → {d.to}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-ink-soft">None.</p>
                )}
              </div>
              <div>
                <h4 className="font-medium">In the log but not the model</h4>
                <p className="mt-1 text-ink-soft">{conformance.unknown.length ? conformance.unknown.slice(0, 10).join(", ") : "Nothing: every activity has a step."}</p>
                <p className="mt-1 text-[12px] text-ink-faint">Steps are matched by name; rename a step to match its activity.</p>
              </div>
              <div>
                <h4 className="font-medium">In the model but never in the log</h4>
                <p className="mt-1 text-ink-soft">{conformance.unused.length ? conformance.unused.join(", ") : "Nothing."}</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="primary"
                onClick={() => {
                  if (canEdit) saveSummary(miningSummary(loaded, conformance.fitness));
                  showOnModel();
                }}
                data-mining-show
              >
                {canEdit ? "Keep the summary and show it on the model" : "Show it on the model"}
              </Button>
              {canEdit && (
                <Button onClick={times} title="Each step's least, usual and most time from the medians between events: these include waiting">
                  Use the log's times in the simulation
                </Button>
              )}
              {canEdit &&
                (confirmReplace ? (
                  <Button variant="danger" onClick={discover}>
                    Replace the model with the one from the log
                  </Button>
                ) : (
                  <Button onClick={() => setConfirmReplace(true)}>Draw the model from the log…</Button>
                ))}
            </div>
          </section>
          <div className="grid gap-6 lg:grid-cols-2">
            <VariantList analysis={loaded.analysis} />
            <SlowHandovers analysis={loaded.analysis} />
          </div>
          <ActivityTable analysis={loaded.analysis} />
        </>
      )}
    </div>
  );
}
