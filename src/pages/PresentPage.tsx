import { ArrowLeft, ArrowRight, Clapperboard, Maximize2, Minimize2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { DiagramCanvas, type CanvasHandle } from "@/components/canvas/DiagramCanvas";
import { DiagramTitleBlock, useDiagramRecord } from "@/components/approvals/TitleBlock";
import { FlowBar, NO_FLOW, useFlowCursor, useFlowKeys } from "@/components/Flows";
import { Button, EmptyState, IconButton } from "@/components/ui";
import type { Diagram } from "@/lib/types";
import { VIEW_TYPE_INFO } from "@/lib/catalog";
import { sortedDiagrams } from "@/lib/model";
import { useWorkspace } from "@/lib/store";

const NOTHING: Diagram = { id: "", name: "", description: "", viewType: "custom" as const, scopeId: null, direction: "TB" as const, nodes: {}, hiddenRelationshipIds: [], edgeKinds: null, colorBy: "type" as const, createdAt: "", updatedAt: "" };

/**
 * A diagram on its own, for a meeting room or a shared screen: nothing can be changed, the
 * arrow keys walk through the diagrams, and a double click on a box opens its inside view.
 */
export function PresentPage() {
  const { id = "" } = useParams();
  const ws = useWorkspace();
  const navigate = useNavigate();
  const diagrams = sortedDiagrams(ws);
  const index = diagrams.findIndex((d) => d.id === id);
  const diagram = diagrams[index];
  // Hooks run before the "no such diagram" exit below, so they are given an empty diagram to hold.
  const flows = useFlowCursor(ws, diagram ?? NOTHING);
  const approval = useDiagramRecord(ws, diagram ?? NOTHING);
  // While a flow is open the arrow keys walk its steps; with none open they move between diagrams.
  useFlowKeys(!!flows.flow, flows.move, () => flows.setCursor(NO_FLOW));
  const canvas = useRef<CanvasHandle>(null);
  const building = useRef(false);
  const frame = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  // Where "back" returns to after opening the inside of a box.
  const [trail, setTrail] = useState<string[]>([]);

  const go = useCallback((to: string | undefined) => to && navigate(`/present/${to}`, { replace: true }), [navigate]);
  const leave = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    navigate(id && ws.diagrams[id] ? `/diagram/${id}` : "/");
  }, [navigate, id, ws.diagrams]);
  const step = useCallback(
    (by: number) => {
      if (index < 0 || diagrams.length < 2) return;
      setTrail([]);
      go(diagrams[(index + by + diagrams.length) % diagrams.length].id);
    },
    [index, diagrams, go],
  );
  const back = useCallback(() => {
    const previous = trail.at(-1);
    if (!previous) return;
    setTrail((t) => t.slice(0, -1));
    go(previous);
  }, [trail, go]);
  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void frame.current?.requestFullscreen?.().catch(() => undefined);
  }, []);

  useEffect(() => {
    const changed = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // While the diagram builds itself, Esc and the space bar belong to the animation.
      if (building.current) return;
      if (e.key === "b" || e.key === "B") {
        canvas.current?.build();
        e.preventDefault();
        return;
      }
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") step(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") step(-1);
      else if (e.key === "Backspace") back();
      else if (e.key === "f" || e.key === "F") toggleFull();
      // In full screen the browser itself takes Escape to leave full screen.
      else if (e.key === "Escape" && !document.fullscreenElement) leave();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [step, back, toggleFull, leave]);
  useEffect(() => {
    const timer = setTimeout(() => canvas.current?.fit(), 80);
    return () => clearTimeout(timer);
  }, [id, full]);

  const inside = useCallback(
    (objectId: string) => {
      const detail = diagrams.find((d) => d.scopeId === objectId && d.id !== id);
      if (!detail) return;
      setTrail((t) => [...t, id]);
      go(detail.id);
    },
    [diagrams, id, go],
  );

  if (!diagram) {
    return (
      <div className="h-full grid place-items-center bg-paper">
        <EmptyState title="This diagram cannot be shown" text="It may have been deleted.">
          <Button variant="primary" onClick={() => navigate("/")}>
            Go to diagrams
          </Button>
        </EmptyState>
      </div>
    );
  }

  return (
    <div ref={frame} className="h-full flex flex-col bg-paper" data-present={diagram.id}>
      <header className="shrink-0 flex items-center gap-3 h-14 px-5 bg-surface border-b border-line">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold truncate">{diagram.name}</h1>
          <p className="text-xs text-ink-soft truncate">
            {VIEW_TYPE_INFO[diagram.viewType].label}
            {diagram.scopeId && ws.objects[diagram.scopeId] ? `, inside ${ws.objects[diagram.scopeId].name}` : ""}
            {diagram.description ? `. ${diagram.description}` : ""}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {trail.length > 0 && (
            <Button size="sm" onClick={back} title="Back to the diagram you came from (Backspace)">
              Back out
            </Button>
          )}
          <IconButton label="Previous diagram (left arrow)" disabled={diagrams.length < 2} onClick={() => step(-1)}>
            <ArrowLeft size={17} />
          </IconButton>
          <span className="text-[13px] text-ink-soft tabular-nums px-1" data-present-count>
            {index + 1} of {diagrams.length}
          </span>
          <IconButton label="Next diagram (right arrow)" disabled={diagrams.length < 2} onClick={() => step(1)}>
            <ArrowRight size={17} />
          </IconButton>
          <span className="mx-1 h-5 w-px bg-line" />
          <Button size="sm" icon={<Clapperboard size={14} />} title="Watch the diagram build itself, from the bottom up (B)" onClick={() => canvas.current?.build()} data-build-play="ready">
            Build
          </Button>
          <IconButton label={full ? "Leave full screen (F)" : "Full screen (F)"} onClick={toggleFull}>
            {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </IconButton>
          <IconButton label="Stop presenting (Esc)" onClick={leave}>
            <X size={17} />
          </IconButton>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        <DiagramCanvas ws={ws} diagram={diagram} readOnly canvasRef={canvas} onOpen={inside} spotlight={flows.spotlight} onBuild={(on) => (building.current = on)} />
        <FlowBar ws={ws} diagram={diagram} cursor={flows.cursor} onCursor={flows.setCursor} />
        <DiagramTitleBlock ws={ws} diagram={diagram} record={approval.record} />
      </div>
    </div>
  );
}
