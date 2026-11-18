import { Link2, Network, Workflow, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, IconButton, Select } from "@/components/ui";
import { VIEW_TYPE_INFO } from "@/lib/catalog";
import { LEVEL_LABEL, STATUS_LABEL, diagramsOfProcess, linksOf, linkProcessDiagram, pathOf, processesOfDiagram, processesUsing } from "@/lib/bpm/processes";
import { apply } from "@/lib/store";
import type { Diagram, ProcessModel, Workspace } from "@/lib/types";

/**
 * Links between architecture diagrams and business processes, both ways and as many as needed: a
 * diagram shows the systems a process runs on; a process says which diagrams draw them. The links
 * are kept on the process.
 */

const pathText = (ws: Workspace, id: string) =>
  pathOf(ws, id)
    .map((p) => p.name)
    .join(" / ");

/** Processes whose steps use what a diagram shows, not linked to it yet. */
function suggestedProcesses(ws: Workspace, diagram: Diagram): { process: ProcessModel; uses: string[] }[] {
  const found = new Map<string, Set<string>>();
  for (const objectId of Object.keys(diagram.nodes)) {
    if (!ws.objects[objectId]) continue;
    for (const { process } of processesUsing(ws, objectId)) {
      if (linksOf(process).includes(diagram.id)) continue;
      found.set(process.id, (found.get(process.id) ?? new Set()).add(ws.objects[objectId].name));
    }
  }
  return [...found.entries()].map(([id, uses]) => ({ process: ws.processes[id], uses: [...uses] })).sort((a, b) => b.uses.length - a.uses.length || a.process.name.localeCompare(b.process.name));
}

/** Diagrams that show the systems a process's steps use, not linked to it yet. */
function suggestedDiagrams(ws: Workspace, process: ProcessModel): { diagram: Diagram; shows: string[] }[] {
  const used = new Set([...Object.values(process.elements).flatMap((e) => e.objectIds), ...(process.objectId ? [process.objectId] : [])].filter((id) => ws.objects[id]));
  if (!used.size) return [];
  return Object.values(ws.diagrams)
    .filter((d) => !linksOf(process).includes(d.id) && !d.archive?.archived)
    .map((d) => ({ diagram: d, shows: [...used].filter((id) => id in d.nodes).map((id) => ws.objects[id].name) }))
    .filter((x) => x.shows.length)
    .sort((a, b) => b.shows.length - a.shows.length || a.diagram.name.localeCompare(b.diagram.name))
    .slice(0, 8);
}

/** The diagram editor's panel: the processes this diagram is linked to. */
export function DiagramProcessesPanel({ ws, diagram, canEdit, onClose }: { ws: Workspace; diagram: Diagram; canEdit: boolean; onClose: () => void }) {
  const linked = processesOfDiagram(ws, diagram.id);
  const suggested = useMemo(() => suggestedProcesses(ws, diagram), [ws, diagram]);
  const others = useMemo(
    () =>
      Object.values(ws.processes)
        .filter((p) => !linksOf(p).includes(diagram.id))
        .sort((a, b) => pathText(ws, a.id).localeCompare(pathText(ws, b.id))),
    [ws, diagram.id],
  );
  const [choice, setChoice] = useState("");
  const link = (processId: string, on: boolean) => apply((w) => linkProcessDiagram(w, processId, diagram.id, on));

  return (
    <div className="flex h-full flex-col text-sm" data-diagram-processes>
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Workflow size={16} className="text-ink-soft" aria-hidden />
        <h2 className="font-semibold">Business processes</h2>
        <Badge>{linked.length}</Badge>
        <IconButton label="Close the processes" className="ml-auto" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <p className="text-[13px] text-ink-soft">The BPMN processes this diagram supports. A diagram can be linked to many processes, and a process to many diagrams.</p>
        {linked.length === 0 ? (
          <p className="text-[13px] text-ink-faint">No process is linked yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {linked.map((p) => (
              <li key={p.id} className="flex items-start gap-2 rounded-md border border-line px-2.5 py-2" data-linked-process={p.id}>
                <div className="min-w-0 flex-1">
                  <Link to={`/processes/${p.id}`} className="font-medium text-blueprint hover:underline">
                    {p.name}
                  </Link>
                  <p className="text-[12px] text-ink-soft">
                    L{p.level} · {LEVEL_LABEL[p.level]} · {STATUS_LABEL[p.status]}
                    {p.parentId ? ` · in ${pathText(ws, p.parentId)}` : ""}
                  </p>
                </div>
                {canEdit && (
                  <IconButton label={`Unlink ${p.name}`} className="size-7" onClick={() => link(p.id, false)}>
                    <X size={14} />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && others.length > 0 && (
          <div className="flex gap-1.5">
            <Select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="A process to link" data-link-process-choice>
              <option value="">Link a process…</option>
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {pathText(ws, p.id)}
                </option>
              ))}
            </Select>
            <Button
              icon={<Link2 size={14} />}
              disabled={!choice}
              onClick={() => {
                link(choice, true);
                setChoice("");
              }}
              data-link-process
            >
              Link
            </Button>
          </div>
        )}
        {canEdit && suggested.length > 0 && (
          <div>
            <p className="text-[13px] font-medium">Their steps use what this diagram shows</p>
            <ul className="mt-1.5 space-y-1">
              {suggested.slice(0, 8).map(({ process, uses }) => (
                <li key={process.id} className="flex items-center gap-2 text-[13px]" data-suggested-process={process.id}>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{process.name}</span> <span className="text-ink-soft">uses {uses.slice(0, 3).join(", ")}{uses.length > 3 ? ` and ${uses.length - 3} more` : ""}</span>
                  </span>
                  <Button size="sm" onClick={() => link(process.id, true)}>
                    Link
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {Object.keys(ws.processes).length === 0 && (
          <p className="text-[13px] text-ink-soft">
            There are no processes yet.{" "}
            <Link to="/processes" className="text-blueprint hover:underline">
              Open the process landscape
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}

/** The process page's tab: the diagrams this process is linked to. */
export function ProcessDiagramsTab({ ws, process, canEdit }: { ws: Workspace; process: ProcessModel; canEdit: boolean }) {
  const linked = diagramsOfProcess(ws, process);
  const suggested = useMemo(() => suggestedDiagrams(ws, process), [ws, process]);
  const others = useMemo(
    () =>
      Object.values(ws.diagrams)
        .filter((d) => !linksOf(process).includes(d.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [ws.diagrams, process],
  );
  const [choice, setChoice] = useState("");
  const link = (diagramId: string, on: boolean) => apply((w) => linkProcessDiagram(w, process.id, diagramId, on));

  return (
    <div className="max-w-4xl space-y-5" data-process-diagrams>
      <p className="text-[13px] text-ink-soft">The architecture diagrams this process is linked to: the systems, servers and networks it runs on, drawn. A process can be linked to many diagrams, and a diagram to many processes.</p>
      {linked.length === 0 ? (
        <p className="text-[13px] text-ink-faint">No diagram is linked yet.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {linked.map((d) => (
            <li key={d.id} className="flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5" data-linked-diagram={d.id}>
              <Network size={18} className="mt-0.5 text-ink-soft" aria-hidden />
              <div className="min-w-0 flex-1">
                <Link to={`/diagram/${d.id}`} className="font-medium text-blueprint hover:underline">
                  {d.name}
                </Link>
                <p className="text-[12.5px] text-ink-soft">
                  {VIEW_TYPE_INFO[d.viewType].label} · {Object.keys(d.nodes).filter((id) => ws.objects[id]).length} objects · linked to {processesOfDiagram(ws, d.id).length} {processesOfDiagram(ws, d.id).length === 1 ? "process" : "processes"}
                </p>
              </div>
              {canEdit && (
                <IconButton label={`Unlink ${d.name}`} className="size-7" onClick={() => link(d.id, false)}>
                  <X size={14} />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && others.length > 0 && (
        <div className="flex max-w-lg gap-1.5">
          <Select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="A diagram to link" data-link-diagram-choice>
            <option value="">Link a diagram…</option>
            {others.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          <Button
            icon={<Link2 size={14} />}
            disabled={!choice}
            onClick={() => {
              link(choice, true);
              setChoice("");
            }}
            data-link-diagram
          >
            Link
          </Button>
        </div>
      )}
      {canEdit && suggested.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold">Diagrams that show what its steps use</h3>
          <ul className="mt-2 space-y-1">
            {suggested.map(({ diagram, shows }) => (
              <li key={diagram.id} className="flex items-center gap-2 text-[13px]" data-suggested-diagram={diagram.id}>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{diagram.name}</span> <span className="text-ink-soft">shows {shows.slice(0, 3).join(", ")}{shows.length > 3 ? ` and ${shows.length - 3} more` : ""}</span>
                </span>
                <Button size="sm" onClick={() => link(diagram.id, true)}>
                  Link
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
