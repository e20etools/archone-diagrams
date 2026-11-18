import "bpmn-js/dist/assets/bpmn-font/css/bpmn.css";
import { Blocks, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { cx } from "@/components/ui";
import { BPMN_ELEMENTS, BPMN_GROUPS, elementById, ownBlocks, type BpmnBlock, type BpmnElement, type BpmnGroup } from "@/lib/bpm/elements";
import type { LibraryItem, Workspace } from "@/lib/types";

/** The symbol of a BPMN element, drawn with bpmn.io's BPMN font. */
export function BpmnSymbol({ element, size = 26, className }: { element: Pick<BpmnElement, "icon" | "name">; size?: number; className?: string }) {
  return <span aria-hidden className={cx(element.icon, "inline-block leading-none text-ink", className)} style={{ fontSize: size }} data-bpmn-symbol={element.icon} />;
}

const words = (e: BpmnElement) => `${e.name} ${e.nameAr} ${e.meaning} ${e.meaningAr} ${e.use} ${e.id}`.toLowerCase();

/** Library elements that match a search, in their groups. */
export function useLibrarySearch(query: string, only?: (e: BpmnElement) => boolean) {
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = BPMN_ELEMENTS.filter((e) => (!only || only(e)) && (!q || words(e).includes(q)));
    return BPMN_GROUPS.map((g) => ({ group: g, elements: shown.filter((e) => e.group === g.id) })).filter((x) => x.elements.length);
  }, [query, only]);
}

const placeable = (e: BpmnElement) => !!e.create;

export function blockElement(block: BpmnBlock): BpmnElement {
  return elementById(block.element) ?? elementById("task")!;
}

/**
 * The BPMN library beside the modeler: search, the workspace's own building blocks, and every
 * element that can be placed. A click picks one up; the next click on the canvas puts it down.
 */
export function LibraryPanel({ ws, canEdit, onPick, onPickBlock }: { ws: Workspace; canEdit: boolean; onPick: (e: BpmnElement, event: MouseEvent) => void; onPickBlock: (b: LibraryItem & { bpmn: BpmnBlock }, event: MouseEvent) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<BpmnGroup | "own" | null>("own");
  const groups = useLibrarySearch(query, placeable);
  const blocks = ownBlocks(ws).filter((b) => !query.trim() || `${b.bpmn.name} ${b.bpmn.role} ${b.bpmn.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  const searching = !!query.trim();
  return (
    <div className="text-[13px]" data-bpmn-library-panel>
      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find an element, e.g. timer or مهمة"
          aria-label="Find a BPMN element"
          className="w-full h-8 rounded-md border border-line bg-paper pl-8 pr-2 text-sm focus:border-blueprint focus:outline-none focus:ring-2 focus:ring-blueprint-soft"
        />
      </div>
      <p className="mt-2 text-ink-faint">{canEdit ? "Click an element, then click on the canvas where it goes. Esc puts it back." : "You can read the model; owners and editors place elements."}</p>
      <div className="mt-2 divide-y divide-line-soft">
        <section>
          <button type="button" className="flex w-full items-center gap-2 py-2 font-medium" aria-expanded={searching || open === "own"} onClick={() => setOpen(open === "own" ? null : "own")}>
            <Blocks size={15} className="text-ink-soft" /> Your building blocks <span className="ml-auto text-ink-faint">{blocks.length}</span>
          </button>
          {(searching || open === "own") && (
            <ul className="pb-2 space-y-0.5" data-bpmn-blocks>
              {blocks.length === 0 && <li className="text-ink-faint">None yet. Select a step in the model and save it to the library, or add one on the BPMN library page.</li>}
              {blocks.map((b) => (
                <li key={b.id}>
                  <button type="button" disabled={!canEdit} onClick={(e) => onPickBlock(b, e.nativeEvent)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-line-soft disabled:opacity-60" data-bpmn-block={b.id}>
                    <BpmnSymbol element={blockElement(b.bpmn)} size={20} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{b.bpmn.name}</span>
                      {b.bpmn.role && <span className="block truncate text-[12px] text-ink-faint">{b.bpmn.role}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {groups.map(({ group, elements }) => (
          <section key={group.id}>
            <button type="button" className="flex w-full items-center gap-2 py-2 font-medium" aria-expanded={searching || open === group.id} onClick={() => setOpen(open === group.id ? null : group.id)}>
              {group.name} <span className="text-ink-faint font-normal" dir="rtl">{group.nameAr}</span>
              <span className="ml-auto text-ink-faint font-normal">{elements.length}</span>
            </button>
            {(searching || open === group.id) && (
              <ul className="grid grid-cols-2 gap-1 pb-2">
                {elements.map((e) => (
                  <li key={e.id}>
                    <button
                      type="button"
                      disabled={!canEdit}
                      onClick={(ev) => onPick(e, ev.nativeEvent)}
                      title={`${e.meaning} ${e.use}`}
                      className="flex h-full w-full items-center gap-1.5 rounded-md border border-transparent px-1.5 py-1 text-left hover:border-line hover:bg-paper disabled:opacity-60"
                      data-bpmn-element={e.id}
                    >
                      <BpmnSymbol element={e} size={22} />
                      <span className="min-w-0 leading-tight">
                        <span className="block text-[12.5px]">{e.name}</span>
                        <span className="block text-[11.5px] text-ink-faint" dir="rtl">
                          {e.nameAr}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
