import { ArrowLeftRight, GitBranch } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ScenarioMerge } from "@/components/cloud/ScenarioMerge";
import { Button, EmptyState, Field, Input, Textarea } from "@/components/ui";
import { createScenario, errorText, openWorkspace, tablesOfWorkspace, useCanEdit, useSession } from "@/lib/cloud/session";
import { toTables, type Tables } from "@/lib/cloud/tables";
import { useWorkspace } from "@/lib/store";

/** Scenarios (PRD FR-17): branch the model, change the copy, and compare it with the model as it is. */
export function ScenariosPage() {
  const ws = useWorkspace();
  const workspaceId = useSession((s) => s.workspaceId);
  const workspaces = useSession((s) => s.workspaces);
  const canEdit = useCanEdit();
  const here = workspaces.find((w) => w.id === workspaceId);
  const main = here?.scenarioOf ? workspaces.find((w) => w.id === here.scenarioOf) : undefined;
  const scenarios = workspaces.filter((w) => w.scenarioOf === workspaceId);

  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [current, setCurrent] = useState<Tables | null>(null);
  const mainId = here?.scenarioOf ?? null;

  useEffect(() => {
    setCurrent(null);
    if (!mainId) return;
    let live = true;
    tablesOfWorkspace(mainId).then(
      (tables) => live && setCurrent(tables),
      (e) => live && setProblem(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [mainId]);
  const target = useMemo(() => toTables(ws), [ws]);

  const run = (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setProblem("");
    work().catch((e) => setProblem(errorText(e))).finally(() => setBusy(false));
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) run(() => createScenario(name, note));
  };

  if (here?.scenarioOf) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-7">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Scenario: {here.name}</h1>
            <p className="text-ink-soft mt-0.5">
              A copy of {main ? `"${main.name}"` : "another workspace"} to try changes in. Nothing here touches that model.
              {here.scenarioNote && <span className="block mt-1 text-ink">{here.scenarioNote}</span>}
            </p>
          </div>
          {main && (
            <Button icon={<ArrowLeftRight size={15} />} disabled={busy} onClick={() => run(() => openWorkspace(main.id))}>
              Back to {main.name}
            </Button>
          )}
        </div>
        {problem && (
          <p role="alert" className="mt-4 rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
            {problem}
          </p>
        )}
        <h2 className="mt-7 font-semibold">What this scenario changes</h2>
        <p className="text-[13px] text-ink-soft mt-0.5">
          Compared with {main ? `"${main.name}"` : "the main model"} as it is now. Tick the changes that are agreed and bring them into that model; the rest stay here.
        </p>
        <div className="mt-3" data-scenario-comparison>
          {!main ? (
            <p className="text-ink-soft">You are no longer a member of the workspace this scenario came from, so there is nothing to compare it with.</p>
          ) : current ? (
            <ScenarioMerge main={main} mainTables={current} scenarioTables={target} since={here.createdAt} onMerged={async () => setCurrent(await tablesOfWorkspace(main.id))} />
          ) : (
            !problem && <p className="text-ink-soft">Reading the main model</p>
          )}
        </div>
        <p className="mt-6 text-[13px] text-ink-soft">To remove the scenario, an owner deletes it under Settings.</p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-7">
      <h1 className="text-xl font-semibold">Scenarios</h1>
      <p className="text-ink-soft mt-0.5">Copy the model, change the copy to show a target state, and compare it with the model as it is. The model itself stays untouched.</p>
      {problem && (
        <p role="alert" className="mt-4 rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
          {problem}
        </p>
      )}

      {scenarios.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-ink-faint bg-surface">
          <EmptyState title="No scenarios yet" text={canEdit ? "Name one below, for example the move you are planning or the year it describes." : "An owner or editor can create one. Scenarios you are a member of are listed here."} />
        </div>
      ) : (
        <ul className="mt-6 rounded-lg border border-line bg-surface divide-y divide-line-soft" data-scenarios>
          {scenarios.map((s) => (
            <li key={s.id} className="px-4 py-3 flex items-center gap-3">
              <GitBranch size={16} className="text-ink-soft shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block font-medium truncate">{s.name}</span>
                {s.scenarioNote && <span className="block text-[13px] text-ink-soft truncate">{s.scenarioNote}</span>}
              </span>
              <Button size="sm" disabled={busy} onClick={() => run(() => openWorkspace(s.id))}>
                Open and compare
              </Button>
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <form onSubmit={create} className="mt-6 rounded-lg border border-line bg-surface px-5 py-4 space-y-3 max-w-xl">
          <h2 className="font-semibold">New scenario</h2>
          <Field label="Name">
            <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="For example: Move payments to the cloud" />
          </Field>
          <Field label="What it is for" hint="Optional.">
            <Textarea rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <p className="text-[13px] text-ink-soft">
            Copies {Object.keys(ws.objects).length} objects, {Object.keys(ws.relationships).length} relationships and {Object.keys(ws.diagrams).length} diagrams. Owners and editors of this workspace become members of the scenario; viewers and
            commenters do not. Comments, versions and drafts are not copied.
          </p>
          <Button type="submit" variant="primary" icon={<GitBranch size={15} />} disabled={busy || !name.trim()}>
            {busy ? "Copying" : "Create scenario"}
          </Button>
        </form>
      )}
    </div>
  );
}
