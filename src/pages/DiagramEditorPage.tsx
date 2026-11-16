import { NOTATION_INFO } from "@/lib/notation";
import { NOTATIONS, type Notation } from "@/lib/types";
import { Zap, Archive, BookmarkPlus, AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalSpaceAround, AlignStartHorizontal, AlignStartVertical, AlignVerticalSpaceAround, ChevronRight, EyeOff, LayoutDashboard, Presentation, ListOrdered, MessageSquare, PanelLeftClose, PanelLeftOpen, Search, Share2, ShieldCheck, Shuffle, SlidersHorizontal, Sparkles, Trash2, Waypoints, X, ZoomIn } from "lucide-react";
import { checkCopy } from "@/lib/freshness";
import { alignNodes, distributeNodes, type AlignMode } from "@/lib/arrange";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { DRAG_MIME, DiagramCanvas, type CanvasHandle, type CanvasSelection, type DragItem } from "@/components/canvas/DiagramCanvas";
import { AiDraftDialog, ExportMenu, ShareDialog } from "@/components/dialogs";
import { FlowBar, FlowsPanel, NO_FLOW, useFlowCursor, useFlowKeys } from "@/components/Flows";
import { LibraryPanel } from "@/components/LibraryBrowser";
import { SaveAsTemplateDialog } from "@/components/SaveAsTemplate";
import { protocolLabel, type ProtocolInfo } from "@/lib/library/protocols";
import { ArchiveDialog } from "@/components/NewArchitecture";
import { componentById, componentSubtitle, objectFromComponent, type LibraryComponent } from "@/lib/library";
import { addStep, flowsOf } from "@/lib/flows";
import { TypeIcon } from "@/components/icons";
import { ObjectEditor, ProvenanceNote, RelationshipEditor, RelationshipList, UsedIn, DecisionsAbout } from "@/components/ObjectPanel";
import { Button, CommitInput, EmptyState, Field, IconButton, Input, Modal, Select, Tabs, useNotice, formatDateTime } from "@/components/ui";
import { CATEGORY_INFO, OBJECT_TYPES, RELATION_KIND_INFO, VIEW_TYPE_INFO, objectType, type Category } from "@/lib/catalog";
import {
  ancestorsOf,
  canSetParent,
  childrenOf,
  createObject,
  createRelationship,
  deleteDiagram,
  deleteObject,
  deleteRelationship,
  diagramBox,
  diagramsUsing,
  placeNodes,
  protocolsOf,
  relationshipsOf,
  removeNodes,
  setProtocols,
  setRelationshipHidden,
  sortedDiagrams,
  sortedObjects,
  updateDiagram,
} from "@/lib/model";
import { CommentsPanel, commentsOn, openThreadsByObject, type CommentAnchor } from "@/components/cloud/CommentsPanel";
import { cloudEnabled } from "@/lib/cloud/config";
import { CommentCategory, useCanEdit, useCategoryRank, useSession } from "@/lib/cloud/session";
import { CATEGORIES as AREAS, CATEGORY_INFO as AREA_INFO, VIEWS_BY_CATEGORY, viewCategory } from "@/lib/categories";
import { searchObjects } from "@/lib/search";
import { apply, useStore, useWorkspace, zoomInto } from "@/lib/store";
import { COLOR_BY, RELATION_KINDS, type ColorBy, type Diagram, type RelationKind, type ViewType, type Workspace } from "@/lib/types";
import { addObjectsToDiagram, missingSuggestions, relayout, visibleEdges } from "@/lib/views";

const CATEGORIES = Object.keys(CATEGORY_INFO) as Category[];
const NONE: CanvasSelection = { objectId: null, edgeId: null };
const ALIGN_BUTTONS: { mode: AlignMode; label: string; icon: typeof X }[] = [
  { mode: "left", label: "Line up the left edges", icon: AlignStartVertical },
  { mode: "center", label: "Line up the centres, one above the other", icon: AlignCenterVertical },
  { mode: "right", label: "Line up the right edges", icon: AlignEndVertical },
  { mode: "top", label: "Line up the top edges", icon: AlignStartHorizontal },
  { mode: "middle", label: "Line up the centres, side by side", icon: AlignCenterHorizontal },
  { mode: "bottom", label: "Line up the bottom edges", icon: AlignEndHorizontal },
];
const PALETTE_KEY = "archone.palette";

/** A sensible first guess for a new arrow; the person can change it in the panel. */
function defaultKind(ws: Workspace, diagram: Diagram, sourceId: string, targetId: string): RelationKind {
  const source = objectType(ws.objects[sourceId].typeId);
  const target = objectType(ws.objects[targetId].typeId);
  let kind: RelationKind = "calls";
  if (target.category === "data" && target.id !== "queue") kind = "reads_writes";
  else if (target.id === "server" || target.id === "cluster") kind = "hosted_on";
  else if (source.id === "gateway") kind = "routes_to";
  if (diagram.edgeKinds && diagram.edgeKinds.length && !diagram.edgeKinds.includes(kind)) kind = diagram.edgeKinds[0];
  return kind;
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="px-4 py-3.5 border-t border-line-soft">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/* ---------- left panel ---------- */

function Palette({
  ws,
  diagram,
  onAddType,
  onAddComponent,
  onAddObject,
  onAddDiagram,
  onPickProtocol,
  onCollapse,
}: {
  ws: Workspace;
  diagram: Diagram;
  onAddType: (typeId: string) => void;
  onAddComponent: (component: LibraryComponent) => void;
  onAddObject: (objectId: string) => void;
  onAddDiagram: (diagramId: string) => void;
  onPickProtocol: (protocol: ProtocolInfo) => void;
  onCollapse: () => void;
}) {
  const [basicOpen, setBasicOpen] = useState(true);
  const [tab, setTab] = useState<"new" | "model">("new");
  const [query, setQuery] = useState("");
  const available = useMemo(() => {
    const pool = query.trim() ? searchObjects(ws, query) : sortedObjects(ws);
    return pool.filter((o) => !(o.id in diagram.nodes)).slice(0, 150);
  }, [ws, diagram.nodes, query]);
  const missing = useMemo(() => missingSuggestions(ws, diagram), [ws, diagram]);
  const drag = (item: DragItem) => (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(item));
    e.dataTransfer.effectAllowed = "copy";
  };
  const unplaced = Object.keys(ws.objects).length - Object.keys(diagram.nodes).length;
  return (
    <aside className="w-[284px] shrink-0 flex flex-col bg-surface border-r border-line">
      <div className="flex items-end gap-1 pl-3 pr-1.5 pt-2">
        <div className="flex-1">
          <Tabs
            tabs={[
              { id: "new", label: "New object" },
              { id: "model", label: "In the model", count: Math.max(0, unplaced) },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
        <IconButton label="Hide this panel" onClick={onCollapse}>
          <PanelLeftClose size={16} />
        </IconButton>
      </div>
      {tab === "new" ? (
        <div className="min-h-0 overflow-y-auto px-3 py-3 space-y-3.5">
          <p className="text-[13px] text-ink-soft">Drag a component onto the canvas, or click it. Each box becomes an object in the model.</p>
          <LibraryPanel
            onPick={onAddComponent}
            diagrams={sortedDiagrams(ws)
              .filter((d) => d.id !== diagram.id)
              .map((d) => ({ id: d.id, name: d.name, kind: VIEW_TYPE_INFO[d.viewType].label }))}
            onPickDiagram={onAddDiagram}
            onPickProtocol={onPickProtocol}
          />
          <div className="border-t border-line-soft pt-2.5">
          <button type="button" className="w-full flex items-center justify-between text-[13px] font-medium" aria-expanded={basicOpen} onClick={() => setBasicOpen(!basicOpen)}>
            Basic types
            <span className="text-xs text-ink-faint">{basicOpen ? "Hide" : "Show"}</span>
          </button>
          </div>
          {basicOpen && CATEGORIES.map((category) => (
            <div key={category}>
              <div className="text-xs text-ink-faint mb-1">{CATEGORY_INFO[category].label}</div>
              <div className="grid grid-cols-2 gap-1.5">
                {OBJECT_TYPES.filter((t) => t.category === category).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    draggable
                    onDragStart={drag({ kind: "type", id: t.id })}
                    onClick={() => onAddType(t.id)}
                    title={t.hint}
                    className="flex items-center gap-1.5 h-8 px-2 rounded-md border border-line text-left text-[13px] cursor-grab hover:border-blueprint hover:bg-blueprint-soft active:cursor-grabbing"
                  >
                    <span style={{ color: CATEGORY_INFO[t.category].color }}>
                      <TypeIcon typeId={t.id} size={15} />
                    </span>
                    <span className="truncate">{t.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="min-h-0 flex flex-col">
          {missing.length > 0 && (
            <div className="mx-3 mt-3 rounded-md bg-blueprint-soft px-3 py-2.5 text-[13px]">
              <p>
                {missing.length} {missing.length === 1 ? "object belongs" : "objects belong"} to this {VIEW_TYPE_INFO[diagram.viewType].label.toLowerCase()} view and{" "}
                {missing.length === 1 ? "is" : "are"} not on it yet.
              </p>
              <Button size="sm" className="mt-2" onClick={() => apply((w) => addObjectsToDiagram(w, diagram.id, missing))}>
                Add {missing.length === 1 ? "it" : `all ${missing.length}`}
              </Button>
            </div>
          )}
          <div className="relative mx-3 mt-3">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
            <Input className="pl-8" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find an object" aria-label="Find an object in the model" />
          </div>
          <ul className="min-h-0 overflow-y-auto px-1.5 py-2">
            {available.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  draggable
                  onDragStart={drag({ kind: "object", id: o.id })}
                  onClick={() => onAddObject(o.id)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left cursor-grab hover:bg-line-soft active:cursor-grabbing"
                >
                  <span className="text-ink-soft shrink-0">
                    <TypeIcon typeId={o.typeId} componentId={o.componentId} size={15} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{o.name}</span>
                    <span className="block truncate text-xs text-ink-faint">
                      {objectType(o.typeId).label}
                      {o.parentId && ws.objects[o.parentId] ? ` in ${ws.objects[o.parentId].name}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {available.length === 0 && (
              <li className="px-2 py-3 text-[13px] text-ink-faint">
                {query.trim() ? "No object in the model matches." : "Every object in the model is already on this diagram."}
              </li>
            )}
          </ul>
        </div>
      )}
    </aside>
  );
}

/* ---------- right panel ---------- */

function DiagramSettings({ ws, diagram, onClose }: { ws: Workspace; diagram: Diagram; onClose: () => void }) {
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const [templating, setTemplating] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [savedAs, setSavedAs] = useState("");
  const rankIn = useCategoryRank();
  const canEdit = useCanEdit() && rankIn(viewCategory(diagram.viewType)) >= 3;
  const patch = (change: Parameters<typeof updateDiagram>[2]) => apply((w) => updateDiagram(w, diagram.id, change));
  const scopes = sortedObjects(ws).filter((o) => objectType(o.typeId).level <= 3);
  const kinds = diagram.edgeKinds;
  const toggleKind = (kind: RelationKind) => {
    const current = new Set(kinds ?? RELATION_KINDS);
    if (current.has(kind)) current.delete(kind);
    else current.add(kind);
    patch({ edgeKinds: current.size === RELATION_KINDS.length ? null : RELATION_KINDS.filter((k) => current.has(k)) });
  };
  const hidden = diagram.hiddenRelationshipIds.map((id) => ws.relationships[id]).filter(Boolean);
  return (
    <>
      <div className="flex items-start gap-2 px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Diagram settings</h2>
          <p className="text-[13px] text-ink-soft mt-0.5">What this diagram shows and how it is drawn.</p>
        </div>
        <IconButton label="Close panel" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <Section title="About">
        <div className="space-y-3">
          <Field label="Description">
            <CommitInput multiline rows={2} value={diagram.description} onCommit={(description) => patch({ description })} placeholder="What this diagram is for" />
          </Field>
          <Field label="What it shows" hint={VIEW_TYPE_INFO[diagram.viewType].hint + "."}>
            <Select value={diagram.viewType} disabled={!canEdit} onChange={(e) => patch({ viewType: e.target.value as ViewType })}>
              {AREAS.map((c) => (
                <optgroup key={c} label={AREA_INFO[c].label}>
                  {VIEWS_BY_CATEGORY[c].map((t) => (
                    <option key={t} value={t} disabled={rankIn(c) < 3}>
                      {VIEW_TYPE_INFO[t].label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <Field label="Inside of" hint="Objects inside the chosen one are drawn within a boundary.">
            <Select value={diagram.scopeId ?? ""} onChange={(e) => patch({ scopeId: e.target.value || null })}>
              <option value="">No single object</option>
              {scopes.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Section>
      <Section title="Appearance">
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Direction">
            <Select value={diagram.direction} onChange={(e) => apply((w) => relayout(updateDiagram(w, diagram.id, { direction: e.target.value as "TB" | "LR" }), diagram.id, true))}>
              <option value="TB">Top to bottom</option>
              <option value="LR">Left to right</option>
            </Select>
          </Field>
          <Field label="Notation" hint={NOTATION_INFO[diagram.notation ?? "plain"].hint}>
            <Select aria-label="Notation" value={diagram.notation ?? "plain"} onChange={(e) => patch({ notation: e.target.value as Notation })}>
              {NOTATIONS.map((n) => (
                <option key={n} value={n}>
                  {NOTATION_INFO[n].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Colour boxes by">
            <Select value={diagram.colorBy} onChange={(e) => patch({ colorBy: e.target.value as ColorBy })}>
              {COLOR_BY.map((c) => (
                <option key={c} value={c}>
                  {c === "type" ? "Type" : c === "lifecycle" ? "Lifecycle" : "Owner"}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Section>
      <Section title="Arrows shown">
        <ul className="space-y-1">
          {RELATION_KINDS.map((kind) => (
            <li key={kind}>
              <label className="flex items-center gap-2 text-[13px] cursor-pointer">
                <input type="checkbox" className="accent-blueprint" checked={!kinds || kinds.includes(kind)} onChange={() => toggleKind(kind)} />
                {RELATION_KIND_INFO[kind].label}
              </label>
            </li>
          ))}
        </ul>
        {hidden.length > 0 && (
          <div className="mt-3">
            <div className="text-xs text-ink-faint mb-1">Hidden on this diagram</div>
            <ul className="space-y-1">
              {hidden.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 text-[13px]">
                  <span className="truncate">
                    {ws.objects[r.sourceId]?.name} to {ws.objects[r.targetId]?.name}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => apply((w) => setRelationshipHidden(w, diagram.id, r.id, false))}>
                    Show
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>
      <Section title="Impact">
        <p className="text-[13px] text-ink-soft mb-2">What this diagram depends on, what depends on it in other diagrams, and what stops if it stops.</p>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" icon={<Zap size={14} />} onClick={() => navigate(`/impact?diagram=${diagram.id}`)} data-diagram-impact>
            Dependencies and impact
          </Button>
          <Button size="sm" onClick={() => navigate(`/impact?diagram=${diagram.id}&tab=whatif`)}>
            What if it stops
          </Button>
        </div>
      </Section>
      {canEdit && (
        <Section title="Template">
          <p className="text-[13px] text-ink-soft mb-2">Keep this diagram as a starting point everyone in the workspace can use, under the perspective you choose.</p>
          <Button size="sm" icon={<BookmarkPlus size={14} />} data-save-as-template={diagram.id} onClick={() => setTemplating(true)}>
            Save as template
          </Button>
          {savedAs && (
            <p role="status" className="mt-2 text-[13px] text-ok">
              Saved as "{savedAs}". Find it under Start from a template.
            </p>
          )}
          {templating && <SaveAsTemplateDialog ws={ws} diagram={diagram} onClose={() => setTemplating(false)} onSaved={setSavedAs} />}
        </Section>
      )}
      {canEdit && (
        <Section title="Archive">
          <p className="text-[13px] text-ink-soft mb-2">Take it out of the lists without deleting anything. It can be restored, with a reason, from Archived diagrams.</p>
          <Button size="sm" icon={<Archive size={14} />} data-archive={diagram.id} onClick={() => setArchiving(true)}>
            Archive diagram
          </Button>
          {archiving && <ArchiveDialog diagram={diagram} onClose={() => setArchiving(false)} onDone={() => navigate("/")} />}
        </Section>
      )}
      <Section title="Delete">
        <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={() => setConfirm(true)}>
          Delete diagram
        </Button>
      </Section>
      {confirm && (
        <Modal
          title="Delete this diagram?"
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button onClick={() => setConfirm(false)}>Keep it</Button>
              <Button
                variant="danger"
                onClick={() => {
                  navigate("/");
                  apply((w) => deleteDiagram(w, diagram.id));
                }}
              >
                Delete diagram
              </Button>
            </>
          }
        >
          <p>"{diagram.name}" will be deleted. Its objects stay in the model and on other diagrams.</p>
        </Modal>
      )}
    </>
  );
}

function ObjectInspector({
  ws,
  diagram,
  objectId,
  onSelect,
  onOpen,
}: {
  ws: Workspace;
  diagram: Diagram;
  objectId: string;
  onSelect: (s: CanvasSelection) => void;
  onOpen: (objectId: string) => void;
}) {
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const object = ws.objects[objectId];
  const type = objectType(object.typeId);
  const children = childrenOf(ws, objectId);
  const usage = diagramsUsing(ws, objectId);
  const links = relationshipsOf(ws, objectId);
  return (
    <>
      <div className="flex items-start gap-2.5 px-4 py-3.5">
        <span className="mt-0.5" style={{ color: CATEGORY_INFO[type.category].color }}>
          <TypeIcon typeId={object.typeId} componentId={object.componentId} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold break-words">{object.name}</h2>
          <p className="text-[13px] text-ink-soft">{componentSubtitle(object) ?? type.label}</p>
        </div>
        <IconButton label="Close panel" onClick={() => onSelect(NONE)}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="px-4 pb-3 flex flex-wrap gap-1.5">
        {type.level <= 3 && (
          <Button size="sm" icon={<ZoomIn size={14} />} onClick={() => onOpen(objectId)}>
            {children.length ? `Open inside (${children.length})` : "Open inside"}
          </Button>
        )}
        <Button size="sm" icon={<Waypoints size={14} />} onClick={() => navigate(`/analysis?object=${objectId}`)}>
          Dependencies
        </Button>
        <Button size="sm" icon={<Zap size={14} />} onClick={() => navigate(`/impact?object=${objectId}`)} data-object-impact>
          Impact
        </Button>
      </div>
      <Section title="Details">
        <ObjectEditor ws={ws} object={object} />
      </Section>
      <Section title="Relationships">
        <RelationshipList
          ws={ws}
          objectId={objectId}
          onPick={(other) => (other in diagram.nodes ? onSelect({ objectId: other, edgeId: null }) : navigate(`/model?object=${other}`))}
        />
      </Section>
      <Section title="Shown on">
        <UsedIn ws={ws} objectId={objectId} currentDiagramId={diagram.id} />
      </Section>
      <Section title="Decisions">
        <DecisionsAbout ws={ws} objectId={objectId} />
      </Section>
      <Section title="Origin">
        <ProvenanceNote provenance={object.provenance} />
      </Section>
      <Section title="Remove">
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            icon={<EyeOff size={14} />}
            onClick={() => {
              apply((w) => removeNodes(w, diagram.id, [objectId]));
              onSelect(NONE);
            }}
          >
            Take off this diagram
          </Button>
          <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => setConfirm(true)}>
            Delete from the model
          </Button>
        </div>
        <p className="mt-2 text-xs text-ink-faint">Taking it off keeps the object in the model and on other diagrams.</p>
      </Section>
      {confirm && (
        <Modal
          title={`Delete "${object.name}" from the model?`}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button onClick={() => setConfirm(false)}>Keep it</Button>
              <Button
                variant="danger"
                onClick={() => {
                  onSelect(NONE);
                  setConfirm(false);
                  apply((w) => deleteObject(w, objectId));
                }}
              >
                Delete object
              </Button>
            </>
          }
        >
          <ul className="list-disc pl-5 space-y-1">
            <li>
              It disappears from {usage.length} {usage.length === 1 ? "diagram" : "diagrams"}.
            </li>
            <li>
              Its {links.incoming.length + links.outgoing.length} {links.incoming.length + links.outgoing.length === 1 ? "relationship is" : "relationships are"} deleted.
            </li>
            {children.length > 0 && (
              <li>
                Its {children.length} nested {children.length === 1 ? "object moves" : "objects move"} up one level.
              </li>
            )}
          </ul>
          <p className="mt-3 text-ink-soft">You can undo this with Ctrl Z.</p>
        </Modal>
      )}
    </>
  );
}

function EdgeInspector({ ws, diagram, edgeId, onSelect }: { ws: Workspace; diagram: Diagram; edgeId: string; onSelect: (s: CanvasSelection) => void }) {
  const edge = visibleEdges(ws, diagram).find((e) => e.id === edgeId);
  if (!edge) return null;
  const header = (title: string, text: string) => (
    <div className="flex items-start gap-2 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-[13px] text-ink-soft">{text}</p>
      </div>
      <IconButton label="Close panel" onClick={() => onSelect(NONE)}>
        <X size={16} />
      </IconButton>
    </div>
  );
  if (edge.implied) {
    return (
      <>
        {header("Rolled-up arrow", "This arrow stands for relationships between objects nested inside these two boxes. Open the inside view to edit them.")}
        <Section title={`${edge.relationshipIds.length} ${edge.relationshipIds.length === 1 ? "relationship" : "relationships"} behind it`}>
          <ul className="space-y-1.5 text-[13px]">
            {edge.relationshipIds.map((id) => {
              const r = ws.relationships[id];
              if (!r) return null;
              return (
                <li key={id}>
                  <span className="font-medium">{ws.objects[r.sourceId]?.name}</span>{" "}
                  <span className="text-ink-soft">{r.label || RELATION_KIND_INFO[r.kind].verb}</span>{" "}
                  <span className="font-medium">{ws.objects[r.targetId]?.name}</span>
                </li>
              );
            })}
          </ul>
        </Section>
      </>
    );
  }
  const relationship = ws.relationships[edge.id];
  if (!relationship) return null;
  return (
    <>
      {header("Relationship", "Stored once in the model and drawn on every diagram that shows both ends.")}
      <Section title="Details">
        <RelationshipEditor ws={ws} relationship={relationship} />
      </Section>
      <Section title="Origin">
        <ProvenanceNote provenance={relationship.provenance} />
      </Section>
      <Section title="Remove">
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            icon={<EyeOff size={14} />}
            onClick={() => {
              apply((w) => setRelationshipHidden(w, diagram.id, relationship.id, true));
              onSelect(NONE);
            }}
          >
            Hide on this diagram
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={<Trash2 size={14} />}
            onClick={() => {
              onSelect(NONE);
              apply((w) => deleteRelationship(w, relationship.id));
            }}
          >
            Delete from the model
          </Button>
        </div>
      </Section>
    </>
  );
}

/* ---------- page ---------- */

function Editor({ ws, diagram }: { ws: Workspace; diagram: Diagram }) {
  const navigate = useNavigate();
  const canvas = useRef<CanvasHandle | null>(null);
  const [selection, setSelectionOnly] = useState<CanvasSelection>(NONE);
  const [flowsOpen, setFlowsOpen] = useState(false);
  const flows = useFlowCursor(ws, diagram);
  // Boxes picked together with Shift-click, to line up, space out or drag as a group.
  const [picked, setPicked] = useState<string[]>([]);
  const setSelection = useCallback((next: CanvasSelection) => {
    setPicked([]);
    setSelectionOnly(next);
  }, []);
  const onPick = useCallback((id: string) => {
    setPicked((current) => {
      const first = selectionRef.current.objectId;
      const base = current.length ? current : first ? [first] : [];
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });
  }, []);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [dialog, setDialog] = useState<"ai" | "share" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(() => {
    try {
      return localStorage.getItem(PALETTE_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const { notify, view: notice } = useNotice();
  const roleCanEdit = useCanEdit();
  const rankIn = useCategoryRank();
  const category = viewCategory(diagram.viewType);
  // Changing a diagram takes edit rights in its category as well as in the workspace.
  const canEdit = roleCanEdit && rankIn(category) >= 3;
  const diagramId = diagram.id;
  useFlowKeys(!!flows.flow, flows.move, () => flows.setCursor(NO_FLOW));
  // While a flow is being written, a click on an arrow adds it as the next step instead of opening the arrow.
  const writingFlow = flowsOpen && canEdit ? flows.flow : null;
  const onCanvasSelect = (next: CanvasSelection) => {
    if (writingFlow && next.edgeId) {
      const edge = visibleEdges(ws, diagram).find((e) => e.id === next.edgeId);
      if (edge) {
        apply((w) => addStep(w, diagramId, writingFlow.id, edge.sourceId, edge.targetId).ws);
        flows.setCursor({ flowId: writingFlow.id, index: writingFlow.steps.length });
        return;
      }
    }
    setSelection(next);
  };
  // A link from a mention opens the comments with that thread in view.
  const [params, setParams] = useSearchParams();
  const focusThread = params.get("thread");
  // A stamped export links here with the time it was made, to be checked against the model as it is now.
  const asOf = params.get("asof");
  const copy = useMemo(() => (asOf ? checkCopy(ws, diagram, asOf) : null), [asOf, ws, diagram]);
  const [commentsOpen, setCommentsOpen] = useState(() => cloudEnabled && (params.has("comments") || params.has("thread")));
  const allComments = useSession((s) => s.comments);
  const togglePalette = (open: boolean) => {
    setPaletteOpen(open);
    try {
      localStorage.setItem(PALETTE_KEY, open ? "open" : "closed");
    } catch {
      // Not remembered; the panel still opens and closes.
    }
  };

  useEffect(() => {
    setSelection(NONE);
    setSettingsOpen(false);
    setFlowsOpen(false);
  }, [diagramId, setSelection]);
  useEffect(() => {
    if (!focusThread) return;
    setCommentsOpen(true);
    const target = useSession.getState().comments[focusThread];
    if (target?.targetKind === "object") setSelection({ objectId: target.targetId, edgeId: null });
    else if (target?.targetKind === "relationship") setSelection({ objectId: null, edgeId: target.targetId });
  }, [focusThread, diagramId]);
  // A deleted or removed selection closes its panel.
  const objectId = selection.objectId && ws.objects[selection.objectId] && selection.objectId in diagram.nodes ? selection.objectId : null;
  const edgeId = selection.edgeId;

  const pickedHere = useMemo(() => picked.filter((id) => ws.objects[id] && id in diagram.nodes), [picked, ws.objects, diagram.nodes]);
  const arrange = (moved: Record<string, { x: number; y: number }>) => {
    if (Object.keys(moved).length) onMove(moved);
  };

  const fitSoon = () => setTimeout(() => canvas.current?.fit(), 60);

  const onMove = useCallback(
    (positions: Record<string, { x: number; y: number }>) => {
      apply((w) => placeNodes(w, diagramId, Object.fromEntries(Object.entries(positions).map(([id, p]) => [id, { ...p, pinned: true }]))));
    },
    [diagramId],
  );

  const onConnect = useCallback(
    (sourceId: string, targetId: string) => {
      const current = useStore.getState().ws;
      const view = current.diagrams[diagramId];
      if (!view || !current.objects[sourceId] || !current.objects[targetId]) return;
      const kind = defaultKind(current, view, sourceId, targetId);
      let id: string | null = null;
      apply((w) => {
        const made = createRelationship(w, { sourceId, targetId, kind });
        id = made.relationship?.id ?? null;
        return id && view.hiddenRelationshipIds.includes(id) ? setRelationshipHidden(made.ws, diagramId, id, false) : made.ws;
      });
      if (id) setSelection({ objectId: null, edgeId: id });
    },
    [diagramId],
  );

  const addType = useCallback(
    (typeId: string, position?: { x: number; y: number }) => {
      let createdId = "";
      apply((w) => {
        const view = w.diagrams[diagramId];
        const type = objectType(typeId);
        const parentId = view.scopeId && canSetParent(w, null, typeId, view.scopeId) ? view.scopeId : null;
        const made = createObject(w, { typeId, name: `New ${type.label.toLowerCase()}`, parentId });
        createdId = made.object.id;
        return addObjectsToDiagram(made.ws, diagramId, [createdId], position);
      });
      if (createdId) setSelection({ objectId: createdId, edgeId: null });
    },
    [diagramId],
  );

  const addComponent = useCallback(
    (component: LibraryComponent, position?: { x: number; y: number }) => {
      let createdId = "";
      apply((w) => {
        const view = w.diagrams[diagramId];
        const input = objectFromComponent(component);
        const parentId = view.scopeId && canSetParent(w, null, input.typeId, view.scopeId) ? view.scopeId : null;
        const made = createObject(w, { ...input, parentId });
        createdId = made.object.id;
        return addObjectsToDiagram(made.ws, diagramId, [createdId], position);
      });
      if (createdId) setSelection({ objectId: createdId, edgeId: null });
    },
    [diagramId],
  );

  // A protocol from the library goes onto the connection picked.
  const pickProtocol = useCallback(
    (p: ProtocolInfo) => {
      const edgeId = selectionRef.current.edgeId;
      const rel = edgeId ? useStore.getState().ws.relationships[edgeId] : undefined;
      if (!rel) {
        notify("Pick a connection on the diagram first, then the protocol.");
        return;
      }
      apply((w) => setProtocols(w, rel.id, [...protocolsOf(w.relationships[rel.id]), { name: p.name, port: p.port, transport: p.transport }]));
      notify(`${protocolLabel(p)} added to the connection.`);
    },
    [notify],
  );

  // Another diagram as one box: the same box wherever that diagram is connected to.
  const addDiagram = useCallback(
    (targetId: string) => {
      let boxId: string | null = null;
      apply((w) => {
        const made = diagramBox(w, targetId);
        boxId = made.objectId;
        return boxId && !(boxId in w.diagrams[diagramId].nodes) ? addObjectsToDiagram(made.ws, diagramId, [boxId]) : made.ws;
      });
      if (boxId) setSelection({ objectId: boxId, edgeId: null });
    },
    [diagramId],
  );

  const addExisting = useCallback(
    (id: string, position?: { x: number; y: number }) => {
      apply((w) => addObjectsToDiagram(w, diagramId, [id], position));
      setSelection({ objectId: id, edgeId: null });
    },
    [diagramId],
  );

  const onDropItem = useCallback(
    (item: DragItem, position: { x: number; y: number }) => {
      if (item.kind === "type") return addType(item.id, position);
      if (item.kind === "component") {
        const component = componentById(item.id);
        return component ? addComponent(component, position) : undefined;
      }
      return addExisting(item.id, position);
    },
    [addType, addComponent, addExisting],
  );

  const onOpen = useCallback(
    (id: string) => {
      const current = useStore.getState().ws;
      const object = current.objects[id];
      if (!object) return;
      // A box standing for another diagram opens that diagram.
      if (object.typeId === "diagram") {
        if (object.diagramId && current.diagrams[object.diagramId]) navigate(`/diagram/${object.diagramId}`);
        else notify("The diagram this box stands for no longer exists.");
        return;
      }
      if (objectType(object.typeId).level >= 4) {
        notify("A component is the smallest level, so it has no inside view.");
        return;
      }
      const target = zoomInto(id);
      if (target) navigate(`/diagram/${target}`);
    },
    [navigate, notify],
  );

  const onRemove = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      apply((w) => removeNodes(w, diagramId, ids));
      setSelection(NONE);
      notify(ids.length === 1 ? "Taken off this diagram. The object is still in the model." : `${ids.length} objects taken off this diagram.`);
    },
    [diagramId, notify],
  );

  const drawnEdges = useMemo(() => visibleEdges(ws, diagram).map((e) => e.id), [ws, diagram]);
  const shownEdge = edgeId && drawnEdges.includes(edgeId) ? edgeId : null;
  const diagramComments = useMemo(() => (cloudEnabled ? commentsOn(Object.values(allComments), diagram, drawnEdges) : []), [allComments, diagram, drawnEdges]);
  const openThreads = diagramComments.filter((c) => !c.parentId && !c.resolved).length;
  const commentMarks = useMemo(() => (commentsOpen ? openThreadsByObject(diagramComments, diagram) : undefined), [commentsOpen, diagramComments, diagram]);
  const anchor: CommentAnchor | null = objectId ? { kind: "object", id: objectId } : shownEdge && ws.relationships[shownEdge] ? { kind: "relationship", id: shownEdge } : null;
  const closeComments = () => {
    setCommentsOpen(false);
    if (params.has("thread") || params.has("comments")) setParams({}, { replace: true });
  };
  const crumbs = diagram.scopeId && ws.objects[diagram.scopeId] ? [...ancestorsOf(ws, diagram.scopeId)].reverse() : [];
  const empty = Object.keys(diagram.nodes).length === 0;

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-2 h-12 px-3 bg-surface border-b border-line">
        <nav aria-label="Location" className="min-w-0 flex items-center gap-1 text-[13px] text-ink-soft">
          <Link to="/" className="hover:text-ink hover:underline shrink-0">
            Diagrams
          </Link>
          {crumbs.map((id) => (
            <span key={id} className="flex items-center gap-1 min-w-0">
              <ChevronRight size={13} className="shrink-0 text-ink-faint" />
              <button type="button" className="truncate hover:text-ink hover:underline" title={`Open the inside view of ${ws.objects[id].name}`} onClick={() => onOpen(id)}>
                {ws.objects[id].name}
              </button>
            </span>
          ))}
          <ChevronRight size={13} className="shrink-0 text-ink-faint" />
        </nav>
        <CommitInput
          aria-label="Diagram name"
          value={diagram.name}
          onCommit={(name) => apply((w) => updateDiagram(w, diagramId, { name }))}
          title={diagram.name}
          className="!w-72 !h-8 font-semibold !border-transparent hover:!border-line focus:!border-blueprint !bg-transparent"
        />
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            icon={<LayoutDashboard size={15} />}
            title="Arrange the boxes. Boxes you placed by hand stay where they are. To line up a few yourself, Shift-click them."
            onClick={() => {
              apply((w) => relayout(w, diagramId, true));
              fitSoon();
            }}
          >
            Tidy layout
          </Button>
          <Button size="sm" icon={<ShieldCheck size={14} />} onClick={() => navigate(`/checks?diagram=${diagramId}`)}>
            Check
          </Button>
          <IconButton
            label="Re-arrange everything, including boxes placed by hand"
            onClick={() => {
              apply((w) => relayout(w, diagramId, false));
              fitSoon();
            }}
          >
            <Shuffle size={16} />
          </IconButton>
          <IconButton
            label="Diagram settings"
            aria-pressed={settingsOpen && !objectId && !shownEdge}
            className={settingsOpen && !objectId && !shownEdge ? "!bg-blueprint-soft !text-blueprint-deep" : undefined}
            onClick={() => {
              const next = !(settingsOpen && !objectId && !shownEdge);
              setSelection(NONE);
              setSettingsOpen(next);
            }}
          >
            <SlidersHorizontal size={16} />
          </IconButton>
          <Button
            icon={<ListOrdered size={15} />}
            aria-pressed={flowsOpen}
            className={flowsOpen ? "!bg-blueprint-soft !text-blueprint-deep !border-transparent" : undefined}
            title={flowsOpen ? "Close the flows" : "Tell a use case step by step over this diagram"}
            data-flows-button
            onClick={() => {
              setFlowsOpen(!flowsOpen);
              if (!flowsOpen) {
                setCommentsOpen(false);
                setSelection(NONE);
              }
            }}
          >
            Flows
            {flowsOf(diagram).length > 0 && <span className="tabular-nums text-ink-soft">{flowsOf(diagram).length}</span>}
          </Button>
          {cloudEnabled && (
            <Button
              icon={<MessageSquare size={15} />}
              aria-pressed={commentsOpen}
              className={commentsOpen ? "!bg-blueprint-soft !text-blueprint-deep !border-transparent" : undefined}
              title={commentsOpen ? "Close the comments" : "Read and write comments on this diagram"}
              onClick={() => {
                if (commentsOpen) return closeComments();
                setFlowsOpen(false);
                setCommentsOpen(true);
              }}
            >
              Comments
              {openThreads > 0 && <span className="tabular-nums text-ink-soft">{openThreads}</span>}
            </Button>
          )}
          <span className="mx-1 h-5 w-px bg-line" />
          <Button icon={<Sparkles size={15} />} onClick={() => setDialog("ai")}>
            Draft with AI
          </Button>
          <ExportMenu ws={ws} diagram={diagram} canvas={canvas} onNotice={notify} />
          <Button icon={<Presentation size={15} />} title="Show this diagram full screen, without the tools around it" onClick={() => navigate(`/present/${diagramId}`)}>
            Present
          </Button>
          <Button variant="primary" icon={<Share2 size={15} />} onClick={() => setDialog("share")}>
            Share
          </Button>
        </div>
      </div>
      {copy && (
        <div role="status" className={`shrink-0 flex items-start gap-3 px-4 py-2 border-b text-sm ${!copy.valid || !copy.current ? "bg-signal-soft border-signal/30" : "bg-ok-soft border-ok/30"}`} data-copy-check={!copy.valid ? "unreadable" : copy.current ? "current" : "stale"}>
          <span className="min-w-0 flex-1">
            {!copy.valid ? (
              "The date on the copy you scanned cannot be read, so it cannot be compared with the model."
            ) : copy.current ? (
              <>
                <span className="font-medium">The copy exported on {formatDateTime(copy.asOf)} is still current.</span> Nothing on this diagram has changed since.
              </>
            ) : (
              <>
                <span className="font-medium">The copy exported on {formatDateTime(copy.asOf)} is out of date.</span>{" "}
                {[
                  copy.objects.length > 0 && `${copy.objects.length === 1 ? "One object" : `${copy.objects.length} objects`} on it changed (${copy.objects.slice(0, 4).join(", ")}${copy.objects.length > 4 ? ", and more" : ""})`,
                  copy.relationships > 0 && `${copy.relationships === 1 ? "one relationship" : `${copy.relationships} relationships`} changed or ${copy.relationships === 1 ? "was" : "were"} added`,
                  copy.diagramEdited && "boxes were added, removed or moved",
                ]
                  .filter(Boolean)
                  .join("; ")}
                . What you see here is the diagram as it is now.
              </>
            )}
          </span>
          <IconButton label="Close this note" className="size-6 shrink-0" onClick={() => setParams({}, { replace: true })}>
            <X size={15} />
          </IconButton>
        </div>
      )}
      {roleCanEdit && !canEdit && (
        <div role="status" className="shrink-0 px-4 py-2 border-b border-line bg-paper text-sm text-ink-soft" data-category-view-only={category}>
          You can view {AREA_INFO[category].label} diagrams but not change them. Ask an owner if you need to.
        </div>
      )}
      <div className="min-h-0 flex-1 flex">
        {!canEdit ? null : paletteOpen ? (
          <Palette ws={ws} diagram={diagram} onAddType={addType} onAddComponent={addComponent} onAddObject={addExisting} onAddDiagram={addDiagram} onPickProtocol={pickProtocol} onCollapse={() => togglePalette(false)} />
        ) : (
          <div className="w-11 shrink-0 flex justify-center pt-2 bg-surface border-r border-line">
            <IconButton label="Show the panel for adding objects" onClick={() => togglePalette(true)}>
              <PanelLeftOpen size={16} />
            </IconButton>
          </div>
        )}
        <div className="relative min-w-0 flex-1">
          <DiagramCanvas
            ws={ws}
            diagram={diagram}
            selection={{ objectId, edgeId }}
            picked={pickedHere}
            onPick={canEdit ? onPick : undefined}
            minimap
            comments={commentMarks}
            spotlight={flows.spotlight}
            readOnly={!canEdit}
            onSelect={onCanvasSelect}
            onMove={onMove}
            onConnect={onConnect}
            onDropItem={onDropItem}
            onOpen={onOpen}
            onRemove={onRemove}
            canvasRef={canvas}
          />
          {canEdit && pickedHere.length >= 2 && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-0.5 rounded-lg border border-line bg-surface shadow-md px-2 py-1" role="toolbar" aria-label="Arrange the picked boxes" data-arrange>
              <span className="px-1.5 text-[13px] text-ink-soft whitespace-nowrap">{pickedHere.length} picked</span>
              {ALIGN_BUTTONS.map(({ mode, label, icon: Icon }) => (
                <IconButton key={mode} label={label} data-align={mode} onClick={() => arrange(alignNodes(diagram.nodes, pickedHere, mode))}>
                  <Icon size={16} />
                </IconButton>
              ))}
              <span className="mx-1 h-5 w-px bg-line" />
              <IconButton label="Space out evenly, left to right" data-distribute="horizontal" disabled={pickedHere.length < 3} onClick={() => arrange(distributeNodes(diagram.nodes, pickedHere, "horizontal"))}>
                <AlignHorizontalSpaceAround size={16} />
              </IconButton>
              <IconButton label="Space out evenly, top to bottom" data-distribute="vertical" disabled={pickedHere.length < 3} onClick={() => arrange(distributeNodes(diagram.nodes, pickedHere, "vertical"))}>
                <AlignVerticalSpaceAround size={16} />
              </IconButton>
              <span className="mx-1 h-5 w-px bg-line" />
              <IconButton label="Stop picking" onClick={() => setPicked([])}>
                <X size={16} />
              </IconButton>
            </div>
          )}
          {(flowsOpen || flows.flow) && !(canEdit && pickedHere.length >= 2) && <FlowBar ws={ws} diagram={diagram} cursor={flows.cursor} onCursor={flows.setCursor} />}
          {empty && (
            <div className="absolute inset-0 grid place-items-center pointer-events-none">
              <div className="pointer-events-auto rounded-lg border border-dashed border-ink-faint bg-surface/90 px-6 py-5 text-center max-w-sm">
                <p className="font-semibold">This diagram is empty</p>
                <p className="text-[13px] text-ink-soft mt-1">Drag a type from the left, pick objects from the model, or describe the system and let AI draft it.</p>
                <Button className="mt-3" variant="primary" icon={<Sparkles size={15} />} onClick={() => setDialog("ai")}>
                  Draft with AI
                </Button>
              </div>
            </div>
          )}
        </div>
        {commentsOpen ? (
          <aside className="w-[340px] shrink-0 bg-surface border-l border-line" aria-label="Comments">
            <CommentCategory.Provider value={category}>
              <CommentsPanel
                ws={ws}
                diagram={diagram}
                edgeIds={drawnEdges}
                anchor={anchor}
                focusThread={focusThread}
                onPick={(target) => setSelection(target.kind === "object" ? { objectId: target.id, edgeId: null } : target.kind === "relationship" ? { objectId: null, edgeId: target.id } : NONE)}
                onClose={closeComments}
              />
            </CommentCategory.Provider>
          </aside>
        ) : flowsOpen && !objectId && !shownEdge ? (
          <aside className="w-[340px] shrink-0 bg-surface border-l border-line" aria-label="Flows">
            <FlowsPanel ws={ws} diagram={diagram} cursor={flows.cursor} canEdit={canEdit} onCursor={flows.setCursor} onClose={() => setFlowsOpen(false)} />
          </aside>
        ) : (
          (objectId || shownEdge || settingsOpen) && (
          <aside className="w-[324px] shrink-0 overflow-y-auto bg-surface border-l border-line" aria-label="Details">
            {objectId ? (
              <ObjectInspector ws={ws} diagram={diagram} objectId={objectId} onSelect={setSelection} onOpen={onOpen} />
            ) : shownEdge ? (
              <EdgeInspector ws={ws} diagram={diagram} edgeId={shownEdge} onSelect={setSelection} />
            ) : (
              <DiagramSettings ws={ws} diagram={diagram} onClose={() => setSettingsOpen(false)} />
            )}
          </aside>
          )
        )}
      </div>
      {dialog === "ai" && <AiDraftDialog ws={ws} targetDiagram={diagram} onClose={() => setDialog(null)} />}
      {dialog === "share" && <ShareDialog ws={ws} diagram={diagram} onClose={() => setDialog(null)} />}
      {notice}
    </div>
  );
}

export function DiagramEditorPage() {
  const { id = "" } = useParams();
  const ws = useWorkspace();
  const diagram = ws.diagrams[id];
  if (!diagram) {
    return (
      <EmptyState title="This diagram does not exist" text="It may have been deleted, or the link may be wrong.">
        <Link to="/" className="font-medium text-blueprint hover:underline">
          Go to diagrams
        </Link>
      </EmptyState>
    );
  }
  return <Editor ws={ws} diagram={diagram} />;
}
