import { Archive, BookmarkPlus, Copy, LayoutGrid, List, Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArchiveDialog } from "@/components/NewArchitecture";
import { BuildButtons, StartModel, useBuildDialogs } from "@/components/DiagramBuild";
import { DiagramThumbnail } from "@/components/DiagramThumbnail";
import { SaveAsTemplateDialog } from "@/components/SaveAsTemplate";
import { Button, EmptyState, IconButton, Input, Modal, Select, cx, formatDate } from "@/components/ui";
import { CATEGORIES, CATEGORY_INFO, viewCategory, type Category } from "@/lib/categories";
import { VIEW_TYPE_INFO } from "@/lib/catalog";
import { categoryColor } from "@/lib/diagramMap";
import { archivedDiagrams, deleteDiagram, duplicateDiagram, sortedDiagrams } from "@/lib/model";
import { apply, useWorkspace } from "@/lib/store";
import { useCanEdit } from "@/lib/cloud/session";
import { visibleEdges } from "@/lib/views";
import { zonesOf } from "@/lib/zones";
import type { Diagram, Workspace } from "@/lib/types";

type Sort = "changed" | "name" | "size";
type Layout = "grid" | "list";

const LAYOUT_KEY = "archone.diagrams.layout";
const storedLayout = (): Layout => {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
};

interface Row {
  diagram: Diagram;
  category: Category;
  boxes: number;
  lines: number;
  /** Lower-case text the search box looks in. */
  text: string;
}

function rowsOf(ws: Workspace, diagrams: Diagram[]): Row[] {
  return diagrams.map((d) => {
    const scope = d.scopeId ? ws.objects[d.scopeId]?.name ?? "" : "";
    return {
      diagram: d,
      category: viewCategory(d.viewType),
      // Zones are drawn as areas around boxes, not as boxes.
      boxes: (() => {
        const zones = new Set(zonesOf(ws, d).map((z) => z.id));
        return Object.keys(d.nodes).filter((id) => ws.objects[id] && !zones.has(id)).length;
      })(),
      lines: visibleEdges(ws, d).length,
      text: [d.name, d.description, VIEW_TYPE_INFO[d.viewType].label, scope].join(" ").toLowerCase(),
    };
  });
}

/**
 * Every diagram of the workspace, each as a small picture of what it holds, with the ways to
 * start a new one. A card opens its diagram for editing; the buttons under it copy, archive,
 * save as a template or delete.
 */
export function DiagramsPage() {
  const ws = useWorkspace();
  const canEdit = useCanEdit();
  const { open, dialogs } = useBuildDialogs(ws);
  const [archiving, setArchiving] = useState<Diagram | null>(null);
  const [removing, setRemoving] = useState<Diagram | null>(null);
  const [templating, setTemplating] = useState<Diagram | null>(null);
  const [area, setArea] = useState<"all" | Category>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("changed");
  const [layout, setLayoutState] = useState<Layout>(storedLayout);
  const setLayout = (next: Layout) => {
    setLayoutState(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      /* The choice is only kept for this visit. */
    }
  };

  const diagrams = sortedDiagrams(ws);
  const archivedCount = archivedDiagrams(ws).length;
  const blank = diagrams.length === 0 && Object.keys(ws.objects).length === 0;
  const all = useMemo(() => rowsOf(ws, diagrams), [ws]); // eslint-disable-line react-hooks/exhaustive-deps
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all
    .filter((r) => area === "all" || r.category === area)
    .filter((r) => words.every((w) => r.text.includes(w)))
    .sort((a, b) =>
      sort === "name"
        ? a.diagram.name.localeCompare(b.diagram.name)
        : sort === "size"
          ? b.boxes - a.boxes || a.diagram.name.localeCompare(b.diagram.name)
          : b.diagram.updatedAt.localeCompare(a.diagram.updatedAt),
    );

  const actions = (d: Diagram) => (
    <>
      {canEdit && (
        <IconButton label={`Save ${d.name} as a template`} data-save-as-template={d.id} onClick={() => setTemplating(d)}>
          <BookmarkPlus size={15} />
        </IconButton>
      )}
      {canEdit && (
        <IconButton label={`Archive ${d.name}`} data-archive={d.id} onClick={() => setArchiving(d)}>
          <Archive size={15} />
        </IconButton>
      )}
      <IconButton label={`Duplicate ${d.name}`} data-duplicate={d.id} onClick={() => apply((w) => duplicateDiagram(w, d.id).ws)}>
        <Copy size={15} />
      </IconButton>
      <IconButton label={`Delete ${d.name}`} data-delete={d.id} onClick={() => setRemoving(d)}>
        <Trash2 size={15} />
      </IconButton>
    </>
  );

  return (
    <div className="max-w-7xl mx-auto px-6 py-7" data-diagrams-page>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Diagrams</h1>
          <p className="text-ink-soft mt-0.5">
            {diagrams.length
              ? `${diagrams.length} ${diagrams.length === 1 ? "diagram" : "diagrams"} drawn from one shared model. Open one to edit it, or start a new one.`
              : "Each diagram is a view of one shared model."}
          </p>
        </div>
        {!blank && <BuildButtons onOpen={open} />}
      </div>

      {blank ? (
        <StartModel ws={ws} onOpen={open} />
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-2" data-diagrams-toolbar>
            <label className="relative">
              <span className="sr-only">Search diagrams</span>
              <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search diagrams" className="w-56 pl-8" data-diagrams-search />
            </label>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Area">
              {(["all", ...CATEGORIES] as const).map((c) => {
                const n = c === "all" ? all.length : all.filter((r) => r.category === c).length;
                if (c !== "all" && !n) return null;
                return (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={area === c}
                    data-diagram-area={c}
                    onClick={() => setArea(c)}
                    className={cx("inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs", area === c ? "border-blueprint bg-blueprint-soft text-blueprint-deep" : "border-line text-ink-soft hover:border-ink-faint")}
                  >
                    {c !== "all" && <span className="size-2 rounded-full" style={{ background: categoryColor[c] }} />}
                    {c === "all" ? "All" : CATEGORY_INFO[c].label}
                    <span className="tabular-nums text-ink-faint">{n}</span>
                  </button>
                );
              })}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-ink-soft">
                Sort
                <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-8 w-auto text-[13px]" data-diagrams-sort>
                  <option value="changed">Last changed</option>
                  <option value="name">Name</option>
                  <option value="size">Most boxes</option>
                </Select>
              </label>
              <div className="flex rounded-md border border-line p-0.5" role="group" aria-label="Layout">
                {([
                  ["grid", LayoutGrid, "Cards"],
                  ["list", List, "List"],
                ] as const).map(([id, Icon, label]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={layout === id}
                    aria-label={label}
                    title={label}
                    data-diagrams-layout={id}
                    onClick={() => setLayout(id)}
                    className={cx("grid size-7 place-items-center rounded", layout === id ? "bg-blueprint-soft text-blueprint-deep" : "text-ink-soft hover:text-ink")}
                  >
                    <Icon size={15} />
                  </button>
                ))}
              </div>
            </div>
          </div>

          {!shown.length ? (
            <div className="mt-6 rounded-lg border border-dashed border-ink-faint bg-surface">
              <EmptyState
                title={all.length ? "No diagram matches" : "No diagrams yet"}
                text={all.length ? "Try other words, or show every area." : "The model has objects, but nothing draws them. Create a diagram to see them."}
              >
                {all.length ? (
                  <Button
                    onClick={() => {
                      setQuery("");
                      setArea("all");
                    }}
                  >
                    Show all diagrams
                  </Button>
                ) : (
                  <Button variant="primary" icon={<Plus size={15} />} onClick={() => open("new")}>
                    New diagram
                  </Button>
                )}
              </EmptyState>
            </div>
          ) : layout === "grid" ? (
            <ul className="mt-5 grid gap-4 grid-cols-[repeat(auto-fill,minmax(230px,1fr))]" data-diagram-grid>
              {canEdit && !words.length && area === "all" && (
                <li>
                  <button
                    type="button"
                    onClick={() => open("new")}
                    data-new-diagram-card
                    className="flex size-full min-h-64 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-ink-faint bg-surface/60 px-4 text-center text-ink-soft transition hover:border-blueprint hover:text-blueprint"
                  >
                    <span className="grid size-10 place-items-center rounded-full bg-blueprint-soft text-blueprint">
                      <Plus size={20} />
                    </span>
                    <span className="text-sm font-medium text-ink">New diagram</span>
                    <span className="text-xs leading-snug">Blank, from a template, with AI, from text, a picture or a file</span>
                  </button>
                </li>
              )}
              {shown.map((r) => (
                <DiagramCard key={r.diagram.id} ws={ws} row={r} actions={actions(r.diagram)} />
              ))}
            </ul>
          ) : (
            <div className="mt-5 rounded-lg border border-line bg-surface overflow-x-auto" data-diagram-list>
              <table className="w-full text-left">
                <thead className="text-[13px] text-ink-soft bg-paper border-b border-line">
                  <tr>
                    <th className="font-medium px-4 py-2.5">Name</th>
                    <th className="font-medium px-4 py-2.5">Shows</th>
                    <th className="font-medium px-4 py-2.5 text-right">Boxes</th>
                    <th className="font-medium px-4 py-2.5 text-right">Lines</th>
                    <th className="font-medium px-4 py-2.5">Last changed</th>
                    <th className="px-4 py-2.5">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(({ diagram: d, boxes, lines, category }) => (
                    <tr key={d.id} className="border-b border-line-soft last:border-b-0 hover:bg-paper/60" data-diagram-row={d.id}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <Link to={`/diagram/${d.id}`} className="block h-10 w-14 shrink-0 overflow-hidden rounded border border-line-soft bg-paper" tabIndex={-1} aria-hidden>
                            <DiagramThumbnail ws={ws} diagram={d} />
                          </Link>
                          <div className="min-w-0">
                            <Link to={`/diagram/${d.id}`} className="font-medium text-blueprint hover:underline" data-diagram-name>
                              {d.name}
                            </Link>
                            {d.description && <p className="text-[13px] text-ink-soft mt-0.5 line-clamp-1 max-w-[46ch]">{d.description}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-ink-soft whitespace-nowrap">
                        <span className="mr-1.5 inline-block size-2 rounded-full align-middle" style={{ background: categoryColor[category] }} />
                        {VIEW_TYPE_INFO[d.viewType].label}
                        {d.scopeId && ws.objects[d.scopeId] && <span className="text-ink-faint">, {ws.objects[d.scopeId].name}</span>}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{boxes}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{lines}</td>
                      <td className="px-4 py-3 text-ink-soft whitespace-nowrap">{formatDate(d.updatedAt)}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap">{actions(d)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {archivedCount > 0 && (
        <p className="mt-4 text-[13px] text-ink-soft">
          <button type="button" className="text-blueprint hover:underline" data-archived-open onClick={() => open("archived")}>
            {archivedCount} archived {archivedCount === 1 ? "diagram" : "diagrams"}
          </button>{" "}
          {archivedCount === 1 ? "is" : "are"} kept out of this list.
        </p>
      )}

      {dialogs}
      {templating && <SaveAsTemplateDialog ws={ws} diagram={templating} onClose={() => setTemplating(null)} />}
      {archiving && <ArchiveDialog diagram={archiving} onClose={() => setArchiving(null)} />}
      {removing && (
        <Modal
          title="Delete this diagram?"
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button onClick={() => setRemoving(null)}>Keep it</Button>
              <Button
                variant="danger"
                onClick={() => {
                  apply((w) => deleteDiagram(w, removing.id));
                  setRemoving(null);
                }}
              >
                Delete diagram
              </Button>
            </>
          }
        >
          <p>
            "{removing.name}" will be deleted. Its {Object.keys(removing.nodes).length} objects stay in the model and on other diagrams.
          </p>
        </Modal>
      )}
    </div>
  );
}

/** One diagram as a card: the picture opens it, the name says what it is, the buttons act on it. */
function DiagramCard({ ws, row, actions }: { ws: Workspace; row: Row; actions: React.ReactNode }) {
  const d = row.diagram;
  const scope = d.scopeId ? ws.objects[d.scopeId]?.name : "";
  return (
    <li className="group flex flex-col overflow-hidden rounded-xl border border-line bg-surface transition hover:border-blueprint hover:shadow-md focus-within:border-blueprint" data-diagram-card={d.id}>
      <Link to={`/diagram/${d.id}`} className="diagram-card__picture relative block aspect-[4/3] overflow-hidden border-b border-line-soft" data-diagram-open tabIndex={-1} aria-hidden>
        <span className="absolute inset-x-2 bottom-2 top-9">
          <DiagramThumbnail ws={ws} diagram={d} />
        </span>
        <span className="absolute left-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-full border border-line-soft bg-surface/90 px-2 py-0.5 text-[11px] text-ink-soft backdrop-blur">
          <span className="size-2 rounded-full" style={{ background: categoryColor[row.category] }} />
          {CATEGORY_INFO[row.category].label}
        </span>
      </Link>
      <div className="flex flex-1 flex-col px-3.5 pt-2.5 pb-2">
        <Link to={`/diagram/${d.id}`} className="font-medium leading-snug line-clamp-2 hover:text-blueprint focus-visible:text-blueprint" data-diagram-name title={d.description || d.name}>
          {d.name}
        </Link>
        <p className="mt-0.5 truncate text-xs text-ink-soft">
          {VIEW_TYPE_INFO[d.viewType].label}
          {scope ? `, ${scope}` : ""}
        </p>
        <p className="mt-1 text-xs text-ink-soft tabular-nums" data-diagram-counts>
          {row.boxes} {row.boxes === 1 ? "box" : "boxes"} · {row.lines} {row.lines === 1 ? "line" : "lines"}
        </p>
        <div className="mt-auto flex items-center justify-between pt-1.5">
          <span className="text-xs text-ink-faint">{formatDate(d.updatedAt)}</span>
          <div className="-mr-1.5 flex opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">{actions}</div>
        </div>
      </div>
    </li>
  );
}
