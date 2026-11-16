import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, CommitInput, Field, IconButton, Select } from "@/components/ui";
import { MAX_FLOWS, MAX_STEPS, addFlow, addStep, deleteFlow, deleteStep, flowsOf, moveStep, stepRoute, stepView, updateFlow, updateStep } from "@/lib/flows";
import { apply } from "@/lib/store";
import type { Diagram, Flow, Workspace } from "@/lib/types";

/** Which flow is open and which of its steps is lit. No flow open means the diagram is shown as usual. */
export interface FlowCursor {
  flowId: string | null;
  index: number;
}
export const NO_FLOW: FlowCursor = { flowId: null, index: 0 };

/** The open flow and step of a diagram, kept valid as the diagram changes underneath. */
export function useFlowCursor(ws: Workspace, diagram: Diagram) {
  const [cursor, setCursor] = useState<FlowCursor>(NO_FLOW);
  useEffect(() => setCursor(NO_FLOW), [diagram.id]);
  const flow = flowsOf(diagram).find((f) => f.id === cursor.flowId) ?? null;
  const index = flow ? Math.min(Math.max(cursor.index, 0), Math.max(flow.steps.length - 1, 0)) : 0;
  const step = flow?.steps[index] ?? null;
  const spotlight = useMemo(() => (flow && step ? stepView(ws, diagram, step) : null), [ws, diagram, flow, step]);
  const move = useCallback(
    (by: number) => setCursor((c) => (flow ? { flowId: c.flowId, index: Math.min(Math.max(index + by, 0), Math.max(flow.steps.length - 1, 0)) } : c)),
    [flow, index],
  );
  return { cursor: { flowId: flow?.id ?? null, index }, setCursor, flow, step, index, spotlight, move };
}

/**
 * The strip under a diagram that walks through a flow. It only reads: choosing a flow and
 * moving between steps changes nothing in the model, so it is the same for a viewer of a
 * shared link as for an editor.
 */
export function FlowBar({ ws, diagram, cursor, onCursor }: { ws: Workspace; diagram: Diagram; cursor: FlowCursor; onCursor: (next: FlowCursor) => void }) {
  const flows = flowsOf(diagram);
  const flow = flows.find((f) => f.id === cursor.flowId) ?? null;
  if (!flows.length) return null;
  const step = flow?.steps[cursor.index] ?? null;
  const view = flow && step ? stepView(ws, diagram, step) : null;
  const last = flow ? flow.steps.length - 1 : 0;
  return (
    <div className="absolute bottom-4 left-16 right-[232px] z-10 mx-auto max-w-[620px] rounded-lg border border-line bg-surface shadow-md" data-flow-bar={flow?.id ?? "closed"}>
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <Select
          aria-label="Flow to walk through"
          className="!h-8 min-w-0 flex-1"
          value={flow?.id ?? ""}
          onChange={(e) => onCursor({ flowId: e.target.value || null, index: 0 })}
        >
          <option value="">{flows.length === 1 ? "Walk through a flow" : `Walk through one of ${flows.length} flows`}</option>
          {flows.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
        {flow && (
          <>
            <IconButton label="Previous step (left arrow)" disabled={cursor.index <= 0} onClick={() => onCursor({ flowId: flow.id, index: cursor.index - 1 })}>
              <ArrowLeft size={16} />
            </IconButton>
            <span className="text-[13px] text-ink-soft tabular-nums whitespace-nowrap" data-flow-count>
              {flow.steps.length ? `${cursor.index + 1} of ${flow.steps.length}` : "No steps"}
            </span>
            <IconButton label="Next step (right arrow)" disabled={cursor.index >= last} onClick={() => onCursor({ flowId: flow.id, index: cursor.index + 1 })}>
              <ArrowRight size={16} />
            </IconButton>
            <IconButton label="Stop walking through the flow" onClick={() => onCursor(NO_FLOW)}>
              <X size={16} />
            </IconButton>
          </>
        )}
      </div>
      {flow && (
        <div className="px-3.5 pb-2.5 text-sm" aria-live="polite" data-flow-step>
          {step ? (
            <>
              <p className="font-medium">{stepRoute(ws, step)}</p>
              {step.text && <p className="text-ink-soft whitespace-pre-wrap">{step.text}</p>}
              {view?.missing && <p className="text-[13px] text-signal">A box of this step is no longer on the diagram.</p>}
              {view && !view.missing && step.fromId !== step.toId && view.edges.length === 0 && <p className="text-[13px] text-ink-faint">The diagram draws no arrow between these two.</p>}
            </>
          ) : (
            <p className="text-ink-soft">{flow.description || "This flow has no steps yet."}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Left and right arrows walk the open flow. Typing in a field is left alone. */
export function useFlowKeys(active: boolean, move: (by: number) => void, stop: () => void) {
  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (e.key === "ArrowRight") move(1);
      else if (e.key === "ArrowLeft") move(-1);
      else if (e.key === "Escape") stop();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    // Capture, so a page with its own arrow keys (presenting) lets the flow have them while one is open.
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [active, move, stop]);
}

function StepRow({ ws, diagram, flow, index, lit, canEdit, onPick }: { ws: Workspace; diagram: Diagram; flow: Flow; index: number; lit: boolean; canEdit: boolean; onPick: () => void }) {
  const step = flow.steps[index];
  const boxes = Object.keys(diagram.nodes)
    .map((id) => ws.objects[id])
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  const gone = (id: string) => !(id in diagram.nodes) || !ws.objects[id];
  const options = (current: string) => (
    <>
      {gone(current) && <option value={current}>No longer on the diagram</option>}
      {boxes.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </>
  );
  return (
    <li className={`rounded-md border px-2.5 py-2 ${lit ? "border-blueprint bg-blueprint-soft/40" : "border-line"}`} data-flow-step-row={index + 1} aria-current={lit ? "step" : undefined}>
      <div className="flex items-start gap-2">
        <button type="button" className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-blueprint text-white text-[11px] font-semibold tabular-nums" title="Show this step on the diagram" onClick={onPick}>
          {index + 1}
        </button>
        {canEdit ? (
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="grid grid-cols-2 gap-1.5">
              <Select aria-label={`Step ${index + 1} starts at`} className="!h-8" value={step.fromId} onChange={(e) => apply((w) => updateStep(w, diagram.id, flow.id, step.id, { fromId: e.target.value }))}>
                {options(step.fromId)}
              </Select>
              <Select aria-label={`Step ${index + 1} goes to`} className="!h-8" value={step.toId} onChange={(e) => apply((w) => updateStep(w, diagram.id, flow.id, step.id, { toId: e.target.value }))}>
                {options(step.toId)}
              </Select>
            </div>
            <CommitInput
              multiline
              rows={2}
              aria-label={`What happens in step ${index + 1}`}
              placeholder="What happens in this step"
              value={step.text}
              onCommit={(text) => apply((w) => updateStep(w, diagram.id, flow.id, step.id, { text }))}
              onFocus={onPick}
            />
            <div className="flex items-center gap-0.5">
              <IconButton label={`Move step ${index + 1} up`} className="size-7" disabled={index === 0} onClick={() => apply((w) => moveStep(w, diagram.id, flow.id, step.id, -1))}>
                <ArrowUp size={14} />
              </IconButton>
              <IconButton label={`Move step ${index + 1} down`} className="size-7" disabled={index === flow.steps.length - 1} onClick={() => apply((w) => moveStep(w, diagram.id, flow.id, step.id, 1))}>
                <ArrowDown size={14} />
              </IconButton>
              <IconButton label={`Remove step ${index + 1}`} className="size-7 ml-auto" onClick={() => apply((w) => deleteStep(w, diagram.id, flow.id, step.id))}>
                <Trash2 size={14} />
              </IconButton>
            </div>
          </div>
        ) : (
          <button type="button" className="min-w-0 flex-1 text-left" onClick={onPick}>
            <span className="block text-[13px] font-medium">{stepRoute(ws, step)}</span>
            {step.text && <span className="block text-[13px] text-ink-soft whitespace-pre-wrap">{step.text}</span>}
          </button>
        )}
      </div>
    </li>
  );
}

/** The side panel of the editor: the flows of this diagram, and the steps of the open one. */
export function FlowsPanel({
  ws,
  diagram,
  cursor,
  canEdit,
  onCursor,
  onClose,
}: {
  ws: Workspace;
  diagram: Diagram;
  cursor: FlowCursor;
  canEdit: boolean;
  onCursor: (next: FlowCursor) => void;
  onClose: () => void;
}) {
  const flows = flowsOf(diagram);
  const flow = flows.find((f) => f.id === cursor.flowId) ?? null;
  const boxes = Object.keys(diagram.nodes)
    .map((id) => ws.objects[id])
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const fromId = from && from in diagram.nodes ? from : (boxes[0]?.id ?? "");
  const toId = to && to in diagram.nodes ? to : (boxes[1]?.id ?? boxes[0]?.id ?? "");
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setConfirm(false), [cursor.flowId]);

  const create = () => {
    let made: string | null = null;
    apply((w) => {
      const result = addFlow(w, diagram.id, "");
      made = result.flow?.id ?? null;
      return result.ws;
    });
    if (made) onCursor({ flowId: made, index: 0 });
  };

  return (
    <div className="h-full flex flex-col" data-flows-panel>
      <div className="flex items-start gap-2 px-4 py-3.5 border-b border-line-soft">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{flow ? "Flow" : "Flows"}</h2>
          <p className="text-[13px] text-ink-soft mt-0.5">
            {flow ? "The steps of one use case, in order, over this diagram." : "A flow tells one use case step by step over this diagram, for example how a customer pays an invoice."}
          </p>
        </div>
        <IconButton label="Close panel" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>

      {!flow ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5 space-y-3">
          {flows.length === 0 && <p className="text-[13px] text-ink-faint">{canEdit ? "No flows yet. Start one, then click the arrows on the diagram in the order things happen." : "This diagram has no flows."}</p>}
          <ul className="space-y-1.5">
            {flows.map((f) => (
              <li key={f.id}>
                <button type="button" className="w-full rounded-md border border-line px-3 py-2 text-left hover:border-blueprint hover:bg-blueprint-soft/40" data-flow-open={f.id} onClick={() => onCursor({ flowId: f.id, index: 0 })}>
                  <span className="block text-[13px] font-medium">{f.name}</span>
                  <span className="block text-xs text-ink-faint">
                    {f.steps.length} {f.steps.length === 1 ? "step" : "steps"}
                    {f.description ? `. ${f.description}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {canEdit && (
            <Button variant="primary" icon={<Plus size={15} />} disabled={flows.length >= MAX_FLOWS} onClick={create}>
              New flow
            </Button>
          )}
          {flows.length >= MAX_FLOWS && <p className="text-xs text-ink-faint">A diagram holds up to {MAX_FLOWS} flows.</p>}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5 space-y-3.5">
          <button type="button" className="text-[13px] text-blueprint hover:underline" onClick={() => onCursor(NO_FLOW)}>
            All flows of this diagram
          </button>
          {canEdit ? (
            <>
              <Field label="Name">
                <CommitInput aria-label="Flow name" value={flow.name} onCommit={(name) => apply((w) => updateFlow(w, diagram.id, flow.id, { name }))} />
              </Field>
              <Field label="What it shows">
                <CommitInput multiline rows={2} aria-label="What the flow shows" value={flow.description} placeholder="Optional" onCommit={(description) => apply((w) => updateFlow(w, diagram.id, flow.id, { description }))} />
              </Field>
            </>
          ) : (
            <div>
              <h3 className="text-sm font-semibold">{flow.name}</h3>
              {flow.description && <p className="text-[13px] text-ink-soft mt-0.5">{flow.description}</p>}
            </div>
          )}

          <div>
            <h3 className="text-[13px] font-semibold mb-1.5">Steps</h3>
            {flow.steps.length === 0 && <p className="text-[13px] text-ink-faint">{canEdit ? "No steps yet. Click an arrow on the diagram to add it as the next step, or choose the two boxes below." : "No steps yet."}</p>}
            <ol className="space-y-1.5">
              {flow.steps.map((s, i) => (
                <StepRow key={s.id} ws={ws} diagram={diagram} flow={flow} index={i} lit={i === cursor.index} canEdit={canEdit} onPick={() => onCursor({ flowId: flow.id, index: i })} />
              ))}
            </ol>
          </div>

          {canEdit && boxes.length > 0 && flow.steps.length < MAX_STEPS && (
            <div className="rounded-md border border-dashed border-line px-2.5 py-2.5 space-y-1.5" data-flow-add>
              <p className="text-[13px] text-ink-soft">Add a step: click an arrow on the diagram, or choose where it starts and where it goes.</p>
              <div className="grid grid-cols-2 gap-1.5">
                <Select aria-label="New step starts at" className="!h-8" value={fromId} onChange={(e) => setFrom(e.target.value)}>
                  {boxes.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
                <Select aria-label="New step goes to" className="!h-8" value={toId} onChange={(e) => setTo(e.target.value)}>
                  {boxes.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              </div>
              <Button
                size="sm"
                icon={<Plus size={14} />}
                onClick={() => {
                  apply((w) => addStep(w, diagram.id, flow.id, fromId, toId).ws);
                  onCursor({ flowId: flow.id, index: flow.steps.length });
                }}
              >
                Add step
              </Button>
            </div>
          )}
          {flow.steps.length >= MAX_STEPS && <p className="text-xs text-ink-faint">A flow holds up to {MAX_STEPS} steps.</p>}

          {canEdit && (
            <div className="pt-1 border-t border-line-soft">
              {confirm ? (
                <div className="flex flex-wrap items-center gap-1.5 pt-2.5">
                  <span className="text-[13px]">Delete this flow and its {flow.steps.length} {flow.steps.length === 1 ? "step" : "steps"}?</span>
                  <Button size="sm" onClick={() => setConfirm(false)}>
                    Keep it
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      onCursor(NO_FLOW);
                      apply((w) => deleteFlow(w, diagram.id, flow.id));
                    }}
                  >
                    Delete flow
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="danger" className="mt-2.5" icon={<Trash2 size={14} />} onClick={() => setConfirm(true)}>
                  Delete flow
                </Button>
              )}
              <p className="mt-2 text-xs text-ink-faint">A flow belongs to this diagram. Deleting it leaves the model and the diagram as they are; Ctrl Z brings it back.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
