import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { ChevronDown, ChevronUp, Download, ExternalLink, Maximize2, Minimize2, RotateCcw, Search, X, Zap } from "lucide-react";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { TypeIcon } from "@/components/icons";
import { Badge, Button, Input, cx } from "@/components/ui";
import { CATEGORIES, type Category } from "@/lib/categories";
import {
  categoryColor,
  categoryLabel,
  diagramMap,
  kindLabel,
  linkLabel,
  linksAmong,
  mapLayout,
  mapMermaid,
  mapPath,
  mapReach,
  mapRows,
  type DiagramMap,
  type MapLink,
  type MapNode,
} from "@/lib/diagramMap";
import { border, type Picture } from "@/lib/export/picture";
import { drawioXml, gifBlob } from "@/lib/export/formats";
import { exportPdf, exportPng, exportSvg } from "@/lib/exportImage";
import { downloadBlob, downloadText, toCsv } from "@/lib/exporters";
import { NODE_H, NODE_W } from "@/lib/layout";
import { useWorkspace } from "@/lib/store";
import type { Diagram, Workspace } from "@/lib/types";

type Point = { x: number; y: number };
type Highlight = "focus" | "up" | "down" | "picked" | "dim" | "match" | undefined;

interface MapNodeData extends Record<string, unknown> {
  node: MapNode;
  highlight: Highlight;
  level?: number;
  open: boolean;
}

const MapActions = createContext<{
  toggle: (id: string) => void;
  names: (ids: string[]) => { id: string; name: string; typeId: string; componentId?: string }[];
}>({
  toggle: () => undefined,
  names: () => [],
});

const DiagramMapNode = memo(function DiagramMapNode({ data }: NodeProps<Node<MapNodeData>>) {
  const { node, highlight, level, open } = data;
  const actions = useContext(MapActions);
  const color = categoryColor[node.category];
  const shown = open ? actions.names(node.linked) : [];
  return (
    <div className="map-node" data-map-node={node.diagram.id} data-highlight={highlight} style={{ ["--node-color" as string]: color }}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="flex items-start gap-2">
        <span className="map-node__icon">
          <TypeIcon typeId="diagram" size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="map-node__name" title={node.diagram.name}>
            {node.diagram.name}
          </span>
          <span className="map-node__meta">
            {kindLabel(node.diagram)} · {node.objects} {node.objects === 1 ? "box" : "boxes"}
          </span>
        </span>
        {level !== undefined && <span className="map-node__level">L{level}</span>}
      </div>
      {node.linked.length > 0 && (
        <button
          type="button"
          className="nodrag map-node__toggle"
          data-map-toggle={node.diagram.id}
          onClick={(e) => {
            e.stopPropagation();
            actions.toggle(node.diagram.id);
          }}
        >
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {node.linked.length} linked {node.linked.length === 1 ? "component" : "components"}
        </button>
      )}
      {open && (
        <ul className="map-node__list" data-map-components={node.diagram.id}>
          {shown.slice(0, 12).map((o) => (
            <li key={o.id} className="flex items-center gap-1.5">
              <TypeIcon typeId={o.typeId} componentId={o.componentId} size={12} />
              <span className="truncate">{o.name}</span>
            </li>
          ))}
          {shown.length > 12 && <li className="text-ink-faint">and {shown.length - 12} more</li>}
        </ul>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});

const nodeTypes = { diagramMap: DiagramMapNode };

const positionsKey = (ws: Workspace) => `archone.map.positions.${ws.name}`;
function loadPositions(ws: Workspace): Record<string, Point> {
  try {
    return JSON.parse(localStorage.getItem(positionsKey(ws)) ?? "{}") as Record<string, Point>;
  } catch {
    return {};
  }
}
function keepPositions(ws: Workspace, positions: Record<string, Point>) {
  try {
    localStorage.setItem(positionsKey(ws), JSON.stringify(positions));
  } catch {
    // Not kept in this browser; the map still works.
  }
}

/**
 * Every diagram on one map: what depends on what, which diagrams share components, how far an
 * outage of one travels, and how a few chosen diagrams connect. Exports what is shown.
 */
export function MapPage() {
  return (
    <ReactFlowProvider>
      <DiagramMapView />
    </ReactFlowProvider>
  );
}

function DiagramMapView() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const flow = useReactFlow();
  const full = useMemo(() => diagramMap(ws), [ws]);
  const frame = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<string[]>([]);
  const [categories, setCategories] = useState<Category[]>([...CATEGORIES]);
  const [showDepends, setShowDepends] = useState(true);
  const [showShared, setShowShared] = useState(true);
  const [onlySelected, setOnlySelected] = useState(false);
  const [query, setQuery] = useState("");
  const [levels, setLevels] = useState(5);
  const [fullScreen, setFullScreen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState("");

  // What is shown: the categories chosen, and, when asked, only the diagrams picked.
  const shown: DiagramMap = useMemo(() => {
    const keep = new Set(
      full.nodes
        .filter((n) => categories.includes(n.category))
        .filter((n) => !onlySelected || !selected.length || selected.includes(n.diagram.id))
        .map((n) => n.diagram.id),
    );
    return {
      nodes: full.nodes.filter((n) => keep.has(n.diagram.id)),
      links: full.links.filter((l) => keep.has(l.from) && keep.has(l.to) && (l.kind === "depends" ? showDepends : showShared)),
    };
  }, [full, categories, onlySelected, selected, showDepends, showShared]);

  const [positions, setPositions] = useState<Record<string, Point>>(() => {
    const saved = loadPositions(ws);
    const laid = mapLayout(diagramMap(ws));
    return { ...laid, ...saved };
  });
  // New diagrams get a place next to the others.
  useEffect(() => {
    const missing = full.nodes.filter((n) => !positions[n.diagram.id]);
    if (!missing.length) return;
    const laid = mapLayout(full);
    setPositions((p) => ({
      ...Object.fromEntries(missing.map((n) => [n.diagram.id, laid[n.diagram.id]])),
      ...p,
    }));
  }, [full, positions]);

  // The flow measures each box; the map keeps the sizes so fitting and the minimap see them.
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const focus = selected.length === 1 ? selected[0] : null;
  const reach = useMemo(() => {
    if (!focus) return null;
    return {
      needs: mapReach(full, focus, "needs", levels),
      neededBy: mapReach(full, focus, "neededBy", levels),
    };
  }, [full, focus, levels]);
  const q = query.trim().toLowerCase();

  const nodes: Node<MapNodeData>[] = useMemo(
    () =>
      shown.nodes.map((n) => {
        const id = n.diagram.id;
        let highlight: Highlight;
        let level: number | undefined;
        if (reach && focus) {
          if (id === focus) highlight = "focus";
          else if (reach.neededBy.has(id)) {
            highlight = "down";
            level = reach.neededBy.get(id);
          } else if (reach.needs.has(id)) {
            highlight = "up";
            level = reach.needs.get(id);
          } else highlight = "dim";
        } else if (selected.length > 1) highlight = selected.includes(id) ? "picked" : "dim";
        if (q) highlight = n.diagram.name.toLowerCase().includes(q) ? "match" : "dim";
        return {
          id,
          type: "diagramMap",
          position: positions[id] ?? { x: 0, y: 0 },
          data: { node: n, highlight, level, open: open.includes(id) },
          zIndex: open.includes(id) ? 10 : 1,
          measured: sizes[id],
        };
      }),
    [shown, positions, reach, focus, selected, q, open, sizes],
  );

  const between = useMemo(() => {
    if (selected.length < 2) return new Set<string>();
    const ids = new Set(linksAmong(full, selected).map((l) => l.id));
    for (let i = 0; i < selected.length; i++) for (let j = i + 1; j < selected.length; j++) for (const l of mapPath(full, selected[i], selected[j])) ids.add(l.id);
    return ids;
  }, [full, selected]);

  const edges: Edge[] = useMemo(() => {
    // Where two diagrams both depend and share, one line says both.
    const pair = (l: MapLink) => [l.from, l.to].sort().join("|");
    const dependsPairs = new Set(shown.links.filter((l) => l.kind === "depends").map(pair));
    const sharedBy = new Map(shown.links.filter((l) => l.kind === "shared").map((l) => [pair(l), l.shared.length]));
    return shown.links
      .filter((l) => l.kind === "depends" || !dependsPairs.has(pair(l)))
      .map((l) => {
        const lit =
          (focus &&
            reach &&
            ((l.kind === "depends" && (l.to === focus || reach.neededBy.has(l.to)) && (l.from === focus || reach.neededBy.has(l.from))) ||
              (l.kind === "depends" && (l.from === focus || reach.needs.has(l.from)) && (l.to === focus || reach.needs.has(l.to))))) ||
          between.has(l.id);
        const faded = (focus || selected.length > 1) && !lit;
        const color = l.kind === "shared" ? "#9AA5B8" : lit ? "var(--color-signal)" : "var(--color-blueprint)";
        return {
          id: l.id,
          source: l.from,
          target: l.to,
          type: l.kind === "shared" ? "straight" : "default",
          animated: l.kind === "depends",
          label: l.kind === "depends" && sharedBy.get(pair(l)) ? `${linkLabel(ws, l)} · ${sharedBy.get(pair(l))} shared` : linkLabel(ws, l),
          data: { kind: l.kind },
          className: cx("map-edge", `map-edge-${l.kind}`, lit && "map-edge-lit", faded && "map-edge-faded"),
          style: {
            stroke: color,
            strokeWidth: lit ? 2.4 : 1.4,
            strokeDasharray: l.kind === "shared" ? "2 5" : undefined,
            opacity: faded ? 0.25 : 1,
          },
          markerEnd:
            l.kind === "depends"
              ? {
                  type: MarkerType.ArrowClosed,
                  color: lit ? "#E0662B" : "#2447D6",
                  width: 16,
                  height: 16,
                }
              : undefined,
          labelStyle: { fontSize: 11, fill: "#5B6779" },
          labelBgStyle: { fill: "#FFFFFF", fillOpacity: 0.9 },
          labelBgPadding: [4, 2] as [number, number],
        };
      });
  }, [shown, ws, focus, reach, between, selected.length]);

  const onNodesChange = useCallback((changes: NodeChange<Node<MapNodeData>>[]) => {
    const moved: Record<string, Point> = {};
    const measured: Record<string, { width: number; height: number }> = {};
    for (const c of changes) {
      if (c.type === "position" && c.position) moved[c.id] = { x: Math.round(c.position.x), y: Math.round(c.position.y) };
      if (c.type === "dimensions" && c.dimensions) measured[c.id] = c.dimensions;
    }
    if (Object.keys(moved).length) setPositions((p) => ({ ...p, ...moved }));
    if (Object.keys(measured).length) setSizes((m) => ({ ...m, ...measured }));
  }, []);

  // Keep what the person arranged, once they let go.
  const savePositions = () => setPositions((p) => (keepPositions(ws, p), p));

  const resetLayout = () => {
    const laid = mapLayout(shown);
    setPositions((p) => {
      const next = { ...p, ...laid };
      keepPositions(ws, next);
      return next;
    });
    setTimeout(() => void flow.fitView({ padding: 0.12, duration: 250, maxZoom: 1 }), 60);
  };

  useEffect(() => {
    const t = setTimeout(() => void flow.fitView({ padding: 0.12, duration: 200, maxZoom: 1 }), 80);
    return () => clearTimeout(t);
  }, [shown.nodes.length, onlySelected, flow]);

  useEffect(() => {
    const onChange = () => {
      setFullScreen(document.fullscreenElement === frame.current);
      setTimeout(() => void flow.fitView({ padding: 0.12, duration: 200, maxZoom: 1 }), 120);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [flow]);
  const toggleFullScreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await frame.current?.requestFullscreen();
    } catch {
      // Full screen is not allowed here; the map stays as it is.
    }
  };

  const pick = (id: string, add: boolean) => setSelected((s) => (add ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : s.length === 1 && s[0] === id ? [] : [id]));
  const names = useCallback(
    (ids: string[]) =>
      ids
        .map((id) => ws.objects[id])
        .filter(Boolean)
        .map((o) => ({
          id: o.id,
          name: o.name,
          typeId: o.typeId,
          componentId: o.componentId,
        })),
    [ws],
  );
  const actions = useMemo(
    () => ({
      toggle: (id: string) => setOpen((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id])),
      names,
    }),
    [names],
  );

  const stamp = new Date().toISOString().slice(0, 10);
  const file = `all-diagrams-${stamp}`;
  const run = async (label: string, job: () => Promise<void> | void) => {
    setBusy(label);
    try {
      await job();
    } finally {
      setBusy("");
      setExporting(false);
    }
  };
  const container = () => frame.current?.querySelector<HTMLElement>(".react-flow") ?? null;
  const exports: {
    id: string;
    label: string;
    hint: string;
    job: () => Promise<void> | void;
  }[] = [
    {
      id: "png",
      label: "PNG",
      hint: "A picture of the map as shown",
      job: () => exportPng(container()!, flow.getNodes(), file),
    },
    {
      id: "svg",
      label: "SVG",
      hint: "A picture that stays sharp",
      job: () => exportSvg(container()!, flow.getNodes(), file),
    },
    {
      id: "pdf",
      label: "PDF",
      hint: "A page to print or send",
      job: () => exportPdf(container()!, flow.getNodes(), file, "All diagrams"),
    },
    {
      id: "gif",
      label: "Animated GIF",
      hint: "The dependencies moving",
      job: async () => downloadBlob(`${file}.gif`, await gifBlob(mapPicture(ws, shown, positions))),
    },
    {
      id: "drawio",
      label: "draw.io",
      hint: "To edit in diagrams.net",
      job: () => downloadText(`${file}.drawio`, drawioXml({ id: "all-diagrams", name: "All diagrams" } as Diagram, mapPicture(ws, shown, positions)), "application/xml"),
    },
    {
      id: "mermaid",
      label: "Mermaid",
      hint: "A text flowchart",
      job: () => downloadText(`${file}.mmd`, mapMermaid(ws, shown)),
    },
    {
      id: "csv",
      label: "CSV",
      hint: "Every link, for a spreadsheet",
      job: () => downloadText(`${file}.csv`, toCsv(mapRows(ws, shown)), "text/csv"),
    },
    {
      id: "json",
      label: "JSON",
      hint: "The diagrams and links as data",
      job: () =>
        downloadText(
          `${file}.json`,
          JSON.stringify(
            {
              diagrams: shown.nodes.map((n) => ({
                id: n.diagram.id,
                name: n.diagram.name,
                kind: n.diagram.viewType,
                category: n.category,
                boxes: n.objects,
                linkedComponents: n.linked.map((id) => ws.objects[id]?.name),
              })),
              links: shown.links.map((l) => ({
                from: ws.diagrams[l.from]?.name,
                to: ws.diagrams[l.to]?.name,
                kind: l.kind,
                protocols: l.protocols,
                through:
                  l.kind === "shared"
                    ? l.shared.map((id) => ws.objects[id]?.name)
                    : l.reasons.map((r) => ({
                        from: ws.objects[r.from]?.name,
                        to: ws.objects[r.to]?.name,
                        kind: r.kind,
                      })),
              })),
            },
            null,
            2,
          ),
          "application/json",
        ),
    },
  ];

  const toggleCategory = (c: Category) => setCategories((list) => (list.includes(c) ? list.filter((x) => x !== c) : [...list, c]));

  return (
    <div className="flex h-full min-h-0" data-map-page>
      <div ref={frame} className={cx("relative flex min-w-0 flex-1 flex-col bg-paper", fullScreen && "h-screen")}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2.5">
          <h1 className="mr-2 text-base font-semibold">All diagrams</h1>
          <div className="relative w-56">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
            <Input className="pl-8 h-8" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a diagram" aria-label="Find a diagram" />
          </div>
          <span className="flex flex-wrap gap-1" role="group" aria-label="Kinds shown">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={categories.includes(c)}
                data-map-category={c}
                onClick={() => toggleCategory(c)}
                className={cx(
                  "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs",
                  categories.includes(c) ? "border-line bg-surface text-ink" : "border-dashed border-line text-ink-faint",
                )}
              >
                <span
                  className="size-2 rounded-full"
                  style={{
                    background: categories.includes(c) ? categoryColor[c] : "transparent",
                    border: `1px solid ${categoryColor[c]}`,
                  }}
                />
                {categoryLabel(c)}
              </button>
            ))}
          </span>
          <span className="flex gap-3 text-[13px] text-ink-soft">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={showDepends} onChange={(e) => setShowDepends(e.target.checked)} data-map-show="depends" /> Dependencies
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={showShared} onChange={(e) => setShowShared(e.target.checked)} data-map-show="shared" /> Shared components
            </label>
            <label className={cx("flex items-center gap-1.5", !selected.length && "opacity-50")}>
              <input type="checkbox" checked={onlySelected} disabled={!selected.length} onChange={(e) => setOnlySelected(e.target.checked)} data-map-only-selected /> Only the ones picked
            </label>
          </span>
          <span className="ml-auto flex gap-1.5">
            <Button size="sm" icon={<RotateCcw size={13} />} onClick={resetLayout} data-map-reset>
              Reset layout
            </Button>
            <Button size="sm" icon={fullScreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />} onClick={toggleFullScreen} data-map-fullscreen>
              {fullScreen ? "Leave full screen" : "Full screen"}
            </Button>
            <span className="relative">
              <Button size="sm" icon={<Download size={13} />} onClick={() => setExporting((e) => !e)} data-map-export-open aria-expanded={exporting}>
                {busy ? `Making ${busy}…` : "Export"}
              </Button>
              {exporting && (
                <div className="absolute right-0 top-9 z-30 w-64 rounded-lg border border-line bg-surface p-1.5 shadow-lg" role="menu" data-map-export-menu>
                  {exports.map((x) => (
                    <button
                      key={x.id}
                      type="button"
                      role="menuitem"
                      data-map-export={x.id}
                      disabled={!!busy || !shown.nodes.length}
                      onClick={() => void run(x.label, x.job)}
                      className="block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-paper disabled:opacity-50"
                    >
                      <span className="block text-[13px] font-medium">{x.label}</span>
                      <span className="block text-xs text-ink-faint">{x.hint}</span>
                    </button>
                  ))}
                  <p className="px-2.5 pt-1 text-[11px] text-ink-faint">Exports what the map shows now.</p>
                </div>
              )}
            </span>
          </span>
        </div>
        <div className="relative min-h-0 flex-1" style={{ minHeight: 480 }}>
          {!full.nodes.length ? (
            <div className="grid h-full place-items-center text-ink-soft">
              <p>
                No diagrams yet.{" "}
                <Link to="/" className="text-blueprint hover:underline">
                  Make one
                </Link>
                , and it appears here with its links to the others.
              </p>
            </div>
          ) : (
            <MapActions.Provider value={actions}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onNodeDragStop={savePositions}
                onNodeClick={(event, node) => pick(node.id, event.shiftKey || event.ctrlKey || event.metaKey)}
                onNodeDoubleClick={(_, node) => navigate(`/diagram/${node.id}`)}
                onPaneClick={() => setSelected([])}
                nodesConnectable={false}
                elementsSelectable={false}
                zoomOnDoubleClick={false}
                minZoom={0.1}
                maxZoom={2}
                fitView
                fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
              >
                <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#c3cbd8" />
                <Controls showInteractive={false} position="bottom-left" />
                <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => categoryColor[(n.data as MapNodeData).node.category]} maskColor="rgba(243,245,248,0.7)" />
              </ReactFlow>
            </MapActions.Provider>
          )}
          <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-surface/90 px-2.5 py-1.5 text-xs text-ink-soft shadow-sm">
            Click a diagram to see what it depends on and what it impacts. Shift-click to pick several. Double-click to open.
          </div>
        </div>
      </div>
      {!fullScreen && (
        <MapPanel
          ws={ws}
          map={full}
          selected={selected}
          reach={reach}
          levels={levels}
          setLevels={setLevels}
          onPick={(id) => setSelected([id])}
          onClear={() => {
            setSelected([]);
            setOnlySelected(false);
          }}
          onDrop={(id) => setSelected((s) => s.filter((x) => x !== id))}
        />
      )}
    </div>
  );
}

/* ---------- the panel beside the map ---------- */

function MapPanel({
  ws,
  map,
  selected,
  reach,
  levels,
  setLevels,
  onPick,
  onClear,
  onDrop,
}: {
  ws: Workspace;
  map: DiagramMap;
  selected: string[];
  reach: { needs: Map<string, number>; neededBy: Map<string, number> } | null;
  levels: number;
  setLevels: (n: number) => void;
  onPick: (id: string) => void;
  onClear: () => void;
  onDrop: (id: string) => void;
}) {
  const name = (id: string) => ws.diagrams[id]?.name ?? "A diagram";
  const obj = (id: string) => ws.objects[id]?.name ?? "?";
  const DiagramButton = ({ id }: { id: string }) => (
    <button type="button" className="font-medium text-blueprint hover:underline text-left" onClick={() => onPick(id)}>
      {name(id)}
    </button>
  );
  const LinkDetails = ({ link }: { link: MapLink }) =>
    link.kind === "shared" ? (
      <span className="block text-xs text-ink-soft">
        Both show {link.shared.map(obj).slice(0, 6).join(", ")}
        {link.shared.length > 6 ? ` and ${link.shared.length - 6} more` : ""}
      </span>
    ) : (
      <span className="block text-xs text-ink-soft">
        {link.reasons
          .slice(0, 4)
          .map((r) => (r.kind === "shown as a box" ? `${obj(r.from)} is a box on it` : `${obj(r.from)} ${r.kind.toLowerCase()} ${obj(r.to)}`))
          .join(" · ")}
        {link.reasons.length > 4 ? ` · and ${link.reasons.length - 4} more` : ""}
        {link.protocols.length ? <span className="block text-ink-faint">Protocols: {link.protocols.join(", ")}</span> : null}
      </span>
    );

  let body: React.ReactNode;
  if (!selected.length) {
    const incoming = new Map<string, number>();
    for (const l of map.links) if (l.kind === "depends") incoming.set(l.to, (incoming.get(l.to) ?? 0) + 1);
    const top = [...incoming].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const alone = map.nodes.filter((n) => !map.links.some((l) => l.from === n.diagram.id || l.to === n.diagram.id));
    body = (
      <>
        <div className="grid grid-cols-3 gap-2" data-map-summary>
          <Count label="Diagrams" value={map.nodes.length} />
          <Count label="Depend on another" value={map.links.filter((l) => l.kind === "depends").length} />
          <Count label="Share components" value={map.links.filter((l) => l.kind === "shared").length} />
        </div>
        <PanelSection title="Most depended on">
          {!top.length && <p className="text-[13px] text-ink-soft">No diagram depends on another yet.</p>}
          <ul className="space-y-1">
            {top.map(([id, n]) => (
              <li key={id} className="flex items-center justify-between text-[13px]">
                <DiagramButton id={id} />
                <span className="text-xs text-ink-faint">{n} depend on it</span>
              </li>
            ))}
          </ul>
        </PanelSection>
        <PanelSection title="Standing alone">
          {!alone.length ? (
            <p className="text-[13px] text-ink-soft">Every diagram is linked to another.</p>
          ) : (
            <ul className="space-y-1 text-[13px]">
              {alone.map((n) => (
                <li key={n.diagram.id}>
                  <DiagramButton id={n.diagram.id} />
                </li>
              ))}
            </ul>
          )}
        </PanelSection>
      </>
    );
  } else if (selected.length === 1 && reach) {
    const id = selected[0];
    const node = map.nodes.find((n) => n.diagram.id === id);
    const out = map.links.filter((l) => l.kind === "depends" && l.from === id);
    const inn = map.links.filter((l) => l.kind === "depends" && l.to === id);
    const shared = map.links.filter((l) => l.kind === "shared" && (l.from === id || l.to === id));
    const byLevel = (m: Map<string, number>) => Array.from({ length: levels }, (_, i) => [...m].filter(([, l]) => l === i + 1).map(([d]) => d));
    body = (
      <>
        <div>
          <p className="text-xs text-ink-faint">{node ? `${categoryLabel(node.category)} · ${kindLabel(node.diagram)} · ${node.objects} boxes` : ""}</p>
          <h2 className="text-base font-semibold" data-map-selected={id}>
            {name(id)}
          </h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Link to={`/diagram/${id}`} className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-xs hover:border-blueprint">
              <ExternalLink size={12} /> Open
            </Link>
            <Link to={`/impact?diagram=${id}`} className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-xs hover:border-blueprint" data-map-impact-link>
              <Zap size={12} /> Impact analysis
            </Link>
            <Link to={`/impact?diagram=${id}&tab=whatif`} className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-xs hover:border-blueprint">
              What if it stops
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-[13px] text-ink-soft">
          Levels
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={levels === n}
              data-map-levels={n}
              onClick={() => setLevels(n)}
              className={cx("h-6 w-6 rounded border text-xs", levels === n ? "border-blueprint bg-blueprint text-white" : "border-line")}
            >
              {n}
            </button>
          ))}
        </div>
        <PanelSection title={`Impacts (${reach.neededBy.size})`} tone="down">
          {!reach.neededBy.size && <p className="text-[13px] text-ink-soft">No other diagram depends on it.</p>}
          {byLevel(reach.neededBy).map((list, i) =>
            list.length ? (
              <p key={i} className="text-[13px]" data-map-impact-level={i + 1}>
                <span className="mr-1 text-xs text-ink-faint">L{i + 1}</span>
                {list.map((d, j) => (
                  <span key={d}>
                    {j > 0 && ", "}
                    <DiagramButton id={d} />
                  </span>
                ))}
              </p>
            ) : null,
          )}
        </PanelSection>
        <PanelSection title={`Depends on (${reach.needs.size})`} tone="up">
          {!reach.needs.size && <p className="text-[13px] text-ink-soft">It depends on no other diagram.</p>}
          {byLevel(reach.needs).map((list, i) =>
            list.length ? (
              <p key={i} className="text-[13px]">
                <span className="mr-1 text-xs text-ink-faint">L{i + 1}</span>
                {list.map((d, j) => (
                  <span key={d}>
                    {j > 0 && ", "}
                    <DiagramButton id={d} />
                  </span>
                ))}
              </p>
            ) : null,
          )}
        </PanelSection>
        <PanelSection title="Direct links">
          <ul className="space-y-2">
            {out.map((l) => (
              <li key={l.id} className="text-[13px]">
                Needs <DiagramButton id={l.to} />
                <LinkDetails link={l} />
              </li>
            ))}
            {inn.map((l) => (
              <li key={l.id} className="text-[13px]">
                Needed by <DiagramButton id={l.from} />
                <LinkDetails link={l} />
              </li>
            ))}
            {shared.map((l) => (
              <li key={l.id} className="text-[13px]">
                Shares with <DiagramButton id={l.from === id ? l.to : l.from} />
                <LinkDetails link={l} />
              </li>
            ))}
            {!out.length && !inn.length && !shared.length && <li className="text-[13px] text-ink-soft">None.</li>}
          </ul>
        </PanelSection>
      </>
    );
  } else {
    const among = linksAmong(map, selected);
    const pairs: { a: string; b: string; path: MapLink[] }[] = [];
    for (let i = 0; i < selected.length; i++)
      for (let j = i + 1; j < selected.length; j++) {
        const a = selected[i];
        const b = selected[j];
        if (among.some((l) => (l.from === a && l.to === b) || (l.from === b && l.to === a))) continue;
        pairs.push({ a, b, path: mapPath(map, a, b) });
      }
    body = (
      <>
        <PanelSection title={`Picked (${selected.length})`}>
          <ul className="flex flex-wrap gap-1.5" data-map-picked={selected.length}>
            {selected.map((id) => (
              <li key={id} className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs">
                {name(id)}
                <button type="button" aria-label={`Take ${name(id)} out`} onClick={() => onDrop(id)}>
                  <X size={11} />
                </button>
              </li>
            ))}
          </ul>
        </PanelSection>
        <PanelSection title={`Links between them (${among.length})`}>
          {!among.length && <p className="text-[13px] text-ink-soft">None directly.</p>}
          <ul className="space-y-2" data-map-between={among.length}>
            {among.map((l) => (
              <li key={l.id} className="text-[13px]">
                <DiagramButton id={l.from} /> {l.kind === "depends" ? "needs" : "shares with"} <DiagramButton id={l.to} />
                <LinkDetails link={l} />
              </li>
            ))}
          </ul>
        </PanelSection>
        {pairs.length > 0 && (
          <PanelSection title="Connected through others">
            <ul className="space-y-2">
              {pairs.map(({ a, b, path }) => (
                <li key={`${a}-${b}`} className="text-[13px]">
                  {path.length ? (
                    <>
                      <span className="font-medium">{name(a)}</span> to <span className="font-medium">{name(b)}</span> in {path.length} steps:
                      <span className="block text-xs text-ink-soft">{pathNames(path, a).map(name).join(" → ")}</span>
                    </>
                  ) : (
                    <span className="text-ink-soft">
                      {name(a)} and {name(b)} are not connected within five steps.
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </PanelSection>
        )}
      </>
    );
  }

  return (
    <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-line bg-surface px-4 py-4 space-y-4" aria-label="Map details" data-map-panel>
      {selected.length > 0 && (
        <button type="button" onClick={onClear} className="float-right text-xs text-ink-soft hover:text-ink" data-map-clear>
          Clear
        </button>
      )}
      {body}
      <div className="border-t border-line-soft pt-3 text-xs text-ink-faint space-y-1">
        <p>
          <span className="mr-1 inline-block h-0.5 w-6 align-middle bg-blueprint" /> depends on: the arrow points to what is needed, and moves with the traffic.
        </p>
        <p>
          <span className="mr-1 inline-block w-6 align-middle border-t border-dashed border-ink-faint" /> shares components with.
        </p>
        <p>
          <Badge tone="amber">impacted</Badge> <Badge tone="green">depended on</Badge> when one diagram is picked.
        </p>
      </div>
    </aside>
  );
}

/** The diagrams along a path, from the first. */
function pathNames(path: MapLink[], from: string): string[] {
  const out = [from];
  let at = from;
  for (const l of path) {
    at = l.from === at ? l.to : l.from;
    out.push(at);
  }
  return out;
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-line px-2 py-1.5">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] leading-tight text-ink-soft">{label}</div>
    </div>
  );
}

function PanelSection({ title, tone, children }: { title: string; tone?: "up" | "down"; children: React.ReactNode }) {
  return (
    <section>
      <h3 className={cx("mb-1 text-[13px] font-semibold", tone === "down" && "text-signal", tone === "up" && "text-[#0e8a7d]")}>{title}</h3>
      {children}
    </section>
  );
}

/** The map as a picture drawn from the model, for the animated and draw.io exports. */
export function mapPicture(ws: Workspace, map: DiagramMap, positions: Record<string, Point>): Picture {
  const PAD = 40;
  const at = (id: string) => positions[id] ?? { x: 0, y: 0 };
  const xs = map.nodes.map((n) => at(n.diagram.id).x);
  const ys = map.nodes.map((n) => at(n.diagram.id).y);
  const minX = Math.min(...xs, 0);
  const minY = Math.min(...ys, 0);
  const place = (id: string) => ({
    x: at(id).x - minX + PAD,
    y: at(id).y - minY + PAD,
  });
  const nodes = map.nodes.map((n) => {
    const p = place(n.diagram.id);
    return {
      id: n.diagram.id,
      x: p.x,
      y: p.y,
      w: NODE_W,
      h: NODE_H,
      name: n.diagram.name,
      subtitle: `${kindLabel(n.diagram)} · ${n.objects} boxes`,
      color: categoryColor[n.category],
      details: [
        { label: "Kind", value: kindLabel(n.diagram) },
        {
          label: "Linked components",
          value: n.linked.map((id) => ws.objects[id]?.name).join(", "),
        },
      ],
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = map.links
    .filter((l) => byId.has(l.from) && byId.has(l.to))
    .map((l) => {
      const a = byId.get(l.from)!;
      const b = byId.get(l.to)!;
      const [x1, y1] = border(a.x + a.w / 2, a.y + a.h / 2, a.w, a.h, b.x + b.w / 2, b.y + b.h / 2);
      const [x2, y2] = border(b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, a.x + a.w / 2, a.y + a.h / 2);
      return {
        id: l.id,
        from: l.from,
        to: l.to,
        x1,
        y1,
        x2,
        y2,
        label: linkLabel(ws, l),
        kind: l.kind,
        flow: "out" as const,
      };
    });
  return {
    title: "All diagrams",
    width: Math.max(...nodes.map((n) => n.x + n.w), 200) + PAD,
    height: Math.max(...nodes.map((n) => n.y + n.h), 120) + PAD,
    nodes,
    edges,
    boundary: null,
    zones: [],
    flows: [],
  };
}
