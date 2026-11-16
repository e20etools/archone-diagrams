import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Field, IconButton, Input, Select, Textarea, useNotice } from "@/components/ui";
import { personLabel, type ReviewStage } from "@/lib/cloud/collab";
import { errorText, saveReviewSettings, useSession } from "@/lib/cloud/session";

interface DraftStage {
  id: string;
  name: string;
  reviewerId: string;
  /** One checklist item per line while editing. */
  checklist: string;
}
const toDraft = (stages: ReviewStage[]): DraftStage[] => stages.map((s) => ({ id: s.id, name: s.name, reviewerId: s.reviewerId, checklist: s.checklist.join("\n") }));
const toStages = (draft: DraftStage[]): ReviewStage[] =>
  draft.map((s) => ({
    id: s.id,
    name: s.name.trim(),
    reviewerId: s.reviewerId,
    checklist: s.checklist
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  }));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Settings: who has to approve the model before viewers and commenters see a change. */
export function ReviewSettingsCard() {
  const settings = useSession((s) => s.review);
  const people = useSession((s) => s.people);
  const role = useSession((s) => s.role);
  const me = useSession((s) => s.user);
  const owner = role === "owner";
  const [required, setRequired] = useState(settings.required);
  const [stages, setStages] = useState<DraftStage[]>(() => toDraft(settings.stages));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const { notify, view: notice } = useNotice();

  // Someone else's change to the settings replaces what is shown, unless this person is mid-edit.
  const [seen, setSeen] = useState(settings);
  useEffect(() => {
    if (same(seen, settings)) return;
    const untouched = required === seen.required && same(toStages(stages), seen.stages);
    setSeen(settings);
    if (untouched) {
      setRequired(settings.required);
      setStages(toDraft(settings.stages));
    }
  }, [settings, seen, required, stages]);

  const nameOf = (userId: string) => personLabel(people.find((p) => p.userId === userId));
  const changed = required !== settings.required || !same(toStages(stages), settings.stages);
  const patch = (index: number, change: Partial<DraftStage>) => setStages((list) => list.map((s, i) => (i === index ? { ...s, ...change } : s)));
  const save = () => {
    setBusy(true);
    setProblem("");
    saveReviewSettings(required, toStages(stages)).then(
      () => {
        setBusy(false);
        notify(required ? "Review is on." : "Review settings saved.");
      },
      (e) => {
        setBusy(false);
        setProblem(errorText(e));
      },
    );
  };

  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4" aria-label="Review before publishing">
      <h2 className="text-base font-semibold">
        Review before publishing <Badge tone={settings.required ? "green" : "neutral"}>{settings.required ? "On" : "Off"}</Badge>
      </h2>
      <p className="text-ink-soft mt-0.5">
        While this is on, viewers and commenters see only the last approved version. Owners and editors keep working on a draft and submit it; each stage's reviewer approves it
        or sends it back with a reason.
      </p>

      {!owner ? (
        <div className="mt-3">
          {settings.stages.length === 0 ? (
            <p className="text-ink-soft">No stages are set up. Only an owner can change this.</p>
          ) : (
            <ol className="list-decimal pl-5 space-y-0.5">
              {settings.stages.map((s) => (
                <li key={s.id}>
                  <span className="font-medium">{s.name}</span> <span className="text-ink-soft">reviewed by {nameOf(s.reviewerId)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : (
        <div className="mt-3.5 space-y-3">
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={required} onChange={(e) => setRequired(e.target.checked)} />
            <span>
              <span className="font-medium">Require review before a change is published</span>
              {required && !settings.required && !settings.publishedVersionId && (
                <span className="block text-[13px] text-ink-soft">The model as it is now becomes the first published version, so readers keep seeing what they see today.</span>
              )}
            </span>
          </label>

          {stages.map((stage, i) => (
            <fieldset key={stage.id} className="rounded-md border border-line px-3.5 py-3">
              <legend className="px-1 text-[13px] font-medium text-ink-soft">Stage {i + 1}</legend>
              <div className="grid sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
                <Field label="Name">
                  <Input value={stage.name} maxLength={80} placeholder="For example: Architecture" onChange={(e) => patch(i, { name: e.target.value })} />
                </Field>
                <Field label="Reviewer">
                  <Select value={stage.reviewerId} onChange={(e) => patch(i, { reviewerId: e.target.value })}>
                    {!people.some((p) => p.userId === stage.reviewerId) && <option value={stage.reviewerId}>Choose a member</option>}
                    {people.map((p) => (
                      <option key={p.userId} value={p.userId}>
                        {personLabel(p)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <IconButton label={`Remove stage ${i + 1}`} onClick={() => setStages((list) => list.filter((_, j) => j !== i))}>
                  <Trash2 size={15} />
                </IconButton>
              </div>
              <Field label="Checklist" hint="One item per line. The reviewer has to tick every item to approve." className="mt-3">
                <Textarea rows={2} value={stage.checklist} placeholder={"Follows the reference architecture\nEvery system has a named owner"} onChange={(e) => patch(i, { checklist: e.target.value })} />
              </Field>
            </fieldset>
          ))}

          {problem && (
            <p role="alert" className="rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
              {problem}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              icon={<Plus size={15} />}
              disabled={stages.length >= 5}
              onClick={() => setStages((list) => [...list, { id: `stage_${Math.random().toString(36).slice(2, 10)}`, name: "", reviewerId: me?.id ?? "", checklist: "" }])}
            >
              Add a stage
            </Button>
            <Button variant="primary" disabled={!changed || busy} onClick={save}>
              {busy ? "Saving" : "Save review settings"}
            </Button>
          </div>
        </div>
      )}
      {notice}
    </section>
  );
}
