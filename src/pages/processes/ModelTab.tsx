import { Download, FileUp, Maximize2 } from "lucide-react";
import { useMemo, useRef, useState, type RefObject } from "react";
import { Link } from "react-router-dom";
import BpmnCanvas, { type BpmnCanvasApi, type OverlayTone, type SelectedElement } from "@/components/bpm/BpmnCanvas";
import { BpmnSymbol, LibraryPanel, blockElement } from "@/components/bpm/BpmnLibrary";
import { Badge, Button, CommitInput, Field, Input, Select, Tabs, cx } from "@/components/ui";
import { blockFromStep, blockInfo, elementOf, saveBlock } from "@/lib/bpm/elements";
import { apply } from "@/lib/store";
import { downloadBlob, downloadText } from "@/lib/exporters";
import { parseBpmn, type BpmnGraph } from "@/lib/bpm/bpmn";
import { pathOf } from "@/lib/bpm/processes";
import { roleOf } from "@/lib/bpm/simulate";
import type { ProcessFinding } from "@/lib/bpm/validate";
import type { SimResult } from "@/lib/bpm/simulate";
import type { ProcessElementInfo, ProcessModel, Workspace } from "@/lib/types";
import { ObjectPicker, minutesLabel } from "./shared";

export type ColourBy = "none" | "checks" | "simulation" | "log";

const TYPE_LABEL: Record<string, string> = {
  task: "Task",
  userTask: "User task: a person does it",
  serviceTask: "Service task: software does it",
  manualTask: "Manual task: physical work",
  scriptTask: "Script task",
  businessRuleTask: "Business rule task: applies a decision table",
  sendTask: "Send task",
  receiveTask: "Receive task",
  subProcess: "Sub-process",
  callActivity: "Call activity: runs another process",
  startEvent: "Start event",
  endEvent: "End event",
  intermediateCatchEvent: "Intermediate event (waits)",
  intermediateThrowEvent: "Intermediate event (signals)",
  boundaryEvent: "Boundary event",
  exclusiveGateway: "Exclusive gateway: one way out",
  parallelGateway: "Parallel gateway: all ways at once",
  inclusiveGateway: "Inclusive gateway: one or more ways",
  eventBasedGateway: "Event-based gateway",
  sequenceFlow: "Sequence flow",
  messageFlow: "Message flow",
  dataObjectReference: "Data object",
  dataStoreReference: "Data store",
  textAnnotation: "Annotation",
  association: "Association",
};
const ACTIVITY = /Task$|^task$|^subProcess$|^callActivity$|^transaction$/;
const RACI = ["R", "A", "C", "I"] as const;

interface Props {
  ws: Workspace;
  process: ProcessModel;
  graph: BpmnGraph | null;
  canEdit: boolean;
  findings: ProcessFinding[];
  sim: SimResult | null;
  colourBy: ColourBy;
  setColourBy: (c: ColourBy) => void;
  apiRef: RefObject<BpmnCanvasApi | null>;
  onXml: (xml: string) => void;
  patchElement: (id: string, patch: Partial<ProcessElementInfo>) => void;
  onDecision: (stepId: string) => void;
}

export function ModelTab({ ws, process, graph, canEdit, findings, sim, colourBy, setColourBy, apiRef, onXml, patchElement, onDecision }: Props) {
  const [selected, setSelected] = useState<SelectedElement | null>(null);
  const [side, setSide] = useState<"details" | "library">("details");
  const [placing, setPlacing] = useState("");
  const [problem, setProblem] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState(false);

  const layers = useMemo(() => {
    const overlays: Record<string, { text: string; tone: OverlayTone; title?: string }> = {};
    const markers: Record<string, "error" | "warning" | "info"> = {};
    const heat: Record<string, number> = {};
    if (colourBy === "checks") {
      for (const f of findings) if (f.elementId && (!markers[f.elementId] || f.severity === "error")) markers[f.elementId] = f.severity;
    }
    if (colourBy === "simulation" && sim) {
      const top = Math.max(1, ...sim.steps.map((s) => s.meanWaitMinutes));
      for (const s of sim.steps) {
        overlays[s.id] = { text: `wait ${minutesLabel(s.meanWaitMinutes)}`, tone: s.meanWaitMinutes > top * 0.5 ? "red" : "grey", title: `${s.count} cases; waited ${minutesLabel(s.meanWaitMinutes)} and worked ${minutesLabel(s.meanWorkMinutes)} on average` };
        heat[s.id] = s.meanWaitMinutes / top;
      }
    }
    if (colourBy === "log" && process.mining && graph) {
      const byName = new Map(Object.entries(process.mining.activities).map(([k, v]) => [k.trim().toLowerCase(), v]));
      const top = Math.max(1, ...Object.values(process.mining.activities).map((a) => a.count));
      for (const n of Object.values(graph.nodes)) {
        if (n.kind !== "activity") continue;
        const a = byName.get(n.name.trim().toLowerCase());
        overlays[n.id] = a ? { text: `${a.count.toLocaleString()}×`, tone: "blue", title: `In the log ${a.count} times; median ${minutesLabel(a.medianMinutes)} from the step before` } : { text: "not in the log", tone: "amber" };
        if (a) heat[n.id] = a.count / top;
      }
    }
    return { overlays, markers, heat };
  }, [colourBy, findings, sim, process.mining, graph]);

  const exportPng = async () => {
    const svg = await apiRef.current?.svg();
    if (!svg) return;
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => b && downloadBlob(`${slug(process.name)}.png`, b), "image/png");
    };
    img.src = url;
  };

  const replace = async (f: File) => {
    setProblem("");
    const text = await f.text();
    try {
      parseBpmn(text);
      if (!text.includes("BPMNDiagram")) throw new Error("This BPMN file has no diagram to show.");
      onXml(text);
      setReplacing(false);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The file could not be read.");
    }
  };

  const errors = findings.filter((f) => f.severity === "error").length;
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_330px] items-start">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <div className="w-52">
            <Select value={colourBy} onChange={(e) => setColourBy(e.target.value as ColourBy)} aria-label="Show on the model" data-model-colour>
              <option value="none">Show the model only</option>
              <option value="checks">Show the checks ({findings.length})</option>
              <option value="simulation" disabled={!sim}>
                Show waits from the simulation
              </option>
              <option value="log" disabled={!process.mining}>
                Show how often, from the log
              </option>
            </Select>
          </div>
          {errors > 0 && <Badge tone="red">{errors === 1 ? "1 error" : `${errors} errors`}</Badge>}
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" icon={<Maximize2 size={14} />} onClick={() => apiRef.current?.fit()}>
              Fit
            </Button>
            <Button size="sm" icon={<Download size={14} />} onClick={() => void apiRef.current?.xml().then((x) => downloadText(`${slug(process.name)}.bpmn`, x, "application/xml"))} data-model-export>
              BPMN
            </Button>
            <Button size="sm" onClick={() => void apiRef.current?.svg().then((x) => downloadText(`${slug(process.name)}.svg`, x, "image/svg+xml"))}>
              SVG
            </Button>
            <Button size="sm" onClick={() => void exportPng()}>
              PNG
            </Button>
            {canEdit && (
              <Button size="sm" icon={<FileUp size={14} />} onClick={() => setReplacing((r) => !r)} aria-expanded={replacing}>
                Replace
              </Button>
            )}
          </div>
        </div>
        {replacing && (
          <div className="mb-2 rounded-md border border-signal bg-signal-soft px-3 py-2 text-[13px] flex flex-wrap items-center gap-2">
            <span>The model is replaced by the file you choose; earlier published versions stay in Versions.</span>
            <input ref={file} type="file" accept=".bpmn,.xml" className="sr-only" onChange={(e) => e.target.files?.[0] && void replace(e.target.files[0])} />
            <Button size="sm" onClick={() => file.current?.click()}>
              Choose a BPMN file
            </Button>
          </div>
        )}
        <div className="h-[calc(100vh-290px)] min-h-[480px] rounded-lg border border-line overflow-hidden" data-model-canvas>
          <BpmnCanvas
            apiRef={apiRef}
            xml={process.xml}
            editable={canEdit}
            onChange={onXml}
            onSelect={(element) => {
              setSelected(element);
              setPlacing("");
            }}
            onError={setProblem}
            overlays={layers.overlays}
            markers={layers.markers}
            heat={layers.heat}
            label={`Model of ${process.name}`}
          />
        </div>
        {problem && (
          <p className="mt-2 text-[13px] text-danger" role="alert">
            {problem}
          </p>
        )}
      </div>
      <aside className="rounded-lg border border-line bg-surface px-4 py-3 xl:sticky xl:top-4 max-h-[calc(100vh-120px)] overflow-y-auto" data-step-panel>
        <div className="mb-3">
          <Tabs
            tabs={[
              { id: "details", label: selected ? "Step" : "Process" },
              { id: "library", label: "BPMN library" },
            ]}
            value={side}
            onChange={setSide}
          />
        </div>
        {side === "library" ? (
          <>
            {placing && (
              <p className="mb-2 rounded-md bg-blueprint-soft px-2.5 py-1.5 text-[13px]" role="status" data-placing>
                Now click on the canvas where {placing} goes.
              </p>
            )}
            <LibraryPanel
              ws={ws}
              canEdit={canEdit}
              onPick={(element, event) => element.create && apiRef.current?.place(event, element.create, () => setPlacing("")) && setPlacing(`the ${element.name.toLowerCase()}`)}
              onPickBlock={(block, event) => {
                const create = blockElement(block.bpmn).create;
                if (create && apiRef.current?.place(event, { ...create, name: block.bpmn.name }, (id) => {
                  setPlacing("");
                  patchElement(id, blockInfo(block.bpmn));
                }))
                  setPlacing(`"${block.bpmn.name}"`);
              }}
            />
          </>
        ) : selected ? (
          <StepPanel key={selected.id} ws={ws} process={process} graph={graph} element={selected} canEdit={canEdit} apiRef={apiRef} patch={(p) => patchElement(selected.id, p)} findings={findings.filter((f) => f.elementId === selected.id)} onDecision={() => onDecision(selected.id)} />
        ) : (
          <ProcessSummary process={process} graph={graph} findings={findings} canEdit={canEdit} />
        )}
      </aside>
    </div>
  );
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "process";

function ProcessSummary({ process, graph, findings, canEdit }: { process: ProcessModel; graph: BpmnGraph | null; findings: ProcessFinding[]; canEdit: boolean }) {
  const steps = graph ? Object.values(graph.nodes).filter((n) => n.kind === "activity").length : 0;
  return (
    <div className="text-[13px] space-y-3">
      <h2 className="text-sm font-semibold">{process.name}</h2>
      <p className="text-ink-soft">
        {steps} steps{graph?.lanes.length ? ` in ${graph.lanes.length} lanes` : ""}, {findings.length ? `${findings.length} things to check` : "nothing to check"}.
      </p>
      {canEdit ? (
        <ul className="space-y-1.5 text-ink-soft list-disc pl-4">
          <li>Drag shapes from the toolbox on the left of the canvas; a shape's tools appear when you click it.</li>
          <li>Double-click a shape or a flow to name it; use the wrench to change its kind.</li>
          <li>Select a step to say how long it takes, who does it, and which systems it uses.</li>
          <li>Ctrl+Z on the canvas undoes the last change to the model.</li>
        </ul>
      ) : (
        <p className="text-ink-soft">Select a step to see how long it takes, who does it and which systems it uses.</p>
      )}
    </div>
  );
}

function NumberField({ label, value, onCommit, disabled, suffix, field }: { label: string; value: number | undefined; onCommit: (v: number | undefined) => void; disabled: boolean; suffix?: string; field?: string }) {
  return (
    <Field label={label}>
      <div className="relative">
        <CommitInput
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          disabled={disabled}
          value={value === undefined ? "" : String(value)}
          onCommit={(v) => onCommit(v.trim() === "" || !Number.isFinite(Number(v)) ? undefined : Math.max(0, Number(v)))}
          className={suffix ? "pr-9" : undefined}
          data-step-field={field}
        />
        {suffix && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-ink-faint pointer-events-none">{suffix}</span>}
      </div>
    </Field>
  );
}

function StepPanel({ ws, process, graph, element, canEdit, apiRef, patch, findings, onDecision }: { ws: Workspace; process: ProcessModel; graph: BpmnGraph | null; element: SelectedElement; canEdit: boolean; apiRef: RefObject<BpmnCanvasApi | null>; patch: (p: Partial<ProcessElementInfo>) => void; findings: ProcessFinding[]; onDecision: () => void }) {
  const info: ProcessElementInfo = process.elements[element.id] ?? { objectIds: [], raci: {} };
  const isActivity = ACTIVITY.test(element.type);
  const isChoice = element.type === "sequenceFlow" && /^(exclusiveGateway|inclusiveGateway)$/.test(element.sourceType ?? "");
  const node = graph?.nodes[element.id];
  const lane = element.laneName ?? "";
  const role = node && graph ? roleOf(graph, process, node) : "";
  const roles = [...new Set([...(graph?.lanes.map((l) => l.name).filter(Boolean) ?? []), ...Object.keys(info.raci)])];
  const [newRole, setNewRole] = useState("");
  const siblings = isChoice && graph && element.sourceId ? graph.nodes[element.sourceId]?.outgoing ?? [] : [];
  const siblingTotal = siblings.reduce((a, id) => a + (id === element.id ? 0 : process.elements[id]?.probability ?? 0), 0);
  const calls = Object.values(ws.processes).filter((p) => p.id !== process.id && p.xml);
  const about = elementOf(element.type, node?.trigger);
  const [kept, setKept] = useState(false);
  const d = info.duration;
  const setDuration = (key: "min" | "mode" | "max", v: number | undefined) => {
    const next = { min: d?.min ?? 0, mode: d?.mode ?? 0, max: d?.max ?? 0, [key]: v ?? 0 };
    if (!next.min && !next.mode && !next.max) return patch({ duration: undefined });
    // Keep least ≤ likely ≤ most, whichever was typed.
    if (key === "mode") {
      next.min = Math.min(next.min || next.mode, next.mode);
      next.max = Math.max(next.max || next.mode, next.mode);
    } else if (key === "min") {
      next.mode = Math.max(next.mode, next.min);
      next.max = Math.max(next.max, next.mode);
    } else {
      next.mode = Math.min(next.mode || next.max, next.max);
      next.min = Math.min(next.min, next.mode);
    }
    patch({ duration: next });
  };

  return (
    <div className="space-y-3 text-sm" data-step={element.id}>
      <div>
        <p className="text-[12px] text-ink-soft">{TYPE_LABEL[element.type] ?? element.type}</p>
        {element.type === "sequenceFlow" || isActivity || /Event$|Gateway$/.test(element.type) || element.type === "textAnnotation" ? (
          <CommitInput value={element.name} disabled={!canEdit} onCommit={(v) => apiRef.current?.rename(element.id, v.trim())} placeholder={isActivity ? "Verb and object: Check the order" : element.type === "sequenceFlow" ? "When it is taken: Yes" : "Name"} aria-label="Name" className="mt-1 font-medium" data-step-name />
        ) : (
          <p className="mt-1 font-medium">{element.name || "No name"}</p>
        )}
        {lane && <p className="mt-1 text-[12px] text-ink-soft">In the lane {lane}</p>}
      </div>
      {findings.length > 0 && (
        <ul className="space-y-1">
          {findings.map((f, i) => (
            <li key={i} className={cx("rounded-md px-2.5 py-1.5 text-[13px]", f.severity === "error" ? "bg-danger-soft text-danger" : f.severity === "warning" ? "bg-signal-soft text-signal" : "bg-blueprint-soft text-blueprint-deep")}>
              {f.message}
            </li>
          ))}
        </ul>
      )}
      {isChoice && (
        <div>
          <NumberField label="Share of cases taking this way" suffix="%" field="probability" value={info.probability} disabled={!canEdit} onCommit={(v) => patch({ probability: v === undefined ? undefined : Math.min(100, v) })} />
          <p className="mt-1 text-[12px] text-ink-faint">The other ways out of this decision have {Math.round(siblingTotal)}% between them. Used by the simulation.</p>
        </div>
      )}
      {isActivity && (
        <>
          <fieldset>
            <legend className="text-[13px] font-medium text-ink-soft mb-1">Time it takes, in minutes</legend>
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="Least" field="min" value={d?.min} disabled={!canEdit} onCommit={(v) => setDuration("min", v)} />
              <NumberField label="Usually" field="mode" value={d?.mode} disabled={!canEdit} onCommit={(v) => setDuration("mode", v)} />
              <NumberField label="Most" field="max" value={d?.max} disabled={!canEdit} onCommit={(v) => setDuration("max", v)} />
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Who does it">
              <CommitInput value={info.resource ?? ""} disabled={!canEdit} onCommit={(v) => patch({ resource: v.trim() || undefined })} placeholder={role || lane || "No one: automated"} maxLength={80} />
            </Field>
            <NumberField label="Cost each time" field="cost" value={info.cost} disabled={!canEdit} onCommit={(v) => patch({ cost: v })} />
          </div>
          <Field label="Automation">
            <Select value={info.automation ?? ""} disabled={!canEdit} onChange={(e) => patch({ automation: (e.target.value || undefined) as ProcessElementInfo["automation"] })} data-step-automation>
              <option value="">Not said</option>
              <option value="manual">Done by hand</option>
              <option value="partly">Partly automated</option>
              <option value="automated">Automated</option>
              <option value="candidate">A candidate for automation</option>
            </Select>
          </Field>
          <div>
            <p className="text-[13px] font-medium text-ink-soft mb-1">Systems and data it uses</p>
            <ObjectPicker ws={ws} ids={info.objectIds} canEdit={canEdit} onChange={(objectIds) => patch({ objectIds })} />
          </div>
          <fieldset>
            <legend className="text-[13px] font-medium text-ink-soft mb-1">Who is responsible (RACI)</legend>
            {roles.length === 0 && <p className="text-[12px] text-ink-faint">Add lanes to the model, or a role here.</p>}
            <ul className="space-y-1">
              {roles.map((r) => (
                <li key={r} className="flex items-center gap-2">
                  <span className="flex-1 truncate text-[13px]">{r}</span>
                  <div className="flex gap-0.5" role="radiogroup" aria-label={`${r}'s part`}>
                    {RACI.map((x) => (
                      <button
                        key={x}
                        type="button"
                        role="radio"
                        aria-checked={info.raci[r] === x}
                        disabled={!canEdit}
                        title={{ R: "Responsible: does the work", A: "Accountable: answers for it", C: "Consulted", I: "Informed" }[x]}
                        onClick={() => {
                          const raci = { ...info.raci };
                          if (raci[r] === x) delete raci[r];
                          else raci[r] = x;
                          patch({ raci });
                        }}
                        className={cx("size-6 rounded text-[12px] font-semibold border", info.raci[r] === x ? "bg-blueprint text-white border-blueprint" : "border-line text-ink-soft hover:border-ink-faint")}
                      >
                        {x}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            {canEdit && (
              <form
                className="mt-1.5 flex gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const r = newRole.trim();
                  if (r && !info.raci[r]) patch({ raci: { ...info.raci, [r]: "C" } });
                  setNewRole("");
                }}
              >
                <Input value={newRole} onChange={(e) => setNewRole(e.target.value)} placeholder="Another role" aria-label="Another role" maxLength={80} />
                <Button size="sm" type="submit" disabled={!newRole.trim()}>
                  Add
                </Button>
              </form>
            )}
          </fieldset>
          {element.type === "businessRuleTask" && (
            <Field label="Decision table it applies">
              <div className="flex gap-1.5">
                <Select value={info.decisionId ?? ""} disabled={!canEdit} onChange={(e) => patch({ decisionId: e.target.value || undefined })} data-step-decision>
                  <option value="">None yet</option>
                  {Object.values(process.decisions).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
                {canEdit && !info.decisionId && (
                  <Button size="sm" onClick={onDecision}>
                    New
                  </Button>
                )}
              </div>
            </Field>
          )}
          {element.type === "callActivity" && (
            <Field label="Process it runs">
              <Select value={info.calledProcessId ?? ""} disabled={!canEdit} onChange={(e) => patch({ calledProcessId: e.target.value || undefined })}>
                <option value="">Not linked</option>
                {calls.map((p) => (
                  <option key={p.id} value={p.id}>
                    {pathOf(ws, p.id)
                      .map((x) => x.name)
                      .join(" / ")}
                  </option>
                ))}
              </Select>
              {info.calledProcessId && ws.processes[info.calledProcessId] && (
                <Link to={`/processes/${info.calledProcessId}`} className="mt-1 inline-block text-[13px] text-blueprint hover:underline">
                  Open {ws.processes[info.calledProcessId].name}
                </Link>
              )}
            </Field>
          )}
        </>
      )}
      <Field label="Notes">
        <CommitInput multiline rows={3} value={info.notes ?? ""} disabled={!canEdit} onCommit={(v) => patch({ notes: v.trim() || undefined })} maxLength={4000} placeholder={isActivity ? "Inputs, outputs, the rules it follows, known problems" : ""} />
      </Field>
      {isActivity && canEdit && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={kept}
            onClick={() => {
              apply((w) => saveBlock(w, blockFromStep({ type: element.type, name: element.name, trigger: node?.trigger }, info.resource ?? (lane || role), info)).ws);
              setKept(true);
            }}
            data-step-save-block
          >
            {kept ? "Saved to the BPMN library" : "Save to the BPMN library"}
          </Button>
          {kept && (
            <Link to="/bpmn-library" className="text-[13px] text-blueprint hover:underline">
              Open it
            </Link>
          )}
        </div>
      )}
      {about && (
        <div className="rounded-md bg-paper px-3 py-2 text-[13px]" data-step-about={about.id}>
          <p className="flex items-center gap-2 font-medium">
            <BpmnSymbol element={about} size={20} /> {about.name} <span className="font-normal text-ink-soft">·</span>
            <span className="font-normal text-ink-soft" dir="rtl">
              {about.nameAr}
            </span>
          </p>
          <p className="mt-1 text-ink-soft">{about.meaning}</p>
          <p className="mt-0.5 text-ink-soft" dir="rtl">
            {about.meaningAr}
          </p>
          <Link to="/bpmn-library" className="mt-1 inline-block text-blueprint hover:underline">
            More in the BPMN library
          </Link>
        </div>
      )}
    </div>
  );
}
