import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Download,
  Lightbulb,
  Plus,
  Save,
  Search,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  DiagramCanvas,
  type Highlight,
} from "@/components/canvas/DiagramCanvas";
import { TypeIcon } from "@/components/icons";
import { Badge, Button, Input, Select, Tabs, cx } from "@/components/ui";
import { VIEW_TYPE_INFO } from "@/lib/catalog";
import { downloadText, slugify, toCsv } from "@/lib/exporters";
import {
  IMPACT_LEVELS,
  LIKELIHOODS,
  MAX_LEVELS,
  SEVERITY_LABEL,
  analyse,
  componentsInUse,
  objectsOfComponent,
  pathOf,
  riskOf,
  subjectName,
  subjectStart,
  typeLabel,
  whatIf,
  type Severity,
  type Step,
  type Subject,
} from "@/lib/impact";
import { LIBRARY_SECTIONS, componentById, searchLibrary } from "@/lib/library";
import { sortedDiagrams, sortedObjects } from "@/lib/model";
import { useWorkspace } from "@/lib/store";
import type { Workspace } from "@/lib/types";
import { analysisDiagram } from "./AnalysisPage";

const MAP_LIMIT = 60;
const sectionName = (id: string) =>
  LIBRARY_SECTIONS.find((s) => s.id === id)?.label ?? id;
const TONE: Record<Severity, "red" | "amber" | "blue" | "neutral"> = {
  critical: "red",
  high: "amber",
  medium: "blue",
  low: "neutral",
};

function subjectFromParams(params: URLSearchParams): Subject | null {
  const object = params.get("object");
  if (object) return { kind: "object", id: object };
  const diagram = params.get("diagram");
  if (diagram) return { kind: "diagram", id: diagram };
  const component = params.get("component");
  if (component) return { kind: "component", id: component };
  return null;
}

/**
 * Impact and dependencies for anything in the model: a component, a whole diagram, or every
 * object that is one library component. Up to five levels each way, the diagrams they reach,
 * and what happens if it stops, with how bad that is and what to do about it.
 */
export function ImpactPage() {
  const ws = useWorkspace();
  const [params, setParams] = useSearchParams();
  const subject = subjectFromParams(params);
  const [levels, setLevels] = useState(MAX_LEVELS);
  const [tab, setTab] = useState<"links" | "whatif">(
    params.get("tab") === "whatif" ? "whatif" : "links",
  );
  const choose = (next: Subject) =>
    setParams(
      { [next.kind]: next.id, ...(tab === "whatif" ? { tab: "whatif" } : {}) },
      { replace: false },
    );

  return (
    <div className="max-w-6xl mx-auto px-6 py-6" data-impact-page>
      <h1 className="text-xl font-semibold">Impact and dependencies</h1>
      <p className="text-ink-soft mt-0.5">
        Pick a component, a diagram or a library component to see what it
        depends on and what depends on it, up to five levels, across every
        diagram. Then ask what happens if it stops.
      </p>
      <SubjectPicker ws={ws} subject={subject} onChoose={choose} />
      {subject && subjectStart(ws, subject).length === 0 && (
        <p
          className="mt-3 rounded-md bg-paper border border-line px-3 py-2 text-[13px] text-ink-soft"
          data-impact-empty
        >
          {subject.kind === "component"
            ? `No object in this model is ${subjectName(ws, subject)} yet, so nothing depends on it here.`
            : "This is no longer in the model."}
        </p>
      )}
      {subject && subjectStart(ws, subject).length > 0 && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Tabs
              tabs={[
                { id: "links", label: "Dependencies and impact" },
                { id: "whatif", label: "What if it stops" },
              ]}
              value={tab}
              onChange={(t) => setTab(t)}
            />
            <span className="ml-auto flex items-center gap-1.5 text-[13px] text-ink-soft">
              Levels
              {Array.from({ length: MAX_LEVELS }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  type="button"
                  data-impact-levels={n}
                  aria-pressed={levels === n}
                  onClick={() => setLevels(n)}
                  className={cx(
                    "h-7 w-7 rounded-md border text-[13px] tabular-nums",
                    levels === n
                      ? "border-blueprint bg-blueprint text-white"
                      : "border-line hover:border-ink-faint",
                  )}
                >
                  {n}
                </button>
              ))}
            </span>
          </div>
          {tab === "links" ? (
            <Links
              ws={ws}
              subject={subject}
              levels={levels}
              onChoose={choose}
            />
          ) : (
            <WhatIf ws={ws} subject={subject} levels={levels} />
          )}
        </>
      )}
    </div>
  );
}

/* ---------- choosing what to analyse ---------- */

function SubjectPicker({
  ws,
  subject,
  onChoose,
}: {
  ws: Workspace;
  subject: Subject | null;
  onChoose: (s: Subject) => void;
}) {
  const [kind, setKind] = useState<Subject["kind"]>(subject?.kind ?? "object");
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (subject) setKind(subject.kind);
  }, [subject]);
  const q = query.trim().toLowerCase();
  const options =
    kind === "object"
      ? sortedObjects(ws)
          .filter((o) => !q || o.name.toLowerCase().includes(q))
          .slice(0, 40)
          .map((o) => ({
            id: o.id,
            name: o.name,
            hint: typeLabel(o),
            typeId: o.typeId,
            componentId: o.componentId,
          }))
      : kind === "diagram"
        ? sortedDiagrams(ws)
            .filter((d) => !q || d.name.toLowerCase().includes(q))
            .slice(0, 40)
            .map((d) => ({
              id: d.id,
              name: d.name,
              hint: VIEW_TYPE_INFO[d.viewType].label,
              typeId: "diagram",
              componentId: undefined,
            }))
        : (q
            ? searchLibrary(query, { limit: 40 })
            : componentsInUse(ws)
                .slice(0, 40)
                .map((u) => componentById(u.id)!)
          ).map((c) => ({
            id: c.id,
            name: c.name,
            hint: `${objectsOfComponent(ws, c.id).length} in this model · ${sectionName(c.sectionId)}`,
            typeId: c.kind,
            componentId: c.id,
          }));
  return (
    <div
      className="mt-4 rounded-lg border border-line bg-surface p-3"
      data-impact-picker
    >
      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          tabs={[
            { id: "object", label: "Component" },
            { id: "diagram", label: "Diagram" },
            { id: "component", label: "Library component" },
          ]}
          value={kind}
          onChange={(k) => {
            setKind(k);
            setQuery("");
          }}
        />
        <div className="relative min-w-60 flex-1">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
          />
          <Input
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              kind === "diagram"
                ? "Find a diagram"
                : kind === "component"
                  ? "Find in the library, such as SQL Server"
                  : "Find a component"
            }
            aria-label="Find what to analyse"
          />
        </div>
        {subject && (
          <span
            className="flex items-center gap-1.5 rounded-full bg-blueprint-soft px-3 py-1 text-[13px] text-blueprint"
            data-impact-subject
          >
            {subject.kind === "diagram"
              ? "Diagram"
              : subject.kind === "component"
                ? "Library component"
                : "Component"}
            : <span className="font-medium">{subjectName(ws, subject)}</span>
          </span>
        )}
      </div>
      {(query || !subject || kind !== subject.kind) && (
        <div
          className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3 max-h-56 overflow-y-auto"
          data-impact-options
        >
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              data-impact-option={o.id}
              onClick={() => {
                onChoose({ kind, id: o.id } as Subject);
                setQuery("");
              }}
              className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5 text-left hover:border-blueprint"
            >
              <TypeIcon
                typeId={o.typeId}
                componentId={o.componentId}
                size={15}
              />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">
                  {o.name}
                </span>
                <span className="block truncate text-xs text-ink-faint">
                  {o.hint}
                </span>
              </span>
            </button>
          ))}
          {!options.length && (
            <p className="text-[13px] text-ink-soft">Nothing matches.</p>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- dependencies and impact ---------- */

function Links({
  ws,
  subject,
  levels,
  onChoose,
}: {
  ws: Workspace;
  subject: Subject;
  levels: number;
  onChoose: (s: Subject) => void;
}) {
  const result = useMemo(
    () => analyse(ws, subject, levels),
    [ws, subject, levels],
  );
  const map = useMemo(() => {
    const near = [...result.dependencies, ...result.impact]
      .sort((a, b) => a.level - b.level)
      .slice(0, MAP_LIMIT);
    const ids = [
      ...new Set([...result.start.slice(0, 20), ...near.map((s) => s.id)]),
    ];
    const highlight: Record<string, Highlight> = {};
    for (const id of result.start) highlight[id] = "focus";
    for (const s of result.dependencies) highlight[s.id] = "up";
    for (const s of result.impact) highlight[s.id] ??= "down";
    return {
      diagram: analysisDiagram(
        ws,
        `${subject.kind}:${subject.id}:${levels}`,
        ids,
      ),
      highlight,
      cut: result.dependencies.length + result.impact.length - near.length,
    };
  }, [ws, result, subject, levels]);
  const name = subjectName(ws, subject);
  const exportCsv = () =>
    downloadText(
      `${slugify(name)}-impact.csv`,
      toCsv([
        [
          "Direction",
          "Level",
          "Name",
          "Type",
          "Via",
          "Protocols",
          "Path",
          "Diagrams",
        ],
        ...result.dependencies.map((s) =>
          row(ws, result.dependencies, s, "Depends on"),
        ),
        ...result.impact.map((s) => row(ws, result.impact, s, "Impacts")),
      ]),
      "text/csv",
    );
  const exportJson = () =>
    downloadText(
      `${slugify(name)}-impact.json`,
      JSON.stringify(
        {
          subject: { ...subject, name },
          levels,
          dependencies: result.dependencies.map((s) => ({
            ...s,
            name: ws.objects[s.id]?.name,
            path: pathOf(ws, result.dependencies, s.id),
          })),
          impact: result.impact.map((s) => ({
            ...s,
            name: ws.objects[s.id]?.name,
            path: pathOf(ws, result.impact, s.id),
          })),
          diagramsDependedOn: result.diagramsDependedOn.map((d) => ({
            id: d.diagram.id,
            name: d.diagram.name,
            count: d.count,
            of: d.of,
            level: d.level,
          })),
          diagramsImpacted: result.diagramsImpacted.map((d) => ({
            id: d.diagram.id,
            name: d.diagram.name,
            count: d.count,
            of: d.of,
            level: d.level,
          })),
        },
        null,
        2,
      ),
      "application/json",
    );
  return (
    <div className="mt-4 space-y-4" data-impact-links>
      <div className="grid gap-2 sm:grid-cols-4">
        <Stat
          label="Depends on"
          value={result.dependencies.length}
          hint={byLevel(result.dependencies)}
          icon={<ArrowUpFromLine size={15} />}
          data="dependencies"
        />
        <Stat
          label="Impacts"
          value={result.impact.length}
          hint={byLevel(result.impact)}
          icon={<ArrowDownToLine size={15} />}
          data="impact"
        />
        <Stat
          label="Diagrams it depends on"
          value={result.diagramsDependedOn.length}
          hint="Diagrams showing what it needs"
          icon={<Zap size={15} />}
          data="diagrams-up"
        />
        <Stat
          label="Diagrams it impacts"
          value={result.diagramsImpacted.length}
          hint="Diagrams showing what needs it"
          icon={<AlertTriangle size={15} />}
          data="diagrams-down"
        />
      </div>
      <div className="rounded-lg border border-line bg-surface overflow-hidden">
        <div className="h-[380px]">
          <DiagramCanvas
            ws={ws}
            diagram={map.diagram}
            readOnly
            highlight={map.highlight}
            onOpen={(id) => onChoose({ kind: "object", id })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line-soft px-4 py-2 text-[13px] text-ink-soft">
          <span>
            An arrow points from a component to what it needs. Double-click a
            box to analyse it instead.
          </span>
          {map.cut > 0 && (
            <span className="text-signal">
              The map shows the nearest {MAP_LIMIT}; the lists show all.
            </span>
          )}
          <span className="ml-auto flex gap-1.5">
            <Button
              size="sm"
              icon={<Download size={13} />}
              onClick={exportCsv}
              data-impact-export="csv"
            >
              CSV
            </Button>
            <Button
              size="sm"
              icon={<Download size={13} />}
              onClick={exportJson}
              data-impact-export="json"
            >
              JSON
            </Button>
          </span>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <LevelList
          ws={ws}
          title="What it depends on"
          empty="It depends on nothing in the model."
          steps={result.dependencies}
          onChoose={onChoose}
          data="dependencies"
        />
        <LevelList
          ws={ws}
          title="What depends on it"
          empty="Nothing in the model depends on it."
          steps={result.impact}
          onChoose={onChoose}
          data="impact"
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <DiagramList
          title="Diagrams it depends on"
          list={result.diagramsDependedOn}
          onChoose={onChoose}
        />
        <DiagramList
          title="Diagrams it impacts"
          list={result.diagramsImpacted}
          onChoose={onChoose}
        />
      </div>
    </div>
  );
}

function row(
  ws: Workspace,
  steps: Step[],
  s: Step,
  direction: string,
): string[] {
  const o = ws.objects[s.id];
  return [
    direction,
    String(s.level),
    o?.name ?? "",
    o ? typeLabel(o) : "",
    s.via,
    s.protocols.join(", "),
    pathOf(ws, steps, s.id).join(" > "),
    "",
  ];
}

const byLevel = (steps: Step[]) =>
  Array.from(
    { length: MAX_LEVELS },
    (_, i) => steps.filter((s) => s.level === i + 1).length,
  )
    .map((n, i) => (n ? `L${i + 1}: ${n}` : ""))
    .filter(Boolean)
    .join(" · ") || "None";

function Stat({
  label,
  value,
  hint,
  icon,
  data,
}: {
  label: string;
  value: number;
  hint: string;
  icon: React.ReactNode;
  data: string;
}) {
  return (
    <div
      className="rounded-lg border border-line bg-surface px-3 py-2.5"
      data-impact-stat={data}
    >
      <div className="flex items-center gap-1.5 text-[13px] text-ink-soft">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-ink-faint truncate">{hint}</div>
    </div>
  );
}

function LevelList({
  ws,
  title,
  empty,
  steps,
  onChoose,
  data,
}: {
  ws: Workspace;
  title: string;
  empty: string;
  steps: Step[];
  onChoose: (s: Subject) => void;
  data: string;
}) {
  return (
    <section
      className="rounded-lg border border-line bg-surface px-4 py-3"
      data-impact-list={data}
    >
      <h2 className="text-sm font-semibold">{title}</h2>
      {!steps.length && (
        <p className="mt-1 text-[13px] text-ink-soft">{empty}</p>
      )}
      {Array.from({ length: MAX_LEVELS }, (_, i) => i + 1).map((level) => {
        const here = steps.filter((s) => s.level === level);
        if (!here.length) return null;
        return (
          <div key={level} className="mt-2.5">
            <p className="text-xs font-semibold text-ink-soft">
              Level {level}{" "}
              <span className="font-normal text-ink-faint">
                {level === 1
                  ? "· directly"
                  : `· through ${level - 1} ${level === 2 ? "other" : "others"}`}
              </span>
            </p>
            <ul className="mt-1 space-y-1">
              {here.map((s) => {
                const o = ws.objects[s.id];
                if (!o) return null;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => onChoose({ kind: "object", id: s.id })}
                      className="w-full flex items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-paper"
                      data-impact-step={s.id}
                      title={pathOf(ws, steps, s.id).join(" → ")}
                    >
                      <TypeIcon
                        typeId={o.typeId}
                        componentId={o.componentId}
                        size={15}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">
                          {o.name}
                        </span>
                        <span className="block truncate text-xs text-ink-faint">
                          {typeLabel(o)} · {s.via}
                          {s.protocols.length
                            ? ` · ${s.protocols.join(", ")}`
                            : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function DiagramList({
  title,
  list,
  onChoose,
}: {
  title: string;
  list: ReturnType<typeof analyse>["diagramsImpacted"];
  onChoose: (s: Subject) => void;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface px-4 py-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      {!list.length && <p className="mt-1 text-[13px] text-ink-soft">None.</p>}
      <ul className="mt-1.5 space-y-1.5">
        {list.map((d) => (
          <li
            key={d.diagram.id}
            className="flex items-center gap-2 text-[13px]"
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left font-medium text-blueprint hover:underline"
              onClick={() => onChoose({ kind: "diagram", id: d.diagram.id })}
            >
              {d.diagram.name}
            </button>
            <span
              className="w-28 h-1.5 rounded-full bg-line-soft overflow-hidden"
              title={`${d.count} of ${d.of} boxes`}
            >
              <span
                className="block h-full bg-blueprint"
                style={{
                  width: `${Math.min(100, Math.round((d.count / Math.max(d.of, 1)) * 100))}%`,
                }}
              />
            </span>
            <span className="w-16 text-right text-xs tabular-nums text-ink-soft">
              {d.count}/{d.of}
            </span>
            <span className="w-8 text-right text-xs text-ink-faint">
              L{d.level}
            </span>
            <Link
              to={`/diagram/${d.diagram.id}`}
              className="text-xs text-ink-soft hover:text-blueprint"
            >
              Open
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------- what if it stops ---------- */

interface SavedScenario {
  id: string;
  name: string;
  stopped: Subject[];
  likelihood: number;
  impact: number | null;
  levels: number;
  savedAt: string;
}

const scenarioKey = (ws: Workspace) => `archone.whatif.${ws.name}`;
function loadScenarios(ws: Workspace): SavedScenario[] {
  try {
    return JSON.parse(
      localStorage.getItem(scenarioKey(ws)) ?? "[]",
    ) as SavedScenario[];
  } catch {
    return [];
  }
}
function keepScenarios(ws: Workspace, list: SavedScenario[]) {
  try {
    localStorage.setItem(scenarioKey(ws), JSON.stringify(list.slice(0, 50)));
  } catch {
    // Not kept in this browser; the scenario still shows.
  }
}

function WhatIf({
  ws,
  subject,
  levels,
}: {
  ws: Workspace;
  subject: Subject;
  levels: number;
}) {
  const [stopped, setStopped] = useState<Subject[]>([subject]);
  const [likelihood, setLikelihood] = useState(3);
  const [impactSet, setImpactSet] = useState<number | null>(null);
  const [adding, setAdding] = useState("");
  const [saved, setSaved] = useState<SavedScenario[]>(() => loadScenarios(ws));
  const [scenarioName, setScenarioName] = useState("");
  useEffect(() => setStopped([subject]), [subject]);
  const result = useMemo(
    () => whatIf(ws, stopped, levels),
    [ws, stopped, levels],
  );
  const impact = impactSet ?? result.impact;
  const risk = riskOf(likelihood, impact);
  const addOptions = [
    ...sortedObjects(ws).map((o) => ({
      label: `${o.name} (component)`,
      value: { kind: "object", id: o.id } as Subject,
    })),
    ...sortedDiagrams(ws).map((d) => ({
      label: `${d.name} (diagram)`,
      value: { kind: "diagram", id: d.id } as Subject,
    })),
  ];
  const add = () => {
    const found = addOptions.find((o) => o.label === adding);
    if (
      found &&
      !stopped.some(
        (s) => s.kind === found.value.kind && s.id === found.value.id,
      )
    )
      setStopped([...stopped, found.value]);
    setAdding("");
  };
  const title = stopped.map((s) => subjectName(ws, s)).join(", ");
  const report = () => {
    const lines = [
      `# What if ${title} stops`,
      "",
      `Likelihood: ${LIKELIHOODS[likelihood - 1].label}. Impact: ${IMPACT_LEVELS[impact - 1].label}. Risk: ${SEVERITY_LABEL[risk.level]} (${risk.score} of 25).`,
      "",
      "## Why the impact is rated so",
      ...result.impactReasons.map((r) => `- ${r}`),
      "",
      `## Affected (${result.affected.length})`,
      "",
      "| Severity | Component | Type | Level | Path |",
      "|---|---|---|---|---|",
      ...result.affected.map(
        (a) =>
          `| ${SEVERITY_LABEL[a.severity]} | ${a.object.name} | ${typeLabel(a.object)} | ${a.level} | ${a.path.join(" → ")} |`,
      ),
      "",
      `## Diagrams affected (${result.diagrams.length})`,
      ...result.diagrams.map(
        (d) =>
          `- ${d.diagram.name}: ${d.count} of ${d.of} boxes, from level ${d.level}`,
      ),
      "",
      "## What to do",
      ...result.remedies.map(
        (r) =>
          `- **${r.priority === "now" ? "Now" : r.priority === "soon" ? "Soon" : "Later"}**: ${r.text}`,
      ),
      "",
      `Owners to tell: ${result.owners.map((o) => `${o.owner || "No owner"} (${o.count})`).join(", ") || "none"}.`,
    ];
    downloadText(
      `what-if-${slugify(title).slice(0, 60)}.md`,
      lines.join("\n"),
      "text/markdown",
    );
  };
  const csv = () =>
    downloadText(
      `what-if-${slugify(title).slice(0, 60)}.csv`,
      toCsv([
        [
          "Severity",
          "Component",
          "Type",
          "Level",
          "Path",
          "Owner",
          "Why",
          "Diagrams",
        ],
        ...result.affected.map((a) => [
          SEVERITY_LABEL[a.severity],
          a.object.name,
          typeLabel(a.object),
          String(a.level),
          a.path.join(" > "),
          a.object.owner,
          a.reasons.join("; "),
          a.diagrams.map((d) => d.name).join("; "),
        ]),
      ]),
      "text/csv",
    );
  return (
    <div className="mt-4 space-y-4" data-impact-whatif>
      <section className="rounded-lg border border-line bg-surface px-4 py-3">
        <h2 className="text-sm font-semibold">What stops</h2>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {stopped.map((s, i) => (
            <span
              key={`${s.kind}-${s.id}`}
              className="inline-flex items-center gap-1 rounded-full border border-danger/40 bg-danger-soft px-2.5 py-0.5 text-[13px]"
              data-whatif-stopped={s.id}
            >
              {subjectName(ws, s)}
              <span className="text-xs text-ink-faint">
                {s.kind === "diagram"
                  ? "diagram"
                  : s.kind === "component"
                    ? "every one"
                    : ""}
              </span>
              {stopped.length > 1 && (
                <button
                  type="button"
                  aria-label={`Take ${subjectName(ws, s)} out`}
                  onClick={() => setStopped(stopped.filter((_, j) => j !== i))}
                >
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
          <span className="flex items-center gap-1">
            <Input
              className="w-80"
              list="whatif-add"
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="Add another component or diagram"
              aria-label="Add to what stops"
            />
            <Button
              size="sm"
              icon={<Plus size={13} />}
              onClick={add}
              disabled={!adding}
              data-whatif-add
            >
              Add
            </Button>
            <datalist id="whatif-add">
              {addOptions.map((o) => (
                <option key={o.label} value={o.label} />
              ))}
            </datalist>
          </span>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <label className="block">
            <span className="block text-xs text-ink-soft mb-1">
              How likely is it
            </span>
            <Select
              value={likelihood}
              onChange={(e) => setLikelihood(Number(e.target.value))}
              aria-label="Likelihood"
              data-whatif-likelihood
            >
              {LIKELIHOODS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.value}. {l.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="block text-xs text-ink-soft mb-1">
              How bad would it be{" "}
              {impactSet === null && (
                <span className="text-ink-faint">(worked out)</span>
              )}
            </span>
            <Select
              value={impact}
              onChange={(e) =>
                setImpactSet(
                  Number(e.target.value) === result.impact
                    ? null
                    : Number(e.target.value),
                )
              }
              aria-label="Impact"
              data-whatif-impact
            >
              {IMPACT_LEVELS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.value}. {l.label}
                  {l.value === result.impact ? " (worked out)" : ""}
                </option>
              ))}
            </Select>
          </label>
          <RiskGrid likelihood={likelihood} impact={impact} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[13px]">Risk</span>
          <Badge tone={TONE[risk.level]}>
            <span data-whatif-risk={risk.level}>
              {SEVERITY_LABEL[risk.level]} · {risk.score} of 25
            </span>
          </Badge>
          <span className="text-xs text-ink-soft">
            {result.impactReasons.join(" · ")}
          </span>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <section className="rounded-lg border border-line bg-surface px-4 py-3">
          <div className="flex items-center">
            <h2 className="text-sm font-semibold">
              What is affected{" "}
              <span className="font-normal text-ink-soft">
                ({result.affected.length})
              </span>
            </h2>
            <span className="ml-auto flex gap-1.5">
              <Button
                size="sm"
                icon={<Download size={13} />}
                onClick={report}
                data-whatif-export="md"
              >
                Report
              </Button>
              <Button
                size="sm"
                icon={<Download size={13} />}
                onClick={csv}
                data-whatif-export="csv"
              >
                CSV
              </Button>
            </span>
          </div>
          {!result.affected.length && (
            <p className="mt-1 text-[13px] text-ink-soft">
              Nothing else stops.
            </p>
          )}
          <table
            className="mt-2 w-full text-left text-[13px]"
            data-whatif-affected={result.affected.length}
          >
            <tbody>
              {result.affected.map((a) => (
                <tr
                  key={a.object.id}
                  className="border-b border-line-soft align-top"
                >
                  <td className="py-1.5 pr-2">
                    <Badge tone={TONE[a.severity]}>
                      {SEVERITY_LABEL[a.severity]}
                    </Badge>
                  </td>
                  <td className="py-1.5 pr-2">
                    <span className="font-medium">{a.object.name}</span>
                    <span className="block text-xs text-ink-faint">
                      {a.reasons.join(" · ")}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2 text-xs text-ink-soft">
                    {typeLabel(a.object)}
                  </td>
                  <td className="py-1.5 text-right text-xs tabular-nums text-ink-faint">
                    L{a.level}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <div className="space-y-4">
          <section
            className="rounded-lg border border-line bg-surface px-4 py-3"
            data-whatif-remedies={result.remedies.length}
          >
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Lightbulb size={15} className="text-signal" />
              What to do
            </h2>
            <ul className="mt-1.5 space-y-1.5">
              {result.remedies.map((r, i) => (
                <li key={i} className="flex gap-2 text-[13px]">
                  <Badge
                    tone={
                      r.priority === "now"
                        ? "red"
                        : r.priority === "soon"
                          ? "amber"
                          : "neutral"
                    }
                  >
                    {r.priority === "now"
                      ? "Now"
                      : r.priority === "soon"
                        ? "Soon"
                        : "Later"}
                  </Badge>
                  <span>{r.text}</span>
                </li>
              ))}
            </ul>
          </section>
          <DiagramList
            title="Diagrams affected"
            list={result.diagrams}
            onChoose={() => undefined}
          />
          <section className="rounded-lg border border-line bg-surface px-4 py-3">
            <h2 className="text-sm font-semibold">Owners to tell</h2>
            <p className="mt-1 text-[13px] text-ink-soft">
              {result.owners
                .map((o) => `${o.owner || "No owner"} (${o.count})`)
                .join(", ") || "Nobody: nothing else is affected."}
            </p>
          </section>
        </div>
      </div>

      <section
        className="rounded-lg border border-line bg-surface px-4 py-3"
        data-whatif-saved
      >
        <h2 className="text-sm font-semibold">Saved scenarios</h2>
        <p className="text-xs text-ink-faint">Kept in this browser.</p>
        <div className="mt-2 flex gap-1.5">
          <Input
            className="max-w-sm"
            value={scenarioName}
            onChange={(e) => setScenarioName(e.target.value)}
            placeholder={`If ${title} stops`}
            aria-label="Scenario name"
          />
          <Button
            size="sm"
            icon={<Save size={13} />}
            data-whatif-save
            onClick={() => {
              const next = [
                {
                  id: `s${Date.now()}`,
                  name: scenarioName.trim() || `If ${title} stops`,
                  stopped,
                  likelihood,
                  impact: impactSet,
                  levels,
                  savedAt: new Date().toISOString(),
                },
                ...saved,
              ];
              setSaved(next);
              keepScenarios(ws, next);
              setScenarioName("");
            }}
          >
            Save
          </Button>
        </div>
        <ul className="mt-2 space-y-1">
          {saved.map((s) => {
            const r = riskOf(
              s.likelihood,
              s.impact ?? whatIf(ws, s.stopped, s.levels).impact,
            );
            return (
              <li key={s.id} className="flex items-center gap-2 text-[13px]">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-blueprint hover:underline"
                  onClick={() => {
                    setStopped(s.stopped);
                    setLikelihood(s.likelihood);
                    setImpactSet(s.impact);
                  }}
                >
                  {s.name}
                </button>
                <Badge tone={TONE[r.level]}>{SEVERITY_LABEL[r.level]}</Badge>
                <button
                  type="button"
                  aria-label={`Delete ${s.name}`}
                  className="text-ink-faint hover:text-danger"
                  onClick={() => {
                    const next = saved.filter((x) => x.id !== s.id);
                    setSaved(next);
                    keepScenarios(ws, next);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            );
          })}
          {!saved.length && (
            <li className="text-[13px] text-ink-soft">None yet.</li>
          )}
        </ul>
      </section>
    </div>
  );
}

/** The five-by-five risk grid, with the scenario's cell marked. */
function RiskGrid({
  likelihood,
  impact,
}: {
  likelihood: number;
  impact: number;
}) {
  return (
    <figure className="self-end">
      <div
        className="grid grid-cols-5 gap-0.5"
        aria-label={`Risk grid: likelihood ${likelihood}, impact ${impact}`}
        data-whatif-grid
      >
        {[5, 4, 3, 2, 1].flatMap((l) =>
          [1, 2, 3, 4, 5].map((i) => {
            const level = riskOf(l, i).level;
            const on = l === likelihood && i === impact;
            return (
              <span
                key={`${l}-${i}`}
                className={cx(
                  "h-4 w-5 rounded-[3px]",
                  level === "critical"
                    ? "bg-danger/70"
                    : level === "high"
                      ? "bg-signal/60"
                      : level === "medium"
                        ? "bg-blueprint/40"
                        : "bg-ok/30",
                  on && "ring-2 ring-ink",
                )}
                title={`Likelihood ${l}, impact ${i}`}
              />
            );
          }),
        )}
      </div>
      <figcaption className="mt-0.5 text-[11px] text-ink-faint">
        Likelihood up, impact across
      </figcaption>
    </figure>
  );
}
