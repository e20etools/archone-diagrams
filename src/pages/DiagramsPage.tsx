import { Archive, BookmarkPlus, Copy, FileUp, LayoutTemplate, Plus, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AiDraftDialog } from "@/components/dialogs";
import { ArchiveDialog, ArchivedDialog, NewArchitectureDialog } from "@/components/NewArchitecture";
import { ImportDialog } from "@/components/ImportDialog";
import { Button, EmptyState, IconButton, Modal, formatDate } from "@/components/ui";
import { VIEW_TYPE_INFO } from "@/lib/catalog";
import { addEnterpriseSample } from "@/lib/enterpriseSample";
import { demoWorkspace } from "@/lib/demo";
import { archivedDiagrams, deleteDiagram, duplicateDiagram, sortedDiagrams } from "@/lib/model";
import { apply, useStore, useWorkspace } from "@/lib/store";
import { allTemplates, applyTemplate, deleteSavedTemplate } from "@/lib/templates";
import { TemplatePicker } from "@/components/TemplatePicker";
import { SaveAsTemplateDialog } from "@/components/SaveAsTemplate";
import { useCanEdit } from "@/lib/cloud/session";
import type { Diagram } from "@/lib/types";

export function DiagramsPage() {
  const ws = useWorkspace();
  const replace = useStore((s) => s.replace);
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<"new" | "ai" | "import" | "template" | "archived" | null>(null);
  const [archiving, setArchiving] = useState<Diagram | null>(null);
  const archivedCount = archivedDiagrams(ws).length;
  const [removing, setRemoving] = useState<Diagram | null>(null);
  const [templating, setTemplating] = useState<Diagram | null>(null);
  const canEdit = useCanEdit();
  const diagrams = sortedDiagrams(ws);
  const blank = diagrams.length === 0 && Object.keys(ws.objects).length === 0;

  return (
    <div className="max-w-5xl mx-auto px-6 py-7">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Diagrams</h1>
          <p className="text-ink-soft mt-0.5">Each diagram is a view of one shared model. Change a component once and every diagram follows.</p>
        </div>
        {!blank && (
          <div className="flex gap-2 shrink-0">
            <Button icon={<FileUp size={15} />} title="Import a Visio or draw.io diagram, or a spreadsheet" onClick={() => setDialog("import")}>
              Import
            </Button>
            <Button icon={<LayoutTemplate size={15} />} onClick={() => setDialog("template")} data-template-open>
              Template
            </Button>
            <Button icon={<Sparkles size={15} />} onClick={() => setDialog("ai")}>
              Draft with AI
            </Button>
            <Button variant="primary" icon={<Plus size={15} />} data-new-diagram onClick={() => setDialog("new")}>
              New diagram
            </Button>
          </div>
        )}
      </div>

      {blank ? (
        <div className="mt-8 rounded-lg border border-dashed border-ink-faint bg-surface">
          <EmptyState
            title="Start your architecture model"
            text="Describe a system and let AI draft it, begin with an empty diagram, import a Visio or draw.io diagram or a spreadsheet, or load a sample model to look around first."
          >
            <Button variant="primary" icon={<Sparkles size={15} />} onClick={() => setDialog("ai")}>
              Draft with AI
            </Button>
            <Button icon={<Plus size={15} />} onClick={() => setDialog("new")}>
              New diagram
            </Button>
            <Button icon={<FileUp size={15} />} onClick={() => setDialog("import")}>
              Import a file
            </Button>
            <Button icon={<LayoutTemplate size={15} />} onClick={() => setDialog("template")} data-template-open>
              Start from a template
            </Button>
            <Button
              onClick={() => {
                const demo = demoWorkspace(ws.userName);
                replace(demo);
                const first = sortedDiagrams(demo).find((d) => d.viewType === "container") ?? sortedDiagrams(demo)[0];
                navigate(`/diagram/${first.id}`);
              }}
            >
              Load the sample model
            </Button>
            <Button
              data-enterprise-sample
              onClick={() => {
                const result = addEnterpriseSample(ws);
                if (result.added) {
                  apply(() => result.ws);
                  navigate("/map");
                }
              }}
            >
              Load the bank sample (10 diagrams)
            </Button>
          </EmptyState>
        </div>
      ) : diagrams.length === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed border-ink-faint bg-surface">
          <EmptyState title="No diagrams yet" text="The model has objects, but nothing draws them. Create a diagram to see them.">
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => setDialog("new")}>
              New diagram
            </Button>
          </EmptyState>
        </div>
      ) : (
        <div className="mt-6 rounded-lg border border-line bg-surface overflow-hidden">
          <table className="w-full text-left">
            <thead className="text-[13px] text-ink-soft bg-paper border-b border-line">
              <tr>
                <th className="font-medium px-4 py-2.5">Name</th>
                <th className="font-medium px-4 py-2.5">Shows</th>
                <th className="font-medium px-4 py-2.5 text-right">Objects</th>
                <th className="font-medium px-4 py-2.5">Last changed</th>
                <th className="px-4 py-2.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {diagrams.map((d) => (
                <tr key={d.id} className="border-b border-line-soft last:border-b-0 hover:bg-paper/60">
                  <td className="px-4 py-3">
                    <Link to={`/diagram/${d.id}`} className="font-medium text-blueprint hover:underline">
                      {d.name}
                    </Link>
                    {d.description && <p className="text-[13px] text-ink-soft mt-0.5">{d.description}</p>}
                  </td>
                  <td className="px-4 py-3 text-ink-soft whitespace-nowrap">
                    {VIEW_TYPE_INFO[d.viewType].label}
                    {d.scopeId && ws.objects[d.scopeId] && <span className="text-ink-faint">, {ws.objects[d.scopeId].name}</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{Object.keys(d.nodes).length}</td>
                  <td className="px-4 py-3 text-ink-soft whitespace-nowrap">{formatDate(d.updatedAt)}</td>
                  <td className="px-2 py-2 text-right whitespace-nowrap">
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
                    <IconButton label={`Duplicate ${d.name}`} onClick={() => apply((w) => duplicateDiagram(w, d.id).ws)}>
                      <Copy size={15} />
                    </IconButton>
                    <IconButton label={`Delete ${d.name}`} onClick={() => setRemoving(d)}>
                      <Trash2 size={15} />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {archivedCount > 0 && (
        <p className="mt-3 text-[13px] text-ink-soft">
          <button type="button" className="text-blueprint hover:underline" data-archived-open onClick={() => setDialog("archived")}>
            {archivedCount} archived {archivedCount === 1 ? "diagram" : "diagrams"}
          </button>{" "}
          are kept out of this list.
        </p>
      )}

      {dialog === "template" && (
        <TemplatePicker
          templates={allTemplates(ws)}
          onDelete={canEdit ? (t) => apply((w) => deleteSavedTemplate(w, t.id)) : undefined}
          onClose={() => setDialog(null)}
          onUse={(t) => {
            let diagramId = "";
            apply((w) => {
              const made = applyTemplate(w, t.id);
              diagramId = made?.diagramId ?? "";
              return made?.ws ?? w;
            });
            setDialog(null);
            // A viewer's change is refused by the edit guard, and then there is no new diagram to open.
            if (diagramId && useStore.getState().ws.diagrams[diagramId]) navigate(`/diagram/${diagramId}`);
          }}
        />
      )}
      {templating && <SaveAsTemplateDialog ws={ws} diagram={templating} onClose={() => setTemplating(null)} />}
      {dialog === "new" && <NewArchitectureDialog ws={ws} onClose={() => setDialog(null)} />}
      {dialog === "archived" && <ArchivedDialog ws={ws} onClose={() => setDialog(null)} />}
      {archiving && <ArchiveDialog diagram={archiving} onClose={() => setArchiving(null)} />}
      {dialog === "ai" && <AiDraftDialog ws={ws} onClose={() => setDialog(null)} />}
      {dialog === "import" && <ImportDialog onClose={() => setDialog(null)} />}
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
