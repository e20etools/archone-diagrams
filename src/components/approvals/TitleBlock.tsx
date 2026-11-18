import { Check, ChevronDown, ShieldCheck, ShieldAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "@/components/ui";
import { boxShown, boxView, companyOf, shownFields, type BoxRecord, type BoxView, type DiagramRecord } from "@/lib/approvals";
import { cloudEnabled } from "@/lib/cloud/config";
import { getBackend, useSession } from "@/lib/cloud/session";
import type { Diagram, Workspace } from "@/lib/types";

/**
 * The information box of a diagram: company and logo, name, version and where its approval stands,
 * who made and changed it and when, the Enterprise Architecture and Cybersecurity approvals, and
 * the authenticity seal. Drawn in a corner over the canvas, on live links and verified copies.
 */

const TONE_TEXT = { ok: "text-ok", warn: "text-signal", muted: "text-ink-faint" } as const;

export function TitleBlockCard({ view, className, collapsible = true, defaultOpen = true }: { view: BoxView; className?: string; collapsible?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const version = view.cells.find((c) => c.field === "version");
  const name = view.cells.find((c) => c.field === "name");
  const body = view.cells.filter((c) => c.field !== "seal");
  const seal = view.cells.find((c) => c.field === "seal");
  const SealIcon = view.sealTone === "ok" ? ShieldCheck : ShieldAlert;
  return (
    <section className={cx("title-block w-[340px] max-w-full rounded-md border border-ink/70 bg-surface text-ink shadow-md", className)} aria-label="Information box" data-title-block data-seal={view.sealTone}>
      <header className="flex items-center gap-2 border-b border-ink/70 px-2.5 py-1.5">
        {view.company?.logo && <img src={view.company.logo} alt="" className="size-7 shrink-0 object-contain" data-title-block-logo />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold" data-title-block-company>
            {view.company?.name ?? name?.value ?? "Information"}
          </div>
          {!open && version && <div className={cx("truncate text-xs", TONE_TEXT[version.tone ?? "muted"])}>Version {version.value}</div>}
        </div>
        {collapsible && (
          <button type="button" className="grid size-6 place-items-center rounded text-ink-soft hover:bg-paper" aria-expanded={open} aria-label={open ? "Fold the information box" : "Unfold the information box"} onClick={() => setOpen(!open)}>
            <ChevronDown size={15} className={open ? "rotate-180" : undefined} />
          </button>
        )}
      </header>
      {open && (
        <>
          <dl className="grid grid-cols-2">
            {body.map((cell, i) => (
              <div key={cell.field} className={cx("min-w-0 border-ink/25 px-2.5 py-1.5", i % 2 === 0 ? "border-r" : "", i >= 2 ? "border-t" : "")} data-title-block-field={cell.field} data-mark={cell.mark}>
                <dt className="text-[11px] leading-4 text-ink-soft">{cell.label}</dt>
                <dd className={cx("flex items-start gap-1 text-xs leading-4 font-medium break-words", cell.tone ? TONE_TEXT[cell.tone] : "")}>
                  {cell.mark && (
                    <span className={cx("mt-px grid size-3.5 shrink-0 place-items-center rounded-full text-white", cell.mark === "yes" ? "bg-ok" : "bg-danger")} aria-hidden>
                      {cell.mark === "yes" ? <Check size={10} strokeWidth={3} /> : <X size={10} strokeWidth={3} />}
                    </span>
                  )}
                  <span className="min-w-0">{cell.value}</span>
                </dd>
              </div>
            ))}
          </dl>
          {seal && (
            <div className={cx("flex items-center gap-2 border-t border-ink/70 px-2.5 py-1.5", view.sealTone === "ok" ? "bg-ok-soft" : view.sealTone === "warn" ? "bg-signal-soft" : "bg-paper")} data-title-block-field="seal">
              <SealIcon size={18} className={cx("shrink-0", TONE_TEXT[view.sealTone])} aria-hidden />
              <div className="min-w-0">
                <div className="text-[11px] leading-4 text-ink-soft">{seal.label}</div>
                <div className={cx("text-xs leading-4 font-medium", TONE_TEXT[view.sealTone])}>{seal.value}</div>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** The box of a diagram as the database froze it, for live links and verified copies. */
export const viewOfRecord = (record: BoxRecord): BoxView =>
  boxView({ name: record.name, company: record.company, logo: record.logo, standing: record, created: record.created, changed: record.changed, fields: shownFields(record.hidden, record.requiredFields) });

/** The box of a diagram in the app: what the workspace knows, with the record from the server when there is one. */
export function viewOfDiagram(ws: Workspace, diagram: Diagram, record: DiagramRecord | null): BoxView {
  const { company, logo } = companyOf(ws, diagram);
  return boxView({
    name: diagram.name,
    company,
    logo,
    standing: record,
    created: record?.created ?? { at: diagram.createdAt, by: "" },
    changed: record?.changed ?? { at: diagram.updatedAt, by: "" },
    fields: shownFields(diagram.titleBlock?.hidden, ws.branding?.workspace?.boxFields),
  });
}

/** Anything the diagram shows changing moves this key: the diagram, its boxes, their objects and the arrows between them. */
function contentKey(ws: Workspace, diagram: Diagram): string {
  const ids = new Set(Object.keys(diagram.nodes));
  let latest = diagram.updatedAt;
  for (const id of ids) {
    const at = ws.objects[id]?.updatedAt ?? "";
    if (at > latest) latest = at;
  }
  for (const r of Object.values(ws.relationships)) if (ids.has(r.sourceId) && ids.has(r.targetId) && r.updatedAt > latest) latest = r.updatedAt;
  return `${latest}|${ids.size}|${Object.values(diagram.nodes).reduce((sum, n) => sum + n.x + n.y, 0)}`;
}

/**
 * Where a diagram stands with its approval, read from the server: again after its own changes are
 * saved, and whenever a request in the workspace moves. Null without a shared workspace.
 */
export function useDiagramRecord(ws: Workspace, diagram: Diagram) {
  const workspaceId = useSession((s) => s.workspaceId);
  const approvals = useSession((s) => s.approvals);
  const syncKind = useSession((s) => s.sync.kind);
  const [record, setRecord] = useState<DiagramRecord | null>(null);
  const [problem, setProblem] = useState("");
  const key = contentKey(ws, diagram);
  const ask = useRef(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!cloudEnabled || !workspaceId || !diagram.id || syncKind === "saving") return;
    const mine = ++ask.current;
    const timer = setTimeout(async () => {
      try {
        const next = await (await getBackend()).diagramRecord(workspaceId, diagram.id);
        if (mine === ask.current) {
          setRecord(next);
          setProblem("");
        }
      } catch (error) {
        if (mine === ask.current) setProblem(error instanceof Error ? error.message : "The approval could not be read.");
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [workspaceId, diagram.id, key, approvals, syncKind, tick]);
  useEffect(() => setRecord(null), [diagram.id]);
  return { record, problem, setRecord, reload: () => setTick((t) => t + 1) };
}

const CORNER_CLASS: Record<string, string> = {
  "top-left": "top-3 left-3",
  "top-right": "top-3 right-3",
  "bottom-left": "bottom-3 left-14",
  // Above the minimap.
  "bottom-right": "bottom-[168px] right-3",
};

/** The box over a canvas, in the corner the diagram chose. */
export function TitleBlockOverlay({ view, corner }: { view: BoxView; corner: string | undefined }) {
  return (
    <div className={cx("absolute z-[5] nodrag nopan", CORNER_CLASS[corner ?? "bottom-right"] ?? CORNER_CLASS["bottom-right"])} data-title-block-corner={corner ?? "bottom-right"}>
      <TitleBlockCard view={view} />
    </div>
  );
}

/** The diagram's own box in the editor and the presenter, when it shows one. */
export function DiagramTitleBlock({ ws, diagram, record }: { ws: Workspace; diagram: Diagram; record: DiagramRecord | null }) {
  const view = useMemo(() => viewOfDiagram(ws, diagram, record), [ws, diagram, record]);
  if (!boxShown(ws, diagram)) return null;
  return <TitleBlockOverlay view={view} corner={diagram.titleBlock?.corner} />;
}
