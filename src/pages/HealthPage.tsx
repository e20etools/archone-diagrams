import { Check, Power, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { DiagramCanvas, type Highlight } from "@/components/canvas/DiagramCanvas";
import { TypeIcon } from "@/components/icons";
import { Badge, Button, EmptyState, IconButton, Input, Tabs, countOf, formatDate } from "@/components/ui";
import { RELATION_KIND_INFO, objectType } from "@/lib/catalog";
import { useMe } from "@/lib/cloud/me";
import { useCanEdit } from "@/lib/cloud/session";
import { TRUTH_STATE_LABEL, confirmTruth, truthMatters, truthOf } from "@/lib/freshness";
import { confirmDependency, handshakeCounts, ownsTarget, pendingHandshakes } from "@/lib/handshake";
import { sortedObjects } from "@/lib/model";
import { declaredAvailability, formatDowntime, resilienceOf, simulateFailure, singlePoints } from "@/lib/resilience";
import { apply, useWorkspace } from "@/lib/store";
import type { ModelObject, Workspace } from "@/lib/types";
import { analysisDiagram } from "@/pages/AnalysisPage";

type Tab = "failure" | "availability" | "confirmations" | "freshness";
const MAP_LIMIT = 60;
const percent = (value: number) => `${value.toFixed(value >= 99.995 || value === Math.round(value * 100) / 100 ? 2 : 3).replace(/\.?0+$/, "")}%`;

function ObjectLink({ object }: { object: ModelObject }) {
  return (
    <Link to={`/model?object=${object.id}`} className="inline-flex items-center gap-1.5 font-medium hover:underline">
      <TypeIcon typeId={object.typeId} size={14} />
      {object.name}
    </Link>
  );
}

/** Switch things off and see what stops. */
function Failure({ ws }: { ws: Workspace }) {
  const [params, setParams] = useSearchParams();
  const failedIds = useMemo(() => (params.get("stop") ?? "").split(",").filter((id) => ws.objects[id]), [params, ws.objects]);
  const [query, setQuery] = useState("");
  const set = (ids: string[]) => setParams(ids.length ? { tab: "failure", stop: ids.join(",") } : { tab: "failure" }, { replace: true });
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return sortedObjects(ws)
      .filter((o) => !failedIds.includes(o.id) && o.typeId !== "actor" && o.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [ws, failedIds, query]);
  const report = useMemo(() => simulateFailure(ws, failedIds), [ws, failedIds]);
  const points = useMemo(() => singlePoints(ws, 8), [ws]);
  const map = useMemo(() => {
    if (!failedIds.length) return null;
    const ids = [...report.failed.map((o) => o.id), ...report.affected.slice(0, MAP_LIMIT).map((c) => c.object.id)];
    const highlight: Record<string, Highlight> = {};
    for (const o of report.failed) highlight[o.id] = "focus";
    for (const c of report.affected) highlight[c.object.id] = "down";
    return { diagram: analysisDiagram(ws, `failure:${failedIds.join()}`, ids), highlight };
  }, [ws, failedIds, report]);

  return (
    <div data-failure>
      <div className="flex flex-wrap items-center gap-2">
        {report.failed
          .filter((o) => failedIds.includes(o.id))
          .map((o) => (
            <span key={o.id} className="inline-flex items-center gap-1.5 rounded-md border border-danger/40 bg-danger-soft text-danger pl-2 pr-1 h-8 text-sm font-medium">
              <Power size={14} />
              {o.name}
              <IconButton label={`Switch ${o.name} back on`} className="size-6 !text-danger" onClick={() => set(failedIds.filter((id) => id !== o.id))}>
                <X size={13} />
              </IconButton>
            </span>
          ))}
        <div className="relative w-72">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={failedIds.length ? "Switch off another object" : "Switch off an object by name"} aria-label="Object to switch off" />
          {candidates.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full rounded-md border border-line bg-surface shadow-lg py-1">
              {candidates.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-line-soft"
                    onClick={() => {
                      set([...failedIds, o.id]);
                      setQuery("");
                    }}
                  >
                    <TypeIcon typeId={o.typeId} size={14} />
                    <span className="truncate">{o.name}</span>
                    <span className="ml-auto text-xs text-ink-faint">{objectType(o.typeId).label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {!failedIds.length ? (
        <div className="mt-5">
          <h2 className="font-semibold">Where a failure would hurt most</h2>
          <p className="text-[13px] text-ink-soft mt-0.5">The objects that take the most with them when they stop. Pick one to see what happens.</p>
          {points.length === 0 ? (
            <p className="mt-3 text-ink-soft">Nothing in the model depends on anything else yet. Draw the relationships and come back.</p>
          ) : (
            <table className="mt-3 w-full text-sm rounded-lg border border-line bg-surface overflow-hidden" data-single-points>
              <thead className="text-left text-[13px] text-ink-soft bg-paper">
                <tr>
                  <th className="px-4 py-2 font-medium">Object</th>
                  <th className="px-4 py-2 font-medium">Stops with it</th>
                  <th className="px-4 py-2 font-medium">Of those, tier-1</th>
                  <th className="px-4 py-2 font-medium">People left without it</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.object.id} className="border-t border-line-soft">
                    <td className="px-4 py-2">
                      <ObjectLink object={p.object} />
                      <span className="block text-xs text-ink-soft">{p.object.owner || "No owner"}</span>
                    </td>
                    <td className="px-4 py-2 tabular-nums">{p.dependents}</td>
                    <td className="px-4 py-2 tabular-nums">{p.tier1}</td>
                    <td className="px-4 py-2 tabular-nums">{p.people}</td>
                    <td className="px-4 py-2 text-right">
                      <Button size="sm" icon={<Power size={13} />} onClick={() => set([p.object.id])}>
                        Switch off
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="mt-5" data-failure-report>
          <p className="text-lg font-semibold">
            {report.affected.length === 0 ? "Nothing else stops." : `${countOf(report.affected.length, "other object")} ${report.affected.length === 1 ? "stops" : "stop"} working.`}
          </p>
          <p className="text-ink-soft mt-0.5">
            {report.tier1.length > 0 && <>Tier-1 hit: {report.tier1.join(", ")}. </>}
            {report.people.length > 0 && <>Left without it: {report.people.join(", ")}. </>}
            {report.owners.filter((o) => o.owner).length > 0 && (
              <>
                To tell:{" "}
                {report.owners
                  .filter((o) => o.owner)
                  .map((o) => `${o.owner} (${o.count})`)
                  .join(", ")}
                .
              </>
            )}
          </p>
          {map && (
            <div className="mt-4 rounded-lg border border-line bg-surface overflow-hidden">
              <div className="h-[380px]">
                <DiagramCanvas ws={ws} diagram={map.diagram} readOnly highlight={map.highlight} onOpen={(id) => !failedIds.includes(id) && ws.objects[id]?.typeId !== "actor" && set([...failedIds, id])} />
              </div>
              <p className="px-4 py-2 border-t border-line-soft text-[13px] text-ink-soft">
                An arrow points from an object to what it needs. Double-click a box to switch it off too.
                {report.affected.length > MAP_LIMIT && ` The map shows the nearest ${MAP_LIMIT}; the list has all ${report.affected.length}.`}
              </p>
            </div>
          )}
          {report.affected.length > 0 && (
            <table className="mt-4 w-full text-sm rounded-lg border border-line bg-surface overflow-hidden">
              <thead className="text-left text-[13px] text-ink-soft bg-paper">
                <tr>
                  <th className="px-4 py-2 font-medium">Stops working</th>
                  <th className="px-4 py-2 font-medium">Owner</th>
                  <th className="px-4 py-2 font-medium">Because</th>
                </tr>
              </thead>
              <tbody>
                {report.affected.map((c) => (
                  <tr key={c.object.id} className="border-t border-line-soft" data-casualty={c.object.name}>
                    <td className="px-4 py-2">
                      <ObjectLink object={c.object} />
                      {c.object.tags.includes("tier-1") && (
                        <span className="ml-2">
                          <Badge tone="red">tier-1</Badge>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-ink-soft">{c.object.owner || "No owner"}</td>
                    <td className="px-4 py-2 text-ink-soft">{[...c.path].reverse().join(" needs ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-[13px] text-ink-soft">
            This follows the relationships that count as dependencies ({Object.values(RELATION_KIND_INFO).filter((k) => k.dependency).map((k) => k.label.toLowerCase()).join(", ")}) and assumes each one is needed. A standby copy or a fallback that is not
            drawn is not known here.
          </p>
        </div>
      )}
    </div>
  );
}

/** What each object can really deliver, given what it needs. */
function Availability({ ws }: { ws: Workspace }) {
  const rows = useMemo(
    () =>
      Object.values(ws.objects)
        .filter((o) => !["actor", "domain"].includes(o.typeId))
        .map((o) => resilienceOf(ws, o.id)!)
        .filter((r) => r.weakest !== null)
        .sort((a, b) => a.effective - b.effective || a.object.name.localeCompare(b.object.name)),
    [ws],
  );
  const declared = Object.values(ws.objects).filter((o) => declaredAvailability(o) !== null).length;
  if (!declared) {
    return (
      <div className="rounded-lg border border-dashed border-ink-faint bg-surface">
        <EmptyState title="No availability has been written down yet" text="Open an object and fill in the availability it promises, for example 99.9. Start with what you buy from others and with your data stores: they set the ceiling for everything above them." />
      </div>
    );
  }
  return (
    <div data-availability>
      <p className="text-[13px] text-ink-soft">
        An object is up only while everything it needs is up, so its real availability is its own multiplied by that of everything in its chain, each counted once. Objects with no number written are counted as always up, which flatters the
        result: {declared} of {Object.keys(ws.objects).length} objects have one.
      </p>
      <table className="mt-3 w-full text-sm rounded-lg border border-line bg-surface overflow-hidden">
        <thead className="text-left text-[13px] text-ink-soft bg-paper">
          <tr>
            <th className="px-4 py-2 font-medium">Object</th>
            <th className="px-4 py-2 font-medium">Promises</th>
            <th className="px-4 py-2 font-medium">Can deliver</th>
            <th className="px-4 py-2 font-medium">Expected to be down</th>
            <th className="px-4 py-2 font-medium">Weakest link</th>
            <th className="px-4 py-2 font-medium">Chain</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const short = r.declared !== null && r.effective < r.declared - 0.0005;
            return (
              <tr key={r.object.id} className="border-t border-line-soft" data-resilience={r.object.name}>
                <td className="px-4 py-2">
                  <ObjectLink object={r.object} />
                </td>
                <td className="px-4 py-2 tabular-nums">{r.declared === null ? <span className="text-ink-faint">Not said</span> : percent(r.declared)}</td>
                <td className={`px-4 py-2 tabular-nums font-medium ${short ? "text-danger" : ""}`} title={short ? "Less than it promises, because of what it depends on" : undefined}>
                  {percent(r.effective)}
                </td>
                <td className="px-4 py-2 text-ink-soft">{formatDowntime(r.downtimeHours)}</td>
                <td className="px-4 py-2 text-ink-soft">{r.weakest && r.weakest.object.id !== r.object.id ? `${r.weakest.object.name} (${percent(r.weakest.availability)})` : "Itself"}</td>
                <td className="px-4 py-2 text-ink-soft">
                  {r.dependsOn === 0 ? "Needs nothing" : `Needs ${r.dependsOn}`}
                  {r.undeclared > 0 && `, ${r.undeclared} without a number`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 text-[13px] text-ink-soft">The sum assumes failures are independent and that nothing is duplicated. Where you run two of something, the real figure is better than shown.</p>
    </div>
  );
}

/** Dependencies on another team that the other team has not confirmed. */
function Confirmations({ ws }: { ws: Workspace }) {
  const me = useMe();
  const canEdit = useCanEdit();
  const pending = useMemo(() => pendingHandshakes(ws), [ws]);
  const counts = handshakeCounts(ws);
  const mine = pending.filter((r) => ownsTarget(ws, r, me.names));
  const others = pending.filter((r) => !mine.includes(r));
  const row = (id: string, canConfirm: boolean) => {
    const r = ws.relationships[id];
    const source = ws.objects[r.sourceId];
    const target = ws.objects[r.targetId];
    return (
      <li key={id} className="px-4 py-2.5 flex items-center gap-3" data-pending-handshake>
        <span className="min-w-0 flex-1">
          <span className="font-medium">{source.name}</span> <span className="text-ink-soft">({source.owner})</span> <span className="text-ink-soft">{RELATION_KIND_INFO[r.kind].verb}</span> <span className="font-medium">{target.name}</span>{" "}
          <span className="text-ink-soft">({target.owner})</span>
          {(r.label || r.protocol) && <span className="block text-[13px] text-ink-soft">{[r.label, r.protocol].filter(Boolean).join(", ")}</span>}
        </span>
        {canEdit && canConfirm && (
          <Button size="sm" icon={<Check size={13} />} onClick={() => apply((w) => confirmDependency(w, id, me.name))}>
            Confirm
          </Button>
        )}
      </li>
    );
  };
  if (!counts.needed) {
    return (
      <div className="rounded-lg border border-dashed border-ink-faint bg-surface">
        <EmptyState title="No dependency crosses teams yet" text="A confirmation is asked when an object of one owner depends on an object of another. Give objects their owners and draw what they need." />
      </div>
    );
  }
  return (
    <div data-confirmations>
      <p className="text-[13px] text-ink-soft">
        {counts.confirmed} of {counts.needed} dependencies between different owners are confirmed by the side that is depended on. A confirmation is for the relationship as it was: changing it asks again.
      </p>
      {mine.length > 0 && (
        <>
          <h2 className="mt-4 font-semibold">Waiting for you</h2>
          <ul className="mt-2 rounded-lg border border-line bg-surface divide-y divide-line-soft">{mine.map((r) => row(r.id, true))}</ul>
        </>
      )}
      {others.length > 0 && (
        <>
          <h2 className="mt-4 font-semibold">Waiting for others</h2>
          <ul className="mt-2 rounded-lg border border-line bg-surface divide-y divide-line-soft">{others.map((r) => row(r.id, me.speaksForEveryone))}</ul>
        </>
      )}
      {pending.length === 0 && <p className="mt-4 text-ok font-medium">Every dependency between teams is confirmed.</p>}
    </div>
  );
}

/** Whose facts are due for a look. */
function Freshness({ ws }: { ws: Workspace }) {
  const me = useMe();
  const canEdit = useCanEdit();
  const [mineOnly, setMineOnly] = useState(false);
  const rows = useMemo(
    () =>
      Object.values(ws.objects)
        .filter(truthMatters)
        .map((object) => ({ object, truth: truthOf(object) }))
        .sort((a, b) => b.truth.ageDays / b.truth.intervalDays - a.truth.ageDays / a.truth.intervalDays || a.object.name.localeCompare(b.object.name)),
    [ws],
  );
  const count = (state: string) => rows.filter((r) => r.truth.state === state).length;
  const due = rows.filter((r) => r.truth.state !== "fresh" && (!mineOnly || me.names.some((n) => n.toLowerCase() === r.object.owner.trim().toLowerCase())));
  return (
    <div data-freshness>
      <p className="text-[13px] text-ink-soft">
        A fact is trusted for as long as someone has looked at it recently. Each object is due every 180 days, or every 90 when it is tagged tier-1. Of {rows.length} active and deprecated objects, {count("fresh")} are fresh, {count("aging")} ageing
        and {count("stale")} stale.
      </p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
        Only objects I own
      </label>
      {due.length === 0 ? (
        <p className="mt-4 text-ok font-medium">{mineOnly ? "Nothing of yours is due." : "Nothing is due. Everything was added or confirmed recently."}</p>
      ) : (
        <ul className="mt-3 rounded-lg border border-line bg-surface divide-y divide-line-soft">
          {due.map(({ object, truth }) => (
            <li key={object.id} className="px-4 py-2.5 flex items-center gap-3" data-due={object.name}>
              <span className="min-w-0 flex-1">
                <ObjectLink object={object} /> <Badge tone={truth.state === "stale" ? "red" : "amber"}>{TRUTH_STATE_LABEL[truth.state]}</Badge>
                <span className="block text-[13px] text-ink-soft">
                  {object.owner || "No owner"}. {truth.confirmed ? `Confirmed ${formatDate(truth.since)}${truth.by ? ` by ${truth.by}` : ""}` : `Never confirmed; added ${formatDate(truth.since)}`}, {truth.ageDays} days ago.
                </span>
              </span>
              {canEdit && (
                <Button size="sm" icon={<Check size={13} />} title="Records that you looked and its details are right" onClick={() => apply((w) => confirmTruth(w, object.id, me.name))}>
                  Still true
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** How far the model can be leaned on: what breaks when something stops, what it can deliver, and whether what it says is still known to be true. */
export function HealthPage() {
  const ws = useWorkspace();
  const [params, setParams] = useSearchParams();
  const tab = (["failure", "availability", "confirmations", "freshness"] as const).find((t) => t === params.get("tab")) ?? "failure";
  const pending = useMemo(() => pendingHandshakes(ws).length, [ws]);
  const stale = useMemo(() => Object.values(ws.objects).filter((o) => truthMatters(o) && truthOf(o).state === "stale").length, [ws]);
  return (
    <div className="max-w-6xl mx-auto px-6 py-7">
      <h1 className="text-xl font-semibold">Health</h1>
      <p className="text-ink-soft mt-0.5">What stops when something stops, what each thing can really deliver, and whether what the model says is still known to be true.</p>
      <div className="mt-4">
        <Tabs<Tab>
          value={tab}
          onChange={(next) => setParams({ tab: next }, { replace: true })}
          tabs={[
            { id: "failure", label: "What if it stops" },
            { id: "availability", label: "Availability" },
            { id: "confirmations", label: "Confirmations", count: pending || undefined },
            { id: "freshness", label: "Freshness", count: stale || undefined },
          ]}
        />
      </div>
      <div className="mt-5">
        {Object.keys(ws.objects).length === 0 ? (
          <EmptyState title="The model is empty" text="Add objects and the relationships between them first." />
        ) : tab === "failure" ? (
          <Failure ws={ws} />
        ) : tab === "availability" ? (
          <Availability ws={ws} />
        ) : tab === "confirmations" ? (
          <Confirmations ws={ws} />
        ) : (
          <Freshness ws={ws} />
        )}
      </div>
    </div>
  );
}
