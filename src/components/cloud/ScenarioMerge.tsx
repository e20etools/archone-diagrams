import { GitMerge, Minus, Pencil, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, countOf } from "@/components/ui";
import { canEditRole, type WorkspaceSummary } from "@/lib/cloud/backend";
import { mergeChange, mergeItems, type MergeItem, type MergeSide } from "@/lib/cloud/merge";
import { bringIntoWorkspace, errorText } from "@/lib/cloud/session";
import { countChanges, type Tables } from "@/lib/cloud/tables";

const KIND = {
  added: { icon: Plus, word: "Adds", tone: "text-ok bg-ok-soft" },
  removed: { icon: Minus, word: "Removes", tone: "text-danger bg-danger-soft" },
  changed: { icon: Pencil, word: "Changes", tone: "text-signal bg-signal-soft" },
} as const;
const TABLE_WORD = { objects: "Object", relationships: "Relationship", diagrams: "Diagram" } as const;

const GROUPS: { side: MergeSide; title: string; text: string }[] = [
  { side: "scenario", title: "Changed in this scenario", text: "The scenario's own work. Ticked to begin with." },
  { side: "both", title: "Changed on both sides", text: "The main model changed these too since the scenario was created. Bringing one over replaces the main model's version with the scenario's." },
  { side: "main", title: "Changed only in the main model", text: "The main model moved on and the scenario did not follow. Bringing one over would undo that change, so leave these unticked unless that is what you mean." },
];

/** What a scenario changes, thing by thing, with a tick for each one to bring into the main model. */
export function ScenarioMerge({ main, mainTables, scenarioTables, since, onMerged }: { main: WorkspaceSummary; mainTables: Tables; scenarioTables: Tables; since: string | null; onMerged: () => Promise<void> }) {
  const items = useMemo(() => mergeItems(mainTables, scenarioTables, since), [mainTables, scenarioTables, since]);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [on, setOn] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [done, setDone] = useState("");
  const mayBring = canEditRole(main.role);

  // Ticks are kept as departures from the default, so a list that reloads keeps what the person chose.
  const ticked = (item: MergeItem) => (item.side === "scenario" ? !off.has(item.key) : on.has(item.key));
  const toggle = (item: MergeItem) => {
    const [set, update] = item.side === "scenario" ? [off, setOff] : [on, setOn];
    const next = new Set(set);
    if (next.has(item.key)) next.delete(item.key);
    else next.add(item.key);
    update(next);
    setDone("");
  };
  const picked = items.filter(ticked).map((i) => i.key);
  const result = useMemo(() => mergeChange(mainTables, scenarioTables, picked), [mainTables, scenarioTables, picked.join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps

  if (items.length === 0) return <p className="text-ink-soft">{done || "Nothing differs yet. Change the model or a diagram in this scenario and come back."}</p>;

  const bring = () => {
    if (busy || !picked.length) return;
    setBusy(true);
    setProblem("");
    setDone("");
    const count = picked.length;
    bringIntoWorkspace(main.id, result.change)
      .then(onMerged)
      .then(() => {
        setOn(new Set());
        setDone(`Brought ${countOf(count, "change")} into "${main.name}".`);
      })
      .catch((e) => setProblem(errorText(e)))
      .finally(() => setBusy(false));
  };

  const extras = [
    result.brought.length ? `${result.brought.join(", ")} ${result.brought.length === 1 ? "comes" : "come"} along, because something ticked needs ${result.brought.length === 1 ? "it" : "them"}.` : "",
    result.dropped.relationships ? `${countOf(result.dropped.relationships, "relationship")} of the main model ${result.dropped.relationships === 1 ? "goes" : "go"} with the removed objects.` : "",
    result.dropped.boxes ? `${countOf(result.dropped.boxes, "box")} on the main model's diagrams ${result.dropped.boxes === 1 ? "goes" : "go"} with them.` : "",
  ].filter(Boolean);

  return (
    <div data-scenario-merge>
      {done && (
        <p role="status" className="mb-3 rounded-md bg-ok-soft text-ok px-3 py-2 text-sm">
          {done}
        </p>
      )}
      <div className="space-y-5">
        {GROUPS.map((group) => {
          const rows = items.filter((i) => i.side === group.side);
          if (!rows.length) return null;
          return (
            <section key={group.side} data-merge-group={group.side}>
              <h3 className="font-semibold">
                {group.title} <span className="font-normal text-ink-soft tabular-nums">{rows.length}</span>
              </h3>
              <p className="text-[13px] text-ink-soft max-w-3xl">{group.text}</p>
              <ul className="mt-2 rounded-lg border border-line bg-surface divide-y divide-line-soft">
                {rows.map((item) => {
                  const { icon: Icon, word, tone } = KIND[item.kind];
                  return (
                    <li key={item.key}>
                      <label className={`flex gap-3 px-4 py-2.5 ${mayBring ? "cursor-pointer hover:bg-paper" : ""}`}>
                        {mayBring && <input type="checkbox" className="mt-1 size-4 accent-blueprint" checked={ticked(item)} onChange={() => toggle(item)} data-merge-item={item.key} />}
                        <span className={`mt-0.5 shrink-0 inline-grid place-items-center size-5 rounded ${tone}`} title={word}>
                          <Icon size={12} strokeWidth={2.5} aria-hidden />
                        </span>
                        <span className="min-w-0">
                          <span className="block">
                            <span className="text-[13px] text-ink-soft">
                              {word} {TABLE_WORD[item.table].toLowerCase()}
                            </span>{" "}
                            <span className="font-medium">{item.title}</span>
                            {item.detail && <span className="ml-2 text-[13px] text-ink-soft">{item.detail}</span>}
                          </span>
                          {item.fields.map((f) => (
                            <span key={f.field} className="block text-[13px] text-ink-soft break-words">
                              {f.field}: <span className="line-through decoration-ink-faint">{f.before}</span> <span className="sr-only">becomes</span>
                              <span aria-hidden>to</span> <span className="text-ink">{f.after}</span>
                            </span>
                          ))}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      {problem && (
        <p role="alert" className="mt-4 rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
          {problem}
        </p>
      )}
      {mayBring ? (
        <div className="mt-5 rounded-lg border border-line bg-surface px-5 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" icon={<GitMerge size={15} />} disabled={busy || !picked.length} onClick={bring} data-merge-bring>
              {busy ? "Bringing over" : `Bring ${countOf(picked.length, "change")} into ${main.name}`}
            </Button>
            <span className="text-[13px] text-ink-soft">{picked.length ? `${countOf(countChanges(result.change), "row")} of the main model will be written.` : "Tick at least one change."}</span>
          </div>
          {extras.map((line) => (
            <p key={line} className="mt-2 text-[13px] text-ink-soft" data-merge-extra>
              {line}
            </p>
          ))}
          <p className="mt-2 text-[13px] text-ink-soft max-w-3xl">
            The changes are saved in the main model as your edits and appear in its audit log. If that workspace requires review, they wait in its working model until they are submitted and approved. The scenario stays as it is.
          </p>
        </div>
      ) : (
        <p className="mt-5 text-[13px] text-ink-soft">Only an owner or editor of "{main.name}" can bring changes into it.</p>
      )}
    </div>
  );
}
