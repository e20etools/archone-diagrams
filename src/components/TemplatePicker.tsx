import { Search } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { LibraryIcon } from "@/components/icons";
import { Button, Input, Modal } from "@/components/ui";
import { NODE_H, NODE_W } from "@/lib/layout";
import { templatePreview } from "@/lib/templatePreview";
import { PERSPECTIVES, searchTemplates, type Perspective, type Template } from "@/lib/templates";

/** The template drawn small: its boxes in their places, coloured by what they are, with the lines between them. */
export const TemplatePreview = memo(function TemplatePreview({ template }: { template: Template }) {
  const p = templatePreview(template);
  const pad = 40;
  // Wide and tall layouts both fit the same square without being stretched.
  return (
    <svg viewBox={`${-pad} ${-pad} ${p.width + pad * 2} ${p.height + pad * 2}`} preserveAspectRatio="xMidYMid meet" className="size-full" aria-hidden data-template-preview>
      {p.lines.map((l, i) => (
        <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="#93a0b4" strokeWidth={10} strokeLinecap="round" />
      ))}
      {p.boxes.map((b) => (
        <g key={b.key} transform={`translate(${b.x} ${b.y})`}>
          <rect width={NODE_W} height={NODE_H} rx={14} fill="#fff" stroke={b.color} strokeWidth={8} />
          <rect width={22} height={NODE_H} rx={8} fill={b.color} />
          {b.icon && (
            <g transform={`translate(${NODE_W / 2 - 10} ${NODE_H / 2 - 30})`} color={b.color}>
              <LibraryIcon name={b.icon} size={60} />
            </g>
          )}
        </g>
      ))}
    </svg>
  );
});

/**
 * Choosing a template: a search box, the four perspectives, and every template as a small
 * picture with its name above it. A click picks one and shows what it is; Use puts it in the model.
 */
export function TemplatePicker({ templates, onUse, onClose, onDelete, initialPerspective = null, useLabel }: { templates: Template[]; onUse: (template: Template) => void; onClose: () => void; onDelete?: (template: Template) => void; initialPerspective?: Perspective | null; useLabel?: string }) {
  const [query, setQuery] = useState("");
  const [perspective, setPerspective] = useState<Perspective | null>(initialPerspective);
  const [ownOnly, setOwnOnly] = useState(false);
  const [picked, setPicked] = useState<Template | null>(null);
  const [confirming, setConfirming] = useState(false);
  const pool = useMemo(() => (ownOnly ? templates.filter((t) => t.saved) : templates), [templates, ownOnly]);
  const ownCount = templates.filter((t) => t.saved).length;
  const shown = useMemo(() => searchTemplates(query, perspective, pool), [query, perspective, pool]);
  const counts = useMemo(() => Object.fromEntries(PERSPECTIVES.map((p) => [p.id, searchTemplates(query, p.id, pool).length])), [query, pool]);
  return (
    <Modal
      title="Start from a template"
      onClose={onClose}
      width={1040}
      footer={
        <div className="flex w-full items-center gap-3" data-template-picked={picked?.id ?? ""}>
          <div className="min-w-0 flex-1 text-left">
            {picked ? (
              <>
                <p className="font-medium truncate">{picked.name}</p>
                <p className="text-[13px] text-ink-soft line-clamp-2">
                  {picked.saved && `Saved in this workspace by ${picked.saved.author}. `}
                  {picked.about} {picked.objects.length} objects, {picked.relationships.length} relationships.
                </p>
              </>
            ) : (
              <p className="text-[13px] text-ink-soft">Pick a template to see what it holds. Objects whose names the model already has are reused.</p>
            )}
          </div>
          {picked?.saved && onDelete &&
            (confirming ? (
              <Button
                variant="danger"
                data-template-delete-confirm
                onClick={() => {
                  onDelete(picked);
                  setPicked(null);
                  setConfirming(false);
                }}
              >
                Delete "{picked.name}"
              </Button>
            ) : (
              <Button variant="danger" data-template-delete onClick={() => setConfirming(true)}>
                Delete template
              </Button>
            ))}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!picked} onClick={() => picked && onUse(picked)} data-template-use>
            {useLabel ?? "Use this template"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
          <Input className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search templates, e.g. DMZ or KYC" aria-label="Search templates" autoFocus />
        </div>
        <div role="tablist" aria-label="Perspective" className="flex flex-wrap gap-1" data-template-perspectives>
          {ownCount > 0 && (
            <button
              type="button"
              aria-pressed={ownOnly}
              data-template-own
              onClick={() => setOwnOnly(!ownOnly)}
              className={`h-8 px-3 rounded-full border text-[13px] ${ownOnly ? "border-ok bg-ok text-white" : "border-ok/50 text-ok hover:border-ok"}`}
            >
              Saved here <span className="tabular-nums">{ownCount}</span>
            </button>
          )}
          {[{ id: null, label: "All", count: searchTemplates(query, null, pool).length }, ...PERSPECTIVES.map((p) => ({ id: p.id, label: p.label, count: counts[p.id] }))].map((p) => (
            <button
              key={p.label}
              type="button"
              role="tab"
              aria-selected={perspective === p.id}
              data-perspective={p.id ?? "all"}
              onClick={() => setPerspective(p.id)}
              className={`h-8 px-3 rounded-full border text-[13px] ${perspective === p.id ? "border-blueprint bg-blueprint text-white" : "border-line hover:border-blueprint"}`}
            >
              {p.label} <span className={`tabular-nums ${perspective === p.id ? "text-white/80" : "text-ink-faint"}`}>{p.count}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 max-h-[58vh] overflow-y-auto pr-1">
        {shown.length === 0 ? (
          <p className="py-10 text-center text-ink-soft">No template matches. Try fewer words, or another perspective.</p>
        ) : (
          <ul className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(176px, 1fr))" }} data-templates>
            {shown.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  data-template={t.id}
                  aria-pressed={picked?.id === t.id}
                  title={t.about}
                  onClick={() => {
                    setPicked(t);
                    setConfirming(false);
                  }}
                  onDoubleClick={() => onUse(t)}
                  className={`w-full rounded-lg border p-2 text-left ${picked?.id === t.id ? "border-blueprint ring-2 ring-blueprint/30 bg-blueprint-soft/40" : "border-line hover:border-blueprint"}`}
                >
                  <span className="block text-[13px] font-medium leading-tight line-clamp-2 min-h-[2lh]">{t.name}</span>
                  <span className="mt-1.5 block aspect-square w-full rounded-md border border-line-soft bg-paper p-1.5">
                    <TemplatePreview template={t} />
                  </span>
                  <span className="mt-1 flex items-center gap-1 text-[11px] text-ink-faint">
                    <LibraryIcon name={t.perspective === "applications" ? "AppWindow" : t.perspective === "data" ? "Database" : t.perspective === "infrastructure" ? "Server" : "Briefcase"} size={11} />
                    {PERSPECTIVES.find((p) => p.id === t.perspective)?.label} · {t.objects.length} boxes
                    {t.saved && <span className="ml-auto rounded px-1 bg-ok-soft text-ok font-medium">Saved here</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-2 text-xs text-ink-faint">
        {templates.length} templates{ownCount ? `, ${ownCount} of them saved in this workspace` : ""}. Double-click one to use it straight away. To add your own, open a diagram and choose Save as template.
      </p>
    </Modal>
  );
}
