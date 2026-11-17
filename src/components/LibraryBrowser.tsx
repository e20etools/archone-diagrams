import { ChevronRight, Search } from "lucide-react";
import { useMemo, useState, type DragEvent } from "react";
import { DRAG_MIME, type DragItem } from "@/components/canvas/DiagramCanvas";
import { PROTOCOLS, protocolLabel, searchProtocols, type ProtocolInfo } from "@/lib/library/protocols";
import { LibraryIcon } from "@/components/icons";
import { Input, Select } from "@/components/ui";
import { networkLink } from "@/lib/networkLinks";
import { LIBRARY_SECTIONS, PROVIDERS, componentsIn, providerById, searchLibrary, sectionById, type LibraryComponent } from "@/lib/library";

/** "general" or a provider id. */
export type LibrarySource = string;
export const GENERAL = "general";

export const sectionsOf = (source: LibrarySource) => LIBRARY_SECTIONS.filter((s) => (source === GENERAL ? !s.provider : s.provider === source));

const drag = (c: LibraryComponent) => (e: DragEvent) => {
  const item: DragItem = { kind: "component", id: c.id };
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(item));
  e.dataTransfer.effectAllowed = "copy";
};

/** One component: its icon and its name. Dragged onto a canvas or clicked. */
export function ComponentTile({ component, onPick, selected, draggable = true, showSection = false }: { component: LibraryComponent; onPick: (c: LibraryComponent) => void; selected?: boolean; draggable?: boolean; showSection?: boolean }) {
  const section = sectionById(component.sectionId);
  const provider = providerById(component.provider);
  // Each kind of network connection has its own colour, the one its lines take in a diagram.
  const network = component.sectionId === "connections" ? networkLink(component.name) : null;
  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={draggable ? drag(component) : undefined}
      onClick={() => onPick(component)}
      title={`${component.name}${provider ? `, ${provider.label}` : ""}. ${section?.label ?? ""}`}
      data-component={component.id}
      data-network-color={network?.color}
      aria-pressed={selected}
      className={`group flex items-center gap-2 min-h-9 px-2 py-1 rounded-md border text-left text-[13px] ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${selected ? "border-blueprint bg-blueprint-soft" : "border-line hover:border-blueprint hover:bg-blueprint-soft"}`}
    >
      <span className="shrink-0" style={{ color: network?.color ?? section?.color }}>
        <LibraryIcon name={component.icon} size={16} />
      </span>
      <span className="min-w-0">
        <span className="block leading-tight line-clamp-2">{component.name}</span>
        {(component.custom || component.changed) && (
          <span className="block text-[10px] font-medium leading-tight text-blueprint" data-library-own={component.custom ? "own" : "changed"}>
            {component.custom ? "Your own" : "Changed here"}
          </span>
        )}
        {showSection && <span className="block text-[11px] leading-tight text-ink-faint truncate">{provider ? `${provider.short}, ${section?.group}` : section?.label}</span>}
      </span>
    </button>
  );
}

/** Which part of the library to look in: the general sections or one provider's. */
export function SourceSelect({ value, onChange, className }: { value: LibrarySource; onChange: (source: LibrarySource) => void; className?: string }) {
  return (
    <Select aria-label="Part of the library" className={className} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value={GENERAL}>General components</option>
      {PROVIDERS.map((p) => (
        <option key={p.id} value={p.id}>
          {p.label}
        </option>
      ))}
    </Select>
  );
}

/**
 * The library as a narrow panel: a search box, a choice of general or one provider, and the
 * sections underneath, each opened on demand. Searching looks through all of it.
 */
export function LibraryPanel({
  onPick,
  intro,
  diagrams,
  onPickDiagram,
  onPickProtocol,
}: {
  onPick: (c: LibraryComponent) => void;
  intro?: React.ReactNode;
  /** The other diagrams of the workspace, offered in the Diagrams section as boxes to connect to. */
  diagrams?: { id: string; name: string; kind: string }[];
  onPickDiagram?: (diagramId: string) => void;
  /** Given, the panel ends with the protocols and ports, applied to the connection picked. */
  onPickProtocol?: (protocol: ProtocolInfo) => void;
}) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<LibrarySource>(GENERAL);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const results = useMemo(() => (query.trim() ? searchLibrary(query, { limit: 60 }) : null), [query]);
  return (
    <div className="space-y-2.5" data-library-panel>
      {intro}
      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
        <Input className="pl-8" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a component, e.g. firewall or S3" aria-label="Find a component in the library" />
      </div>
      {results ? (
        <div>
          <p className="text-xs text-ink-faint mb-1.5" data-library-results={results.length}>
            {results.length === 0 ? "Nothing in the library matches." : results.length === 60 ? "The first 60 matches." : `${results.length} ${results.length === 1 ? "match" : "matches"}.`}
          </p>
          <div className="grid grid-cols-1 gap-1">
            {results.map((c) => (
              <ComponentTile key={c.id} component={c} onPick={onPick} showSection />
            ))}
          </div>
        </div>
      ) : (
        <>
          <SourceSelect value={source} onChange={setSource} />
          <ul className="space-y-1">
            {sectionsOf(source).map((s) => {
              const isOpen = open[s.id] ?? false;
              const items = isOpen ? componentsIn(s.id) : [];
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded-md text-left text-[13px] font-medium hover:bg-line-soft"
                    aria-expanded={isOpen}
                    data-library-section={s.id}
                    onClick={() => setOpen((o) => ({ ...o, [s.id]: !isOpen }))}
                  >
                    <ChevronRight size={14} className={`shrink-0 text-ink-faint transition-transform ${isOpen ? "rotate-90" : ""}`} />
                    <span className="shrink-0" style={{ color: s.color }}>
                      <LibraryIcon name={s.icon} size={15} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{s.provider ? s.group : s.label}</span>
                    <span className="text-xs text-ink-faint tabular-nums">{s.id === "diagrams" && diagrams ? diagrams.length : componentsIn(s.id).length}</span>
                  </button>
                  {isOpen && s.id === "diagrams" && diagrams && onPickDiagram ? (
                    <div className="space-y-1 pl-1 pt-1 pb-1.5" data-library-diagrams>
                      {diagrams.length === 0 && <p className="px-1.5 text-xs text-ink-faint">No other diagrams yet.</p>}
                      {diagrams.map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          draggable={false}
                          data-library-diagram={d.id}
                          onClick={() => onPickDiagram(d.id)}
                          className="w-full flex items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5 text-left hover:border-blueprint"
                          title={`Add ${d.name} as one box to connect to`}
                        >
                          <LibraryIcon name="Workflow" size={14} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium">{d.name}</span>
                            <span className="block truncate text-xs text-ink-faint">{d.kind}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : isOpen && (
                    <div className="grid grid-cols-2 gap-1 pl-1 pt-1 pb-1.5">
                      {items.map((c) => (
                        <ComponentTile key={c.id} component={c} onPick={onPick} />
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {onPickProtocol && <ProtocolsSection onPick={onPickProtocol} />}
        </>
      )}
    </div>
  );
}

/** The protocols and ports, by group; a click gives the connection picked on the diagram that protocol. */
function ProtocolsSection({ onPick }: { onPick: (p: ProtocolInfo) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shown = searchProtocols(query);
  return (
    <div className="border-t border-line-soft pt-1.5" data-library-protocols>
      <button type="button" className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded-md text-left text-[13px] font-medium hover:bg-line-soft" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className={`shrink-0 text-ink-faint transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="shrink-0 text-[#0E7490]">
          <LibraryIcon name="Cable" size={15} />
        </span>
        <span className="min-w-0 flex-1 truncate">Protocols and ports</span>
        <span className="text-xs text-ink-faint tabular-nums">{PROTOCOLS.length}</span>
      </button>
      {open && (
        <div className="pl-1 pt-1 pb-1.5 space-y-1">
          <p className="px-1 text-xs text-ink-faint">Pick a connection on the diagram, then a protocol to add it.</p>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="HTTPS, 1433, LDAP…" aria-label="Find a protocol" />
          <div className="max-h-72 overflow-y-auto space-y-0.5">
            {shown.map((p) => (
              <button
                key={`${p.name}-${p.port}`}
                type="button"
                data-library-protocol={p.name}
                onClick={() => onPick(p)}
                className="w-full flex items-center gap-2 rounded px-1.5 py-1 text-left text-[13px] hover:bg-line-soft"
                title={p.use}
              >
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="text-xs tabular-nums text-ink-faint">{protocolLabel(p).slice(p.name.length).trim()}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
