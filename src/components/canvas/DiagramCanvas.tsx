import { archimateArrow, archimateElement, bpmnArrow, bpmnShape } from "@/lib/notation";
import type { Notation } from "@/lib/types";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  getSmoothStepPath,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { MessageSquare } from "lucide-react";
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type DragEvent, type Ref } from "react";
import { TypeIcon } from "@/components/icons";
import { LIFECYCLE_INFO, RELATION_KIND_INFO, objectType, ownerColor, typeColor } from "@/lib/catalog";
import { NODE_H, NODE_W, boundsOf } from "@/lib/layout";
import { childrenOf } from "@/lib/model";
import type { Diagram, ModelObject, Workspace } from "@/lib/types";
import { scopeMembers, visibleEdges } from "@/lib/views";

export type Highlight = "focus" | "up" | "down" | "dim";
export type DragItem = { kind: "type"; id: string } | { kind: "object"; id: string };
export const DRAG_MIME = "application/x-archone-item";

export interface CanvasHandle {
  nodes: () => Node[];
  element: () => HTMLElement | null;
  fit: () => void;
  /**
   * A large diagram draws only the boxes in view. Before taking a picture of all of it, ask
   * for the whole diagram and wait; afterwards hand it back.
   */
  whole: (on: boolean) => Promise<void>;
}

/** From this many boxes on, only what is in view is drawn. */
export const LARGE_DIAGRAM = 150;

export interface CanvasSelection {
  objectId: string | null;
  edgeId: string | null;
}

interface Props {
  ws: Workspace;
  diagram: Diagram;
  readOnly?: boolean;
  selection?: CanvasSelection;
  /** Boxes picked together with Shift, to arrange or move as a group. When set, these are the selected ones. */
  picked?: string[];
  highlight?: Record<string, Highlight>;
  /** One step of a flow: these boxes and arrows are brought forward and the rest is dimmed. Wins over `highlight`. */
  spotlight?: { nodes: string[]; edges: string[] } | null;
  /** Open comment threads per object, drawn as a small marker on the box. */
  comments?: Record<string, number>;
  minimap?: boolean;
  /** Draw every box even on a large diagram, for a canvas that exists to be photographed. */
  renderAll?: boolean;
  onSelect?: (selection: CanvasSelection) => void;
  /** A Shift-click on a box. */
  onPick?: (objectId: string) => void;
  onMove?: (positions: Record<string, { x: number; y: number }>) => void;
  onConnect?: (sourceId: string, targetId: string) => void;
  onDropItem?: (item: DragItem, position: { x: number; y: number }) => void;
  onOpen?: (objectId: string) => void;
  onRemove?: (objectIds: string[]) => void;
  canvasRef?: Ref<CanvasHandle>;
}

type ObjectNodeData = {
  notation?: Notation;
  object: ModelObject;
  color: string;
  childCount: number;
  direction: "TB" | "LR";
  highlight?: Highlight;
  comments?: number;
  onOpen?: (objectId: string) => void;
};

const BOUNDARY_ID = "__boundary";
const lifecycleTone = { planned: "#2447d6", active: "#1f8a4c", deprecated: "#c97a0a", retired: "#b4321f" } as const;

const ObjectNode = memo(function ObjectNode({ data }: NodeProps<Node<ObjectNodeData>>) {
  const { object, color, childCount, direction, highlight, comments, onOpen, notation } = data;
  const type = objectType(object.typeId);
  const archimate = notation === "archimate" ? archimateElement(object.typeId) : null;
  const bpmn = notation === "bpmn" ? bpmnShape(object.typeId) : null;
  const drafted = object.provenance.origin === "ai-prompt" || object.provenance.origin === "ai-image";
  return (
    <div className="object-node" data-highlight={highlight} data-notation={notation && notation !== "plain" ? notation : undefined} data-layer={archimate?.layer} data-shape={bpmn?.shape} style={{ ["--node-color" as string]: color }}>
      <Handle type="target" position={direction === "TB" ? Position.Top : Position.Left} />
      <span className="object-node__icon">
        <TypeIcon typeId={object.typeId} size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="object-node__name" title={object.name}>
          {object.name}
        </div>
        <div className="object-node__meta">
          <span>{archimate?.name ?? bpmn?.name ?? type.label}</span>
          {object.technology && <span className="object-node__tech">{object.technology}</span>}
        </div>
      </div>
      <div className="object-node__corner">
        {!!comments && (
          <span
            title={`${comments} open ${comments === 1 ? "comment" : "comments"}`}
            className="object-node__comments inline-flex items-center gap-0.5 h-[18px] px-1.5 rounded-[9px] bg-blueprint text-white text-[11px] font-semibold leading-[18px]"
          >
            <MessageSquare size={10} strokeWidth={2.5} aria-hidden />
            {comments}
          </span>
        )}
        {drafted && (
          <span
            title={`Drafted by AI, approved by ${object.provenance.approvedBy ?? "a reviewer"}`}
            className="h-[18px] px-1.5 rounded-[9px] bg-signal-soft text-signal text-[11px] font-medium leading-[18px] border border-signal/30"
          >
            AI draft
          </span>
        )}
        {object.lifecycle !== "active" && (
          <span
            className="h-[18px] px-1.5 rounded-[9px] bg-surface text-[11px] font-medium leading-[17px] border"
            style={{ color: lifecycleTone[object.lifecycle], borderColor: lifecycleTone[object.lifecycle] }}
          >
            {LIFECYCLE_INFO[object.lifecycle].label}
          </span>
        )}
      </div>
      {childCount > 0 && onOpen && (
        <button
          type="button"
          className="object-node__inside nodrag"
          title={`Open the diagram of what is inside ${object.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(object.id);
          }}
        >
          {childCount} inside
        </button>
      )}
      <Handle type="source" position={direction === "TB" ? Position.Bottom : Position.Right} />
    </div>
  );
});

const BoundaryNode = memo(function BoundaryNode({ data }: NodeProps<Node<{ label: string }>>) {
  return (
    <div className="boundary-node">
      <span className="boundary-node__label">{data.label}</span>
    </div>
  );
});

/**
 * An arrow whose label sits next to its arrowhead, in a layer above all lines.
 * Arrows that fan out from one box share their first stretch, so a label in the middle of the
 * line would collide with its siblings; the last stretch belongs to one arrow only.
 */
const LabelledEdge = memo(function LabelledEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerStart,
  markerEnd,
  style,
  label,
  data,
  selected,
  interactionWidth,
}: EdgeProps<Edge<{ slot: number; dim?: boolean }>>) {
  const [path] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 8 });
  const slot = data?.slot ?? 0;
  const vertical = targetPosition === Position.Top;
  // Top-to-bottom: centred on the final drop. Left-to-right: resting on the final run, right-aligned to the arrowhead.
  const transform = vertical
    ? `translate(-50%, -50%) translate(${targetX}px, ${targetY - 27 - slot * 19}px)`
    : `translate(-100%, -100%) translate(${targetX - 20}px, ${targetY - 5 - slot * 19}px)`;
  return (
    <>
      <BaseEdge id={id} path={path} markerStart={markerStart} markerEnd={markerEnd} style={style} interactionWidth={interactionWidth} />
      {label && (
        <EdgeLabelRenderer>
          <div className="edge-label" data-selected={selected || undefined} style={{ transform, opacity: data?.dim ? 0.25 : undefined }}>
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

const nodeTypes = { object: ObjectNode, boundary: BoundaryNode };
const edgeTypes = { labelled: LabelledEdge };

function nodeColor(o: ModelObject, colorBy: Diagram["colorBy"]): string {
  if (colorBy === "lifecycle") return LIFECYCLE_INFO[o.lifecycle].color;
  if (colorBy === "owner") return ownerColor(o.owner);
  return typeColor(o.typeId);
}

function Inner({
  ws,
  diagram,
  readOnly = false,
  selection,
  picked,
  highlight,
  spotlight,
  comments,
  minimap,
  renderAll,
  onSelect,
  onPick,
  onMove,
  onConnect,
  onDropItem,
  onOpen,
  onRemove,
  canvasRef,
}: Props) {
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [connecting, setConnecting] = useState(false);
  const [whole, setWhole] = useState(false);

  const derived = useMemo<Node[]>(() => {
    const list: Node[] = [];
    for (const [id, placement] of Object.entries(diagram.nodes)) {
      const object = ws.objects[id];
      if (!object) continue;
      const data: ObjectNodeData = {
        object,
        color: nodeColor(object, diagram.colorBy),
        notation: diagram.notation,
        childCount: childrenOf(ws, id).length,
        direction: diagram.direction,
        highlight: spotlight ? (spotlight.nodes.includes(id) ? "focus" : "dim") : highlight?.[id],
        comments: comments?.[id],
        onOpen,
      };
      list.push({
        id,
        type: "object",
        position: { x: placement.x, y: placement.y },
        data,
        draggable: !readOnly,
        selected: picked?.length ? picked.includes(id) : selection?.objectId === id,
        width: NODE_W,
        height: NODE_H,
      });
    }
    return list;
  }, [ws, diagram, highlight, spotlight, comments, readOnly, selection?.objectId, picked, onOpen]);

  // React Flow owns positions while a node is being dragged; the store is updated when the drag ends.
  const [nodes, setNodes] = useState<Node[]>(derived);
  useEffect(() => setNodes(derived), [derived]);

  const members = useMemo(() => new Set(scopeMembers(ws, diagram)), [ws, diagram]);
  const scopeName = diagram.scopeId ? ws.objects[diagram.scopeId]?.name : undefined;
  const allNodes = useMemo<Node[]>(() => {
    if (!scopeName || !members.size) return nodes;
    const box = boundsOf(nodes.filter((n) => members.has(n.id)).map((n) => n.position));
    if (!box) return nodes;
    const boundary: Node = {
      id: BOUNDARY_ID,
      type: "boundary",
      position: { x: box.x - 28, y: box.y - 46 },
      data: { label: scopeName },
      style: { width: box.width + 56, height: box.height + 74 },
      width: box.width + 56,
      height: box.height + 74,
      selectable: false,
      draggable: false,
      focusable: false,
      zIndex: -1,
    };
    return [boundary, ...nodes];
  }, [nodes, members, scopeName]);

  const edges = useMemo<Edge[]>(() => {
    // Labelled arrows into the same box stack their labels instead of printing them on top of each other,
    // and several arrows that say the same thing about one box ("hosted on") share a single label.
    const slots = new Map<string, number>();
    const said = new Set<string>();
    const lit = spotlight ? new Set(spotlight.edges) : null;
    return visibleEdges(ws, diagram).map((e) => {
        const inStep = lit?.has(e.id) ?? false;
        const color = inStep ? "#2447d6" : e.implied ? "#93a0b4" : "#5b6b84";
        // In a notation the line itself says what kind of relationship it is.
        const arrow = diagram.notation === "archimate" ? archimateArrow(e.kind) : diagram.notation === "bpmn" ? bpmnArrow(e.kind) : null;
        let text = e.label.trim() || (arrow ? arrow.name : e.kind === "calls" ? "" : RELATION_KIND_INFO[e.kind].verb);
        const repeat = `${e.targetId}|${text}`;
        if (text && !e.implied && said.has(repeat) && selection?.edgeId !== e.id) text = "";
        if (text && !e.implied) said.add(repeat);
        const slot = text ? (slots.get(e.targetId) ?? 0) : 0;
        if (text) slots.set(e.targetId, slot + 1);
        return {
          id: e.id,
          source: e.sourceId,
          target: e.targetId,
          type: "labelled",
          label: text || undefined,
          data: { slot, dim: !!lit && !inStep },
          className: lit ? (inStep ? "flow-edge" : "dim-edge") : undefined,
          animated: inStep,
          ...(arrow
            ? {
                [arrow.reversed ? "markerStart" : "markerEnd"]: { type: arrow.head === "open" ? MarkerType.Arrow : MarkerType.ArrowClosed, width: 16, height: 16, color },
                style: { stroke: color, strokeDasharray: e.implied ? "6 4" : arrow.dashed ? "4 4" : undefined },
              }
            : { markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color }, style: { stroke: color, strokeDasharray: e.implied ? "6 4" : undefined } }),
          selected: selection?.edgeId === e.id,
          deletable: false,
          reconnectable: false,
          interactionWidth: 18,
        };
      });
  }, [ws, diagram, selection?.edgeId, spotlight]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Selection and removal are decided by the page, not by React Flow.
    const kept = changes.filter((c) => c.type === "position" || c.type === "dimensions");
    if (kept.length) setNodes((current) => applyNodeChanges(kept, current));
  }, []);

  useImperativeHandle(
    canvasRef,
    () => ({
      nodes: () => flow.getNodes().filter((n) => n.id !== BOUNDARY_ID),
      element: () => wrapper.current,
      fit: () => void flow.fitView({ padding: 0.08, duration: 200 }),
      whole: async (on) => {
        const count = flow.getNodes().length;
        if (count <= LARGE_DIAGRAM) return;
        setWhole(on);
        if (!on) return;
        // Boxes that were out of view have to be drawn before they can be photographed.
        const started = Date.now();
        do await new Promise((done) => setTimeout(done, 80));
        while (Date.now() - started < 5000 && (wrapper.current?.querySelectorAll(".react-flow__node").length ?? 0) < count);
        await new Promise((done) => setTimeout(done, 120));
      },
    }),
    [flow],
  );

  const handleDrop = (event: DragEvent) => {
    if (readOnly || !onDropItem) return;
    const raw = event.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    event.preventDefault();
    try {
      const item = JSON.parse(raw) as DragItem;
      const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      onDropItem(item, { x: Math.round(point.x - NODE_W / 2), y: Math.round(point.y - NODE_H / 2) });
    } catch {
      // Not one of our drag items.
    }
  };

  return (
    <div ref={wrapper} className="size-full" onDrop={handleDrop} onDragOver={(e) => !readOnly && e.preventDefault()}>
      <ReactFlow
        className={`${readOnly ? "read-only" : ""} ${connecting ? "connecting" : ""}`}
        nodes={allNodes}
        edges={edges}
        onlyRenderVisibleElements={allNodes.length > LARGE_DIAGRAM && !whole && !renderAll}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(event, node) => {
          if (node.id === BOUNDARY_ID) return;
          if (event.shiftKey && onPick) onPick(node.id);
          else onSelect?.({ objectId: node.id, edgeId: null });
        }}
        onEdgeClick={(_, edge) => onSelect?.({ objectId: null, edgeId: edge.id })}
        onPaneClick={() => onSelect?.({ objectId: null, edgeId: null })}
        onNodeDoubleClick={(_, node) => node.id !== BOUNDARY_ID && onOpen?.(node.id)}
        onNodeDragStop={(_, _node, dragged) => {
          const moved: Record<string, { x: number; y: number }> = {};
          for (const n of dragged) if (n.id !== BOUNDARY_ID) moved[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
          if (Object.keys(moved).length) onMove?.(moved);
        }}
        onConnect={(c: Connection) => c.source && c.target && c.source !== c.target && onConnect?.(c.source, c.target)}
        onConnectStart={() => setConnecting(true)}
        onConnectEnd={() => setConnecting(false)}
        onNodesDelete={(deleted) => onRemove?.(deleted.map((n) => n.id).filter((id) => id !== BOUNDARY_ID))}
        nodesConnectable={!readOnly}
        nodesDraggable={!readOnly}
        elementsSelectable
        deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        zoomOnDoubleClick={false}
        minZoom={0.15}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.08, maxZoom: 1.1 }}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#c3cbd8" />
        <Controls showInteractive={false} position="bottom-left" />
        {minimap && <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => (n.id === BOUNDARY_ID ? "transparent" : "#c3cbd8")} maskColor="rgba(243,245,248,0.7)" />}
      </ReactFlow>
    </div>
  );
}

/** The drawing surface. It draws whatever the model and the diagram say; it never holds its own copy of the data. */
export function DiagramCanvas(props: Props) {
  return (
    <ReactFlowProvider key={props.diagram.id}>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
