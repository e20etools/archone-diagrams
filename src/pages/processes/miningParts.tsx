import { FileUp, FlaskConical } from "lucide-react";
import { useRef, useState } from "react";
import { Button, Field, Select, cx, formatDate } from "@/components/ui";
import { LogError, analyseLog, guessColumns, readEventLog, sampleEventLog, type CsvColumns, type EventLog, type LogAnalysis } from "@/lib/bpm/mining";
import { hoursLabel, minutesLabel, percent } from "./shared";

export interface LoadedLog {
  log: EventLog;
  analysis: LogAnalysis;
  fileName: string;
}

const MAX_BYTES = 40 * 1024 * 1024;

/** Reads an event log from a file on this computer. The log is not uploaded or kept. */
export function LogLoader({ onLoaded, compact }: { onLoaded: (loaded: LoadedLog) => void; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  // A CSV whose columns could not be told apart waits here for the person to say which is which.
  const [pending, setPending] = useState<{ name: string; text: string; headings: string[]; columns: CsvColumns } | null>(null);
  // An object-centric log: which kind of object to follow.
  const [ocel, setOcel] = useState<{ name: string; text: string; types: string[]; chosen: string } | null>(null);

  const read = (name: string, text: string, options: Parameters<typeof readEventLog>[2] = {}) => {
    setProblem("");
    try {
      const log = readEventLog(name, text, options);
      if (log.format === "OCEL 2.0" && (log.objectTypes?.length ?? 0) > 1) setOcel({ name, text, types: log.objectTypes!, chosen: log.caseType ?? "" });
      else setOcel(null);
      setPending(null);
      onLoaded({ log, analysis: analyseLog(log), fileName: name });
    } catch (error) {
      if (error instanceof LogError && /\.csv$|\.txt$/i.test(name)) {
        const first = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
        const delimiter = [",", ";", "\t", "|"].sort((a, b) => first.split(b).length - first.split(a).length)[0];
        const headings = first.split(delimiter).map((h) => h.replace(/^"|"$/g, "").trim());
        setPending({ name, text, headings, columns: guessColumns(headings) });
      }
      setProblem(error instanceof Error ? error.message : "The log could not be read.");
    }
  };

  const open = async (file: File) => {
    if (file.size > MAX_BYTES) return setProblem("The file is larger than 40 MB. Export a shorter period, or only the columns for the case, activity, time and resource.");
    setBusy(true);
    try {
      read(file.name, await file.text());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-log-loader>
      <input ref={input} type="file" accept=".csv,.txt,.xes,.json,.jsonocel,.xml" className="sr-only" onChange={(e) => e.target.files?.[0] && void open(e.target.files[0])} data-log-file />
      <div className="flex flex-wrap gap-2">
        <Button variant={compact ? "secondary" : "primary"} icon={<FileUp size={15} />} disabled={busy} onClick={() => input.current?.click()}>
          {busy ? "Reading…" : "Open an event log"}
        </Button>
        <Button icon={<FlaskConical size={15} />} onClick={() => read("purchase-to-pay-sample.csv", sampleEventLog())} data-log-sample>
          Try a sample log
        </Button>
      </div>
      {!compact && <p className="mt-2 text-[13px] text-ink-soft max-w-2xl">A CSV with a case, an activity and a time for each event (and who did it, if you have it), an XES file, or an OCEL 2.0 JSON file. It is read in this browser: the events are not uploaded or kept, only a summary when you choose to save one.</p>}
      {pending && (
        <div className="mt-3 rounded-md border border-line bg-paper px-3 py-3 max-w-2xl" data-log-columns>
          <p className="text-[13px] font-medium">Which columns hold what?</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-4">
            {(
              [
                ["caseId", "Case"],
                ["activity", "Activity"],
                ["time", "Time"],
                ["resource", "Who (optional)"],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <Select value={pending.columns[key]} onChange={(e) => setPending({ ...pending, columns: { ...pending.columns, [key]: Number(e.target.value) } })}>
                  <option value={-1}>None</option>
                  {pending.headings.map((h, i) => (
                    <option key={`${h}${i}`} value={i}>
                      {h || `Column ${i + 1}`}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
          </div>
          <Button size="sm" variant="primary" className="mt-2" onClick={() => read(pending.name, pending.text, { columns: pending.columns })}>
            Read the log
          </Button>
        </div>
      )}
      {ocel && (
        <div className="mt-3 max-w-xs">
          <Field label="Follow each" hint="An object-centric log has several kinds of object; the process is drawn for one of them.">
            <Select
              value={ocel.chosen}
              onChange={(e) => {
                setOcel({ ...ocel, chosen: e.target.value });
                read(ocel.name, ocel.text, { caseType: e.target.value });
              }}
            >
              {ocel.types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      {problem && !pending && (
        <p className="mt-2 text-[13px] text-danger" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

export function LogSummary({ loaded }: { loaded: LoadedLog }) {
  const { log, analysis: a } = loaded;
  const items: [string, string][] = [
    ["Cases", a.cases.toLocaleString()],
    ["Events", a.events.toLocaleString()],
    ["Activities", String(a.activities.length)],
    ["Variants", a.variants.length.toLocaleString()],
    ["Median time", hoursLabel(a.medianHours)],
    ["9 in 10 within", hoursLabel(a.p90Hours)],
    ["Cases with rework", percent(a.reworkShare)],
  ];
  return (
    <div>
      <p className="text-[13px] text-ink-soft">
        {loaded.fileName}, {log.format}
        {log.caseType ? ` following each ${log.caseType}` : ""}: {formatDate(new Date(a.start).toISOString())} to {formatDate(new Date(a.end).toISOString())}
        {log.skipped ? `. ${log.skipped.toLocaleString()} rows without a case, activity or time were left out` : ""}.
      </p>
      <dl className="mt-2 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-px rounded-lg border border-line bg-line overflow-hidden" data-log-summary>
        {items.map(([label, value]) => (
          <div key={label} className="bg-surface px-3 py-2">
            <dt className="text-[12px] text-ink-soft">{label}</dt>
            <dd className="font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The most common ways cases go, as a share of all cases. */
export function VariantList({ analysis, limit = 8 }: { analysis: LogAnalysis; limit?: number }) {
  const shown = analysis.variants.slice(0, limit);
  return (
    <section data-log-variants>
      <h3 className="text-sm font-semibold">The most common ways through</h3>
      <ol className="mt-2 space-y-2">
        {shown.map((v, i) => (
          <li key={i} className="rounded-md border border-line bg-surface px-3 py-2">
            <div className="flex items-center gap-3 text-[13px]">
              <span className="font-medium tabular-nums w-12">{percent(v.share)}</span>
              <span className="h-1.5 flex-1 rounded-full bg-line-soft overflow-hidden">
                <span className="block h-full bg-blueprint" style={{ width: `${Math.max(2, v.share * 100)}%` }} />
              </span>
              <span className="text-ink-soft tabular-nums">
                {v.count.toLocaleString()} cases, median {hoursLabel(v.medianHours)}
              </span>
            </div>
            <p className="mt-1 text-[13px] text-ink-soft leading-relaxed">
              {v.steps.map((s, j) => (
                <span key={j}>
                  {j > 0 && <span className="text-ink-faint"> → </span>}
                  <span className={cx(v.steps.indexOf(s) !== j && "text-signal font-medium")} title={v.steps.indexOf(s) !== j ? "Done again" : undefined}>
                    {s}
                  </span>
                </span>
              ))}
            </p>
          </li>
        ))}
      </ol>
      {analysis.variants.length > limit && <p className="mt-2 text-[13px] text-ink-soft">and {(analysis.variants.length - limit).toLocaleString()} rarer ones.</p>}
    </section>
  );
}

export function ActivityTable({ analysis }: { analysis: LogAnalysis }) {
  return (
    <section>
      <h3 className="text-sm font-semibold">Activities</h3>
      <div className="mt-2 rounded-lg border border-line bg-surface overflow-x-auto">
        <table className="w-full text-sm" data-log-activities>
          <thead className="text-left text-[13px] text-ink-soft">
            <tr className="border-b border-line">
              <th className="px-3 py-2 font-medium">Activity</th>
              <th className="px-3 py-2 font-medium text-right">Done</th>
              <th className="px-3 py-2 font-medium text-right">In cases</th>
              <th className="px-3 py-2 font-medium text-right" title="From the event before it to this one: the wait and the work">
                Median time to it
              </th>
              <th className="px-3 py-2 font-medium">Mostly by</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {analysis.activities.map((a) => (
              <tr key={a.name}>
                <td className="px-3 py-1.5">{a.name}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{a.count.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{percent(a.cases / analysis.cases)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{minutesLabel(a.medianMinutes)}</td>
                <td className="px-3 py-1.5 text-ink-soft">{a.resources.slice(0, 2).join(", ") || "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function SlowHandovers({ analysis }: { analysis: LogAnalysis }) {
  if (!analysis.slowest.length) return null;
  return (
    <section data-log-slowest>
      <h3 className="text-sm font-semibold">Where cases wait longest</h3>
      <ul className="mt-2 space-y-1 text-[13px]">
        {analysis.slowest.map((t) => (
          <li key={`${t.from}>${t.to}`} className="flex gap-2">
            <span className="font-medium tabular-nums w-20 shrink-0">{minutesLabel(t.medianMinutes)}</span>
            <span>
              {t.from} <span className="text-ink-faint">→</span> {t.to} <span className="text-ink-soft">({t.count.toLocaleString()} times)</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The summary a process keeps of the last log compared with it. */
export function miningSummary(loaded: LoadedLog, fitness: number | null) {
  const a = loaded.analysis;
  return {
    source: loaded.fileName,
    importedAt: new Date().toISOString(),
    cases: a.cases,
    events: a.events,
    variants: a.variants.length,
    fitness,
    medianHours: a.medianHours,
    activities: Object.fromEntries(a.activities.map((x) => [x.name, { count: x.count, medianMinutes: x.medianMinutes }])),
  };
}
