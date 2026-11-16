import { ArrowLeft, Pencil, Plus, Trash2, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, EmptyState, Field, IconButton, Input, Select, Textarea, countOf } from "@/components/ui";
import { LIFECYCLE_INFO, OBJECT_TYPES } from "@/lib/catalog";
import { CLASSIFICATIONS } from "@/lib/checks/checks";
import { createRule, deleteRule, describeRule, emptySelector, runCustomCheck, sortedRules, updateRule } from "@/lib/checks/custom";
import { parseRule } from "@/lib/checks/parseRule";
import { cloudEnabled } from "@/lib/cloud/config";
import { useSession } from "@/lib/cloud/session";
import { sortedObjects } from "@/lib/model";
import { apply, useWorkspace } from "@/lib/store";
import { LIFECYCLES, OBJECT_REQUIREMENTS, type CustomRule, type ObjectRequirement, type RuleCheck, type Selector, type Workspace } from "@/lib/types";

const TONE = { high: "red", medium: "amber", low: "neutral" } as const;
const REQUIREMENT_LABEL: Record<ObjectRequirement, string> = {
  owner: "have an owner",
  description: "have a description",
  technology: "say what technology they use",
  classification: "have a data classification",
  residency: "say where their data is kept",
  tag: "carry the tag",
  "no-tag": "not carry the tag",
  field: "have the field filled in",
  lifecycle: "be in one of these lifecycles",
};
const NEEDS_VALUE: Partial<Record<ObjectRequirement, string>> = { tag: "Tag", "no-tag": "Tag", field: 'Field name, or "name = value"', lifecycle: "Lifecycles allowed, for example: planned, active" };
const START: Record<RuleCheck["kind"], () => RuleCheck> = {
  object: () => ({ kind: "object", subject: emptySelector(), require: "owner", value: "" }),
  connection: () => ({ kind: "connection", from: emptySelector(), to: emptySelector(), mode: "never", value: "" }),
  journey: () => ({ kind: "journey", from: emptySelector(), to: emptySelector(), through: emptySelector(), mode: "always" }),
};
const tick = "size-4 accent-blueprint";
const toList = (text: string) => [...new Set(text.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))];

/** Which objects one side of a rule is about. Everything left empty means every object. */
function SelectorEditor({ ws, label, value, onChange, name }: { ws: Workspace; label: string; value: Selector; onChange: (next: Selector) => void; name: string }) {
  const [tags, setTags] = useState(value.tags.join(", "));
  const flip = <T,>(items: T[], item: T) => (items.includes(item) ? items.filter((x) => x !== item) : [...items, item]);
  const parents = useMemo(() => sortedObjects(ws).filter((o) => Object.values(ws.objects).some((c) => c.parentId === o.id)), [ws]);
  return (
    <fieldset className="rounded-md border border-line px-3 py-2.5" data-selector={name}>
      <legend className="px-1 text-[13px] font-medium">{label}</legend>
      <details className="group" open={value.types.length > 0}>
        <summary className="cursor-pointer text-[13px] text-ink-soft select-none">
          Kinds: <span className="text-ink">{value.types.length ? value.types.map((t) => OBJECT_TYPES.find((x) => x.id === t)?.label ?? t).join(", ") : "any kind"}</span>
        </summary>
        <div className="mt-1.5 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1">
          {OBJECT_TYPES.map((t) => (
            <label key={t.id} className="flex items-center gap-2 text-[13px] cursor-pointer">
              <input type="checkbox" className={tick} checked={value.types.includes(t.id)} onChange={() => onChange({ ...value, types: flip(value.types, t.id) })} />
              {t.label}
            </label>
          ))}
        </div>
      </details>
      <div className="mt-2 grid sm:grid-cols-2 gap-2">
        <Field label="Tagged" hint="Separate tags with commas.">
          <Input
            value={tags}
            onChange={(e) => {
              setTags(e.target.value);
              onChange({ ...value, tags: toList(e.target.value) });
            }}
            placeholder="any tag"
          />
        </Field>
        <Field label="Name contains">
          <Input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder="any name" />
        </Field>
        <Field label="Inside">
          <Select value={value.inside ?? ""} onChange={(e) => onChange({ ...value, inside: e.target.value || null })}>
            <option value="">Anywhere</option>
            {parents.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="text-[13px]">
          <p className="font-medium mb-1">Lifecycle</p>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {LIFECYCLES.map((l) => (
              <label key={l} className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" className={tick} checked={value.lifecycle.includes(l)} onChange={() => onChange({ ...value, lifecycle: flip(value.lifecycle, l) })} />
                {LIFECYCLE_INFO[l].label}
              </label>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" className={tick} checked={value.personal} onChange={() => onChange({ ...value, personal: !value.personal })} />
          Holds personal data
        </label>
        <span className="text-ink-soft">Classified:</span>
        {CLASSIFICATIONS.map((c) => (
          <label key={c} className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" className={tick} checked={value.classification.includes(c)} onChange={() => onChange({ ...value, classification: flip(value.classification, c) })} />
            {c}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

interface Draft {
  id: string | null;
  text: string;
  title: string;
  severity: CustomRule["severity"];
  check: RuleCheck;
  /** What the reader did with the sentence: nothing yet, read it, or could not. */
  reading: "none" | "read" | "failed";
  unread: string[];
  /** Counts up when the sentence is read again, so the fields below start afresh from what was read. */
  round: number;
}
const blank = (): Draft => ({ id: null, text: "", title: "", severity: "medium", check: START.object(), reading: "none", unread: [], round: 0 });

function RuleEditor({ ws, start, onDone }: { ws: Workspace; start: Draft; onDone: () => void }) {
  const [draft, setDraft] = useState(start);
  const { check } = draft;
  const setCheck = (next: RuleCheck) => setDraft((d) => ({ ...d, check: next }));
  const found = useMemo(() => runCustomCheck(ws, check, Object.values(ws.objects), Object.values(ws.relationships).filter((r) => ws.objects[r.sourceId] && ws.objects[r.targetId])), [ws, check]);
  const sentence = describeRule(ws, check);
  const needsValue = check.kind === "object" ? NEEDS_VALUE[check.require] : check.kind === "connection" && check.mode === "protocol" ? "Protocols allowed, for example: HTTPS, mTLS" : undefined;
  const incomplete = !!needsValue && !("value" in check && check.value.trim());

  const read = () => {
    const parsed = parseRule(ws, draft.text);
    setDraft((d) => (parsed ? { ...d, check: parsed.check, severity: parsed.severity, reading: "read", unread: parsed.unread, round: d.round + 1 } : { ...d, reading: "failed", unread: [] }));
  };
  const save = () => {
    if (incomplete) return;
    const input = { title: draft.title.trim() || sentence, text: draft.text, severity: draft.severity, check };
    apply((w) => (draft.id ? updateRule(w, draft.id, input) : createRule(w, input).ws));
    onDone();
  };

  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4 space-y-4" data-rule-editor>
      <h2 className="font-semibold">{draft.id ? "Change the rule" : "New rule"}</h2>
      <div>
        <Field label="The rule in your own words" hint="English or Arabic. For example: External systems must never connect directly to databases.">
          <Textarea rows={2} dir="auto" value={draft.text} maxLength={500} onChange={(e) => setDraft({ ...draft, text: e.target.value })} data-rule-text />
        </Field>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button icon={<Wand2 size={15} />} disabled={draft.text.trim().length < 4} onClick={read} data-rule-read>
            Read it
          </Button>
          {draft.reading === "failed" && (
            <span role="alert" className="text-[13px] text-danger">
              Nothing in that sentence could be read as a rule. Set it up with the fields below.
            </span>
          )}
          {draft.reading === "read" && draft.unread.length > 0 && (
            <span className="text-[13px] text-signal" data-rule-unread>
              Not read: {draft.unread.map((u) => `"${u}"`).join(", ")}. Check the fields below.
            </span>
          )}
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="What kind of rule">
          <Select value={check.kind} onChange={(e) => setDraft({ ...draft, check: START[e.target.value as RuleCheck["kind"]](), round: draft.round + 1 })} data-rule-kind>
            <option value="object">Something every chosen object must have</option>
            <option value="connection">How two sets of objects may connect</option>
            <option value="journey">A journey: what lies on the way between two sets</option>
          </Select>
        </Field>
        <Field label="Severity">
          <Select value={draft.severity} onChange={(e) => setDraft({ ...draft, severity: e.target.value as CustomRule["severity"] })}>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </Select>
        </Field>
      </div>

      {/* Keyed by the round, so fields that keep their own text start again from a fresh reading. */}
      <div key={draft.round} className="space-y-3">
        {check.kind === "object" && (
          <>
            <SelectorEditor ws={ws} name="subject" label="These objects" value={check.subject} onChange={(subject) => setCheck({ ...check, subject })} />
            <Field label="must">
              <Select value={check.require} onChange={(e) => setCheck({ ...check, require: e.target.value as ObjectRequirement })}>
                {OBJECT_REQUIREMENTS.map((r) => (
                  <option key={r} value={r}>
                    {REQUIREMENT_LABEL[r]}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
        {check.kind === "connection" && (
          <>
            <SelectorEditor ws={ws} name="from" label="Between these objects" value={check.from} onChange={(from) => setCheck({ ...check, from })} />
            <SelectorEditor ws={ws} name="to" label="and these" value={check.to} onChange={(to) => setCheck({ ...check, to })} />
            <Field label="the rule is">
              <Select value={check.mode} onChange={(e) => setCheck({ ...check, mode: e.target.value as "never" | "only" | "protocol" })}>
                <option value="never">they are never connected</option>
                <option value="only">the first set connects only to the second</option>
                <option value="protocol">their connections use one of these protocols</option>
              </Select>
            </Field>
          </>
        )}
        {check.kind === "journey" && (
          <>
            <SelectorEditor ws={ws} name="from" label="On the way from these objects" value={check.from} onChange={(from) => setCheck({ ...check, from })} />
            <SelectorEditor ws={ws} name="to" label="to these" value={check.to} onChange={(to) => setCheck({ ...check, to })} />
            <Field label="following the arrows, the way">
              <Select value={check.mode} onChange={(e) => setCheck({ ...check, mode: e.target.value as "never" | "always" })}>
                <option value="always">always passes through</option>
                <option value="never">never passes through</option>
              </Select>
            </Field>
            <SelectorEditor ws={ws} name="through" label="these" value={check.through} onChange={(through) => setCheck({ ...check, through })} />
          </>
        )}
        {needsValue && "value" in check && (
          <Field label={needsValue}>
            <Input value={check.value} onChange={(e) => setCheck({ ...check, value: e.target.value })} />
          </Field>
        )}
      </div>

      <div className="rounded-md bg-paper border border-line-soft px-4 py-3" data-rule-preview>
        <p className="text-[13px] text-ink-soft">Read as</p>
        <p className="font-medium" data-rule-sentence>
          {sentence}
        </p>
        <p className="mt-2 text-[13px] text-ink-soft" data-rule-found>
          {incomplete ? "Fill in the field above to see what it would find." : found.length === 0 ? "Run now, it would find nothing: the model already follows it." : `Run now, it would find ${countOf(found.length, "thing")}:`}
        </p>
        {!incomplete && found.length > 0 && (
          <ul className="mt-1 text-[13px] list-disc pl-5 space-y-0.5">
            {found.slice(0, 5).map((f, i) => (
              <li key={i}>{f.message}</li>
            ))}
            {found.length > 5 && <li className="list-none text-ink-soft">and {found.length - 5} more</li>}
          </ul>
        )}
      </div>

      <Field label="Name" hint="Left empty, the sentence above is used.">
        <Input value={draft.title} maxLength={160} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder={sentence} />
      </Field>
      <div className="flex gap-2">
        <Button variant="primary" disabled={incomplete} onClick={save} data-rule-save>
          {draft.id ? "Save the rule" : "Add the rule"}
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </section>
  );
}

/** The workspace's own rules: written as a sentence, read into a form, tried against the model, then kept. */
export function RulesPage() {
  const ws = useWorkspace();
  const role = useSession((s) => s.role);
  const mayChange = !cloudEnabled || role === "owner";
  const [editing, setEditing] = useState<Draft | null>(null);
  const rules = sortedRules(ws);
  const relationships = useMemo(() => Object.values(ws.relationships).filter((r) => ws.objects[r.sourceId] && ws.objects[r.targetId]), [ws]);
  const counts = useMemo(() => Object.fromEntries(rules.map((r) => [r.id, runCustomCheck(ws, r.check, Object.values(ws.objects), relationships).length])), [ws, rules, relationships]);

  return (
    <div className="max-w-4xl mx-auto px-6 py-7" data-rules-page>
      <Link to="/checks" className="inline-flex items-center gap-1 text-[13px] text-ink-soft hover:text-ink">
        <ArrowLeft size={14} aria-hidden /> Checks
      </Link>
      <div className="mt-1 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Your rules</h1>
          <p className="text-ink-soft mt-0.5 max-w-2xl">Rules this workspace wrote for itself. They run with the built-in checks, on the whole model, on one diagram, in a scenario and in the evidence pack of a review.</p>
        </div>
        {mayChange && !editing && (
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing(blank())} data-rule-new>
            New rule
          </Button>
        )}
      </div>
      {!mayChange && <p className="mt-3 text-[13px] text-ink-soft">Only an owner can add or change rules.</p>}

      {editing && (
        <div className="mt-5">
          <RuleEditor key={editing.id ?? "new"} ws={ws} start={editing} onDone={() => setEditing(null)} />
        </div>
      )}

      {rules.length === 0 && !editing ? (
        <div className="mt-6 rounded-lg border border-dashed border-ink-faint bg-surface">
          <EmptyState title="No rules of your own yet" text={mayChange ? "Write one as a sentence, for example: Traffic from customers to databases must pass through a gateway." : "An owner can add them."} />
        </div>
      ) : (
        <ul className="mt-5 rounded-lg border border-line bg-surface divide-y divide-line-soft empty:hidden" data-rules>
          {rules.map((rule) => (
            <li key={rule.id} className="px-4 py-3 flex items-start gap-3" data-rule-row={rule.id}>
              <label className="mt-1" title={rule.enabled ? "Switched on" : "Switched off"}>
                <input type="checkbox" className={tick} checked={rule.enabled} disabled={!mayChange} onChange={() => apply((w) => updateRule(w, rule.id, { enabled: !rule.enabled }))} />
                <span className="sr-only">Run this rule</span>
              </label>
              <div className={`min-w-0 flex-1 ${rule.enabled ? "" : "opacity-60"}`}>
                <p className="font-medium break-words">{rule.title}</p>
                {rule.title !== describeRule(ws, rule.check) && <p className="text-[13px] text-ink-soft">{describeRule(ws, rule.check)}</p>}
                {rule.text && (
                  <p className="text-[13px] text-ink-soft" dir="auto">
                    Written as: {rule.text}
                  </p>
                )}
              </div>
              <span className="shrink-0 flex items-center gap-2">
                <Badge tone={TONE[rule.severity]}>{rule.severity[0].toUpperCase() + rule.severity.slice(1)}</Badge>
                <span className={`text-[13px] tabular-nums ${counts[rule.id] ? "text-ink" : "text-ok"}`} data-rule-count>
                  {counts[rule.id] ? countOf(counts[rule.id], "finding") : "Followed"}
                </span>
                {mayChange && (
                  <>
                    <IconButton label={`Change ${rule.title}`} onClick={() => setEditing({ id: rule.id, text: rule.text, title: rule.title === describeRule(ws, rule.check) ? "" : rule.title, severity: rule.severity, check: rule.check, reading: "none", unread: [], round: 0 })}>
                      <Pencil size={15} />
                    </IconButton>
                    <IconButton label={`Delete ${rule.title}`} onClick={() => apply((w) => deleteRule(w, rule.id))}>
                      <Trash2 size={15} />
                    </IconButton>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-5 text-[13px] text-ink-soft max-w-2xl">
        A sentence is read by recognising words: kinds of object, tags, lifecycles, object names, and ways of saying must, never, only and through. It does not understand the sentence, so always compare "Read as" with what you meant.
        A journey follows the arrows from source to target.
      </p>
    </div>
  );
}
