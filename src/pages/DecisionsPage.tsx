import { Download, FilePlus2, Plus, Replace, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { TypeIcon } from "@/components/icons";
import { Badge, Button, CommitInput, EmptyState, Field, IconButton, Input, Select, cx, formatDate } from "@/components/ui";
import { ADR_STATUS_LABEL, adrLabel, adrLocked, adrLogMarkdown, adrMarkdown, createAdr, decideAdr, deleteAdr, setAdrObjects, sortedAdrs, supersedeAdr, updateAdr } from "@/lib/adr";
import { objectType } from "@/lib/catalog";
import { cloudEnabled } from "@/lib/cloud/config";
import { useCanEdit, useSession } from "@/lib/cloud/session";
import { downloadText } from "@/lib/exporters";
import { sortedObjects } from "@/lib/model";
import { apply, useStore, useWorkspace } from "@/lib/store";
import { ADR_STATUSES, type Adr, type AdrStatus, type Workspace } from "@/lib/types";

const TONE: Record<AdrStatus, "neutral" | "blue" | "amber" | "green" | "red"> = { proposed: "amber", accepted: "green", rejected: "red", superseded: "neutral" };

export function AdrStatusBadge({ status }: { status: AdrStatus }) {
  return <Badge tone={TONE[status]}>{ADR_STATUS_LABEL[status]}</Badge>;
}

function useAuthor(): string {
  const local = useWorkspace().userName.trim();
  const user = useSession((s) => s.user);
  return local || user?.name || user?.email || "Unnamed";
}

const fileName = (adr: Adr) => `${adrLabel(adr).toLowerCase()}-${adr.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "decision"}.md`;

/** A long text that is saved when the field is left. Shown as plain paragraphs once the record is decided. */
function Section({ label, hint, value, locked, onCommit, name }: { label: string; hint: string; value: string; locked: boolean; onCommit: (value: string) => void; name: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (locked) {
    return (
      <section data-adr-section={name}>
        <h3 className="font-semibold">{label}</h3>
        <p className={cx("mt-1 whitespace-pre-wrap", !value && "text-ink-soft")}>{value || "Not written."}</p>
      </section>
    );
  }
  return (
    <Field label={label} hint={hint}>
      <textarea
        data-adr-section={name}
        rows={4}
        value={draft}
        maxLength={20000}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
        className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-blueprint focus:ring-2 focus:ring-blueprint/20"
      />
    </Field>
  );
}

function ObjectLinks({ ws, adr, canEdit }: { ws: Workspace; adr: Adr; canEdit: boolean }) {
  const [query, setQuery] = useState("");
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return sortedObjects(ws)
      .filter((o) => !adr.objectIds.includes(o.id) && o.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [ws, adr.objectIds, query]);
  const set = (ids: string[]) => apply((w) => setAdrObjects(w, adr.id, ids));
  const missing = adr.objectIds.filter((id) => !ws.objects[id]).length;
  return (
    <section data-adr-objects>
      <h3 className="font-semibold">What it is about</h3>
      {adr.objectIds.length === 0 && <p className="mt-1 text-ink-soft">No objects are linked. Link the systems this decision is about, and it shows up on each of them.</p>}
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {adr.objectIds
          .filter((id) => ws.objects[id])
          .map((id) => (
            <li key={id} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface pl-2 pr-1 h-7 text-[13px]">
              <TypeIcon typeId={ws.objects[id].typeId} componentId={ws.objects[id].componentId} size={14} />
              <Link to={`/model?object=${id}`} className="hover:underline" title={objectType(ws.objects[id].typeId).label}>
                {ws.objects[id].name}
              </Link>
              {canEdit && (
                <IconButton label={`Unlink ${ws.objects[id].name}`} className="size-6" onClick={() => set(adr.objectIds.filter((x) => x !== id))}>
                  <X size={13} />
                </IconButton>
              )}
            </li>
          ))}
      </ul>
      {missing > 0 && <p className="mt-1 text-[13px] text-ink-soft">{missing === 1 ? "One linked object has" : `${missing} linked objects have`} since been deleted from the model.</p>}
      {canEdit && (
        <div className="mt-2 max-w-sm relative">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Link an object by name" aria-label="Link an object by name" />
          {candidates.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full rounded-md border border-line bg-surface shadow-lg py-1">
              {candidates.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-line-soft"
                    onClick={() => {
                      set([...adr.objectIds, o.id]);
                      setQuery("");
                    }}
                  >
                    <TypeIcon typeId={o.typeId} componentId={o.componentId} size={14} />
                    <span className="truncate">{o.name}</span>
                    <span className="ml-auto text-xs text-ink-faint">{objectType(o.typeId).label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function Record({ ws, adr, canEdit }: { ws: Workspace; adr: Adr; canEdit: boolean }) {
  const navigate = useNavigate();
  const author = useAuthor();
  const locked = adrLocked(adr) || !canEdit;
  const patch = (change: Parameters<typeof updateAdr>[2]) => apply((w) => updateAdr(w, adr.id, change));
  const replacement = adr.supersededBy ? ws.adrs[adr.supersededBy] : undefined;
  const replaces = Object.values(ws.adrs).find((a) => a.supersededBy === adr.id);
  const ready = adr.decision.trim().length > 0;

  const supersede = () => {
    const made = supersedeAdr(useStore.getState().ws, adr.id, author);
    if (!made.adr) return;
    apply(() => made.ws);
    navigate(`/decisions/${made.adr.id}`);
  };

  return (
    <article className="rounded-lg border border-line bg-surface px-6 py-5 space-y-5" data-adr={adr.id}>
      <header>
        <div className="flex items-center gap-2 text-[13px] text-ink-soft">
          <span className="font-medium text-ink">{adrLabel(adr)}</span>
          <AdrStatusBadge status={adr.status} />
          <span>
            {adr.decidedAt ? `Decided ${formatDate(adr.decidedAt)}` : `Written ${formatDate(adr.createdAt)}`} by {adr.author || "Unnamed"}
          </span>
        </div>
        {locked ? (
          <h2 className="mt-1.5 text-lg font-semibold">{adr.title}</h2>
        ) : (
          <div className="mt-2">
            {/* A record that was just started opens with its placeholder title selected, ready to be typed over. */}
            <CommitInput value={adr.title} onCommit={(title) => patch({ title })} aria-label="Title" maxLength={200} className="text-lg font-semibold" autoFocus={adr.title === "New decision"} onFocus={(e) => e.currentTarget.select()} />
          </div>
        )}
        {adr.origin === "review" && (
          <p className="mt-1.5 text-[13px] text-ink-soft">
            Written when a review was closed.{" "}
            {cloudEnabled && adr.reviewId && (
              <Link to={`/reviews/${adr.reviewId}`} className="font-medium text-blueprint hover:underline">
                Open the review
              </Link>
            )}
          </p>
        )}
        {replacement && (
          <p className="mt-1.5 text-[13px]">
            Superseded by{" "}
            <Link to={`/decisions/${replacement.id}`} className="font-medium text-blueprint hover:underline">
              {adrLabel(replacement)}: {replacement.title}
            </Link>
            {replacement.status === "proposed" && <span className="text-ink-soft"> (still proposed)</span>}
          </p>
        )}
        {replaces && (
          <p className="mt-1.5 text-[13px]">
            Replaces{" "}
            <Link to={`/decisions/${replaces.id}`} className="font-medium text-blueprint hover:underline">
              {adrLabel(replaces)}: {replaces.title}
            </Link>
          </p>
        )}
      </header>

      <Section name="context" label="Context" hint="What makes a decision necessary: the forces, the constraints, what was tried." value={adr.context} locked={locked} onCommit={(context) => patch({ context })} />
      <Section name="decision" label="Decision" hint="What will be done, in a sentence that starts with 'We will'." value={adr.decision} locked={locked} onCommit={(decision) => patch({ decision })} />
      <Section name="consequences" label="Consequences" hint="What becomes easier, what becomes harder, what has to follow." value={adr.consequences} locked={locked} onCommit={(consequences) => patch({ consequences })} />
      <ObjectLinks ws={ws} adr={adr} canEdit={canEdit} />

      <footer className="pt-4 border-t border-line-soft flex flex-wrap items-center gap-2">
        {canEdit && adr.status === "proposed" && (
          <>
            <Button variant="primary" disabled={!ready} title={ready ? undefined : "Write the decision first"} onClick={() => apply((w) => decideAdr(w, adr.id, "accepted"))}>
              Accept
            </Button>
            <Button disabled={!ready} onClick={() => apply((w) => decideAdr(w, adr.id, "rejected"))}>
              Reject
            </Button>
            <Button
              icon={<Trash2 size={15} />}
              onClick={() => {
                apply((w) => deleteAdr(w, adr.id));
                navigate("/decisions");
              }}
            >
              Discard
            </Button>
            <span className="text-[13px] text-ink-soft">Once accepted or rejected, the text is fixed.</span>
          </>
        )}
        {canEdit && adr.status === "accepted" && (
          <Button icon={<Replace size={15} />} onClick={supersede}>
            Supersede with a new decision
          </Button>
        )}
        <Button icon={<Download size={15} />} className="ml-auto" onClick={() => downloadText(fileName(adr), adrMarkdown(ws, adr), "text/markdown")}>
          Markdown
        </Button>
      </footer>
    </article>
  );
}

/** The decision log (ADR): what was decided about the architecture, why, and what followed. */
export function DecisionsPage() {
  const ws = useWorkspace();
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const canEdit = useCanEdit();
  const author = useAuthor();
  const [filter, setFilter] = useState<AdrStatus | "all">("all");
  const [query, setQuery] = useState("");
  const all = useMemo(() => sortedAdrs(ws), [ws]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((a) => (filter === "all" || a.status === filter) && (!q || `${adrLabel(a)} ${a.title} ${a.decision}`.toLowerCase().includes(q)));
  }, [all, filter, query]);
  const selected = id ? ws.adrs[id] : undefined;

  const add = (objectId?: string) => {
    const made = createAdr(useStore.getState().ws, { title: "New decision", author, objectIds: objectId ? [objectId] : [] });
    apply(() => made.ws);
    navigate(`/decisions/${made.adr.id}`, { replace: true });
  };
  // "Record a decision" on an object arrives here with the object to link.
  const about = params.get("about");
  useEffect(() => {
    if (!about || !canEdit) return;
    setParams({}, { replace: true });
    add(ws.objects[about] ? about : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [about]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-7">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Decisions</h1>
          <p className="text-ink-soft mt-0.5 max-w-2xl">
            Why the architecture is the way it is. Each record keeps one decision with its reasons{cloudEnabled ? "; closing a review writes one by itself" : ""}. A decided record is never rewritten, only superseded.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {all.length > 0 && (
            <Button icon={<Download size={15} />} onClick={() => downloadText("decision-log.md", adrLogMarkdown(ws), "text/markdown")}>
              Whole log
            </Button>
          )}
          {canEdit && (
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => add()}>
              New decision
            </Button>
          )}
        </div>
      </div>

      {all.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-ink-faint bg-surface">
          <EmptyState title="No decisions recorded yet" text={canEdit ? "Start with the one people ask about most: why a system was chosen, split or kept." : "An owner or editor can record one."}>
            {canEdit && (
              <Button variant="primary" icon={<FilePlus2 size={15} />} onClick={() => add()}>
                Record the first decision
              </Button>
            )}
          </EmptyState>
        </div>
      ) : (
        <div className="mt-6 grid gap-5 lg:grid-cols-[320px_1fr] items-start">
          <div>
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search decisions" aria-label="Search decisions" />
              </div>
              <div className="w-[128px] shrink-0">
              <Select value={filter} onChange={(e) => setFilter(e.target.value as AdrStatus | "all")} aria-label="Status">
                <option value="all">All</option>
                {ADR_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {ADR_STATUS_LABEL[s]}
                  </option>
                ))}
              </Select>
              </div>
            </div>
            <ul className="mt-3 rounded-lg border border-line bg-surface divide-y divide-line-soft" data-adr-list>
              {shown.length === 0 && <li className="px-4 py-3 text-ink-soft">Nothing matches.</li>}
              {shown.map((a) => (
                <li key={a.id}>
                  <Link to={`/decisions/${a.id}`} className={cx("block px-4 py-2.5 hover:bg-line-soft", a.id === id && "bg-blueprint-soft hover:bg-blueprint-soft")}>
                    <span className="flex items-center gap-2 text-xs text-ink-soft">
                      <span>{adrLabel(a)}</span>
                      <AdrStatusBadge status={a.status} />
                      <span className="ml-auto">{formatDate(a.decidedAt ?? a.createdAt)}</span>
                    </span>
                    <span className={cx("block mt-0.5 font-medium", a.status === "superseded" && "text-ink-soft")}>{a.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          {selected ? (
            <Record key={selected.id} ws={ws} adr={selected} canEdit={canEdit} />
          ) : (
            <div className="rounded-lg border border-dashed border-ink-faint bg-surface">
              <EmptyState title={id ? "This decision no longer exists" : "Choose a decision"} text={id ? "It may have been discarded before it was decided." : "Pick one from the list to read it."} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
