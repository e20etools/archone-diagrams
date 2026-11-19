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
  Panel,
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
import { ChevronDown, Cable, SquareDashed, MessageSquare, Lock, LockOpen, CircleHelp, ShieldCheck, Pause, Play, RotateCcw, SkipForward, X } from "lucide-react";
import { createPortal } from "react-dom";
import { buildScript, buildStages, scriptTime, type BuildStep } from "@/lib/buildShow";
import { Clock, Hand, Stopped, cardFor, easeInOut, sourceOf, type Point } from "./buildHand";
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type DragEvent, type Ref } from "react";
import { TypeIcon } from "@/components/icons";
import { CATEGORY_INFO, LIFECYCLE_INFO, RELATION_KIND_INFO, objectType, ownerColor, typeColor } from "@/lib/catalog";
import { NODE_H, NODE_W, boundsOf } from "@/lib/layout";
import { zonesOf } from "@/lib/zones";
import { protocolLabel } from "@/lib/library/protocols";
import { componentSubtitle } from "@/lib/library";
import { childrenOf, protocolsOf } from "@/lib/model";
import { SHOW_CHANGES, type ShowChanges } from "@/lib/assistant/show";
import { PACKS, runChecks, type PackId } from "@/lib/checks/checks";
import { PROTECTION_INFO, TRUST_INFO, classificationOf, findingsByObject, protectionOf, trustOfZone, type BoxFindings, type Protection } from "@/lib/security";
import type { RelationKind } from "@/lib/types";
import type { Diagram, ModelObject, Workspace } from "@/lib/types";
import { scopeMembers, visibleEdges } from "@/lib/views";
import { familyLabel, networkLink, objectNetwork, type NetworkLink } from "@/lib/networkLinks";

export type Highlight = "focus" | "up" | "down" | "dim";
export type DragItem = { kind: "type"; id: string } | { kind: "object"; id: string } | { kind: "component"; id: string };
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
  /** Plays the build animation: the diagram rises from the bottom up. False when there is nothing to build. */
  build: () => boolean;
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
  /** "security": lines coloured by whether they are encrypted, boxes with what the checks find, zones by trust. */
  lens?: "normal" | "security";
  /** Told when the build animation starts and ends. */
  onBuild?: (playing: boolean) => void;
  onSelect?: (selection: CanvasSelection) => void;
  /** A Shift-click on a box. */
  onPick?: (objectId: string) => void;
  onMove?: (positions: Record<string, { x: number; y: number }>) => void;
  onConnect?: (sourceId: string, targetId: string) => void;
  onDropItem?: (item: DragItem, position: { x: number; y: number }) => void;
  onOpen?: (objectId: string) => void;
  /** A double-click on a box; falls back to onOpen when not given. */
  onExplore?: (objectId: string) => void;
  onRemove?: (objectIds: string[]) => void;
  canvasRef?: Ref<CanvasHandle>;
}

type ObjectNodeData = {
  notation?: Notation;
  object: ModelObject;
  /** In the Security view: what the checks find on the box, and how its data is classified. */
  security?: { findings?: BoxFindings; classification: string | null };
  color: string;
  childCount: number;
  direction: "TB" | "LR";
  highlight?: Highlight;
  comments?: number;
  onOpen?: (objectId: string) => void;
};

const BOUNDARY_ID = "__boundary";

/** Each kind of connection has its colour, readable on light and dark canvases alike; a known network wins. */
const KIND_COLOR: Record<RelationKind, string> = {
  calls: "#3e63dd",
  depends_on: "#64748b",
  reads_writes: "#0f8b8d",
  hosted_on: "#94a3b8",
  routes_to: "#5b5bd6",
  replicates_to: "#8b5cf6",
  flows_to: "#64748b",
};
const ALL_PACKS = PACKS.map((p) => p.id) as PackId[];
/** Of several connections drawn as one line, the least protected says how the line is drawn. */
const WORST: Protection[] = ["plain", "unknown", "encrypted"];
const lifecycleTone = { planned: "#2447d6", active: "#1f8a4c", deprecated: "#c97a0a", retired: "#b4321f" } as const;

const ObjectNode = memo(function ObjectNode({ data }: NodeProps<Node<ObjectNodeData>>) {
  const { object, color, childCount, direction, highlight, comments, onOpen, notation, security } = data;
  const type = objectType(object.typeId);
  // A box made from the library says what it is ("Firewall"), not only its type ("Network device").
  const component = componentSubtitle(object);
  const archimate = notation === "archimate" ? archimateElement(object.typeId) : null;
  const bpmn = notation === "bpmn" ? bpmnShape(object.typeId) : null;
  const drafted = object.provenance.origin === "ai-prompt" || object.provenance.origin === "ai-image";
  return (
    <div
      className="object-node"
      data-highlight={highlight}
      data-notation={notation && notation !== "plain" ? notation : undefined}
      data-layer={archimate?.layer}
      data-shape={bpmn?.shape}
      data-kind={object.typeId === "external-system" ? "outside" : object.typeId === "actor" ? "person" : undefined}
      style={{ ["--node-color" as string]: color }}
    >
      <Handle type="target" position={direction === "TB" ? Position.Top : Position.Left} />
      <span className="object-node__icon">
        <TypeIcon typeId={object.typeId} componentId={object.componentId} size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="object-node__name" title={object.name}>
          {object.name}
        </div>
        <div className="object-node__meta">
          <span>{archimate?.name ?? bpmn?.name ?? component ?? type.label}</span>
          {object.technology && <span className="object-node__tech">{object.technology}</span>}
        </div>
      </div>
      <div className="object-node__corner">
        {security?.findings && (security.findings.high > 0 || security.findings.medium > 0) && (
          <span
            className="object-node__risk"
            data-risk={security.findings.high ? "high" : "medium"}
            title={[security.findings.high && `${security.findings.high} high`, security.findings.medium && `${security.findings.medium} medium`, security.findings.low && `${security.findings.low} low`].filter(Boolean).join(", ") + " from the checks"}
          >
            {security.findings.high ? `${security.findings.high} high` : `${security.findings.medium} to check`}
          </span>
        )}
        {security?.classification && <span className="object-node__class">{security.classification}</span>}
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
      {object.typeId === "diagram" && object.diagramId && onOpen && (
        <button
          type="button"
          className="object-node__inside nodrag"
          data-open-diagram={object.diagramId}
          title={`Open the diagram ${object.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(object.id);
          }}
        >
          Open diagram
        </button>
      )}
      {childCount > 0 && onOpen && object.typeId !== "diagram" && (
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
}: EdgeProps<Edge<{ slot: number; dim?: boolean; title?: string; network?: string; networkColor?: string; protection?: Protection; lock?: boolean; traffic?: "out" | "in" | "both"; arriving?: boolean }>>) {
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
      {/* Which way the traffic goes: light dashes running along the line, which stays solid. */}
      {data?.traffic && <path d={path} className={`edge-traffic edge-traffic--${data.traffic}`} fill="none" aria-hidden />}
      {label && (
        <EdgeLabelRenderer>
          <div
            className="edge-label"
            data-selected={selected || undefined}
            data-network={data?.network}
            data-protection={data?.lock ? data.protection : undefined}
            data-arriving={data?.arriving || undefined}
            title={data?.title}
            style={{ transform, opacity: data?.dim ? 0.25 : undefined, ...(data?.networkColor ? { ["--network-color" as string]: data.networkColor } : {}) }}
          >
            {data?.lock && data.protection === "encrypted" && <Lock size={10} strokeWidth={2.5} aria-label="Encrypted" />}
            {data?.lock && data.protection === "plain" && <LockOpen size={10} strokeWidth={2.5} aria-label="Not encrypted" />}
            {data?.lock && data.protection === "unknown" && <CircleHelp size={10} strokeWidth={2.5} aria-label="Not recorded" />}
            <span className="edge-label__text">{label}</span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

/** A network zone drawn around what sits in it. It can be picked, and lines can reach it. */
const ZoneNode = memo(function ZoneNode({ data, selected }: NodeProps<Node<{ label: string; color: string; direction: "TB" | "LR"; trust?: keyof typeof TRUST_INFO | null }>>) {
  return (
    <div className="zone-node" data-selected={selected || undefined} data-trust={data.trust ?? undefined} style={{ ["--zone-color" as string]: data.color }}>
      <Handle type="target" position={data.direction === "TB" ? Position.Top : Position.Left} />
      <span className="zone-node__label">
        <SquareDashed size={12} aria-hidden />
        {data.label}
        {data.trust && <span className="zone-node__trust">{TRUST_INFO[data.trust].label}</span>}
      </span>
      <Handle type="source" position={data.direction === "TB" ? Position.Bottom : Position.Right} />
    </div>
  );
});

const nodeTypes = { object: ObjectNode, boundary: BoundaryNode, zone: ZoneNode };
const edgeTypes = { labelled: LabelledEdge };

function nodeColor(o: ModelObject, colorBy: Diagram["colorBy"]): string {
  if (colorBy === "lifecycle") return LIFECYCLE_INFO[o.lifecycle].color;
  if (colorBy === "owner") return ownerColor(o.owner);
  // A box standing for a network takes that network's colour, the same as the lines that run over it.
  return objectNetwork(o)?.color ?? typeColor(o.typeId);
}

/** The network a line runs over: its relationship's, or the one all the rolled-up relationships share. */
function edgeNetwork(ws: Workspace, relationshipIds: string[]): NetworkLink | null {
  const found = relationshipIds.map((id) => networkLink(ws.relationships[id]?.network));
  return found[0] && found.every((n) => n === found[0]) ? found[0] : null;
}

/** The Security view's key: how many lines are encrypted, not encrypted or not recorded, and what the checks find. */
function SecurityLegend({ edges, findings }: { edges: Edge[]; findings: { severity: "high" | "medium" | "low" }[] }) {
  const [open, setOpen] = useState(true);
  const count = (p: Protection) => edges.filter((e) => (e.data as { protection?: Protection } | undefined)?.protection === p).length;
  const by = (s: "high" | "medium" | "low") => findings.filter((f) => f.severity === s).length;
  return (
    <div className="network-legend security-legend nodrag nopan" data-security-legend>
      <button type="button" className="network-legend__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ShieldCheck size={13} aria-hidden />
        Security view
        <ChevronDown size={13} aria-hidden className={open ? "rotate-180" : undefined} />
      </button>
      {open && (
        <>
          <ul>
            {(["encrypted", "plain", "unknown"] as Protection[]).map((p) => (
              <li key={p} data-protection-count={p} title={PROTECTION_INFO[p].hint}>
                <svg width="26" height="8" aria-hidden>
                  <line x1="1" y1="4" x2="25" y2="4" stroke={PROTECTION_INFO[p].color} strokeWidth={PROTECTION_INFO[p].width} strokeDasharray={PROTECTION_INFO[p].dash} strokeLinecap="round" />
                </svg>
                {PROTECTION_INFO[p].label}
                <span className="network-legend__count">{count(p)}</span>
              </li>
            ))}
          </ul>
          <p className="security-legend__findings" data-security-findings={`${by("high")}/${by("medium")}/${by("low")}`}>
            The checks find {by("high")} high, {by("medium")} medium and {by("low")} low here.
          </p>
        </>
      )}
    </div>
  );
}

/** Which colour stands for which network, for the networks this diagram draws. */
function NetworkLegend({ networks }: { networks: { link: NetworkLink; lines: number; boxes: number }[] }) {
  const [open, setOpen] = useState(networks.length <= 8);
  return (
    <div className="network-legend nodrag nopan" data-network-legend>
      <button type="button" className="network-legend__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Cable size={13} aria-hidden />
        Network links
        <span className="network-legend__count">{networks.length}</span>
        <ChevronDown size={13} aria-hidden className={open ? "rotate-180" : undefined} />
      </button>
      {open && (
        <ul>
          {networks.map(({ link, lines, boxes }) => (
            <li key={link.name} data-network-kind={link.name} title={`${familyLabel(link.family)}: ${[lines && `${lines} ${lines === 1 ? "line" : "lines"}`, boxes && `${boxes} ${boxes === 1 ? "box" : "boxes"}`].filter(Boolean).join(", ")}`}>
              <span className="network-legend__swatch" style={{ background: link.color }} />
              {link.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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
  lens = "normal",
  onBuild,
  onSelect,
  onPick,
  onMove,
  onConnect,
  onDropItem,
  onOpen,
  onExplore,
  onRemove,
  canvasRef,
}: Props) {
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [connecting, setConnecting] = useState(false);
  const [whole, setWhole] = useState(false);
  const [flash, setFlash] = useState<ReadonlySet<string>>(() => new Set());

  // What the assistant changed comes into view, clear of its panel, and is marked for a moment.
  useEffect(() => {
    let fit = 0;
    let fade = 0;
    const show = (event: Event) => {
      const detail = (event as CustomEvent<ShowChanges>).detail;
      if (!detail || detail.diagramId !== diagram.id) return;
      window.clearTimeout(fit);
      window.clearTimeout(fade);
      setFlash(new Set(detail.ids));
      fit = window.setTimeout(() => {
        const box = wrapper.current?.getBoundingClientRect();
        const panel = document.querySelector("[data-assistant-panel]")?.getBoundingClientRect();
        const covered = box && panel && panel.left < box.right && panel.right > box.left ? Math.max(0, Math.min(box.width * 0.6, box.right - panel.left)) : 0;
        const nodes = detail.ids.filter((id) => flow.getNode(id)).map((id) => ({ id }));
        void flow.fitView({ ...(nodes.length ? { nodes } : {}), padding: { top: "56px", bottom: "56px", left: "56px", right: `${Math.round(covered) + 56}px` }, duration: 350, maxZoom: 1 });
      }, 90);
      fade = window.setTimeout(() => setFlash(new Set()), 3200);
    };
    window.addEventListener(SHOW_CHANGES, show);
    return () => {
      window.removeEventListener(SHOW_CHANGES, show);
      window.clearTimeout(fit);
      window.clearTimeout(fade);
    };
  }, [flow, diagram.id]);

  const secure = lens === "security";
  // What the checks find on this diagram, per box, for the Security view.
  const findings = useMemo(() => (secure ? runChecks(ws, diagram, ALL_PACKS) : []), [secure, ws, diagram]);
  const perBox = useMemo(() => findingsByObject(findings), [findings]);
  // A zone holding boxes on this diagram is drawn around them rather than as a box.
  const zones = useMemo(() => zonesOf(ws, diagram), [ws, diagram]);
  const zoneIds = useMemo(() => new Set(zones.map((z) => z.id)), [zones]);
  const derived = useMemo<Node[]>(() => {
    const list: Node[] = [];
    for (const [id, placement] of Object.entries(diagram.nodes)) {
      const object = ws.objects[id];
      if (!object || zoneIds.has(id)) continue;
      const data: ObjectNodeData = {
        object,
        color: nodeColor(object, diagram.colorBy),
        notation: diagram.notation,
        childCount: childrenOf(ws, id).length,
        direction: diagram.direction,
        highlight: spotlight ? (spotlight.nodes.includes(id) ? "focus" : "dim") : highlight?.[id],
        comments: comments?.[id],
        onOpen,
        ...(secure ? { security: { findings: perBox[id], classification: classificationOf(object) } } : {}),
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
        ...(flash.has(id) ? { className: "assistant-changed" } : {}),
      });
    }
    return list;
  }, [ws, diagram, highlight, spotlight, comments, readOnly, selection?.objectId, picked, onOpen, zoneIds, flash, secure, perBox]);

  // React Flow owns positions while a node is being dragged; the store is updated when the drag ends.
  const [nodes, setNodes] = useState<Node[]>(derived);
  useEffect(() => setNodes(derived), [derived]);

  const members = useMemo(() => new Set(scopeMembers(ws, diagram)), [ws, diagram]);
  const scopeName = diagram.scopeId ? ws.objects[diagram.scopeId]?.name : undefined;
  const allNodes = useMemo<Node[]>(() => {
    // Zones first, outer ones behind inner ones, each around the boxes it holds as they stand now.
    const at = new Map(nodes.map((n) => [n.id, n.position]));
    const zoneNodes: Node[] = [];
    const zoneBox = new Map<string, { x: number; y: number; width: number; height: number }>();
    for (const z of [...zones].sort((a, b) => b.depth - a.depth)) {
      const points = z.members.flatMap((m) => {
        const inner = zoneBox.get(m);
        if (inner) return [{ x: inner.x, y: inner.y }, { x: inner.x + inner.width - NODE_W, y: inner.y + inner.height - NODE_H }];
        const p = at.get(m);
        return p ? [p] : [];
      });
      const box = boundsOf(points);
      if (!box) continue;
      const frame = { x: box.x - 26, y: box.y - 42, width: box.width + 52, height: box.height + 68 };
      zoneBox.set(z.id, frame);
      zoneNodes.push({
        id: z.id,
        type: "zone",
        position: { x: frame.x, y: frame.y },
        // In the Security view a zone takes the colour of how far it is trusted, when its name says.
        data: { label: z.name, color: (secure && (() => { const t = trustOfZone(z.name); return t ? TRUST_INFO[t].color : null; })()) || z.color, direction: diagram.direction, trust: secure ? trustOfZone(z.name) : null },
        style: { width: frame.width, height: frame.height },
        width: frame.width,
        height: frame.height,
        selectable: true,
        selected: selection?.objectId === z.id,
        draggable: false,
        zIndex: -2 + z.depth,
      });
    }
    const withZones = zoneNodes.length ? [...zoneNodes, ...nodes] : nodes;
    if (!scopeName || !members.size) return withZones;
    const box = boundsOf(nodes.filter((n) => members.has(n.id)).map((n) => n.position));
    if (!box) return withZones;
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
    return [boundary, ...withZones];
  }, [nodes, members, scopeName, zones, diagram.direction, selection?.objectId, secure]);

  const edges = useMemo<Edge[]>(() => {
    // Labelled arrows into the same box stack their labels instead of printing them on top of each other,
    // and several arrows that say the same thing about one box ("hosted on") share a single label.
    const slots = new Map<string, number>();
    const said = new Set<string>();
    const lit = spotlight ? new Set(spotlight.edges) : null;
    return visibleEdges(ws, diagram).map((e) => {
        const inStep = lit?.has(e.id) ?? false;
        const network = edgeNetwork(ws, e.relationshipIds);
        // How well the line is protected: of several connections drawn as one, the least protected.
        const behind = e.relationshipIds.map((id) => ws.relationships[id]).filter(Boolean);
        const protection = behind.length ? WORST.find((p) => behind.some((r) => protectionOf(r) === p))! : "unknown";
        const shield = PROTECTION_INFO[protection];
        const color = inStep ? "#2447d6" : secure ? shield.color : network ? network.color : e.implied ? "#93a0b4" : KIND_COLOR[e.kind];
        // Which way traffic goes, and what it carries, from the relationship behind the line.
        const rel = e.implied ? undefined : ws.relationships[e.relationshipIds[0]];
        const flow = rel?.flow ?? "out";
        const carried = rel ? protocolsOf(rel) : [];
        const carriedText = carried.slice(0, 2).map(protocolLabel).join(", ") + (carried.length > 2 ? ` +${carried.length - 2}` : "");
        // In a notation the line itself says what kind of relationship it is.
        const arrow = diagram.notation === "archimate" ? archimateArrow(e.kind) : diagram.notation === "bpmn" ? bpmnArrow(e.kind) : null;
        // The Security view says only what protects the line: its protocols, or that none is recorded.
        let text = secure
          ? carriedText || (protection === "unknown" ? "No protocol" : protection === "plain" ? "Not encrypted" : "Encrypted")
          : [e.label.trim() || (arrow ? arrow.name : e.kind === "calls" ? "" : RELATION_KIND_INFO[e.kind].verb), carriedText].filter(Boolean).join(" · ");
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
          data: {
            slot,
            dim: !!lit && !inStep,
            network: secure ? undefined : network?.name,
            networkColor: secure ? undefined : network?.color,
            protection,
            // A lock on the label where it names its protocols, or always in the Security view.
            lock: secure || (!!carriedText && protection === "encrypted"),
            traffic: !e.implied && !lit && !inStep ? flow : undefined,
            title: [RELATION_KIND_INFO[e.kind].label, flow === "both" ? "both ways" : flow === "in" ? "inbound" : "outbound", ...carried.map(protocolLabel), rel?.network ? `over ${rel.network}` : "", rel?.encrypted === "yes" ? "encrypted" : rel?.encrypted === "no" ? "not encrypted" : ""].filter(Boolean).join(" · "),
          },
          className: [lit ? (inStep ? "flow-edge" : "dim-edge") : "", !e.implied && !lit ? `traffic traffic-${flow}` : "", network && !secure ? "network-edge" : "", secure ? `security-edge protection-${protection}` : ""].filter(Boolean).join(" ") || undefined,
          animated: inStep,
          ...(arrow
            ? {
                [arrow.reversed ? "markerStart" : "markerEnd"]: { type: arrow.head === "open" ? MarkerType.Arrow : MarkerType.ArrowClosed, width: 16, height: 16, color },
                style: { stroke: color, strokeDasharray: secure ? shield.dash : e.implied ? "6 4" : arrow.dashed ? "4 4" : undefined, strokeWidth: secure ? shield.width : network ? 2.25 : 1.75 },
              }
            : {
                ...(flow !== "in" ? { markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color } } : {}),
                ...(flow !== "out" ? { markerStart: { type: MarkerType.ArrowClosed, width: 16, height: 16, color } } : {}),
                style: { stroke: color, strokeDasharray: secure ? shield.dash : e.implied ? "6 4" : e.kind === "hosted_on" ? "2 4" : undefined, strokeWidth: secure ? shield.width : network ? 2.25 : 1.75 },
              }),
          selected: selection?.edgeId === e.id,
          deletable: false,
          reconnectable: false,
          interactionWidth: 18,
        };
      });
  }, [ws, diagram, selection?.edgeId, spotlight, secure]);

  // The networks drawn here, by lines that run over them or boxes that stand for them, for the legend.
  const networks = useMemo(() => {
    const found = new Map<string, { link: NetworkLink; lines: number; boxes: number }>();
    const entry = (link: NetworkLink) => found.get(link.name) ?? found.set(link.name, { link, lines: 0, boxes: 0 }).get(link.name)!;
    for (const e of edges) {
      const name = (e.data as { network?: string } | undefined)?.network;
      const link = name ? networkLink(name) : null;
      if (link) entry(link).lines++;
    }
    for (const id of Object.keys(diagram.nodes)) {
      const link = objectNetwork(ws.objects[id]);
      if (link) entry(link).boxes++;
    }
    return [...found.values()].sort((a, b) => b.lines + b.boxes - (a.lines + a.boxes) || a.link.name.localeCompare(b.link.name));
  }, [edges, ws, diagram.nodes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Selection and removal are decided by the page, not by React Flow.
    const kept = changes.filter((c) => c.type === "position" || c.type === "dimensions");
    if (kept.length) setNodes((current) => applyNodeChanges(kept, current));
  }, []);

  /* ---------- the build animation: a hand puts the diagram together, from the bottom up ---------- */
  const [show, setShow] = useState<BuildShow | null>(null);
  const onBuildRef = useRef(onBuild);
  onBuildRef.current = onBuild;
  const clockRef = useRef<Clock | null>(null);
  const runs = useRef(0);
  const handParts = useRef<{ hand: HTMLDivElement | null; chip: HTMLDivElement | null; marquee: HTMLDivElement | null }>({ hand: null, chip: null, marquee: null });
  // What the moves need, as the diagram stood when the animation began.
  const plan = useRef<{ rects: Map<string, { x: number; y: number; w: number; h: number }>; names: Map<string, string>; speed: number } | null>(null);
  const startBuild = useCallback((): boolean => {
    const stages = buildStages(ws, diagram, zoneIds);
    if (!stages.length) return false;
    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    // A zone holds its boxes and those of the zones inside it.
    const holds = (id: string, seen = new Set<string>()): Set<string> => {
      const found = new Set<string>();
      if (seen.has(id)) return found;
      seen.add(id);
      for (const m of zones.find((z) => z.id === id)?.members ?? []) {
        if (zoneIds.has(m)) for (const inner of holds(m, seen)) found.add(inner);
        else found.add(m);
      }
      return found;
    };
    const frames = allNodes
      .filter((n) => n.type === "zone" || n.id === BOUNDARY_ID)
      .map((n) => ({ id: n.id, holds: n.id === BOUNDARY_ID ? members : holds(n.id), area: (n.width ?? 0) * (n.height ?? 0) }));
    const steps = buildScript(stages, frames, edges.map((e) => ({ id: e.id, source: e.source, target: e.target })));
    const names = new Map<string, string>();
    for (const n of allNodes) names.set(n.id, n.id === BOUNDARY_ID ? (scopeName ?? "") : n.type === "zone" ? String((n.data as { label?: string }).label ?? "") : (ws.objects[n.id]?.name ?? ""));
    // A large diagram goes faster, so that it is built in about half a minute.
    plan.current = { rects: new Map(allNodes.map((n) => [n.id, { x: n.position.x, y: n.position.y, w: n.width ?? NODE_W, h: n.height ?? NODE_H }])), names, speed: Math.min(4, Math.max(1, scriptTime(steps) / 23000)) };
    runs.current += 1;
    setShow({ run: runs.current, phase: "clearing", steps, step: -1, standing: new Set(), drawn: new Set(), drawing: null, landed: null, label: null, paused: false, fast: false, still, boxes: stages.reduce((sum, st) => sum + st.ids.length, 0), placed: 0, lines: edges.length });
    onBuildRef.current?.(true);
    return true;
  }, [ws, diagram, zoneIds, zones, allNodes, edges, members, scopeName]);
  const endBuild = useCallback(() => {
    clockRef.current?.stop();
    setShow(null);
    onBuildRef.current?.(false);
  }, []);
  const skipBuild = useCallback(() => {
    clockRef.current?.stop();
    const { hand, chip, marquee } = handParts.current;
    hand?.classList.remove("is-on", "is-down");
    chip?.classList.remove("is-on");
    marquee?.classList.remove("is-on");
    setShow((s) => (s ? { ...s, phase: "done", paused: false, drawing: null, landed: null, label: null, placed: s.boxes } : s));
  }, []);
  // The moves, one after the other, on this canvas as it stands.
  useEffect(() => {
    if (!show || !plan.current) return;
    const clock = new Clock();
    clockRef.current = clock;
    const { rects, names, speed } = plan.current;
    clock.speed = speed;
    const { run, steps, still } = show;
    const { hand: handEl, chip, marquee } = handParts.current;
    const hand = handEl && chip && marquee ? new Hand({ hand: handEl, chip, marquee }, clock) : null;
    const screen = (x: number, y: number) => flow.flowToScreenPosition({ x, y });
    const canvas = () => wrapper.current?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight);
    const update = (change: (s: BuildShow) => Partial<BuildShow>) => setShow((s) => (s && s.run === run ? { ...s, ...change(s) } : s));
    const stand = (step: BuildStep) =>
      update((s) =>
        step.kind === "connect"
          ? { drawing: null, drawn: new Set([...s.drawn, step.id]), label: step.id }
          : { standing: new Set([...s.standing, step.id]), landed: step.id, placed: s.placed + (step.kind === "place" ? 1 : 0) },
      );
    void (async () => {
      // The whole diagram in view, then an empty canvas: it is built where it stands, in this frame.
      await flow.fitView({ padding: 0.08, maxZoom: 1.1, duration: still ? 0 : 450 });
      await clock.wait(still ? 0 : 520);
      update(() => ({ phase: "building" }));
      if (hand && !still) {
        const r = canvas();
        hand.put({ x: r.right - 150, y: r.bottom - 120 });
        hand.show();
      }
      await clock.wait(still ? 60 : 360);
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        update(() => ({ step: i }));
        if (still || !hand) {
          await clock.wait(130);
          stand(step);
          continue;
        }
        if (step.kind === "frame") {
          // Drawn as a rectangle, from its top left corner to the bottom right.
          const r = rects.get(step.id)!;
          const corner = () => screen(r.x, r.y);
          const far = () => screen(r.x + r.w, r.y + r.h);
          await hand.moveTo(corner);
          await hand.press();
          const a0 = corner();
          const b0 = far();
          await clock.tween(420 + Math.min(Math.hypot(b0.x - a0.x, b0.y - a0.y), 1000) * 0.3, (t) => {
            const e = easeInOut(t);
            const a = corner();
            const b = far();
            const p = { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
            hand.put(p);
            hand.frame(a, p);
          });
          await hand.release();
          stand(step);
          hand.frameDone();
          await clock.wait(140);
        } else if (step.kind === "place") {
          // Taken from the panel of components, carried to its place, and put down.
          const r = rects.get(step.id)!;
          const object = ws.objects[step.id];
          const centre = () => screen(r.x + r.w / 2, r.y + r.h / 2);
          const from = sourceOf(object?.componentId, object?.typeId ?? "", canvas(), centre().y);
          await hand.moveTo(() => from.point);
          await hand.press();
          if (from.tile) {
            const box = from.tile.getBoundingClientRect();
            const copy = from.tile.cloneNode(true) as HTMLElement;
            for (const name of ["data-component", "data-palette-type", "aria-pressed", "title", "draggable"]) copy.removeAttribute(name);
            copy.classList.add("build-chip__tile");
            hand.pickUp(copy, box.width, { x: from.point.x - box.left, y: from.point.y - box.top });
          } else {
            const type = objectType(object?.typeId ?? "");
            hand.pickUp(cardFor(names.get(step.id) ?? "", type.label, CATEGORY_INFO[type.category].color), 190, { x: 22, y: 20 });
          }
          await hand.carryTo(centre, screen(r.x + r.w, r.y).x - screen(r.x, r.y).x, 1.1);
          await hand.release();
          hand.letGo();
          stand(step);
          await clock.wait(170);
        } else {
          // Dragged from one box to the other; the line follows the hand.
          update(() => ({ drawing: step.id }));
          await clock.wait(40);
          const g = wrapper.current?.querySelector<SVGGElement>(`.react-flow__edge[data-id="${CSS.escape(step.id)}"]`) ?? wrapper.current?.querySelector<SVGGElement>(`[data-testid="rf__edge-${CSS.escape(step.id)}"]`);
          const path = g?.querySelector<SVGPathElement>("path.react-flow__edge-path");
          if (g && path) {
            const length = path.getTotalLength();
            g.style.setProperty("--build-len", `${length}px`);
            g.style.setProperty("--build-off", `${length}px`);
            const along = (l: number): Point => {
              const p = path.getPointAtLength(l);
              const m = path.getScreenCTM();
              return m ? new DOMPoint(p.x, p.y).matrixTransform(m) : p;
            };
            await hand.moveTo(() => along(0));
            await hand.press();
            await clock.tween(300 + Math.min(length, 900) * 0.42, (t) => {
              const e = easeInOut(t);
              g.style.setProperty("--build-off", `${length * (1 - e)}px`);
              hand.put(along(length * e));
            });
            await hand.release();
          }
          stand(step);
          await clock.wait(70);
        }
      }
      if (hand && !still) {
        const r = canvas();
        await hand.moveTo(() => ({ x: r.right - 110, y: r.bottom - 90 }));
        hand.hide();
      }
      update((s) => ({ phase: "done", drawing: null, landed: null, placed: s.boxes }));
    })().catch((error) => {
      if (!(error instanceof Stopped)) throw error;
    });
    return () => clock.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show?.run]);
  // Pausing and going faster act on the moves under way.
  useEffect(() => {
    const clock = clockRef.current;
    if (!clock || !show) return;
    clock.paused = show.paused;
    clock.speed = (plan.current?.speed ?? 1) * (show.fast ? 2 : 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show?.paused, show?.fast, show?.run]);
  // Once built, the canvas is given back a moment later, as it now stands.
  useEffect(() => {
    if (show?.phase !== "done") return;
    const timer = window.setTimeout(endBuild, 2600);
    return () => window.clearTimeout(timer);
  }, [show?.phase, show?.run, endBuild]);
  // Esc ends it; the space bar pauses it.
  useEffect(() => {
    if (!show) return;
    // It listens first, so that a page around it (a presentation) does not also take the key.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        endBuild();
      } else if (event.key === " " && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        event.stopPropagation();
        setShow((s) => (s && s.phase !== "done" ? { ...s, paused: !s.paused } : s));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [show !== null, endBuild]);
  // A diagram changed under the animation ends it rather than build what is no longer there.
  useEffect(() => {
    if (show) endBuild();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagram.id, diagram.nodes]);

  const building = show?.phase === "building";
  const shownNodes = useMemo<Node[]>(() => {
    if (!show || !building) return allNodes;
    return allNodes.map((n) =>
      !show.standing.has(n.id) ? { ...n, hidden: true } : n.id === show.landed ? { ...n, className: [n.className, n.type === "object" ? "build-drop" : "build-frame-in"].filter(Boolean).join(" ") } : n,
    );
  }, [allNodes, show, building]);
  const finalEdges = useMemo<Edge[]>(() => {
    if (!show || !building) return edges;
    // A line is not there until it is drawn; the one being drawn has no head or label yet.
    return edges.map((e) =>
      show.drawn.has(e.id)
        ? e.id === show.label
          ? { ...e, data: { ...e.data, arriving: true } }
          : e
        : e.id === show.drawing
          ? { ...e, className: [e.className, "build-draw"].filter(Boolean).join(" "), markerEnd: undefined, markerStart: undefined, label: undefined }
          : { ...e, hidden: true },
    );
  }, [edges, show, building]);

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
      build: startBuild,
    }),
    [flow, startBuild],
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
    <div ref={wrapper} className={`size-full relative ${show ? "is-building" : ""} ${show?.phase === "clearing" ? "build-clearing" : ""}`} onDrop={handleDrop} onDragOver={(e) => !readOnly && e.preventDefault()}>
      <ReactFlow
        className={`${readOnly ? "read-only" : ""} ${connecting ? "connecting" : ""}`}
        nodes={shownNodes}
        edges={finalEdges}
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
        onNodeDoubleClick={(_, node) => node.id !== BOUNDARY_ID && (onExplore ?? onOpen)?.(node.id)}
        onNodeDragStop={(_, _node, dragged) => {
          const moved: Record<string, { x: number; y: number }> = {};
          for (const n of dragged) if (n.id !== BOUNDARY_ID) moved[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
          if (Object.keys(moved).length) onMove?.(moved);
        }}
        onConnect={(c: Connection) => c.source && c.target && c.source !== c.target && onConnect?.(c.source, c.target)}
        onConnectStart={() => setConnecting(true)}
        onConnectEnd={() => setConnecting(false)}
        onNodesDelete={(deleted) => onRemove?.(deleted.map((n) => n.id).filter((id) => id !== BOUNDARY_ID))}
        // While the diagram builds itself, the canvas holds still and takes no clicks.
        nodesConnectable={!readOnly && !show}
        nodesDraggable={!readOnly && !show}
        elementsSelectable={!show}
        panOnDrag={!show}
        zoomOnScroll={!show}
        zoomOnPinch={!show}
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
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="var(--color-dots)" />
        <Controls showInteractive={false} position="bottom-left" />
        {secure ? (
          <Panel position="bottom-left" style={{ marginLeft: 56 }}>
            <SecurityLegend edges={edges} findings={findings} />
          </Panel>
        ) : (
          networks.length > 0 && (
            <Panel position="bottom-left" style={{ marginLeft: 56 }}>
              <NetworkLegend networks={networks} />
            </Panel>
          )
        )}
        {minimap && <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => (n.id === BOUNDARY_ID ? "transparent" : "var(--color-dots)")} maskColor="color-mix(in srgb, var(--color-canvas) 72%, transparent)" />}
      </ReactFlow>
      {show && (
        <BuildBar
          show={show}
          caption={buildCaption(show, plan.current?.names)}
          onPause={() => setShow((s) => (s ? { ...s, paused: !s.paused } : s))}
          onFast={() => setShow((s) => (s ? { ...s, fast: !s.fast } : s))}
          onSkip={skipBuild}
          onReplay={() => void startBuild()}
          onClose={endBuild}
        />
      )}
      {show &&
        createPortal(
          <>
            <div className="build-chip" ref={(el) => void (handParts.current.chip = el)} aria-hidden />
            <div className="build-marquee" ref={(el) => void (handParts.current.marquee = el)} aria-hidden />
            <div className="build-hand" ref={(el) => void (handParts.current.hand = el)} data-build-hand aria-hidden>
              <span className="build-hand__ring" />
              <svg width="26" height="26" viewBox="0 0 26 26" className="build-hand__arrow">
                <path d="M5 3 L5 20.5 L9.6 16.2 L12.7 23 L15.6 21.7 L12.6 15 L18.8 15 Z" fill="#ffffff" stroke="#1d2433" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

interface BuildShow {
  /** Changes on each start, to begin the moves again. */
  run: number;
  /** "clearing": the canvas empties; "building": the moves; "done": all of it stands. */
  phase: "clearing" | "building" | "done";
  steps: BuildStep[];
  /** The move under way; -1 before the first. */
  step: number;
  /** Boxes and frames put down so far. */
  standing: ReadonlySet<string>;
  /** Lines drawn so far. */
  drawn: ReadonlySet<string>;
  /** The line being drawn. */
  drawing: string | null;
  /** What was put down last, as it lands. */
  landed: string | null;
  /** The line whose label is fading in. */
  label: string | null;
  paused: boolean;
  fast: boolean;
  /** For people who ask their system for less motion: no hand, things appear in turn. */
  still: boolean;
  boxes: number;
  placed: number;
  lines: number;
}

/** What the hand is doing, in words. */
function buildCaption(show: BuildShow, names: Map<string, string> | undefined): string {
  const name = (id: string) => names?.get(id) || "a box";
  const many = (n: number, one: string, more: string) => `${n} ${n === 1 ? one : more}`;
  if (show.phase === "clearing") return "Starting from an empty canvas";
  if (show.phase === "done") return `Built: ${many(show.boxes, "component", "components")} and ${many(show.lines, "connection", "connections")}`;
  const step = show.steps[show.step];
  if (!step) return "Getting ready";
  if (step.kind === "place") return `Placing ${name(step.id)}`;
  if (step.kind === "frame") return step.id === BOUNDARY_ID ? `Framing the inside of ${name(step.id)}` : `Drawing the zone ${name(step.id)}`;
  return `Connecting ${name(step.from)} to ${name(step.to)}`;
}

/** A small bar on the canvas: what is being done, how far along, and the controls. */
function BuildBar({ show, caption, onPause, onFast, onSkip, onReplay, onClose }: { show: BuildShow; caption: string; onPause: () => void; onFast: () => void; onSkip: () => void; onReplay: () => void; onClose: () => void }) {
  const done = show.phase === "done";
  const share = done ? 1 : show.steps.length ? Math.max(0, show.step) / show.steps.length : 0;
  return (
    <div className="build-bar nodrag nopan" role="group" aria-label="Build animation" data-build-show data-build-phase={show.phase} data-build-step={show.step} data-still={show.still || undefined}>
      <span className="build-bar__dot" data-paused={show.paused || undefined} data-done={done || undefined} aria-hidden />
      <span className="build-bar__text" aria-live="polite" data-build-caption>
        {show.paused ? `Paused: ${caption}` : caption}
      </span>
      <span className="build-bar__count" data-build-count>
        {show.placed} of {show.boxes}
      </span>
      <span className="build-bar__controls">
        <button type="button" onClick={onPause} disabled={done} aria-label={show.paused ? "Play (space)" : "Pause (space)"} title={show.paused ? "Play (space)" : "Pause (space)"} data-build-pause>
          {show.paused ? <Play size={14} /> : <Pause size={14} />}
        </button>
        <button type="button" onClick={onFast} disabled={done} aria-pressed={show.fast} aria-label="Twice as fast" title="Twice as fast" className="build-bar__fast" data-build-fast>
          2×
        </button>
        <button type="button" onClick={onSkip} disabled={done} aria-label="Skip to the end" title="Skip to the end" data-build-skip>
          <SkipForward size={14} />
        </button>
        <button type="button" onClick={onReplay} aria-label="Build it again" title="Build it again" data-build-replay>
          <RotateCcw size={14} />
        </button>
        <button type="button" onClick={onClose} aria-label="Stop (Esc)" title="Stop (Esc)" data-build-close>
          <X size={14} />
        </button>
      </span>
      <span className="build-bar__progress" aria-hidden>
        <span style={{ width: `${share * 100}%` }} />
      </span>
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
