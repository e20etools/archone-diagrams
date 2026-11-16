import { Minus, Pencil, Plus } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { DiagramCanvas, type CanvasSelection } from "@/components/canvas/DiagramCanvas";
import { Select } from "@/components/ui";
import { RELATION_KIND_INFO, objectType } from "@/lib/catalog";
import { compareTables, diagramsOf, relationshipTitle, type Comparison, type FieldChange } from "@/lib/cloud/collab";
import { errorText, versionTablesOf } from "@/lib/cloud/session";
import { fromTables, type Tables } from "@/lib/cloud/tables";
import { emptyWorkspace } from "@/lib/model";
import type { Workspace } from "@/lib/types";

/**
 * Loads a version's copy of the model. The result is kept, so going back to a version is instant.
 * `retryWhen` asks again when it changes: a reviewer may open a version only once the review reaches them.
 */
export function useVersionTables(versionId: string | null, retryWhen = ""): { tables: Tables | null; problem: string } {
  const [state, setState] = useState<{ id: string | null; tables: Tables | null; problem: string }>({ id: null, tables: null, problem: "" });
  useEffect(() => {
    if (!versionId) return;
    let live = true;
    versionTablesOf(versionId).then(
      (tables) => live && setState({ id: versionId, tables, problem: "" }),
      (error) => live && setState({ id: versionId, tables: null, problem: errorText(error) }),
    );
    return () => {
      live = false;
    };
  }, [versionId, retryWhen]);
  return state.id === versionId ? { tables: state.tables, problem: state.problem } : { tables: null, problem: "" };
}

const KIND = {
  added: { icon: Plus, word: "Added", tone: "text-ok bg-ok-soft" },
  removed: { icon: Minus, word: "Removed", tone: "text-danger bg-danger-soft" },
  changed: { icon: Pencil, word: "Changed", tone: "text-signal bg-signal-soft" },
} as const;

function Row({ kind, title, detail, fields }: { kind: keyof typeof KIND; title: string; detail?: string; fields?: FieldChange[] }) {
  const { icon: Icon, word, tone } = KIND[kind];
  return (
    <li className="flex gap-2.5 py-2 border-b border-line-soft last:border-b-0">
      <span className={`mt-0.5 shrink-0 inline-grid place-items-center size-5 rounded ${tone}`} title={word}>
        <Icon size={12} strokeWidth={2.5} aria-hidden />
        <span className="sr-only">{word}</span>
      </span>
      <div className="min-w-0">
        <p>
          <span className="font-medium">{title}</span>
          {detail && <span className="ml-2 text-[13px] text-ink-soft">{detail}</span>}
        </p>
        {fields?.map((f) => (
          <p key={f.field} className="text-[13px] text-ink-soft break-words">
            {f.field}: <span className="line-through decoration-ink-faint">{f.before}</span> <span aria-hidden>→</span>
            <span className="sr-only">became</span> <span className="text-ink">{f.after}</span>
          </p>
        ))}
      </div>
    </li>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (!count) return null;
  return (
    <section>
      <h3 className="text-[13px] font-semibold text-ink-soft">
        {title} <span className="font-normal tabular-nums">{count}</span>
      </h3>
      <ul className="mt-1">{children}</ul>
    </section>
  );
}

/** What changed between two copies of the model, listed thing by thing. */
export function ComparisonList({ before, after, emptyText }: { before: Tables; after: Tables; emptyText: string }) {
  const c: Comparison = compareTables(before, after);
  if (c.total === 0) return <p className="text-ink-soft">{emptyText}</p>;
  const names = { ...before.objects, ...after.objects };
  const boxes = (n: number, what: string) => (n ? `${n} ${n === 1 ? "box" : "boxes"} ${what}` : "");
  const moves = (d: Comparison["diagrams"]["changed"][number]) => [boxes(d.boxesAdded, "added"), boxes(d.boxesRemoved, "removed"), boxes(d.boxesMoved, "moved")].filter(Boolean).join(", ");
  return (
    <div className="space-y-4" data-comparison>
      <Group title="Objects" count={c.objects.added.length + c.objects.removed.length + c.objects.changed.length}>
        {c.objects.added.map((o) => (
          <Row key={o.id} kind="added" title={o.name} detail={objectType(o.typeId).label} />
        ))}
        {c.objects.changed.map((o) => (
          <Row key={o.after.id} kind="changed" title={o.after.name} detail={objectType(o.after.typeId).label} fields={o.fields} />
        ))}
        {c.objects.removed.map((o) => (
          <Row key={o.id} kind="removed" title={o.name} detail={objectType(o.typeId).label} />
        ))}
      </Group>
      <Group title="Relationships" count={c.relationships.added.length + c.relationships.removed.length + c.relationships.changed.length}>
        {c.relationships.added.map((r) => (
          <Row key={r.id} kind="added" title={relationshipTitle(r, names)} detail={RELATION_KIND_INFO[r.kind].label} />
        ))}
        {c.relationships.changed.map((r) => (
          <Row key={r.after.id} kind="changed" title={relationshipTitle(r.after, names)} detail={RELATION_KIND_INFO[r.after.kind].label} fields={r.fields} />
        ))}
        {c.relationships.removed.map((r) => (
          <Row key={r.id} kind="removed" title={relationshipTitle(r, names)} detail={RELATION_KIND_INFO[r.kind].label} />
        ))}
      </Group>
      <Group title="Diagrams" count={c.diagrams.added.length + c.diagrams.removed.length + c.diagrams.changed.length}>
        {c.diagrams.added.map((d) => (
          <Row key={d.id} kind="added" title={d.name} />
        ))}
        {c.diagrams.changed.map((d) => (
          <Row key={d.after.id} kind="changed" title={d.after.name} detail={moves(d)} fields={d.fields} />
        ))}
        {c.diagrams.removed.map((d) => (
          <Row key={d.id} kind="removed" title={d.name} />
        ))}
      </Group>
    </div>
  );
}

/** The diagrams of a version, drawn as they were. Nothing here can be changed. */
export function VersionDiagrams({ tables, name }: { tables: Tables; name: string }) {
  const diagrams = diagramsOf(tables);
  const [diagramId, setDiagramId] = useState(diagrams[0]?.id ?? "");
  const [selection, setSelection] = useState<CanvasSelection>({ objectId: null, edgeId: null });
  const diagram = diagrams.find((d) => d.id === diagramId) ?? diagrams[0];
  if (!diagram) return <p className="text-ink-soft">This version holds no diagrams.</p>;
  const ws: Workspace = { ...emptyWorkspace(name), ...fromTables(tables) };
  return (
    <div>
      <label className="flex items-center gap-2 text-[13px] text-ink-soft">
        Diagram
        <Select className="!w-72" value={diagram.id} onChange={(e) => setDiagramId(e.target.value)}>
          {diagrams.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
      </label>
      <div className="mt-2 h-[460px] rounded-md border border-line overflow-hidden bg-paper" data-version-canvas>
        <DiagramCanvas key={diagram.id} ws={ws} diagram={diagram} readOnly selection={selection} onSelect={setSelection} />
      </div>
    </div>
  );
}
