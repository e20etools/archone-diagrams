import { AuditChainCard } from "@/components/cloud/AuditChainCard";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, EmptyState, Input, Select, formatDateTime } from "@/components/ui";
import { AUDIT_ENTITIES, auditAction, auditChanges, auditCsv, type AuditEntry, type AuditQuery } from "@/lib/cloud/audit";
import { errorText, listAudit, useSession } from "@/lib/cloud/session";
import { downloadText, slugify } from "@/lib/exporters";
import { useWorkspace } from "@/lib/store";

/** The most entries one download holds. More than this is a job for a narrower filter. */
const EXPORT_LIMIT = 5000;

const VIA_LABEL: Record<AuditEntry["via"], string> = { app: "", api: "API", system: "System" };

/** Where an entry's subject lives now, if it is something with a page. */
function linkFor(entry: AuditEntry, exists: { object: (id: string) => boolean; diagram: (id: string) => boolean }): string | null {
  if (entry.entity === "object" && exists.object(entry.entityId)) return `/model?object=${entry.entityId}`;
  if (entry.entity === "diagram" && exists.diagram(entry.entityId)) return `/diagram/${entry.entityId}`;
  if (entry.entity === "version") return `/versions/${entry.entityId}`;
  if (entry.entity === "review") return `/reviews/${entry.entityId}`;
  return null;
}

export function AuditPage() {
  const ws = useWorkspace();
  const role = useSession((s) => s.role);
  const workspaceId = useSession((s) => s.workspaceId);
  const [entity, setEntity] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [more, setMore] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "more" | "exporting">("loading");
  const [problem, setProblem] = useState("");
  const [open, setOpen] = useState<Set<number>>(new Set());
  const request = useRef(0);

  const filtered = !!(entity || search.trim() || from || to);
  const query: AuditQuery = { entity: entity || undefined, search: search.trim() || undefined, from: from || undefined, to: to || undefined };
  const key = JSON.stringify([workspaceId, query]);

  useEffect(() => {
    if (role !== "owner") return;
    const mine = ++request.current;
    setState("loading");
    setProblem("");
    // Typing in the search field asks once the person pauses.
    const timer = setTimeout(() => {
      listAudit(JSON.parse(key)[1] as AuditQuery).then(
        (page) => {
          if (mine !== request.current) return;
          setEntries(page.entries);
          setMore(page.more);
          setState("ready");
        },
        (e) => {
          if (mine !== request.current) return;
          setProblem(errorText(e));
          setState("ready");
        },
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [key, role]);

  if (role !== "owner") {
    return (
      <div className="max-w-5xl mx-auto px-6 py-7">
        <h1 className="text-xl font-semibold">Audit log</h1>
        <div className="mt-8 rounded-lg border border-dashed border-ink-faint bg-surface">
          <EmptyState title="Only owners can read the audit log" text="It records who changed what in this workspace. Ask an owner if you need an extract." />
        </div>
      </div>
    );
  }

  const loadMore = () => {
    const mine = request.current;
    setState("more");
    listAudit({ ...query, before: entries.at(-1)?.id }).then(
      (page) => {
        if (mine !== request.current) return;
        setEntries((list) => [...list, ...page.entries]);
        setMore(page.more);
        setState("ready");
      },
      (e) => {
        setProblem(errorText(e));
        setState("ready");
      },
    );
  };

  const download = async () => {
    setState("exporting");
    setProblem("");
    try {
      const all: AuditEntry[] = [];
      let before: number | undefined;
      for (;;) {
        const page = await listAudit({ ...query, before, limit: 500 });
        all.push(...page.entries);
        if (!page.more || !page.entries.length || all.length >= EXPORT_LIMIT) {
          if (page.more) setProblem(`The download holds the newest ${all.length.toLocaleString()} entries. Narrow the dates to get the rest.`);
          break;
        }
        before = page.entries.at(-1)!.id;
      }
      downloadText(`${slugify(ws.name)}-audit-log.csv`, auditCsv(all), "text/csv");
    } catch (e) {
      setProblem(errorText(e));
    }
    setState("ready");
  };

  const nameOf = (id: string) => ws.objects[id]?.name;
  const exists = { object: (id: string) => !!ws.objects[id], diagram: (id: string) => !!ws.diagrams[id] };
  const toggle = (id: number) =>
    setOpen((set) => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="max-w-6xl mx-auto px-6 py-7">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Audit log</h1>
          <p className="text-ink-soft mt-0.5">Who changed what, and when. The database writes each entry itself, and no one can change or remove one.</p>
        </div>
        <Button icon={<Download size={15} />} onClick={() => void download()} disabled={state !== "ready" || entries.length === 0}>
          {state === "exporting" ? "Preparing" : "Download CSV"}
        </Button>
      </div>
      <AuditChainCard />

      <div className="mt-5 flex flex-wrap items-end gap-3">
        <label className="block grow max-w-xs">
          <span className="block text-[13px] font-medium mb-1">Search</span>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="A person, an action or a name" aria-label="Search the audit log" />
        </label>
        <label className="block">
          <span className="block text-[13px] font-medium mb-1">What changed</span>
          <Select className="!w-44" value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="What changed">
            <option value="">Everything</option>
            {AUDIT_ENTITIES.map((name) => (
              <option key={name} value={name}>
                {name.charAt(0).toUpperCase() + name.slice(1)}s
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="block text-[13px] font-medium mb-1">From</span>
          <Input type="date" className="!w-40" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="block">
          <span className="block text-[13px] font-medium mb-1">To</span>
          <Input type="date" className="!w-40" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
        {filtered && (
          <button
            type="button"
            className="h-9 text-[13px] text-ink-soft hover:text-ink"
            onClick={() => {
              setEntity("");
              setSearch("");
              setFrom("");
              setTo("");
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {problem && (
        <p role="alert" className="mt-4 rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
          {problem}
        </p>
      )}

      <div className="mt-5 rounded-lg border border-line bg-surface overflow-hidden" aria-busy={state === "loading"}>
        {state === "loading" && entries.length === 0 ? (
          <p className="px-4 py-10 text-center text-ink-soft">Reading the log</p>
        ) : entries.length === 0 ? (
          <EmptyState
            title={filtered ? "No entries match" : "Nothing recorded yet"}
            text={filtered ? "Try other words, another kind of change or wider dates." : "Entries appear here from the moment the audit log was switched on. Changes made before that were not recorded."}
          />
        ) : (
          <table className="w-full text-left" data-audit-table>
            <thead className="text-[13px] text-ink-soft bg-paper border-b border-line">
              <tr>
                <th className="w-9" />
                <th className="font-medium px-2 py-2.5 w-44">When</th>
                <th className="font-medium px-3 py-2.5 w-52">Who</th>
                <th className="font-medium px-3 py-2.5">What</th>
              </tr>
            </thead>
            <tbody className={state === "loading" ? "opacity-60" : ""}>
              {entries.map((entry) => {
                const changes = auditChanges(entry, nameOf);
                const expanded = open.has(entry.id);
                const link = linkFor(entry, exists);
                return (
                  <Fragment key={entry.id}>
                    <tr className="border-b border-line-soft last:border-b-0 align-top" data-audit-entry={`${entry.action} ${entry.entity}`}>
                      <td className="pl-2 py-2">
                        {changes.length > 0 && !entry.action.startsWith("object ") && (
                          <button
                            type="button"
                            className="grid place-items-center w-7 h-7 rounded hover:bg-paper text-ink-soft"
                            aria-expanded={expanded}
                            aria-label={`${expanded ? "Hide" : "Show"} what changed`}
                            onClick={() => toggle(entry.id)}
                          >
                            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          </button>
                        )}
                      </td>
                      <td className="px-2 py-2.5 text-[13px] text-ink-soft whitespace-nowrap">{formatDateTime(entry.at)}</td>
                      <td className="px-3 py-2.5">
                        <span className="mr-1.5">{entry.actorName}</span>
                        {VIA_LABEL[entry.via] && entry.actorName !== "System" && <Badge>{VIA_LABEL[entry.via]}</Badge>}
                      </td>
                      <td className="px-3 py-2.5">
                        {auditAction(entry)}{" "}
                        {link ? (
                          <Link to={link} className="font-medium text-blueprint hover:underline">
                            {entry.entityName || entry.entityId}
                          </Link>
                        ) : (
                          <span className="font-medium">{entry.entityName || entry.entityId}</span>
                        )}
                        {!expanded && changes.length > 0 && entry.action === "updated" && (
                          <span className="text-ink-soft text-[13px]"> · {changes.length <= 3 ? changes.map((c) => c.label.toLowerCase()).join(", ") : `${changes.length} fields`}</span>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-line-soft bg-paper/60">
                        <td />
                        <td colSpan={3} className="px-2 pb-3 pt-1">
                          <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1 text-[13px]" data-audit-changes>
                            {changes.map((c) => (
                              <Fragment key={c.label}>
                                <dt className="text-ink-soft">{c.label}</dt>
                                <dd className="break-words">
                                  {c.before !== null && (
                                    <>
                                      <span className="line-through text-ink-soft">{c.before}</span>
                                      <span className="text-ink-faint"> to </span>
                                    </>
                                  )}
                                  {c.after}
                                </dd>
                              </Fragment>
                            ))}
                          </dl>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {more && (
        <div className="mt-4 text-center">
          <Button onClick={loadMore} disabled={state !== "ready"}>
            {state === "more" ? "Loading" : "Show older entries"}
          </Button>
        </div>
      )}
      <p className="mt-4 text-[13px] text-ink-soft">
        Recorded: objects, relationships, diagrams and what they show, members and invitations, versions, reviews, API keys, webhooks and live links, whether changed here or through the API. Not recorded: moving a box, comments, and
        drafts that were never saved to the model.
      </p>
    </div>
  );
}
