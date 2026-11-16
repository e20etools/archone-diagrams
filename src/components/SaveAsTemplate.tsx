import { useMemo, useState } from "react";
import { LibraryIcon } from "@/components/icons";
import { TemplatePreview } from "@/components/TemplatePicker";
import { Button, Field, Input, Modal, Textarea } from "@/components/ui";
import { componentById } from "@/lib/library";
import { apply } from "@/lib/store";
import { PERSPECTIVES, fromSaved, saveTemplate, templateFromDiagram, type Perspective } from "@/lib/templates";
import type { Diagram, Workspace } from "@/lib/types";

const PERSPECTIVE_ICON: Record<Perspective, string> = { applications: "AppWindow", data: "Database", infrastructure: "Server", business: "Briefcase" };

/** A first guess at the perspective, from what most of the diagram's boxes are. The person chooses. */
function guessPerspective(ws: Workspace, diagram: Diagram): Perspective {
  const votes: Record<Perspective, number> = { applications: 0, data: 0, infrastructure: 0, business: 0 };
  for (const id of Object.keys(diagram.nodes)) {
    const o = ws.objects[id];
    if (!o) continue;
    const section = componentById(o.componentId)?.sectionId ?? "";
    if (diagram.notation === "bpmn" || ["business", "people"].includes(section) || ["domain", "process", "task", "event", "decision", "actor"].includes(o.typeId)) votes.business++;
    else if (["data"].includes(section) || ["database", "storage", "cache", "queue"].includes(o.typeId)) votes.data++;
    else if (["compute", "storage", "datacenter", "network", "security", "end-user", "containers", "iot"].includes(section) || ["server", "network", "cluster", "gateway"].includes(o.typeId)) votes.infrastructure++;
    else votes.applications++;
  }
  return (Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0] as Perspective) ?? "applications";
}

/**
 * Turning one of the workspace's diagrams into a template of its own: a name, the perspective
 * it belongs under, and a line on what it is for. The preview shows what will be kept.
 */
export function SaveAsTemplateDialog({ ws, diagram, onClose, onSaved }: { ws: Workspace; diagram: Diagram; onClose: () => void; onSaved?: (name: string) => void }) {
  const [name, setName] = useState(diagram.name);
  const [perspective, setPerspective] = useState<Perspective>(() => guessPerspective(ws, diagram));
  const [about, setAbout] = useState(diagram.description);
  const [tags, setTags] = useState("");
  const made = useMemo(() => templateFromDiagram(ws, diagram.id, { name, perspective, about, tags }, ws.userName || "Someone"), [ws, diagram.id, name, perspective, about, tags]);

  if (!made) {
    return (
      <Modal title="Save as a template" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
        <p className="text-ink-soft">This diagram has no boxes yet, so there is nothing to make a template of.</p>
      </Modal>
    );
  }
  const { template, substitutions } = made;
  return (
    <Modal
      title="Save as a template"
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            data-save-template
            disabled={!name.trim()}
            onClick={() => {
              apply((w) => saveTemplate(w, template));
              onSaved?.(template.name);
              onClose();
            }}
          >
            Save template
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-[1fr_220px]" data-save-template-dialog>
        <div className="space-y-3.5">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Template name" maxLength={120} />
          </Field>
          <fieldset>
            <legend className="text-[13px] font-medium text-ink-soft mb-1.5">Perspective it belongs under</legend>
            <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Perspective">
              {PERSPECTIVES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={perspective === p.id}
                  data-perspective-choice={p.id}
                  onClick={() => setPerspective(p.id)}
                  className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-left ${perspective === p.id ? "border-blueprint bg-blueprint-soft" : "border-line hover:border-blueprint"}`}
                >
                  <span className="mt-0.5 text-blueprint">
                    <LibraryIcon name={PERSPECTIVE_ICON[p.id]} size={15} />
                  </span>
                  <span>
                    <span className="block text-[13px] font-medium">{p.label}</span>
                    <span className="block text-xs text-ink-soft">{p.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
          <Field label="What it is for" hint="Shown when someone picks it.">
            <Textarea rows={2} value={about} onChange={(e) => setAbout(e.target.value)} aria-label="What the template is for" maxLength={400} />
          </Field>
          <Field label="Words to find it by (optional)" hint="For example: branch, Riyadh, PCI.">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Words to find the template by" maxLength={200} />
          </Field>
        </div>
        <div>
          <p className="text-[13px] font-medium text-ink-soft mb-1.5">What it will hold</p>
          <div className="aspect-square rounded-md border border-line-soft bg-paper p-2">
            <TemplatePreview template={fromSaved(template)} />
          </div>
          <p className="mt-1.5 text-xs text-ink-faint" data-template-counts>
            {template.objects.length} {template.objects.length === 1 ? "box" : "boxes"} and {template.relationships.length} {template.relationships.length === 1 ? "line" : "lines"}, where they stand now.
          </p>
        </div>
      </div>
      {substitutions.length > 0 && (
        <div className="mt-4 rounded-md bg-signal-soft border border-signal/30 px-3 py-2.5 text-[13px]" data-template-substitutions={substitutions.length}>
          <p className="font-medium">
            {substitutions.length} {substitutions.length === 1 ? "box is" : "boxes are"} not a component of the library.
          </p>
          <p className="text-ink-soft mt-0.5">A template holds only library components, so {substitutions.length === 1 ? "it" : "each"} will be saved as the usual component for its type. To choose a better one, cancel and pick its Component in the box's details first.</p>
          <ul className="mt-1.5 space-y-0.5">
            {substitutions.slice(0, 8).map((s) => (
              <li key={s.objectId}>
                {s.name} <span className="text-ink-soft">will be saved as</span> {componentById(s.componentId)?.name}
              </li>
            ))}
            {substitutions.length > 8 && <li className="text-ink-soft">and {substitutions.length - 8} more</li>}
          </ul>
        </div>
      )}
      <p className="mt-3 text-xs text-ink-faint">
        Kept: each box's name, component and technology, the lines between the boxes, and where everything stands. Not kept: owners, descriptions, basic information, links and comments. The template is
        shared with everyone in this workspace; changing the diagram later does not change it.
      </p>
    </Modal>
  );
}
