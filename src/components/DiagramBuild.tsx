import { FileUp, LayoutTemplate, Plus, Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { AiDraftDialog } from "@/components/dialogs";
import { ArchivedDialog, NewArchitectureDialog } from "@/components/NewArchitecture";
import { ImportDialog } from "@/components/ImportDialog";
import { TemplatePicker } from "@/components/TemplatePicker";
import { Button, EmptyState } from "@/components/ui";
import { useCanEdit } from "@/lib/cloud/session";
import { demoWorkspace } from "@/lib/demo";
import { addEnterpriseSample } from "@/lib/enterpriseSample";
import { sortedDiagrams } from "@/lib/model";
import { apply, useStore } from "@/lib/store";
import { allTemplates, applyTemplate, deleteSavedTemplate } from "@/lib/templates";
import type { Workspace } from "@/lib/types";

/** The ways to start a diagram, shared by the home page and the Diagrams page. */
export type BuildDialog = "new" | "ai" | "import" | "template" | "archived";

/** The dialogs behind the build buttons, and a function that opens one. */
export function useBuildDialogs(ws: Workspace): { open: (dialog: BuildDialog) => void; dialogs: ReactNode } {
  const [dialog, setDialog] = useState<BuildDialog | null>(null);
  const navigate = useNavigate();
  const canEdit = useCanEdit();
  const close = () => setDialog(null);
  const dialogs = (
    <>
      {dialog === "template" && (
        <TemplatePicker
          templates={allTemplates(ws)}
          onDelete={canEdit ? (t) => apply((w) => deleteSavedTemplate(w, t.id)) : undefined}
          onClose={close}
          onUse={(t) => {
            let diagramId = "";
            apply((w) => {
              const made = applyTemplate(w, t.id);
              diagramId = made?.diagramId ?? "";
              return made?.ws ?? w;
            });
            close();
            // A viewer's change is refused by the edit guard, and then there is no new diagram to open.
            if (diagramId && useStore.getState().ws.diagrams[diagramId]) navigate(`/diagram/${diagramId}`);
          }}
        />
      )}
      {dialog === "new" && <NewArchitectureDialog ws={ws} onClose={close} />}
      {dialog === "archived" && <ArchivedDialog ws={ws} onClose={close} />}
      {dialog === "ai" && <AiDraftDialog ws={ws} onClose={close} />}
      {dialog === "import" && <ImportDialog onClose={close} />}
    </>
  );
  return { open: setDialog, dialogs };
}

/** Import, Template, Draft with AI and New diagram, in that order, the last one primary. */
export function BuildButtons({ onOpen }: { onOpen: (dialog: BuildDialog) => void }) {
  return (
    <div className="flex flex-wrap gap-2 shrink-0" data-build-buttons>
      <Button icon={<FileUp size={15} />} title="Import a Visio or draw.io diagram, or a spreadsheet" onClick={() => onOpen("import")}>
        Import
      </Button>
      <Button icon={<LayoutTemplate size={15} />} onClick={() => onOpen("template")} data-template-open>
        Template
      </Button>
      <Button icon={<Sparkles size={15} />} onClick={() => onOpen("ai")}>
        Draft with AI
      </Button>
      <Button variant="primary" icon={<Plus size={15} />} data-new-diagram onClick={() => onOpen("new")}>
        New diagram
      </Button>
    </div>
  );
}

/** What an empty workspace offers: AI, a blank diagram, an import, a template, or a sample to look around. */
export function StartModel({ ws, onOpen }: { ws: Workspace; onOpen: (dialog: BuildDialog) => void }) {
  const replace = useStore((s) => s.replace);
  const navigate = useNavigate();
  return (
    <div className="mt-8 rounded-lg border border-dashed border-ink-faint bg-surface">
      <EmptyState
        title="Start your architecture model"
        text="Describe a system and let AI draft it, begin with an empty diagram, import a Visio or draw.io diagram or a spreadsheet, or load a sample model to look around first."
      >
        <Button variant="primary" icon={<Sparkles size={15} />} onClick={() => onOpen("ai")}>
          Draft with AI
        </Button>
        <Button icon={<Plus size={15} />} onClick={() => onOpen("new")}>
          New diagram
        </Button>
        <Button icon={<FileUp size={15} />} onClick={() => onOpen("import")}>
          Import a file
        </Button>
        <Button icon={<LayoutTemplate size={15} />} onClick={() => onOpen("template")} data-template-open>
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
  );
}
