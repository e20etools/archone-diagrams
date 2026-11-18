import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn.css";
import Modeler from "bpmn-js/lib/Modeler";
import NavigatedViewer from "bpmn-js/lib/NavigatedViewer";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";

/**
 * The BPMN canvas: bpmn.io's modeler (or its viewer, for reading), which reads and writes
 * BPMN 2.0 itself. It is loaded only on the process pages. The bpmn.io mark stays on the
 * canvas, as its licence asks.
 */

export interface SelectedElement {
  id: string;
  /** The BPMN type without its prefix: userTask, sequenceFlow, exclusiveGateway... */
  type: string;
  name: string;
  /** For a flow: the type of the step it leaves. */
  sourceType?: string;
  sourceId?: string;
  laneName?: string;
}

/** A shape to put on the canvas: its BPMN type and settings (see the BPMN library). */
export interface ShapeToPlace {
  type: string;
  eventDefinition?: string;
  isExpanded?: boolean;
  triggeredByEvent?: boolean;
  cancelActivity?: boolean;
  participant?: boolean;
  name?: string;
}

export interface BpmnCanvasApi {
  /**
   * Picks up a shape to place: it follows the pointer onto the canvas and is put down with a click
   * (a boundary event, on the edge of an activity). Says when it was placed, with its id.
   */
  place: (event: MouseEvent, shape: ShapeToPlace, onPlaced?: (id: string) => void) => boolean;
  rename: (id: string, name: string) => void;
  select: (id: string) => void;
  fit: () => void;
  xml: () => Promise<string>;
  svg: () => Promise<string>;
}

export type OverlayTone = "blue" | "amber" | "red" | "green" | "grey";

interface Props {
  xml: string;
  editable: boolean;
  onChange?: (xml: string) => void;
  onSelect?: (element: SelectedElement | null) => void;
  onError?: (message: string) => void;
  /** Small labels on steps: counts from a log, waits from a simulation. */
  overlays?: Record<string, { text: string; tone: OverlayTone; title?: string }>;
  /** Colours steps: a finding, or how busy a step is (0 to 1). */
  markers?: Record<string, "error" | "warning" | "info">;
  heat?: Record<string, number>;
  apiRef?: Ref<BpmnCanvasApi | null>;
  className?: string;
  label?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Diagram = any;

// Types come as bpmn:UserTask; the app speaks of userTask, as the file does.
const local = (type: string) => {
  const name = type.slice(type.indexOf(":") + 1);
  return name.charAt(0).toLowerCase() + name.slice(1);
};

/** The whole model in view, no larger than life, and clear of the toolbox on the left. */
function fitView(canvas: Diagram, left: number) {
  const vb = canvas.viewbox();
  const inner = vb.inner;
  const outer = vb.outer;
  if (!inner.width || !outer.width) return canvas.zoom("fit-viewport", "auto");
  const scale = Math.min(1, (outer.width - left - 24) / inner.width, (outer.height - 48) / inner.height);
  const width = outer.width / scale;
  const height = outer.height / scale;
  const room = width - inner.width - left / scale;
  canvas.viewbox({ x: inner.x - left / scale - Math.max(0, room / 2 - 12 / scale), y: inner.y - (height - inner.height) / 2, width, height });
}

function themeColours() {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return { fill: read("--color-surface", "#ffffff"), stroke: read("--color-ink", "#16233a"), label: read("--color-ink", "#16233a") };
}

function describe(element: Diagram): SelectedElement | null {
  if (!element || !element.businessObject) return null;
  const bo = element.businessObject;
  const type = local(bo.$type);
  if (type === "process" || type === "collaboration" || type === "participant" || type === "lane" || type === "label") return null;
  let laneName: string | undefined;
  let parent = element.parent;
  while (parent) {
    if (parent.businessObject && local(parent.businessObject.$type) === "lane") {
      laneName = parent.businessObject.name ?? "";
      break;
    }
    parent = parent.parent;
  }
  return {
    id: bo.id,
    type,
    name: bo.name ?? "",
    sourceType: bo.sourceRef ? local(bo.sourceRef.$type) : undefined,
    sourceId: bo.sourceRef?.id,
    laneName,
  };
}

export default function BpmnCanvas({ xml, editable, onChange, onSelect, onError, overlays, markers, heat, apiRef, className, label = "Process model" }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const diagram = useRef<Diagram>(null);
  const shown = useRef<string>("");
  const [ready, setReady] = useState(0);
  const handlers = useRef({ onChange, onSelect, onError });
  useEffect(() => {
    handlers.current = { onChange, onSelect, onError };
  });

  // One canvas per mount; a change between editing and reading makes a new one.
  useEffect(() => {
    if (!host.current) return;
    const { fill, stroke, label: labelColour } = themeColours();
    const options = { container: host.current, bpmnRenderer: { defaultFillColor: fill, defaultStrokeColor: stroke, defaultLabelColor: labelColour } };
    const d: Diagram = editable ? new Modeler(options) : new NavigatedViewer(options);
    diagram.current = d;
    shown.current = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = async () => {
      try {
        const { xml: out } = await d.saveXML({ format: true });
        if (out && out !== shown.current) {
          shown.current = out;
          handlers.current.onChange?.(out);
        }
      } catch {
        handlers.current.onError?.("The model could not be saved. Undo the last change and try again.");
      }
    };
    if (editable) {
      d.on("commandStack.changed", () => {
        clearTimeout(timer);
        timer = setTimeout(() => void save(), 450);
      });
    }
    d.on("selection.changed", (e: { newSelection: Diagram[] }) => handlers.current.onSelect?.(e.newSelection.length === 1 ? describe(e.newSelection[0]) : null));
    // Renaming in place changes the selected element without changing the selection.
    d.on("element.changed", (e: { element: Diagram }) => {
      const selected = d.get("selection").get();
      if (selected.length === 1 && selected[0] === e.element) handlers.current.onSelect?.(describe(e.element));
    });
    setReady((n) => n + 1);
    return () => {
      clearTimeout(timer);
      // A change still waiting is saved before the canvas goes.
      if (editable && timer) void save();
      d.destroy();
      diagram.current = null;
    };
  }, [editable]);

  // The file the canvas shows: read again only when it changed from outside (undo, someone else).
  useEffect(() => {
    const d = diagram.current;
    if (!d || !xml || xml === shown.current) return;
    let cancelled = false;
    const canvas = d.get("canvas");
    const first = !shown.current;
    const view = first ? null : canvas.viewbox();
    shown.current = xml;
    d.importXML(xml)
      .then(() => {
        if (cancelled) return;
        if (view) canvas.viewbox(view);
        else fitView(canvas, editable ? 120 : 24);
        handlers.current.onSelect?.(null);
        setReady((n) => n + 1);
      })
      .catch((error: Error) => {
        if (!cancelled) handlers.current.onError?.(`The BPMN file could not be shown: ${error.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [xml, ready]);

  // Labels and colours on top of the model.
  useEffect(() => {
    const d = diagram.current;
    if (!d || !shown.current) return;
    const registry = d.get("elementRegistry");
    const layer = d.get("overlays");
    const canvas = d.get("canvas");
    layer.remove({ type: "archone" });
    const marked: [string, string][] = [];
    for (const [id, o] of Object.entries(overlays ?? {})) {
      if (!registry.get(id)) continue;
      const el = document.createElement("span");
      el.className = `bpm-overlay bpm-overlay-${o.tone}`;
      el.textContent = o.text;
      if (o.title) el.title = o.title;
      layer.add(id, "archone", { position: { top: -11, right: 8 }, html: el });
    }
    for (const [id, kind] of Object.entries(markers ?? {})) {
      if (!registry.get(id)) continue;
      canvas.addMarker(id, `bpm-mark-${kind}`);
      marked.push([id, `bpm-mark-${kind}`]);
    }
    for (const [id, level] of Object.entries(heat ?? {})) {
      if (!registry.get(id)) continue;
      const cls = `bpm-heat-${Math.max(1, Math.min(4, Math.ceil(level * 4)))}`;
      canvas.addMarker(id, cls);
      marked.push([id, cls]);
    }
    return () => {
      for (const [id, cls] of marked) if (registry.get(id)) canvas.removeMarker(id, cls);
    };
  }, [overlays, markers, heat, ready]);

  useImperativeHandle(
    apiRef,
    () => ({
      place: (event, wanted, onPlaced) => {
        const d = diagram.current;
        if (!d || !editable) return false;
        const factory = d.get("elementFactory");
        const attrs: Record<string, unknown> = { type: wanted.type };
        if (wanted.eventDefinition) attrs.eventDefinitionType = wanted.eventDefinition;
        if (wanted.isExpanded !== undefined) attrs.isExpanded = wanted.isExpanded;
        if (wanted.triggeredByEvent) attrs.triggeredByEvent = true;
        if (wanted.cancelActivity === false) attrs.cancelActivity = false;
        const shape = wanted.participant ? factory.createParticipantShape() : factory.createShape(attrs);
        if (wanted.name) shape.businessObject.name = wanted.name;
        if (onPlaced) {
          const placed = (e: { context: { shape: Diagram } }) => {
            if (e.context.shape !== shape) return;
            d.off("commandStack.shape.create.postExecuted", placed);
            onPlaced(shape.businessObject.id);
          };
          d.on("commandStack.shape.create.postExecuted", placed);
        }
        d.get("create").start(event, shape);
        return true;
      },
      rename: (id, name) => {
        const d = diagram.current;
        const el = d?.get("elementRegistry").get(id);
        if (el && editable) d.get("modeling").updateLabel(el, name);
      },
      select: (id) => {
        const d = diagram.current;
        const el = d?.get("elementRegistry").get(id);
        if (!el) return;
        d.get("selection").select(el);
        d.get("canvas").scrollToElement(el, { top: 120, bottom: 120, left: 200, right: 200 });
      },
      fit: () => diagram.current && fitView(diagram.current.get("canvas"), editable ? 120 : 24),
      xml: async () => (await diagram.current.saveXML({ format: true })).xml as string,
      svg: async () => (await diagram.current.saveSVG()).svg as string,
    }),
    [editable],
  );

  return <div ref={host} data-own-undo data-bpmn-canvas={editable ? "edit" : "view"} role="application" aria-label={label} className={className ?? "h-full w-full"} />;
}
