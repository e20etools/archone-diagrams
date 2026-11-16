import { CLASSIFICATIONS, agentLens, dataLens, isDataField, withAgentField, withDataField } from "@/lib/checks/checks";
import { ArrowRight, ExternalLink, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { MAX_LINKS, linkLabel, safeUrl } from "@/lib/links";
import { ADR_STATUS_LABEL, adrLabel, adrsAbout } from "@/lib/adr";
import { Link } from "react-router-dom";
import { BasicInformation, ComponentField } from "@/components/BasicInformation";
import { TypeIcon } from "@/components/icons";
import { profileOf } from "@/lib/library";
import { Badge, Button, CommitInput, Field, IconButton, Input, Select, formatDateTime } from "@/components/ui";
import { CATEGORY_INFO, LIFECYCLE_INFO, OBJECT_TYPES, RELATION_KIND_INFO, objectType, type Category } from "@/lib/catalog";
import { allOwners, diagramsUsing, possibleParents, relationshipsOf, updateObject, updateRelationship } from "@/lib/model";
import { cloudSuggestions } from "@/lib/cloudCatalog";
import { useMe } from "@/lib/cloud/me";
import { useCanEdit } from "@/lib/cloud/session";
import { TRUTH_STATE_LABEL, confirmTruth, truthMatters, truthOf } from "@/lib/freshness";
import { confirmDependency, handshakeState, ownsTarget, withdrawConfirmation } from "@/lib/handshake";
import { AVAILABILITY_FIELD, declaredAvailability } from "@/lib/resilience";
import { apply } from "@/lib/store";
import { LIFECYCLES, RELATION_KINDS, type Lifecycle, type ModelLink, type ModelObject, type Provenance, type RelationKind, type Relationship, type Workspace } from "@/lib/types";

const CATEGORIES = Object.keys(CATEGORY_INFO) as Category[];

export function TypeOptions() {
  return (
    <>
      {CATEGORIES.map((category) => (
        <optgroup key={category} label={CATEGORY_INFO[category].label}>
          {OBJECT_TYPES.filter((t) => t.category === category).map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

/** Where an item came from and who approved it (PRD AI-07). */
export function ProvenanceNote({ provenance }: { provenance: Provenance }) {
  if (provenance.origin === "manual") return <p className="text-[13px] text-ink-soft">Entered by hand.</p>;
  if (provenance.origin === "demo") return <p className="text-[13px] text-ink-soft">Part of the demo data.</p>;
  if (provenance.origin === "import") return <p className="text-[13px] text-ink-soft">Imported from {provenance.source ?? "a file"}.</p>;
  if (provenance.origin === "api") return <p className="text-[13px] text-ink-soft">Created through the API{provenance.source ? ` (${provenance.source})` : ""}.</p>;
  const from = provenance.origin === "ai-image" ? "an image" : "a description";
  return (
    <div className="rounded-md border border-signal/30 bg-signal-soft px-3 py-2.5 text-[13px]">
      <p className="font-medium text-signal">Drafted by AI from {from}</p>
      {provenance.source && (
        <p className="mt-1 text-ink-soft break-words" title={provenance.source}>
          {provenance.origin === "ai-image" ? `File: ${provenance.source}` : `"${provenance.source.length > 150 ? `${provenance.source.slice(0, 150)}…` : provenance.source}"`}
        </p>
      )}
      <p className="mt-1 text-ink-soft">
        {provenance.engine && <>Engine: {provenance.engine}. </>}
        Approved by {provenance.approvedBy ?? "an unnamed reviewer"}
        {provenance.approvedAt && <> on {formatDateTime(provenance.approvedAt)}</>}.
      </p>
      {provenance.proposalId && (
        <Link to={`/ai/${provenance.proposalId}`} className="mt-1 inline-block font-medium text-blueprint hover:underline">
          Open the reviewed draft
        </Link>
      )}
    </div>
  );
}

/**
 * Links to the real thing: the repository, the runbook, the dashboard. Only web addresses are
 * accepted, and each opens in a new tab without telling the other site where it was opened from.
 */
export function LinksEditor({ links, onChange, about }: { links: ModelLink[] | undefined; onChange: (links: ModelLink[]) => void; about: string }) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [problem, setProblem] = useState("");
  const current = links ?? [];
  const add = () => {
    const safe = safeUrl(url);
    if (!safe) return setProblem("Enter a web address, for example https://github.com/your-team/billing.");
    if (current.some((l) => l.url === safe)) return setProblem("That address is already linked.");
    if (current.length >= MAX_LINKS) return setProblem(`${MAX_LINKS} links is the most one item holds.`);
    onChange([...current, { label: label.trim(), url: safe }]);
    setUrl("");
    setLabel("");
    setProblem("");
  };
  return (
    <div data-links>
      <span className="block text-[13px] font-medium text-ink-soft mb-1">Links</span>
      {current.length === 0 && <p className="text-xs text-ink-faint mb-1.5">None yet. Point to where {about} really lives: its repository, runbook or dashboard.</p>}
      <ul className="space-y-1 mb-1.5">
        {current.map((link) => (
          <li key={link.url} className="flex items-center gap-1.5">
            <ExternalLink size={13} className="shrink-0 text-ink-faint" aria-hidden />
            <a href={link.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-[13px] font-medium text-blueprint hover:underline" title={link.url}>
              {linkLabel(link)}
            </a>
            <IconButton label={`Remove the link to ${linkLabel(link)}`} className="size-7" onClick={() => onChange(current.filter((l) => l.url !== link.url))}>
              <Trash2 size={14} />
            </IconButton>
          </li>
        ))}
      </ul>
      <div className="flex gap-1.5">
        <Input
          aria-label="Web address of the link"
          className="min-w-0 flex-1"
          inputMode="url"
          placeholder="https://"
          value={url}
          aria-invalid={!!problem}
          onChange={(e) => {
            setUrl(e.target.value);
            setProblem("");
          }}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <Input aria-label="Name of the link" className="w-[34%]" placeholder="Name" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <Button size="sm" className="!h-9" disabled={!url.trim()} onClick={add}>
          Add
        </Button>
      </div>
      {problem && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}

export function ObjectEditor({ ws, object }: { ws: Workspace; object: ModelObject }) {
  const patch = (change: Parameters<typeof updateObject>[2]) => apply((w) => updateObject(w, object.id, change));
  const parents = possibleParents(ws, object.id, object.typeId);
  const owners = allOwners(ws);
  const technologies = [...new Set(Object.values(ws.objects).map((o) => o.technology.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  // The data lens has its own controls; it is kept out of the free-form list.
  // The data lens and the basic information have their own controls; they are kept out of the free-form list.
  const asked = new Set(profileOf(object).fields.map((f) => f.label));
  const fields = Object.entries(object.fields).filter(([key]) => !isDataField(key) && !asked.has(key));
  const lens = dataLens(object);
  const setField = (oldKey: string, key: string, value: string) => {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(object.fields)) {
      if (k === oldKey) {
        if (key.trim()) next[key.trim()] = value;
      } else next[k] = v;
    }
    patch({ fields: next });
  };
  return (
    <div className="space-y-3">
      <Field label="Name">
        <CommitInput value={object.name} onCommit={(name) => patch({ name })} />
      </Field>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Type">
          <Select value={object.typeId} onChange={(e) => patch({ typeId: e.target.value })}>
            <TypeOptions />
          </Select>
        </Field>
        <Field label="Lifecycle">
          <Select value={object.lifecycle} onChange={(e) => patch({ lifecycle: e.target.value as Lifecycle })}>
            {LIFECYCLES.map((l) => (
              <option key={l} value={l}>
                {LIFECYCLE_INFO[l].label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <ComponentField object={object} />
      <Field label="Part of" hint={parents.length ? undefined : "No object on a higher level exists yet."}>
        <Select value={object.parentId ?? ""} onChange={(e) => patch({ parentId: e.target.value || null })}>
          <option value="">Nothing (top level)</option>
          {parents.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({objectType(p.typeId).label})
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Owner">
          <CommitInput value={object.owner} onCommit={(owner) => patch({ owner })} list="owner-options" placeholder="Team or person" />
          <datalist id="owner-options">
            {owners.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </Field>
        <Field label="Technology">
          <CommitInput value={object.technology} onCommit={(technology) => patch({ technology })} list="technology-options" placeholder="For example PostgreSQL" />
          {/* Technologies already in the model first, then cloud services by name, so one service is spelled one way. */}
          <datalist id="technology-options">
            {technologies.map((t) => (
              <option key={t} value={t} />
            ))}
            {cloudSuggestions(object.typeId)
              .filter((s) => !technologies.includes(s.name))
              .map((s) => (
                <option key={s.name} value={s.name} label={s.provider} />
              ))}
          </datalist>
        </Field>
      </div>
      <Field label="Tags" hint="Separate tags with commas.">
        <CommitInput value={object.tags.join(", ")} onCommit={(text) => patch({ tags: text.split(",") })} placeholder="tier-1, customer-facing" />
      </Field>
      <Field label="Description">
        <CommitInput multiline rows={3} value={object.description} onCommit={(description) => patch({ description })} />
      </Field>
      <BasicInformation object={object} />
      <fieldset data-data-lens>
        <legend className="text-[13px] font-medium text-ink-soft mb-1">Data it holds</legend>
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Classification">
            <Select value={lens.classification} onChange={(e) => patch({ fields: withDataField(object, "classification", e.target.value) })}>
              <option value="">Not set</option>
              {CLASSIFICATIONS.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label="Personal data">
            <Select value={lens.personal} onChange={(e) => patch({ fields: withDataField(object, "personal", e.target.value) })}>
              <option value="">Not set</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>
          </Field>
        </div>
        <Field label="Kept in" className="mt-2.5">
          <CommitInput value={lens.residency} onCommit={(value) => patch({ fields: withDataField(object, "residency", value) })} placeholder="For example EU, or Saudi Arabia" />
        </Field>
      </fieldset>
      {object.typeId === "ai-agent" && (
        <fieldset data-agent-lens>
          <legend className="text-[13px] font-medium text-ink-soft mb-1">What this agent can do</legend>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Reads untrusted content">
              <Select value={agentLens(object).untrusted} onChange={(e) => patch({ fields: withAgentField(object, "untrusted", e.target.value) })}>
                <option value="">Not said</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </Select>
            </Field>
            <Field label="Can send outside">
              <Select value={agentLens(object).outward} onChange={(e) => patch({ fields: withAgentField(object, "outward", e.target.value) })}>
                <option value="">Not said</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </Select>
            </Field>
          </div>
          <p className="mt-1 text-xs text-ink-faint">Untrusted content is anything a stranger could have written: web pages, incoming email, uploaded files, tickets. The AI agents check uses both answers.</p>
        </fieldset>
      )}
      <Field label="Availability it promises (%)" hint="On its own, for example 99.9. Dependencies uses it to work out what it can really deliver.">
        <CommitInput
          value={object.fields[AVAILABILITY_FIELD] ?? ""}
          inputMode="decimal"
          placeholder="Not said"
          aria-invalid={!!object.fields[AVAILABILITY_FIELD] && declaredAvailability(object) === null}
          onCommit={(value) => {
            const { [AVAILABILITY_FIELD]: _old, ...rest } = object.fields;
            patch({ fields: value.trim() ? { ...rest, [AVAILABILITY_FIELD]: value.trim() } : rest });
          }}
        />
      </Field>
      <LinksEditor links={object.links} about="this object" onChange={(links) => patch({ links })} />
      <TruthLine object={object} />
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[13px] font-medium text-ink-soft">Custom fields</span>
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus size={14} />}
            onClick={() => {
              let key = "Field";
              for (let i = 2; key in object.fields; i++) key = `Field ${i}`;
              patch({ fields: { ...object.fields, [key]: "" } });
            }}
          >
            Add field
          </Button>
        </div>
        {fields.length === 0 && <p className="text-xs text-ink-faint">None yet. Add any detail your team tracks, such as a cost centre or a support contact.</p>}
        <div className="space-y-1.5">
          {fields.map(([key, value]) => (
            <div key={key} className="flex gap-1.5">
              <CommitInput aria-label="Field name" className="w-2/5" value={key} onCommit={(k) => setField(key, k, value)} />
              <CommitInput aria-label={`Value of ${key}`} value={value} onCommit={(v) => setField(key, key, v)} />
              <IconButton label={`Remove ${key}`} onClick={() => setField(key, "", "")}>
                <Trash2 size={15} />
              </IconButton>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const TRUTH_TONE = { fresh: "green", aging: "amber", stale: "red" } as const;

/** When the object's facts were last confirmed, and the button that confirms them. */
function TruthLine({ object }: { object: ModelObject }) {
  const me = useMe();
  const canEdit = useCanEdit();
  const truth = truthOf(object);
  return (
    <div className="rounded-md border border-line px-3 py-2.5" data-truth={truth.state}>
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium">Still true?</span>
        {truthMatters(object) ? <Badge tone={TRUTH_TONE[truth.state]}>{TRUTH_STATE_LABEL[truth.state]}</Badge> : <Badge>Not asked</Badge>}
        {canEdit && (
          <Button size="sm" className="ml-auto" onClick={() => apply((w) => confirmTruth(w, object.id, me.name))} title="Records that you looked and the details above are right">
            Confirm
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-ink-soft">
        {truth.confirmed
          ? `Confirmed ${truth.ageDays === 0 ? "today" : `${truth.ageDays} ${truth.ageDays === 1 ? "day" : "days"} ago`}${truth.by ? ` by ${truth.by}` : ""}.`
          : `Nobody has confirmed it since it was added ${truth.ageDays === 0 ? "today" : `${truth.ageDays} ${truth.ageDays === 1 ? "day" : "days"} ago`}.`}{" "}
        {truthMatters(object) ? `Due every ${truth.intervalDays} days${truth.intervalDays === 90 ? ", because it is tier-1" : ""}.` : "Planned and retired objects are not asked about."}
      </p>
    </div>
  );
}

/** Whether the owner of the object that is depended on has confirmed the dependency. */
function Handshake({ ws, relationship }: { ws: Workspace; relationship: Relationship }) {
  const me = useMe();
  const canEdit = useCanEdit();
  const state = handshakeState(ws, relationship);
  if (state === "none") return null;
  const target = ws.objects[relationship.targetId];
  const mine = me.speaksForEveryone || ownsTarget(ws, relationship, me.names);
  return (
    <div className="rounded-md border border-line px-3 py-2.5" data-handshake={state}>
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium">Known to {target.owner}?</span>
        <Badge tone={state === "confirmed" ? "green" : "amber"}>{state === "confirmed" ? "Confirmed" : "Not confirmed"}</Badge>
        {canEdit && state === "pending" && mine && (
          <Button size="sm" className="ml-auto" onClick={() => apply((w) => confirmDependency(w, relationship.id, me.name))}>
            Confirm
          </Button>
        )}
        {canEdit && state === "confirmed" && mine && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => apply((w) => withdrawConfirmation(w, relationship.id))}>
            Take back
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-ink-soft">
        {state === "confirmed"
          ? `${relationship.acknowledgement!.by} confirmed it on ${formatDateTime(relationship.acknowledgement!.at)}. Changing the relationship takes the confirmation back.`
          : mine
            ? `${ws.objects[relationship.sourceId].owner} says it depends on ${target.name}. Confirm when ${target.owner} knows and agrees.`
            : `Waiting for ${target.owner}, who owns ${target.name}. Only they or a workspace owner can confirm.`}
      </p>
    </div>
  );
}

export function RelationshipList({ ws, objectId, onPick }: { ws: Workspace; objectId: string; onPick?: (objectId: string) => void }) {
  const { outgoing, incoming } = relationshipsOf(ws, objectId);
  if (!outgoing.length && !incoming.length) {
    return <p className="text-[13px] text-ink-faint">No relationships yet. Drag from the dot on this box to another box to draw one.</p>;
  }
  const row = (r: Relationship, otherId: string) => {
    const other = ws.objects[otherId];
    if (!other) return null;
    return (
      <li key={r.id}>
        <button
          type="button"
          onClick={() => onPick?.(otherId)}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-[13px] hover:bg-line-soft"
        >
          <span className="text-ink-soft shrink-0">
            <TypeIcon typeId={other.typeId} componentId={other.componentId} size={14} />
          </span>
          <span className="truncate font-medium">{other.name}</span>
          <span className="ml-auto pl-2 text-ink-faint whitespace-nowrap">{r.label || RELATION_KIND_INFO[r.kind].verb}</span>
        </button>
      </li>
    );
  };
  // Grouped by direction, so the reader never has to decode which way an arrow points.
  return (
    <div className="-mx-2 space-y-2">
      {outgoing.length > 0 && (
        <div>
          <div className="px-2 text-xs text-ink-faint">Outgoing, from this object</div>
          <ul>{outgoing.map((r) => row(r, r.targetId))}</ul>
        </div>
      )}
      {incoming.length > 0 && (
        <div>
          <div className="px-2 text-xs text-ink-faint">Incoming, to this object</div>
          <ul>{incoming.map((r) => row(r, r.sourceId))}</ul>
        </div>
      )}
    </div>
  );
}

export function UsedIn({ ws, objectId, currentDiagramId }: { ws: Workspace; objectId: string; currentDiagramId?: string }) {
  const diagrams = diagramsUsing(ws, objectId);
  if (!diagrams.length) return <p className="text-[13px] text-ink-faint">Not on any diagram yet.</p>;
  return (
    <ul className="space-y-1">
      {diagrams.map((d) => (
        <li key={d.id} className="text-[13px]">
          {d.id === currentDiagramId ? (
            <span className="text-ink-soft">{d.name} (this diagram)</span>
          ) : (
            <Link to={`/diagram/${d.id}`} className="text-blueprint hover:underline">
              {d.name}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The decisions that are about this object, and a way to record one. */
export function DecisionsAbout({ ws, objectId }: { ws: Workspace; objectId: string }) {
  const canEdit = useCanEdit();
  const records = adrsAbout(ws, objectId);
  return (
    <div data-object-decisions>
      {records.length === 0 ? (
        <p className="text-[13px] text-ink-faint">No decision is recorded about it.</p>
      ) : (
        <ul className="space-y-1">
          {records.map((a) => (
            <li key={a.id} className="text-[13px]">
              <Link to={`/decisions/${a.id}`} className={a.status === "superseded" || a.status === "rejected" ? "text-ink-soft hover:underline" : "text-blueprint hover:underline"}>
                {adrLabel(a)}: {a.title}
              </Link>
              {a.status !== "accepted" && <span className="text-ink-faint"> ({ADR_STATUS_LABEL[a.status].toLowerCase()})</span>}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <Link to={`/decisions?about=${encodeURIComponent(objectId)}`} className="mt-1 inline-block text-[13px] font-medium text-blueprint hover:underline">
          Record a decision
        </Link>
      )}
    </div>
  );
}

export function RelationshipEditor({ ws, relationship }: { ws: Workspace; relationship: Relationship }) {
  const patch = (change: Parameters<typeof updateRelationship>[2]) => apply((w) => updateRelationship(w, relationship.id, change));
  const source = ws.objects[relationship.sourceId];
  const target = ws.objects[relationship.targetId];
  const info = RELATION_KIND_INFO[relationship.kind];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className="truncate">{source?.name}</span>
        <ArrowRight size={15} className="shrink-0 text-ink-faint" />
        <span className="truncate">{target?.name}</span>
      </div>
      <Field label="Kind" hint={info.hint + "."}>
        <Select value={relationship.kind} onChange={(e) => patch({ kind: e.target.value as RelationKind })}>
          {RELATION_KINDS.map((k) => (
            <option key={k} value={k}>
              {RELATION_KIND_INFO[k].label}
            </option>
          ))}
        </Select>
      </Field>
      <div>
        <Badge tone={info.dependency ? "blue" : "neutral"}>{info.dependency ? "Counts in impact analysis" : "Not a dependency"}</Badge>
      </div>
      <Field label="Label" hint="Shown on the arrow. Leave empty to show the kind.">
        <CommitInput value={relationship.label} onCommit={(label) => patch({ label })} placeholder={info.verb} />
      </Field>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Protocol">
          <CommitInput value={relationship.protocol} onCommit={(protocol) => patch({ protocol })} placeholder="HTTPS" />
        </Field>
        <Field label="Port">
          <CommitInput value={relationship.port} onCommit={(port) => patch({ port })} placeholder="443" />
        </Field>
      </div>
      <Field label="Description">
        <CommitInput multiline rows={2} value={relationship.description} onCommit={(description) => patch({ description })} />
      </Field>
      <LinksEditor links={relationship.links} about="this connection" onChange={(links) => patch({ links })} />
      <Handshake ws={ws} relationship={relationship} />
    </div>
  );
}
