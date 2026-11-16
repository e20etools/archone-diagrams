import { ArrowDown, ArrowUp, ListOrdered, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, IconButton, Input, Select, cx } from "@/components/ui";
import { CATEGORY_INFO as AREA_INFO, VIEWS_BY_CATEGORY, CATEGORIES as AREAS } from "@/lib/categories";
import { OBJECT_TYPES, RELATION_KIND_INFO, VIEW_TYPE_INFO } from "@/lib/catalog";
import { useMe } from "@/lib/cloud/me";
import { useSession } from "@/lib/cloud/session";
import { cloudEnabled } from "@/lib/cloud/config";
import { componentById } from "@/lib/library";
import { apply, useWorkspace } from "@/lib/store";
import { RELATION_KINDS, type RelationKind, type ViewType } from "@/lib/types";
import { BUILT_IN_STEPS, hasOwnWizard, newStepId, resetWizard, saveWizard, stepComponents, wizardSteps, wizardStepsProblems, type WizardStep } from "@/lib/wizard";

const clone = (steps: WizardStep[]) => JSON.parse(JSON.stringify(steps)) as WizardStep[];

/**
 * The wizard's questions for each kind of diagram, as the workspace wants them: add, remove,
 * reorder and change the steps, what each one asks, which library components it offers and how
 * its answers connect. Owners change them; everyone else sees them.
 */
export function WizardSettingsCard() {
  const ws = useWorkspace();
  const me = useMe();
  const role = useSession((s) => s.role);
  const canChange = !cloudEnabled || role === "owner";
  const [kind, setKind] = useState<ViewType>("container");
  const saved = wizardSteps(kind, ws);
  const [steps, setSteps] = useState<WizardStep[]>(() => clone(saved));
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  // Another kind, or a change saved elsewhere, starts the editor again from what is kept.
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    setSteps(clone(JSON.parse(savedKey)));
    setOpen(null);
  }, [kind, savedKey]);
  const dirty = JSON.stringify(steps) !== savedKey;
  const problems = useMemo(() => wizardStepsProblems(steps), [steps]);
  const own = hasOwnWizard(kind, ws);

  const update = (id: string, patch: Partial<WizardStep>) => setSteps((all) => all.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const move = (index: number, by: number) =>
    setSteps((all) => {
      const next = [...all];
      const [step] = next.splice(index, 1);
      next.splice(index + by, 0, step);
      return next;
    });
  const remove = (id: string) =>
    setSteps((all) =>
      all
        .filter((s) => s.id !== id)
        // Nothing may point at a step that is gone.
        .map((s) => ({ ...s, inside: s.inside === id ? undefined : s.inside, links: (s.links ?? []).filter((l) => l.to !== id) })),
    );
  const add = () => {
    const id = newStepId(steps);
    setSteps((all) => [...all, { id, title: "New step", question: "", kinds: ["application"], usual: "applications.custom-application", placeholder: "", links: [] }]);
    setOpen(id);
  };

  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4" data-wizard-settings>
      <div className="flex items-start gap-3">
        <ListOrdered size={18} className="mt-0.5 text-ink-soft" />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Wizard steps</h2>
          <p className="text-ink-soft mt-0.5">
            The questions the wizard asks when a diagram is built step by step, for each kind of diagram. {canChange ? "Add, remove, reorder or change them." : "Only an owner can change them."}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Kind of diagram">
        {AREAS.flatMap((area) => VIEWS_BY_CATEGORY[area].map((v) => ({ area, v }))).map(({ area, v }) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={kind === v}
            data-wizard-kind={v}
            onClick={() => setKind(v)}
            className={cx("rounded-full border px-3 py-1 text-[13px]", kind === v ? "border-blueprint bg-blueprint-soft text-blueprint" : "border-line text-ink-soft hover:border-ink-faint")}
            title={AREA_INFO[area].label}
          >
            {VIEW_TYPE_INFO[v].label}
            {hasOwnWizard(v, ws) && <span className="ml-1 text-ok">•</span>}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-faint">
        {own ? `Set for this workspace by ${ws.wizards[kind].author}.` : "The built-in steps."} A dot marks the kinds with steps of their own.
      </p>

      <ol className="mt-3 space-y-1.5" data-wizard-steps={steps.length}>
        {steps.map((step, index) => (
          <li key={step.id} className="rounded-md border border-line" data-wizard-step-row={step.id}>
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-paper text-xs tabular-nums">{index + 1}</span>
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === step.id ? null : step.id)} aria-expanded={open === step.id} data-wizard-step-open={step.id}>
                <span className="font-medium">{step.title || "Untitled step"}</span>
                <span className="ml-2 text-[13px] text-ink-soft">{step.question}</span>
                <span className="ml-2 inline-flex gap-1 align-middle">
                  {step.required && <Badge tone="amber">Required</Badge>}
                  {step.single && <Badge>One answer</Badge>}
                  {step.chain && <Badge>In order</Badge>}
                </span>
              </button>
              {canChange && (
                <>
                  <IconButton label={`Move ${step.title} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                    <ArrowUp size={14} />
                  </IconButton>
                  <IconButton label={`Move ${step.title} down`} disabled={index === steps.length - 1} onClick={() => move(index, 1)}>
                    <ArrowDown size={14} />
                  </IconButton>
                  <IconButton label={`Remove ${step.title}`} data-wizard-step-remove={step.id} onClick={() => remove(step.id)}>
                    <Trash2 size={14} />
                  </IconButton>
                </>
              )}
            </div>
            {open === step.id && <StepEditor step={step} steps={steps} disabled={!canChange} onChange={(patch) => update(step.id, patch)} />}
          </li>
        ))}
      </ol>

      {canChange && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" icon={<Plus size={14} />} onClick={add} disabled={steps.length >= 20} data-wizard-add>
            Add a step
          </Button>
          <span className="mr-auto" />
          {own && (
            <Button
              size="sm"
              data-wizard-reset
              icon={<RotateCcw size={14} />}
              onClick={() => {
                apply((w) => resetWizard(w, kind));
                setNotice("Back to the built-in steps.");
              }}
            >
              Use the built-in steps
            </Button>
          )}
          <Button size="sm" disabled={!dirty} onClick={() => setSteps(clone(saved))}>
            Undo changes
          </Button>
          <Button
            size="sm"
            variant="primary"
            data-wizard-save
            disabled={!dirty || problems.length > 0}
            onClick={() => {
              apply((w) => saveWizard(w, kind, steps, me.name));
              setNotice(`Saved. The wizard for ${VIEW_TYPE_INFO[kind].label} now asks ${steps.length} ${steps.length === 1 ? "question" : "questions"}.`);
            }}
          >
            Save steps
          </Button>
        </div>
      )}
      {dirty && problems.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[13px] text-danger" data-wizard-problems>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {notice && !dirty && (
        <p role="status" className="mt-2 text-[13px] text-ok">
          {notice}
        </p>
      )}
      <p className="mt-2 text-xs text-ink-faint">The built-in steps for this kind: {BUILT_IN_STEPS[kind].map((s) => s.title).join(", ")}.</p>
    </section>
  );
}

const KIND_OPTIONS = OBJECT_TYPES.filter((t) => t.id !== "diagram");

function StepEditor({ step, steps, disabled, onChange }: { step: WizardStep; steps: WizardStep[]; disabled: boolean; onChange: (patch: Partial<WizardStep>) => void }) {
  const offered = useMemo(() => stepComponents(step).slice(0, 800), [step]);
  const usual = componentById(step.usual);
  const others = steps.filter((s) => s.id !== step.id);
  const listId = `wizard-usual-${step.id}`;
  return (
    <fieldset disabled={disabled} className="border-t border-line-soft px-3 py-3 space-y-3 text-[13px]" data-wizard-step-editor={step.id}>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className="block">
          <span className="block text-xs text-ink-soft mb-1">Title</span>
          <Input value={step.title} maxLength={60} aria-label="Step title" onChange={(e) => onChange({ title: e.target.value })} />
        </label>
        <label className="block">
          <span className="block text-xs text-ink-soft mb-1">Example answer</span>
          <Input value={step.placeholder} maxLength={80} aria-label="Example answer" onChange={(e) => onChange({ placeholder: e.target.value })} />
        </label>
        <label className="block sm:col-span-2">
          <span className="block text-xs text-ink-soft mb-1">Question</span>
          <Input value={step.question} maxLength={200} aria-label="Question" onChange={(e) => onChange({ question: e.target.value })} />
        </label>
      </div>

      <div>
        <span className="block text-xs text-ink-soft mb-1">Kinds of component offered (none ticked offers the whole library)</span>
        <div className="flex flex-wrap gap-1">
          {KIND_OPTIONS.map((t) => {
            const on = step.kinds.includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={on}
                data-wizard-kind-option={t.id}
                onClick={() => onChange({ kinds: on ? step.kinds.filter((k) => k !== t.id) : [...step.kinds, t.id] })}
                className={cx("rounded-full border px-2 py-0.5 text-xs", on ? "border-blueprint bg-blueprint-soft text-blueprint" : "border-line text-ink-soft hover:border-ink-faint")}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <label className="block">
        <span className="block text-xs text-ink-soft mb-1">An answer becomes this component unless a better one is chosen or named</span>
        <Input
          list={listId}
          aria-label="Usual component"
          defaultValue={usual?.name ?? ""}
          key={step.usual}
          onChange={(e) => {
            const found = offered.find((c) => c.name === e.target.value);
            if (found) onChange({ usual: found.id });
          }}
        />
        <datalist id={listId}>
          {offered.map((c) => (
            <option key={c.id} value={c.name} />
          ))}
        </datalist>
        {usual && <span className="mt-0.5 block text-xs text-ink-faint">Now: {usual.name}</span>}
      </label>

      <div className="flex flex-wrap gap-x-5 gap-y-1.5">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" className="accent-blueprint" checked={!!step.required} onChange={(e) => onChange({ required: e.target.checked || undefined })} />
          Has to be answered
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" className="accent-blueprint" checked={!!step.single} onChange={(e) => onChange({ single: e.target.checked || undefined })} />
          One answer only
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" className="accent-blueprint" checked={!!step.chain} onChange={(e) => onChange({ chain: e.target.checked || undefined })} />
          Answers connect one after another, in order
        </label>
      </div>

      <label className="block max-w-sm">
        <span className="block text-xs text-ink-soft mb-1">Answers sit inside the answer of</span>
        <Select value={step.inside ?? ""} aria-label="Answers sit inside" onChange={(e) => onChange({ inside: e.target.value || undefined })}>
          <option value="">No other step</option>
          {others.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </Select>
      </label>

      <div>
        <span className="block text-xs text-ink-soft mb-1">Connections from this step's answers</span>
        <ul className="space-y-1.5">
          {(step.links ?? []).map((l, i) => {
            const setLink = (patch: Partial<typeof l>) => onChange({ links: (step.links ?? []).map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <li key={i} className="flex flex-wrap items-center gap-1.5" data-wizard-link>
                <Select className="w-40" value={l.kind} aria-label="Relationship" onChange={(e) => setLink({ kind: e.target.value as RelationKind })}>
                  {RELATION_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {RELATION_KIND_INFO[k].label}
                    </option>
                  ))}
                </Select>
                <Select className="w-44" value={l.to} aria-label="To the answers of" onChange={(e) => setLink({ to: e.target.value })}>
                  {others.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                </Select>
                <Select className="w-40" value={l.how} aria-label="How" onChange={(e) => setLink({ how: e.target.value as "each" | "spread" })}>
                  <option value="each">every answer to every one</option>
                  <option value="spread">each answer to one, in turn</option>
                </Select>
                <Input className="w-32" value={l.label} placeholder="Label" aria-label="Label" maxLength={80} onChange={(e) => setLink({ label: e.target.value })} />
                <IconButton label="Remove this connection" onClick={() => onChange({ links: (step.links ?? []).filter((_, j) => j !== i) })}>
                  <X size={14} />
                </IconButton>
              </li>
            );
          })}
        </ul>
        {others.length > 0 && (step.links ?? []).length < 10 && (
          <Button size="sm" variant="ghost" className="mt-1" icon={<Plus size={13} />} data-wizard-link-add onClick={() => onChange({ links: [...(step.links ?? []), { to: others[0].id, kind: "calls", label: "", how: "each" }] })}>
            Add a connection
          </Button>
        )}
      </div>
    </fieldset>
  );
}
