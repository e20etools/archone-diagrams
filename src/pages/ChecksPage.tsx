import { Download } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Badge, Button, EmptyState, Select, Tabs } from "@/components/ui";
import { PACKS, SEVERITIES, dataMap, dataMapCsv, findingsCsv, ruleById, rulesOf, runChecks, type Finding, type PackId, type Severity } from "@/lib/checks/checks";
import { downloadText, slugify } from "@/lib/exporters";
import { sortedDiagrams } from "@/lib/model";
import { useWorkspace } from "@/lib/store";
import type { Workspace } from "@/lib/types";

const PACKS_KEY = "archone.checks.packs";
const TONE: Record<Severity, "red" | "amber" | "neutral"> = { high: "red", medium: "amber", low: "neutral" };
const LABEL: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low" };

function savedPacks(): PackId[] {
  try {
    const saved = JSON.parse(localStorage.getItem(PACKS_KEY) ?? "null") as unknown;
    if (Array.isArray(saved)) {
      const known = PACKS.map((p) => p.id).filter((id) => saved.includes(id));
      if (known.length) return known;
    }
  } catch {
    // fall through to the default
  }
  return ["practice", "security"];
}

function ObjectLinks({ ws, ids }: { ws: Workspace; ids: string[] }) {
  return (
    <>
      {ids
        .filter((id) => ws.objects[id])
        .map((id, i) => (
          <Fragment key={id}>
            {i > 0 && ", "}
            <Link to={`/model?object=${id}`} className="text-blueprint hover:underline">
              {ws.objects[id].name}
            </Link>
          </Fragment>
        ))}
    </>
  );
}

function Findings({ ws, findings }: { ws: Workspace; findings: Finding[] }) {
  // One block per rule, so the reason is said once.
  const groups = new Map<string, Finding[]>();
  for (const f of findings) groups.set(f.ruleId, [...(groups.get(f.ruleId) ?? []), f]);
  return (
    <ul className="mt-4 space-y-3" data-findings>
      {[...groups.entries()].map(([ruleId, list]) => {
        const rule = ruleById(ruleId)!;
        return (
          <li key={ruleId} className="rounded-lg border border-line bg-surface" data-rule={ruleId}>
            <div className="px-4 py-3 border-b border-line-soft flex items-start justify-between gap-3">
              <div>
                <p className="font-medium">{rule.title}</p>
                <p className="text-[13px] text-ink-soft mt-0.5">{rule.why}</p>
              </div>
              <span className="shrink-0 flex items-center gap-2">
                <span className="text-[13px] text-ink-soft">{list.length}</span>
                <Badge tone={TONE[rule.severity]}>{LABEL[rule.severity]}</Badge>
              </span>
            </div>
            <ul className="px-4 py-2 divide-y divide-line-soft">
              {list.map((f, i) => (
                <li key={i} className="py-1.5 flex items-baseline justify-between gap-4">
                  <span>{f.message}</span>
                  <span className="text-[13px] shrink-0 text-right">
                    <ObjectLinks ws={ws} ids={f.objectIds} />
                  </span>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

function DataMap({ ws }: { ws: Workspace }) {
  const { rows, flows } = useMemo(() => dataMap(ws), [ws]);
  if (!rows.length) {
    return (
      <div className="mt-5 rounded-lg border border-dashed border-ink-faint bg-surface">
        <EmptyState title="No data recorded yet" text="Open an object in the model and fill in Data it holds: its classification, whether it holds personal data, and where it is kept. Databases, queues, caches and file stores are listed here as soon as they exist." />
      </div>
    );
  }
  return (
    <div className="mt-5 space-y-6">
      <div className="rounded-lg border border-line bg-surface overflow-hidden">
        <table className="w-full text-left" data-data-map>
          <thead className="text-[13px] text-ink-soft bg-paper border-b border-line">
            <tr>
              <th className="font-medium px-4 py-2.5">Object</th>
              <th className="font-medium px-3 py-2.5">Owner</th>
              <th className="font-medium px-3 py-2.5">Classification</th>
              <th className="font-medium px-3 py-2.5">Personal data</th>
              <th className="font-medium px-3 py-2.5">Kept in</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ object, lens, partOf }) => (
              <tr key={object.id} className="border-b border-line-soft last:border-b-0">
                <td className="px-4 py-2.5">
                  <Link to={`/model?object=${object.id}`} className="font-medium text-blueprint hover:underline">
                    {object.name}
                  </Link>
                  {partOf && <span className="block text-[13px] text-ink-soft">{partOf}</span>}
                </td>
                <td className="px-3 py-2.5">{object.owner || <span className="text-ink-faint">None</span>}</td>
                <td className="px-3 py-2.5">{lens.classification || <span className="text-ink-faint">Not set</span>}</td>
                <td className="px-3 py-2.5">{lens.personal === "yes" ? <Badge tone="amber">Yes</Badge> : lens.personal === "no" ? "No" : <span className="text-ink-faint">Not set</span>}</td>
                <td className="px-3 py-2.5">{lens.residency || <span className="text-ink-faint">Not set</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <h2 className="font-semibold">Where personal data may travel</h2>
        <p className="text-[13px] text-ink-soft mt-0.5">Every relationship with an object that holds personal data at one end. A relationship has no data fields of its own yet, so this is read from its two ends.</p>
        {flows.length === 0 ? (
          <p className="mt-3 text-ink-soft">No object is marked as holding personal data, or none of them is connected.</p>
        ) : (
          <ul className="mt-3 rounded-lg border border-line bg-surface divide-y divide-line-soft" data-data-flows>
            {flows.map(({ relationship, from, to, notes }) => (
              <li key={relationship.id} className="px-4 py-2 flex items-center justify-between gap-3">
                <span>
                  <ObjectLinks ws={ws} ids={[from.id]} /> <span className="text-ink-faint">to</span> <ObjectLinks ws={ws} ids={[to.id]} />
                  {relationship.protocol && <span className="text-[13px] text-ink-soft"> · {relationship.protocol}</span>}
                </span>
                <span className="flex gap-1.5">
                  {notes.map((note) => (
                    <Badge key={note} tone="amber">
                      {note}
                    </Badge>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function ChecksPage() {
  const ws = useWorkspace();
  const [params, setParams] = useSearchParams();
  const tab = params.get("view") === "data" ? "data" : "findings";
  const diagram = ws.diagrams[params.get("diagram") ?? ""] ?? null;
  const [packs, setPacks] = useState<PackId[]>(savedPacks);
  const findings = useMemo(() => runChecks(ws, diagram, packs), [ws, diagram, packs]);
  const counts = SEVERITIES.map((s) => ({ severity: s, n: findings.filter((f) => f.severity === s).length }));
  const set = (change: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(change)) value ? next.set(key, value) : next.delete(key);
    setParams(next, { replace: true });
  };
  const toggle = (id: PackId) => {
    const next = packs.includes(id) ? packs.filter((p) => p !== id) : [...packs, id];
    setPacks(next);
    try {
      localStorage.setItem(PACKS_KEY, JSON.stringify(next));
    } catch {
      // the choice lasts for this visit only
    }
  };
  const empty = Object.keys(ws.objects).length === 0;

  return (
    <div className="max-w-5xl mx-auto px-6 py-7">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Checks</h1>
          <p className="text-ink-soft mt-0.5">Rules run against the model or one diagram. They read what the model records and change nothing.</p>
        </div>
        {!empty && (
          <Button
            icon={<Download size={15} />}
            disabled={tab === "findings" && findings.length === 0}
            onClick={() => (tab === "data" ? downloadText(`${slugify(ws.name)}-data-map.csv`, dataMapCsv(ws), "text/csv") : downloadText(`${slugify(diagram?.name ?? ws.name)}-findings.csv`, findingsCsv(ws, findings), "text/csv"))}
          >
            Download CSV
          </Button>
        )}
      </div>

      {empty ? (
        <div className="mt-8 rounded-lg border border-dashed border-ink-faint bg-surface">
          <EmptyState title="Nothing to check yet" text="Checks read the objects and relationships in the model. Add some, or import a file, then come back." />
        </div>
      ) : (
        <>
          <div className="mt-5">
            <Tabs
              tabs={[
                { id: "findings", label: "Findings", count: findings.length },
                { id: "data", label: "Data map" },
              ]}
              value={tab}
              onChange={(id) => set({ view: id === "data" ? "data" : "" })}
            />
          </div>
          {tab === "data" ? (
            <DataMap ws={ws} />
          ) : (
            <>
              <div className="mt-4 flex flex-wrap items-start gap-x-8 gap-y-3">
                <label className="block">
                  <span className="block text-[13px] font-medium mb-1">Check</span>
                  <Select className="!w-64" value={diagram?.id ?? ""} onChange={(e) => set({ diagram: e.target.value })} aria-label="What to check">
                    <option value="">The whole model</option>
                    {sortedDiagrams(ws).map((d) => (
                      <option key={d.id} value={d.id}>
                        Diagram: {d.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <fieldset>
                  <legend className="text-[13px] font-medium mb-1">Rule packs</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {PACKS.map((pack) => (
                      <label key={pack.id} className="flex items-center gap-1.5 h-9 cursor-pointer" title={pack.about}>
                        <input type="checkbox" className="accent-blueprint" checked={packs.includes(pack.id)} onChange={() => toggle(pack.id)} />
                        {pack.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
              {packs.length === 0 ? (
                <p className="mt-6 text-ink-soft">Choose at least one rule pack.</p>
              ) : findings.length === 0 ? (
                <div className="mt-5 rounded-lg border border-line bg-surface">
                  <EmptyState title="No findings" text={`${rulesOf(packs).length} rules were run against ${diagram ? `the diagram "${diagram.name}"` : "the whole model"} and none of them found anything.`} />
                </div>
              ) : (
                <>
                  <p className="mt-4 text-[13px] text-ink-soft" data-findings-summary>
                    {rulesOf(packs).length} rules run against {diagram ? `the diagram "${diagram.name}"` : "the whole model"}: {counts.map((c) => `${c.n} ${c.severity}`).join(", ")}.
                  </p>
                  <Findings ws={ws} findings={findings} />
                </>
              )}
              <p className="mt-5 text-[13px] text-ink-soft">
                The packs borrow the concerns of well-known frameworks. They see only what the model records, so a clean result is not a certificate of compliance.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
