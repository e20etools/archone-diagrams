import { Lock, Plus, Search, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ComponentTile, GENERAL, SourceSelect, sectionsOf, type LibrarySource } from "@/components/LibraryBrowser";
import { LibraryIcon } from "@/components/icons";
import { Badge, Button, Input } from "@/components/ui";
import { objectType } from "@/lib/catalog";
import { useCanEdit } from "@/lib/cloud/session";
import { LIBRARY_COUNTS, PROVIDERS, componentById, componentLabel, componentsIn, objectFromComponent, providerById, searchLibrary, sectionById } from "@/lib/library";
import { profileById } from "@/lib/library/profiles";
import { PROTOCOLS, PROTOCOL_GROUPS, protocolLabel, searchProtocols } from "@/lib/library/protocols";
import { protocolsOf } from "@/lib/model";
import { addObject, useWorkspace } from "@/lib/store";

const PROTOCOLS_ID = "__protocols";
const FIELD_KIND: Record<string, string> = { text: "Text", number: "Number", date: "Date", url: "Web address", select: "Choice", ip: "IP address" };

/**
 * The whole component library on one page: the general sections and each cloud provider's,
 * every component with its icon, and for the one picked what it becomes in the model and the
 * basic information it asks for.
 */
export function LibraryPage() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const canEdit = useCanEdit();
  const [params, setParams] = useSearchParams();
  const picked = componentById(params.get("component"));
  const [source, setSource] = useState<LibrarySource>(picked?.provider ?? GENERAL);
  const sections = sectionsOf(source);
  const [sectionId, setSectionId] = useState<string>(picked?.sectionId ?? sections[0].id);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => (query.trim() ? searchLibrary(query, { limit: 300 }) : componentsIn(sectionId)), [query, sectionId]);
  const section = sectionById(sectionId);
  const pick = (id: string) => setParams({ component: id }, { replace: true });
  const usedBy = useMemo(() => (picked ? Object.values(ws.objects).filter((o) => o.componentId === picked.id) : []), [ws.objects, picked]);

  return (
    <div className="h-full flex" data-library-page>
      <aside className="w-[260px] shrink-0 flex flex-col bg-surface border-r border-line" aria-label="Sections">
        <div className="px-3 pt-3.5 pb-2.5 border-b border-line-soft">
          <h1 className="text-base font-semibold">Component library</h1>
          <p className="text-[13px] text-ink-soft mt-0.5">
            {LIBRARY_COUNTS.components.toLocaleString()} components: {LIBRARY_COUNTS.general} general and {LIBRARY_COUNTS.cloud.toLocaleString()} from {PROVIDERS.length} cloud providers.
          </p>
          <SourceSelect
            className="mt-2.5"
            value={source}
            onChange={(next) => {
              setSource(next);
              setSectionId(sectionsOf(next)[0].id);
              setQuery("");
            }}
          />
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
          {sections.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-[13px] ${s.id === sectionId && !query ? "bg-blueprint-soft text-blueprint-deep font-medium" : "hover:bg-line-soft"}`}
                onClick={() => {
                  setSectionId(s.id);
                  setQuery("");
                }}
                data-library-section={s.id}
              >
                <span style={{ color: s.color }}>
                  <LibraryIcon name={s.icon} size={15} />
                </span>
                <span className="min-w-0 flex-1 truncate">{s.provider ? s.group : s.label}</span>
                <span className="text-xs text-ink-faint tabular-nums">{componentsIn(s.id).length}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-line-soft px-1.5 py-2">
          <button
            type="button"
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-[13px] ${sectionId === PROTOCOLS_ID ? "bg-blueprint-soft text-blueprint-deep font-medium" : "hover:bg-line-soft"}`}
            onClick={() => setSectionId(PROTOCOLS_ID)}
            data-library-section={PROTOCOLS_ID}
          >
            <LibraryIcon name="Cable" size={15} />
            <span className="min-w-0 flex-1 truncate">Protocols and ports</span>
            <span className="text-xs text-ink-faint tabular-nums">{PROTOCOLS.length}</span>
          </button>
        </div>
      </aside>

      {sectionId === PROTOCOLS_ID ? (
        <ProtocolsCatalog />
      ) : (
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="relative max-w-md">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
          <Input className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search every section and provider" aria-label="Search the library" />
        </div>
        <div className="mt-4 mb-3">
          {query.trim() ? (
            <h2 className="text-sm font-semibold">
              {shown.length === 0 ? "Nothing matches" : `${shown.length === 300 ? "The first 300" : shown.length} ${shown.length === 1 ? "match" : "matches"}`}
            </h2>
          ) : (
            section && (
              <>
                <h2 className="text-sm font-semibold">{section.label}</h2>
                <p className="text-[13px] text-ink-soft">{section.hint}</p>
              </>
            )
          )}
        </div>
        <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }} data-library-grid>
          {shown.map((c) => (
            <ComponentTile key={c.id} component={c} onPick={(x) => pick(x.id)} selected={picked?.id === c.id} draggable={false} showSection={!!query.trim()} />
          ))}
        </div>
      </main>
      )}

      {picked && sectionId !== PROTOCOLS_ID && (
        <aside className="w-[320px] shrink-0 overflow-y-auto bg-surface border-l border-line px-4 py-4" aria-label="Component details" data-library-detail={picked.id}>
          <div className="flex items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-lg border border-line" style={{ color: sectionById(picked.sectionId)?.color }}>
              <LibraryIcon name={picked.icon} size={24} />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold break-words">{picked.name}</h2>
              <p className="text-[13px] text-ink-soft">{providerById(picked.provider)?.label ?? sectionById(picked.sectionId)?.label}</p>
            </div>
          </div>
          <dl className="mt-4 space-y-2 text-[13px]">
            <div>
              <dt className="text-ink-soft">Section</dt>
              <dd>{sectionById(picked.sectionId)?.label}</dd>
            </div>
            <div>
              <dt className="text-ink-soft">In the model it is a</dt>
              <dd>
                {objectType(picked.kind).label} <span className="text-ink-faint">({objectType(picked.kind).hint.toLowerCase()})</span>
              </dd>
            </div>
            {picked.provider && (
              <div>
                <dt className="text-ink-soft">Technology written as</dt>
                <dd>{componentLabel(picked)}</dd>
              </div>
            )}
            {picked.aliases && !picked.provider && (
              <div>
                <dt className="text-ink-soft">Also found by</dt>
                <dd>{picked.aliases}</dd>
              </div>
            )}
          </dl>
          {canEdit && (
            <Button
              variant="primary"
              className="mt-4"
              icon={<Plus size={15} />}
              onClick={() => {
                const made = addObject(objectFromComponent(picked));
                navigate(`/model?object=${made.id}`);
              }}
            >
              Add to the model
            </Button>
          )}
          <Button className="mt-2" icon={<Zap size={15} />} onClick={() => navigate(`/impact?component=${picked.id}`)} data-library-impact>
            Dependencies and impact
          </Button>
          <p className="mt-2 text-xs text-ink-faint">
            {usedBy.length ? `${usedBy.length} ${usedBy.length === 1 ? "object" : "objects"} in this model ${usedBy.length === 1 ? "is" : "are"} this component.` : "No object in this model is this component yet."} On a diagram, drag it from the panel on the left.
          </p>
          <h3 className="mt-5 text-[13px] font-semibold">Basic information it asks for</h3>
          <p className="text-xs text-ink-faint mb-2">{profileById(picked.profile).label}</p>
          <ul className="space-y-1" data-library-fields>
            {profileById(picked.profile).fields.map((f) => (
              <li key={f.label} className="text-[13px]">
                <div className="flex items-baseline justify-between gap-2">
                  <span>
                    {f.label}
                    {f.unit ? ` (${f.unit})` : ""}
                  </span>
                  <Badge>{FIELD_KIND[f.kind]}</Badge>
                </div>
                {f.kind === "select" && <p className="text-xs text-ink-faint">{f.options!.join(", ")}</p>}
              </li>
            ))}
          </ul>
          {picked.provider && <p className="mt-4 text-xs text-ink-faint">Drawn with an icon for what it does. The provider's own artwork is not part of this app.</p>}
        </aside>
      )}
    </div>
  );
}

/**
 * The protocols and ports connections use, by group, with how many connections of this model
 * use each. A connection takes them in its details: one or more each.
 */
function ProtocolsCatalog() {
  const ws = useWorkspace();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const used = useMemo(() => {
    const count = new Map<string, number>();
    for (const r of Object.values(ws.relationships)) for (const p of protocolsOf(r)) count.set(p.name.toLowerCase(), (count.get(p.name.toLowerCase()) ?? 0) + 1);
    return count;
  }, [ws.relationships]);
  const shown = searchProtocols(query).filter((p) => !group || p.group === group);
  return (
    <main className="min-w-0 flex-1 overflow-y-auto px-6 py-5" data-protocols-catalog>
      <h2 className="text-sm font-semibold">Protocols and ports</h2>
      <p className="text-[13px] text-ink-soft">
        What connections carry. Open a connection on a diagram to give it one or more of these; the lock marks protocols that encrypt what they carry.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <div className="relative w-64">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
          <Input className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, port or use" aria-label="Search protocols" />
        </div>
        {[null, ...PROTOCOL_GROUPS].map((g) => (
          <button key={g ?? "all"} type="button" onClick={() => setGroup(g)} className={`rounded-full border px-2.5 py-0.5 text-xs ${group === g ? "border-blueprint bg-blueprint-soft text-blueprint" : "border-line text-ink-soft hover:border-ink-faint"}`}>
            {g ?? "All"}
          </button>
        ))}
      </div>
      <table className="mt-3 w-full text-left text-[13px]">
        <thead className="text-xs text-ink-soft border-b border-line">
          <tr>
            <th className="py-1.5 font-medium">Protocol</th>
            <th className="py-1.5 font-medium">Port</th>
            <th className="py-1.5 font-medium">Transport</th>
            <th className="py-1.5 font-medium">Group</th>
            <th className="py-1.5 font-medium">Use</th>
            <th className="py-1.5 font-medium text-right">In this model</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((p) => (
            <tr key={`${p.name}-${p.port}`} className="border-b border-line-soft" data-protocol={p.name}>
              <td className="py-1.5 font-medium">
                <span className="inline-flex items-center gap-1">
                  {p.name}
                  {p.secure && <Lock size={12} className="text-ok" aria-label="Encrypts what it carries" />}
                </span>
              </td>
              <td className="py-1.5 tabular-nums">{p.port || "–"}</td>
              <td className="py-1.5">{p.transport}</td>
              <td className="py-1.5 text-ink-soft">{p.group}</td>
              <td className="py-1.5 text-ink-soft">{p.use}</td>
              <td className="py-1.5 text-right tabular-nums">{used.get(p.name.toLowerCase()) ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!shown.length && <p className="mt-3 text-ink-soft">No protocol matches.</p>}
      <p className="mt-3 text-xs text-ink-faint">Written on a line as {protocolLabel(PROTOCOLS[1])}.</p>
    </main>
  );
}
