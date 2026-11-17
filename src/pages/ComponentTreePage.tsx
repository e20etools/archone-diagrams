import { ArrowLeft, ArrowLeftRight, ChevronRight, CornerDownRight, Network, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { DiagramThumbnail } from "@/components/DiagramThumbnail";
import { TypeIcon } from "@/components/icons";
import { Badge, Button, EmptyState, cx } from "@/components/ui";
import { CATEGORY_INFO, LIFECYCLE_INFO, objectType } from "@/lib/catalog";
import { componentTree, flatten, levelCounts, treeDiagrams, type TreeDirection, type TreeNode, type TreeScope } from "@/lib/componentTree";
import { MAX_LEVELS, typeLabel } from "@/lib/impact";
import { diagramsUsing } from "@/lib/model";
import { useWorkspace } from "@/lib/store";
import type { Workspace } from "@/lib/types";

/** Each level a little quieter than the one before, so depth reads at a glance. */
const LEVEL_TONE = ["bg-blueprint text-on-accent", "bg-blueprint/80 text-on-accent", "bg-blueprint/30 text-blueprint-deep", "bg-blueprint/18 text-blueprint-deep", "bg-blueprint/10 text-blueprint-deep"];

const SIDES: { side: TreeDirection; title: (name: string) => string; hint: string }[] = [
  { side: "out", title: (n) => `What ${n} relies on`, hint: "Following its arrows: what it calls, reads, runs on or depends on." },
  { side: "in", title: (n) => `What relies on ${n}`, hint: "Against its arrows: what calls it, reads from it or runs on it." },
];

/**
 * One component and everything related to it, as two trees up to five levels deep: what it
 * relies on and what relies on it. Each row names the relationship and its protocols and the
 * diagrams the object is on; a name opens that object's own tree. Opened by double-clicking a
 * box in a diagram.
 */
export function ComponentTreePage() {
  const { id = "" } = useParams();
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const from = params.get("from") ?? "";
  const levels = Math.min(MAX_LEVELS, Math.max(1, Number(params.get("levels")) || 3));
  const scope: TreeScope = params.get("scope") === "dependencies" ? "dependencies" : "all";
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [lit, setLit] = useState<string | null>(null);
  const object = ws.objects[id];

  const trees = useMemo(
    () => ({ out: componentTree(ws, id, "out", levels, scope), in: componentTree(ws, id, "in", levels, scope) }),
    [ws, id, levels, scope],
  );
  const diagrams = useMemo(() => treeDiagrams(ws, id, trees), [ws, id, trees]);
  const onDiagram = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const d of diagrams) map.set(d.diagram.id, new Set([id, ...d.objects]));
    return map;
  }, [diagrams, id]);

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  if (!object) {
    return (
      <EmptyState title="This component is not in the model" text="It may have been deleted, or the link may be wrong.">
        <Link to="/diagrams" className="font-medium text-blueprint hover:underline">
          Go to diagrams
        </Link>
      </EmptyState>
    );
  }

  const fromDiagram = from ? ws.diagrams[from] : undefined;
  const type = objectType(object.typeId);
  const color = CATEGORY_INFO[type.category]?.color ?? "#2447D6";
  const branches = [...flatten(trees.out), ...flatten(trees.in)].filter((n) => n.children.length);
  const keyOf = (side: TreeDirection, n: TreeNode) => `${side}:${n.id}`;
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const openTree = (target: string) => navigate(`/component/${target}?${new URLSearchParams({ ...(from ? { from } : {}), levels: String(levels), ...(scope === "dependencies" ? { scope } : {}) })}`);
  const total = (side: TreeDirection) => flatten(trees[side]).filter((n) => !n.repeat).length;

  return (
    <div className="max-w-7xl mx-auto px-6 py-6" data-component-tree={id}>
      <Link to={fromDiagram ? `/diagram/${fromDiagram.id}` : "/diagrams"} className="inline-flex items-center gap-1.5 text-[13px] text-ink-soft hover:text-blueprint" data-tree-back>
        <ArrowLeft size={14} />
        {fromDiagram ? `Back to ${fromDiagram.name}` : "Diagrams"}
      </Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl text-white" style={{ background: color }}>
            <TypeIcon typeId={object.typeId} componentId={object.componentId} size={22} />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{object.name}</h1>
            <p className="text-ink-soft text-[13px]">
              {[typeLabel(object), object.technology, object.owner && `Owner: ${object.owner}`].filter(Boolean).join(" · ")}
              {object.lifecycle !== "active" && (
                <span className="ml-2 align-middle">
                  <Badge tone="amber">{LIFECYCLE_INFO[object.lifecycle].label}</Badge>
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button icon={<Zap size={15} />} onClick={() => navigate(`/impact?object=${id}`)}>
            Impact and what-if
          </Button>
          <Button icon={<Network size={15} />} onClick={() => navigate(`/model?object=${id}`)}>
            Show in model
          </Button>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border border-line bg-surface px-4 py-3" data-tree-controls>
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-ink-soft">Levels</span>
          <div className="flex rounded-lg border border-line p-0.5" role="group" aria-label="How many levels to show">
            {Array.from({ length: MAX_LEVELS }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={levels === n}
                data-tree-levels={n}
                onClick={() => {
                  setCollapsed(new Set());
                  set("levels", String(n));
                }}
                className={cx("h-7 min-w-8 rounded-md px-2 text-[13px] tabular-nums", levels === n ? "bg-blueprint text-on-accent" : "text-ink-soft hover:text-ink")}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-ink-soft">Relationships</span>
          <div className="flex rounded-lg border border-line p-0.5" role="group" aria-label="Which relationships to follow">
            {([
              ["all", "All"],
              ["dependencies", "Dependencies only"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={scope === value}
                data-tree-scope={value}
                onClick={() => set("scope", value === "all" ? null : value)}
                className={cx("h-7 rounded-md px-2.5 text-[13px]", scope === value ? "bg-blueprint text-on-accent" : "text-ink-soft hover:text-ink")}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="ml-auto flex gap-2">
          <Button size="sm" onClick={() => setCollapsed(new Set())} data-tree-expand>
            Expand all
          </Button>
          <Button size="sm" onClick={() => setCollapsed(new Set(SIDES.flatMap(({ side }) => flatten(trees[side]).filter((n) => n.children.length).map((n) => keyOf(side, n)))))} disabled={!branches.length} data-tree-collapse>
            Collapse all
          </Button>
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        {SIDES.map(({ side, title, hint }) => {
          const counts = levelCounts(trees[side]);
          return (
            <section key={side} className="rounded-xl border border-line bg-surface" aria-label={title(object.name)} data-tree-side={side}>
              <header className="border-b border-line-soft px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-sm font-semibold">{title(object.name)}</h2>
                  <span className="text-xs text-ink-soft tabular-nums" data-tree-total>
                    {total(side)} {total(side) === 1 ? "object" : "objects"}
                  </span>
                </div>
                <p className="text-xs text-ink-soft">{hint}</p>
                <div className="mt-2 flex flex-wrap gap-1.5" data-tree-counts>
                  {counts.slice(0, levels).map((c, i) => (
                    <span key={i} className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] tabular-nums", c ? LEVEL_TONE[i] : "bg-paper text-ink-faint")}>
                      Level {i + 1}: {c}
                    </span>
                  ))}
                </div>
              </header>
              <div className="px-3 py-3">
                <div className="flex items-center gap-2 px-1 pb-1 text-[13px] font-medium">
                  <span className="grid size-6 place-items-center rounded-md text-white" style={{ background: color }}>
                    <TypeIcon typeId={object.typeId} componentId={object.componentId} size={13} />
                  </span>
                  {object.name}
                </div>
                {trees[side].length ? (
                  <TreeList
                    ws={ws}
                    nodes={trees[side]}
                    side={side}
                    collapsed={collapsed}
                    keyOf={keyOf}
                    onToggle={toggle}
                    onOpenTree={openTree}
                    from={from}
                    lit={lit ? onDiagram.get(lit) ?? null : null}
                  />
                ) : (
                  <p className="px-1 py-3 text-[13px] text-ink-soft" data-tree-empty>
                    {side === "out" ? `${object.name} relies on nothing in the model` : `Nothing in the model relies on ${object.name}`}
                    {scope === "dependencies" ? " through a dependency." : "."}
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <section className="mt-6" aria-label="Diagrams" data-tree-diagrams>
        <h2 className="text-sm font-semibold">Diagrams these objects are on</h2>
        <p className="text-xs text-ink-soft">Point at one to light its objects in the trees above. A click opens the diagram.</p>
        {diagrams.length ? (
          <ul className="mt-3 grid gap-3 grid-cols-[repeat(auto-fill,minmax(210px,1fr))]">
            {diagrams.map((d) => (
              <li key={d.diagram.id}>
                <Link
                  to={`/diagram/${d.diagram.id}`}
                  onMouseEnter={() => setLit(d.diagram.id)}
                  onMouseLeave={() => setLit(null)}
                  onFocus={() => setLit(d.diagram.id)}
                  onBlur={() => setLit(null)}
                  className={cx("flex h-full flex-col overflow-hidden rounded-xl border bg-surface transition hover:border-blueprint", lit === d.diagram.id ? "border-blueprint" : "border-line")}
                  data-tree-diagram={d.diagram.id}
                >
                  <span className="diagram-card__picture relative block aspect-[16/9] overflow-hidden border-b border-line-soft">
                    <span className="absolute inset-2">
                      <DiagramThumbnail ws={ws} diagram={d.diagram} />
                    </span>
                  </span>
                  <span className="px-3 py-2">
                    <span className="block truncate text-[13px] font-medium">{d.diagram.name}</span>
                    <span className="block text-xs text-ink-soft">
                      {d.level === 0 ? `${object.name} is on it` : `From level ${d.level}`} · {d.objects.length} {d.objects.length === 1 ? "object" : "objects"}
                    </span>
                    {d.diagram.id === from && <span className="mt-1 inline-block text-[11px] text-blueprint">You came from here</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[13px] text-ink-soft">None of these objects is on a diagram.</p>
        )}
      </section>
    </div>
  );
}

function TreeList({
  ws,
  nodes,
  side,
  collapsed,
  keyOf,
  onToggle,
  onOpenTree,
  from,
  lit,
}: {
  ws: Workspace;
  nodes: TreeNode[];
  side: TreeDirection;
  collapsed: Set<string>;
  keyOf: (side: TreeDirection, n: TreeNode) => string;
  onToggle: (key: string) => void;
  onOpenTree: (id: string) => void;
  from: string;
  lit: Set<string> | null;
}) {
  return (
    <ul className="component-tree" role="group">
      {nodes.map((n) => {
        const o = ws.objects[n.id];
        if (!o) return null;
        const key = keyOf(side, n);
        const open = !collapsed.has(key);
        const color = CATEGORY_INFO[objectType(o.typeId).category]?.color ?? "#2447D6";
        const on = diagramsUsing(ws, n.id).filter((d) => !d.archive?.archived);
        const elsewhere = on.filter((d) => d.id !== from);
        const relation = [n.link.label, n.link.protocols.slice(0, 2).join(", ")].filter(Boolean).join(" · ");
        return (
          <li key={`${n.id}:${n.link.relationshipId}`} data-tree-node={n.id} data-tree-level={n.level} data-tree-repeat={n.repeat || undefined}>
            <div className={cx("tree-row group flex items-center gap-1.5 rounded-lg py-1 pr-2", n.repeat && "opacity-70", lit && (lit.has(n.id) ? "bg-blueprint-soft" : "opacity-40"))}>
              {n.children.length ? (
                <button type="button" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${o.name}`} onClick={() => onToggle(key)} className="grid size-5 shrink-0 place-items-center rounded text-ink-soft hover:bg-line-soft" data-tree-toggle>
                  <ChevronRight size={14} className={cx("transition-transform", open && "rotate-90")} />
                </button>
              ) : (
                <span className="size-5 shrink-0" />
              )}
              <span className={cx("shrink-0 rounded px-1 text-[10px] font-semibold tabular-nums", LEVEL_TONE[n.level - 1])} title={`Level ${n.level}`}>
                L{n.level}
              </span>
              <span className="shrink-0" style={{ color }}>
                <TypeIcon typeId={o.typeId} componentId={o.componentId} size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <button type="button" onClick={() => onOpenTree(n.id)} className="truncate text-left text-[13px] font-medium hover:text-blueprint hover:underline" title={`Show the tree of ${o.name}`} data-tree-open={n.id}>
                    {o.name}
                  </button>
                  {n.repeat && (
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-ink-faint" title="Already listed nearer the top; its own branches are shown there">
                      <CornerDownRight size={11} />
                      listed above
                    </span>
                  )}
                </span>
                <span className="flex min-w-0 items-center gap-1 text-[11px] text-ink-soft">
                  {n.link.both && <ArrowLeftRight size={11} className="shrink-0" aria-label="Both ways" />}
                  <span className="truncate">{relation}</span>
                </span>
              </span>
              <span className="hidden shrink-0 items-center gap-1 sm:flex" data-tree-on={on.map((d) => d.id).join(" ")}>
                {elsewhere.slice(0, 2).map((d) => (
                  <Link key={d.id} to={`/diagram/${d.id}`} className="max-w-28 truncate rounded-full border border-line px-1.5 py-px text-[11px] text-ink-soft hover:border-blueprint hover:text-blueprint" title={`On ${d.name}`}>
                    {d.name}
                  </Link>
                ))}
                {elsewhere.length > 2 && <span className="text-[11px] text-ink-faint">+{elsewhere.length - 2}</span>}
                {!on.length && <span className="text-[11px] text-ink-faint">no diagram</span>}
              </span>
            </div>
            {n.children.length > 0 && open && (
              <TreeList ws={ws} nodes={n.children} side={side} collapsed={collapsed} keyOf={keyOf} onToggle={onToggle} onOpenTree={onOpenTree} from={from} lit={lit} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

