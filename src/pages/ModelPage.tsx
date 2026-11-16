import { Download, FileUp, Plus, Trash2, Waypoints, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { TypeIcon } from "@/components/icons";
import { ImportDialog } from "@/components/ImportDialog";
import { ObjectEditor, ProvenanceNote, RelationshipEditor, RelationshipList, TypeOptions, UsedIn, DecisionsAbout } from "@/components/ObjectPanel";
import { Badge, Button, EmptyState, Field, IconButton, Input, Modal, Select, Tabs } from "@/components/ui";
import { CATEGORY_INFO, LIFECYCLE_INFO, RELATION_KIND_INFO, objectType } from "@/lib/catalog";
import { downloadBlob, downloadText, objectsCsv, relationshipsCsv, slugify } from "@/lib/exporters";
import { writeArchimate } from "@/lib/import/archimate";
import { modelSheets } from "@/lib/import/draft";
import { writeXlsx } from "@/lib/import/xlsx";
import { deleteObject, deleteRelationship, diagramsUsing, possibleParents, sortedObjects } from "@/lib/model";
import { searchObjects } from "@/lib/search";
import { addObject, addRelationship, apply, useWorkspace } from "@/lib/store";
import { LIFECYCLES, RELATION_KINDS, type Lifecycle, type RelationKind, type Workspace } from "@/lib/types";

const LIFECYCLE_TONE = { planned: "blue", active: "green", deprecated: "amber", retired: "red" } as const;

function NewObjectDialog({ ws, onClose, onCreated }: { ws: Workspace; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [typeId, setTypeId] = useState("application");
  const [parentId, setParentId] = useState("");
  const parents = possibleParents(ws, null, typeId);
  const create = () => {
    const object = addObject({ typeId, name, parentId: parents.some((p) => p.id === parentId) ? parentId : null });
    onClose();
    onCreated(object.id);
  };
  return (
    <Modal
      title="New object"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={create}>
            Create object
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && create()} placeholder="For example: Billing service" />
        </Field>
        <Field label="Type" hint={objectType(typeId).hint + "."}>
          <Select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            <TypeOptions />
          </Select>
        </Field>
        <Field label="Part of">
          <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">Nothing (top level)</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({objectType(p.typeId).label})
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

function NewRelationshipDialog({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const objects = sortedObjects(ws);
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [kind, setKind] = useState<RelationKind>("calls");
  const ready = sourceId && targetId && sourceId !== targetId;
  return (
    <Modal
      title="New relationship"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() => {
              addRelationship({ sourceId, targetId, kind });
              onClose();
            }}
          >
            Create relationship
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="From">
          <Select autoFocus value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            <option value="">Choose an object</option>
            {objects.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Kind" hint={RELATION_KIND_INFO[kind].hint + "."}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as RelationKind)}>
            {RELATION_KINDS.map((k) => (
              <option key={k} value={k}>
                {RELATION_KIND_INFO[k].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="To">
          <Select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            <option value="">Choose an object</option>
            {objects
              .filter((o) => o.id !== sourceId)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

export function ModelPage() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("object");
  const selected = selectedId ? ws.objects[selectedId] : undefined;
  const [tab, setTab] = useState<"objects" | "relationships">("objects");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [lifecycleFilter, setLifecycleFilter] = useState("");
  const [dialog, setDialog] = useState<"object" | "relationship" | "import" | null>(null);
  const [editingRelationship, setEditingRelationship] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const select = (id: string | null) => setParams(id ? { object: id } : {}, { replace: true });

  const objects = useMemo(() => {
    const pool = query.trim() ? searchObjects(ws, query, 2000) : sortedObjects(ws);
    return pool.filter((o) => (!typeFilter || o.typeId === typeFilter) && (!lifecycleFilter || o.lifecycle === lifecycleFilter));
  }, [ws, query, typeFilter, lifecycleFilter]);

  const relationships = useMemo(() => {
    const term = query.trim().toLowerCase();
    return Object.values(ws.relationships)
      .filter((r) => {
        if (!term) return true;
        const text = `${ws.objects[r.sourceId]?.name} ${ws.objects[r.targetId]?.name} ${r.label} ${r.protocol} ${RELATION_KIND_INFO[r.kind].label}`.toLowerCase();
        return term.split(/\s+/).every((t) => text.includes(t));
      })
      .sort((a, b) => (ws.objects[a.sourceId]?.name ?? "").localeCompare(ws.objects[b.sourceId]?.name ?? ""));
  }, [ws, query]);

  const total = Object.keys(ws.objects).length;
  const editing = editingRelationship ? ws.relationships[editingRelationship] : undefined;

  return (
    <div className="h-full flex">
      <div className="min-w-0 flex-1 overflow-auto px-6 py-7">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Model</h1>
            <p className="text-ink-soft mt-0.5">Every component and dependency, stored once. Diagrams draw from this list.</p>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button
              icon={<Download size={15} />}
              disabled={tab === "objects" ? !objects.length : !relationships.length}
              onClick={() =>
                tab === "objects"
                  ? downloadText("objects.csv", objectsCsv(ws, objects), "text/csv")
                  : downloadText("relationships.csv", relationshipsCsv(ws, relationships), "text/csv")
              }
            >
              Export CSV
            </Button>
            <Button
              icon={<Download size={15} />}
              disabled={!total}
              title="The whole model as one workbook: a sheet of objects and a sheet of relationships. Edit it in Excel and import it back to update the model."
              onClick={() =>
                downloadBlob(`${slugify(ws.name) || "model"}.xlsx`, new Blob([writeXlsx(modelSheets(ws)) as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }))
              }
            >
              Export Excel
            </Button>
            <Button
              icon={<Download size={15} />}
              disabled={!total}
              title="The model as an ArchiMate Model Exchange File, which Archi, Bizzdesign, Sparx and other tools open. Diagrams go along as views."
              onClick={() => downloadText(`${slugify(ws.name) || "model"}-archimate.xml`, writeArchimate(ws), "application/xml")}
            >
              Export ArchiMate
            </Button>
            <Button icon={<FileUp size={15} />} onClick={() => setDialog("import")}>
              Import
            </Button>
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => setDialog(tab === "objects" ? "object" : "relationship")}>
              {tab === "objects" ? "New object" : "New relationship"}
            </Button>
          </div>
        </div>

        <div className="mt-5">
          <Tabs
            tabs={[
              { id: "objects", label: "Objects", count: total },
              { id: "relationships", label: "Relationships", count: Object.keys(ws.relationships).length },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Input
            className="max-w-sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === "objects" ? "Filter by name, tag:tier-1, owner:platform" : "Filter by object, label or protocol"}
            aria-label="Filter the list"
          />
          {tab === "objects" && (
            <>
              <Select className="!w-48" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Filter by type">
                <option value="">All types</option>
                <TypeOptions />
              </Select>
              <Select className="!w-40" value={lifecycleFilter} onChange={(e) => setLifecycleFilter(e.target.value)} aria-label="Filter by lifecycle">
                <option value="">Any lifecycle</option>
                {LIFECYCLES.map((l) => (
                  <option key={l} value={l}>
                    {LIFECYCLE_INFO[l as Lifecycle].label}
                  </option>
                ))}
              </Select>
            </>
          )}
        </div>

        {total === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-ink-faint bg-surface">
            <EmptyState title="The model is empty" text="Objects appear here as you draw diagrams, accept AI drafts, or add them by hand.">
              <Button variant="primary" icon={<Plus size={15} />} onClick={() => setDialog("object")}>
                New object
              </Button>
              <Link to="/" className="font-medium text-blueprint hover:underline">
                Go to diagrams
              </Link>
            </EmptyState>
          </div>
        ) : tab === "objects" ? (
          <div className="mt-4 rounded-lg border border-line bg-surface overflow-hidden">
            <table className="w-full text-left">
              <thead className="text-[13px] text-ink-soft bg-paper border-b border-line">
                <tr>
                  <th className="font-medium px-4 py-2.5">Name</th>
                  <th className="font-medium px-3 py-2.5">Type</th>
                  <th className="font-medium px-3 py-2.5">Owner</th>
                  <th className="font-medium px-3 py-2.5">Lifecycle</th>
                  <th className="font-medium px-3 py-2.5">Tags</th>
                  <th className="font-medium px-3 py-2.5 text-right">Diagrams</th>
                </tr>
              </thead>
              <tbody>
                {objects.map((o) => {
                  const type = objectType(o.typeId);
                  const ai = o.provenance.origin === "ai-prompt" || o.provenance.origin === "ai-image";
                  return (
                    <tr
                      key={o.id}
                      onClick={() => select(o.id)}
                      className={`border-b border-line-soft last:border-b-0 cursor-pointer ${o.id === selectedId ? "bg-blueprint-soft" : "hover:bg-paper/60"}`}
                    >
                      <td className="px-4 py-2.5">
                        <button type="button" className="flex items-center gap-2 text-left" onClick={() => select(o.id)}>
                          <span style={{ color: CATEGORY_INFO[type.category].color }}>
                            <TypeIcon typeId={o.typeId} size={16} />
                          </span>
                          <span>
                            <span className="font-medium">{o.name}</span>
                            {ai && (
                              <span className="ml-2 align-middle">
                                <Badge tone="amber" title={`Approved by ${o.provenance.approvedBy ?? "a reviewer"}`}>
                                  AI draft
                                </Badge>
                              </span>
                            )}
                            {o.parentId && ws.objects[o.parentId] && <span className="block text-xs text-ink-faint">in {ws.objects[o.parentId].name}</span>}
                          </span>
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-ink-soft whitespace-nowrap">{type.label}</td>
                      <td className="px-3 py-2.5 text-ink-soft">{o.owner || <span className="text-ink-faint">None</span>}</td>
                      <td className="px-3 py-2.5">
                        <Badge tone={LIFECYCLE_TONE[o.lifecycle]}>{LIFECYCLE_INFO[o.lifecycle].label}</Badge>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="flex flex-wrap gap-1">
                          {o.tags.map((t) => (
                            <Badge key={t}>{t}</Badge>
                          ))}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{diagramsUsing(ws, o.id).length}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {objects.length === 0 && <p className="px-4 py-6 text-center text-ink-soft">No object matches these filters.</p>}
          </div>
        ) : (
          <div className="mt-4 rounded-lg border border-line bg-surface overflow-hidden">
            <table className="w-full text-left">
              <thead className="text-[13px] text-ink-soft bg-paper border-b border-line">
                <tr>
                  <th className="font-medium px-4 py-2.5">From</th>
                  <th className="font-medium px-3 py-2.5">Kind</th>
                  <th className="font-medium px-3 py-2.5">To</th>
                  <th className="font-medium px-3 py-2.5">Label</th>
                  <th className="font-medium px-3 py-2.5">Protocol and port</th>
                  <th className="font-medium px-3 py-2.5">Impact analysis</th>
                  <th className="px-3 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {relationships.map((r) => (
                  <tr key={r.id} className="border-b border-line-soft last:border-b-0 hover:bg-paper/60 cursor-pointer" onClick={() => setEditingRelationship(r.id)}>
                    <td className="px-4 py-2.5 font-medium">{ws.objects[r.sourceId]?.name}</td>
                    <td className="px-3 py-2.5 text-ink-soft whitespace-nowrap">{RELATION_KIND_INFO[r.kind].label}</td>
                    <td className="px-3 py-2.5 font-medium">{ws.objects[r.targetId]?.name}</td>
                    <td className="px-3 py-2.5 text-ink-soft">{r.label}</td>
                    <td className="px-3 py-2.5 text-ink-soft tabular-nums">{[r.protocol, r.port].filter(Boolean).join(" ")}</td>
                    <td className="px-3 py-2.5">
                      {RELATION_KIND_INFO[r.kind].dependency ? <Badge tone="blue">Counts</Badge> : <span className="text-ink-faint text-[13px]">Not a dependency</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <IconButton
                        label="Delete relationship"
                        onClick={(e) => {
                          e.stopPropagation();
                          apply((w) => deleteRelationship(w, r.id));
                        }}
                      >
                        <Trash2 size={15} />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {relationships.length === 0 && <p className="px-4 py-6 text-center text-ink-soft">No relationship matches.</p>}
          </div>
        )}
      </div>

      {selected && (
        <aside className="w-[360px] shrink-0 overflow-y-auto bg-surface border-l border-line" aria-label="Object details">
          <div className="flex items-start gap-2.5 px-4 py-3.5">
            <span className="mt-0.5" style={{ color: CATEGORY_INFO[objectType(selected.typeId).category].color }}>
              <TypeIcon typeId={selected.typeId} size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold break-words">{selected.name}</h2>
              <p className="text-[13px] text-ink-soft">{objectType(selected.typeId).label}</p>
            </div>
            <IconButton label="Close panel" onClick={() => select(null)}>
              <X size={16} />
            </IconButton>
          </div>
          <div className="px-4 pb-3">
            <Button size="sm" icon={<Waypoints size={14} />} onClick={() => navigate(`/analysis?object=${selected.id}`)}>
              Dependencies
            </Button>
          </div>
          <section className="px-4 py-3.5 border-t border-line-soft">
            <ObjectEditor ws={ws} object={selected} />
          </section>
          <section className="px-4 py-3.5 border-t border-line-soft">
            <h3 className="text-[13px] font-semibold mb-2">Relationships</h3>
            <RelationshipList ws={ws} objectId={selected.id} onPick={(id) => select(id)} />
          </section>
          <section className="px-4 py-3.5 border-t border-line-soft">
            <h3 className="text-[13px] font-semibold mb-2">Shown on</h3>
            <UsedIn ws={ws} objectId={selected.id} />
          </section>
          <section className="px-4 py-3.5 border-t border-line-soft">
            <h3 className="text-[13px] font-semibold mb-2">Decisions</h3>
            <DecisionsAbout ws={ws} objectId={selected.id} />
          </section>
          <section className="px-4 py-3.5 border-t border-line-soft">
            <h3 className="text-[13px] font-semibold mb-2">Origin</h3>
            <ProvenanceNote provenance={selected.provenance} />
          </section>
          <section className="px-4 py-3.5 border-t border-line-soft">
            <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => setConfirmDelete(true)}>
              Delete from the model
            </Button>
          </section>
        </aside>
      )}

      {dialog === "object" && <NewObjectDialog ws={ws} onClose={() => setDialog(null)} onCreated={select} />}
      {dialog === "relationship" && <NewRelationshipDialog ws={ws} onClose={() => setDialog(null)} />}
      {dialog === "import" && <ImportDialog onClose={() => setDialog(null)} />}
      {editing && (
        <Modal title="Relationship" onClose={() => setEditingRelationship(null)} footer={<Button onClick={() => setEditingRelationship(null)}>Done</Button>}>
          <RelationshipEditor ws={ws} relationship={editing} />
          <div className="mt-4">
            <ProvenanceNote provenance={editing.provenance} />
          </div>
        </Modal>
      )}
      {confirmDelete && selected && (
        <Modal
          title={`Delete "${selected.name}" from the model?`}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(false)}>Keep it</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const id = selected.id;
                  setConfirmDelete(false);
                  select(null);
                  apply((w) => deleteObject(w, id));
                }}
              >
                Delete object
              </Button>
            </>
          }
        >
          <p>
            It is removed from {diagramsUsing(ws, selected.id).length} diagrams together with its relationships. Objects nested inside it move up one level. You can undo this with
            Ctrl Z.
          </p>
        </Modal>
      )}
    </div>
  );
}
