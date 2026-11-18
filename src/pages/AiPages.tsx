import { Check, FileUp, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AiDraftDialog } from "@/components/dialogs";
import { TypeIcon } from "@/components/icons";
import { ImportDialog } from "@/components/ImportDialog";
import { TypeOptions } from "@/components/ObjectPanel";
import { Badge, Button, CommitInput, EmptyState, Modal, Select, cx, formatDateTime } from "@/components/ui";
import { RULES_ENGINE } from "@/lib/ai/heuristic";
import { dismissProposal, importUpdates, proposalCounts, relationshipReady, setAllDecisions, updateProposal } from "@/lib/ai/proposals";
import { RELATION_KIND_INFO, objectType } from "@/lib/catalog";
import { findByName } from "@/lib/model";
import { apply, applyProposalNow, useWorkspace } from "@/lib/store";
import { RELATION_KINDS, type Decision, type Proposal, type ProposedObject, type ProposedRelationship, type RelationKind } from "@/lib/types";

const STATUS = {
  pending: { label: "Waiting for review", tone: "amber" },
  applied: { label: "Saved to the model", tone: "green" },
  dismissed: { label: "Discarded", tone: "neutral" },
} as const;

const sourceLabel = (p: Proposal) => (p.origin === "ai-image" ? `Image: ${p.source}` : p.origin === "import" ? (p.importKind === "apm" ? p.source : p.importKind === "discovery" && !/\.[a-z0-9]+$/i.test(p.source) ? `Discovered: ${p.source}` : `File: ${p.source}`) : p.source.trim().replace(/\s+/g, " "));

export function AiInboxPage() {
  const ws = useWorkspace();
  const [drafting, setDrafting] = useState(false);
  const [importing, setImporting] = useState(false);
  const proposals = Object.values(ws.proposals).sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="max-w-5xl mx-auto px-6 py-7">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Drafts to review</h1>
          <p className="text-ink-soft mt-0.5">AI drafts and imported files wait here. Nothing reaches the model until a person accepts it.</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button icon={<FileUp size={15} />} onClick={() => setImporting(true)}>
            Import a file
          </Button>
          <Button variant="primary" icon={<Sparkles size={15} />} onClick={() => setDrafting(true)}>
            Draft with AI
          </Button>
        </div>
      </div>
      {proposals.length === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed border-ink-faint bg-surface">
          <EmptyState title="No drafts yet" text="Describe a system in a few sentences, upload a picture of an existing diagram, or import a spreadsheet, a Visio drawing or a draw.io file, and review what comes out.">
            <Button variant="primary" icon={<Sparkles size={15} />} onClick={() => setDrafting(true)}>
              Draft with AI
            </Button>
          </EmptyState>
        </div>
      ) : (
        <ul className="mt-6 space-y-2.5">
          {proposals.map((p) => {
            const counts = proposalCounts(p);
            return (
              <li key={p.id}>
                <Link
                  to={`/ai/${p.id}`}
                  className={cx(
                    "block rounded-lg border bg-surface px-4 py-3 hover:border-blueprint",
                    p.status === "pending" ? "border-signal/50 border-l-4 border-l-signal" : "border-line",
                  )}
                >
                  <div className="flex items-start justify-between gap-4">
                    <p className="font-medium line-clamp-2">{sourceLabel(p)}</p>
                    <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>
                  </div>
                  <p className="mt-1 text-[13px] text-ink-soft">
                    {counts.objects} objects and {counts.relationships} relationships {p.origin === "import" ? "read by the" : "proposed by"} {p.origin === "import" ? p.engine.toLowerCase().replace("visio", "Visio").replace("mermaid", "Mermaid").replace("structurizr", "Structurizr") : p.engine}, {formatDateTime(p.createdAt)}
                    {p.decidedBy && p.status !== "pending" ? `. Decided by ${p.decidedBy}.` : ""}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {drafting && <AiDraftDialog ws={ws} onClose={() => setDrafting(false)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </div>
  );
}

function DecisionButtons({ decision, onChange, disabled, name }: { decision: Decision; onChange: (d: Decision) => void; disabled?: boolean; name: string }) {
  const base = "inline-flex items-center gap-1 h-7 px-2 rounded-md border text-[13px] font-medium disabled:opacity-45 disabled:cursor-not-allowed";
  return (
    <span className="inline-flex gap-1">
      <button
        type="button"
        disabled={disabled}
        aria-pressed={decision === "accepted"}
        aria-label={`Accept ${name}`}
        onClick={() => onChange(decision === "accepted" ? "pending" : "accepted")}
        className={cx(base, decision === "accepted" ? "bg-ok text-white border-ok" : "bg-surface border-line text-ink-soft hover:border-ok hover:text-ok")}
      >
        <Check size={14} /> Accept
      </button>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={decision === "rejected"}
        aria-label={`Reject ${name}`}
        onClick={() => onChange(decision === "rejected" ? "pending" : "rejected")}
        className={cx(base, decision === "rejected" ? "bg-danger text-white border-danger" : "bg-surface border-line text-ink-soft hover:border-danger hover:text-danger")}
      >
        <X size={14} /> Reject
      </button>
    </span>
  );
}

export function ProposalReviewPage() {
  const { id = "" } = useParams();
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const proposal = ws.proposals[id];
  if (!proposal) {
    return (
      <EmptyState title="This draft does not exist" text="It may have been removed with a restored backup.">
        <Link to="/ai" className="font-medium text-blueprint hover:underline">
          Go to drafts
        </Link>
      </EmptyState>
    );
  }

  const pending = proposal.status === "pending";
  const counts = proposalCounts(proposal);
  const byKey = new Map(proposal.objects.map((o) => [o.key, o]));
  const acceptedObjects = proposal.objects.filter((o) => o.decision === "accepted").length;
  const readyRelationships = proposal.relationships.filter((r) => r.decision === "accepted" && relationshipReady(proposal, r.key)).length;
  const target = proposal.targetDiagramId ? ws.diagrams[proposal.targetDiagramId] : undefined;
  const result = proposal.resultDiagramId ? ws.diagrams[proposal.resultDiagramId] : undefined;
  const usedRules = proposal.engine === RULES_ENGINE;

  const patchObject = (key: string, change: Partial<ProposedObject>) =>
    apply((w) => updateProposal(w, id, (p) => ({ ...p, objects: p.objects.map((o) => (o.key === key ? { ...o, ...change } : o)) })));
  const patchRelationship = (key: string, change: Partial<ProposedRelationship>) =>
    apply((w) => updateProposal(w, id, (p) => ({ ...p, relationships: p.relationships.map((r) => (r.key === key ? { ...r, ...change } : r)) })));

  const save = () => {
    const outcome = applyProposalNow(id);
    if (outcome.diagramId) navigate(`/diagram/${outcome.diagramId}`);
    // A spreadsheet draws nothing; the model list is where its rows can be seen.
    else if (proposal.withoutDiagram && outcome.createdObjects + outcome.reusedObjects > 0) navigate("/model");
  };

  return (
    <div className="max-w-6xl mx-auto px-6 pt-7 pb-28">
      <Link to="/ai" className="text-[13px] text-ink-soft hover:text-ink hover:underline">
        Drafts
      </Link>
      <div className="mt-1 flex items-start justify-between gap-4">
        <h1 className="text-xl font-semibold">Review the draft</h1>
        <Badge tone={STATUS[proposal.status].tone}>{STATUS[proposal.status].label}</Badge>
      </div>

      <div className="mt-4 rounded-lg border border-line bg-surface px-4 py-3.5">
        <div className="text-[13px] text-ink-soft">{proposal.origin === "ai-image" ? "Drafted from an uploaded image" : proposal.sourceKind === "transcript" ? "Drafted from what was said in a meeting" : proposal.importKind === "apm" ? "Read from the application portfolio" : proposal.importKind === "iac" ? "Read from infrastructure as code" : proposal.importKind === "discovery" ? "Read from what a cloud account or discovery tool reports" : proposal.origin === "import" ? "Imported from this file" : proposal.origin === "api" ? "Proposed through the API or an AI assistant" : "Drafted from this description"}</div>
        <p className="mt-1 whitespace-pre-wrap">{proposal.source}</p>
        <p className="mt-2.5 text-[13px] text-ink-soft">
          {proposal.origin === "import" ? "Read by" : proposal.origin === "api" ? "Sent with" : "Engine"}: {proposal.engine}. {proposal.origin === "import" ? "Imported" : proposal.origin === "api" ? "Received" : "Drafted"} {formatDateTime(proposal.createdAt)}.
          {proposal.decidedBy && !pending ? ` ${proposal.status === "applied" ? "Approved" : "Discarded"} by ${proposal.decidedBy}, ${formatDateTime(proposal.decidedAt ?? "")}.` : ""}
        </p>
        {proposal.notes && !usedRules && <p className="mt-2 text-[13px] text-ink-soft">{proposal.origin === "import" ? proposal.notes : proposal.origin === "api" ? `Note from the sender: ${proposal.notes}` : `Note from the engine: ${proposal.notes}`}</p>}
      </div>

      {pending && usedRules && (
        <p className="mt-3 rounded-md bg-signal-soft text-signal px-4 py-2.5 text-sm">
          No AI model is connected, so this draft was read with the built-in rules. They only catch plainly stated components and connections. Check each line.
        </p>
      )}
      {!pending && result && (
        <p className="mt-3 text-sm">
          The accepted items were saved to{" "}
          <Link to={`/diagram/${result.id}`} className="font-medium text-blueprint hover:underline">
            {result.name}
          </Link>
          .
        </p>
      )}

      <section className="mt-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">
            Objects <span className="text-ink-faint font-normal tabular-nums">{proposal.objects.length}</span>
          </h2>
          {pending && (
            <div className="flex gap-1.5">
              <Button size="sm" onClick={() => apply((w) => setAllDecisions(w, id, "accepted"))}>
                Accept all
              </Button>
              <Button size="sm" variant="ghost" onClick={() => apply((w) => setAllDecisions(w, id, "pending"))}>
                Clear decisions
              </Button>
            </div>
          )}
        </div>
        <div className="mt-2 rounded-lg border border-line bg-surface overflow-x-auto">
          <table className="w-full text-left min-w-[860px]">
            <thead className="text-[13px] text-ink-soft bg-paper border-b border-line">
              <tr>
                <th className="font-medium px-4 py-2.5 w-[23%]">Name</th>
                <th className="font-medium px-2 py-2.5 w-[15%]">Type</th>
                <th className="font-medium px-2 py-2.5 w-[14%]">Part of</th>
                <th className="font-medium px-2 py-2.5 w-[12%]">Technology</th>
                <th className="font-medium px-2 py-2.5">In the model</th>
                <th className="font-medium px-4 py-2.5 text-right w-[190px]">Decision</th>
              </tr>
            </thead>
            <tbody>
              {proposal.objects.map((o) => {
                const match = o.matchId ? ws.objects[o.matchId] : undefined;
                const updates = (proposal.origin === "import" || proposal.origin === "api") && pending ? importUpdates(ws, o) : [];
                const level = objectType(o.typeId).level;
                const parents = proposal.objects.filter((p) => p.key !== o.key && objectType(p.typeId).level < level);
                return (
                  <tr key={o.key} className={cx("border-b border-line-soft last:border-b-0", o.decision === "rejected" && "opacity-55")}>
                    <td className="px-4 py-2">
                      {pending ? (
                        <CommitInput
                          aria-label="Object name"
                          value={o.name}
                          onCommit={(name) => name.trim() && patchObject(o.key, { name: name.trim(), matchId: findByName(ws, name)?.id ?? null })}
                        />
                      ) : (
                        <span className="flex items-center gap-2 font-medium">
                          <TypeIcon typeId={o.typeId} size={15} />
                          {o.name}
                        </span>
                      )}
                      {o.description && <p className="mt-1 text-xs text-ink-soft">{o.description}</p>}
                      {o.evidence && (
                        <p className="mt-1 text-xs text-ink-soft border-l-2 border-line pl-2" data-evidence>
                          {o.evidence}
                        </p>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {pending ? (
                        <Select aria-label={`Type of ${o.name}`} value={o.typeId} onChange={(e) => patchObject(o.key, { typeId: e.target.value })}>
                          <TypeOptions />
                        </Select>
                      ) : (
                        <span className="text-ink-soft">{objectType(o.typeId).label}</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {pending ? (
                        <Select aria-label={`What ${o.name} is part of`} value={o.parentKey ?? ""} onChange={(e) => patchObject(o.key, { parentKey: e.target.value || null })}>
                          <option value="">Nothing</option>
                          {parents.map((p) => (
                            <option key={p.key} value={p.key}>
                              {p.name}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <span className="text-ink-soft">{(o.parentKey && byKey.get(o.parentKey)?.name) || "Nothing"}</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {pending ? (
                        <CommitInput aria-label={`Technology of ${o.name}`} value={o.technology} onCommit={(technology) => patchObject(o.key, { technology })} placeholder="None" />
                      ) : (
                        <span className="text-ink-soft">{o.technology}</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-[13px]">
                      {match ? (
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <Badge tone="blue" title={`Accepting reuses "${match.name}" instead of creating a duplicate.`}>
                            Reuses the existing one
                          </Badge>
                          {updates.length > 0 && (
                            <Badge tone="amber" title={`Accepting writes the file's value for: ${updates.join(", ")}.`}>
                              Updates {updates.join(", ").toLowerCase()}
                            </Badge>
                          )}
                          {pending && (
                            <button type="button" className="text-blueprint hover:underline" onClick={() => patchObject(o.key, { matchId: null })}>
                              Make a new one
                            </button>
                          )}
                        </span>
                      ) : (
                        <span className="text-ink-soft">New object</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {pending ? (
                        <DecisionButtons name={o.name} decision={o.decision} onChange={(decision) => patchObject(o.key, { decision })} />
                      ) : (
                        <Badge tone={o.decision === "accepted" ? "green" : "neutral"}>{o.decision === "accepted" ? "Accepted" : "Rejected"}</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {proposal.objects.length === 0 && <p className="px-4 py-6 text-center text-ink-soft">{proposal.origin === "import" ? "No objects were found in this file." : "The engine found no objects in this input."}</p>}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold">
          Relationships <span className="text-ink-faint font-normal tabular-nums">{proposal.relationships.length}</span>
        </h2>
        <div className="mt-2 rounded-lg border border-line bg-surface overflow-x-auto">
          <table className="w-full text-left min-w-[860px]">
            <thead className="text-[13px] text-ink-soft bg-paper border-b border-line">
              <tr>
                <th className="font-medium px-4 py-2.5">From</th>
                <th className="font-medium px-2 py-2.5 w-[19%]">Kind</th>
                <th className="font-medium px-2 py-2.5">To</th>
                <th className="font-medium px-2 py-2.5 w-[22%]">Label</th>
                <th className="font-medium px-4 py-2.5 text-right">Decision</th>
              </tr>
            </thead>
            <tbody>
              {proposal.relationships.map((r) => {
                const source = byKey.get(r.sourceKey);
                const targetObject = byKey.get(r.targetKey);
                const endRejected = source?.decision === "rejected" || targetObject?.decision === "rejected";
                const waiting = r.decision === "accepted" && !relationshipReady(proposal, r.key);
                const name = `${source?.name ?? "?"} to ${targetObject?.name ?? "?"}`;
                return (
                  <tr key={r.key} className={cx("border-b border-line-soft last:border-b-0", (r.decision === "rejected" || endRejected) && "opacity-55")}>
                    <td className="px-4 py-2 font-medium">{source?.name ?? "?"}</td>
                    <td className="px-2 py-2">
                      {pending ? (
                        <Select aria-label={`Kind of ${name}`} value={r.kind} onChange={(e) => patchRelationship(r.key, { kind: e.target.value as RelationKind })}>
                          {RELATION_KINDS.map((k) => (
                            <option key={k} value={k}>
                              {RELATION_KIND_INFO[k].label}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <span className="text-ink-soft">{RELATION_KIND_INFO[r.kind].label}</span>
                      )}
                    </td>
                    <td className="px-2 py-2 font-medium">{targetObject?.name ?? "?"}</td>
                    <td className="px-2 py-2">
                      {pending ? (
                        <CommitInput aria-label={`Label of ${name}`} value={r.label} onCommit={(label) => patchRelationship(r.key, { label })} placeholder="None" />
                      ) : (
                        <span className="text-ink-soft">{r.label}</span>
                      )}
                      {r.evidence && (
                        <p className="mt-1 text-xs text-ink-soft border-l-2 border-line pl-2" data-evidence>
                          {r.evidence}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {pending ? (
                        <>
                          <DecisionButtons name={name} decision={r.decision} disabled={endRejected} onChange={(decision) => patchRelationship(r.key, { decision })} />
                          {endRejected && <span className="block mt-1 text-xs text-ink-soft">One of its objects is rejected</span>}
                          {waiting && !endRejected && <span className="block mt-1 text-xs text-signal">Accept both objects to save this</span>}
                        </>
                      ) : (
                        <Badge tone={r.decision === "accepted" ? "green" : "neutral"}>{r.decision === "accepted" ? "Accepted" : "Rejected"}</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {proposal.relationships.length === 0 && <p className="px-4 py-6 text-center text-ink-soft">{proposal.origin === "import" ? "No relationships were found in this file." : "The engine found no relationships in this input."}</p>}
        </div>
      </section>

      {pending && (
        <div className="fixed bottom-0 right-0 left-[212px] z-30 border-t border-line bg-surface/95 backdrop-blur pl-6 pr-20 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-sm">
            <span className="font-semibold tabular-nums">{acceptedObjects}</span> of {proposal.objects.length} objects and{" "}
            <span className="font-semibold tabular-nums">{readyRelationships}</span> of {proposal.relationships.length} relationships will be saved to{" "}
            {proposal.withoutDiagram ? "the model, without a diagram" : target ? <span className="font-medium">{target.name}</span> : proposal.placeAsDrawn ? "a new diagram, laid out as it was drawn" : "a new diagram"}.
            {counts.pending > 0 && <span className="text-ink-soft"> {counts.pending} still undecided; undecided items are not saved.</span>}
          </p>
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={() => setConfirmDiscard(true)}>
              Discard draft
            </Button>
            <Button variant="primary" disabled={acceptedObjects === 0} onClick={save}>
              Save accepted to the model
            </Button>
          </div>
        </div>
      )}

      {confirmDiscard && (
        <Modal
          title="Discard this draft?"
          onClose={() => setConfirmDiscard(false)}
          footer={
            <>
              <Button onClick={() => setConfirmDiscard(false)}>Keep reviewing</Button>
              <Button
                variant="danger"
                onClick={() => {
                  apply((w) => dismissProposal(w, id, w.userName.trim() || "Unnamed reviewer"));
                  setConfirmDiscard(false);
                  navigate("/ai");
                }}
              >
                Discard draft
              </Button>
            </>
          }
        >
          <p>None of its suggestions reach the model. The draft stays in the list as a record.</p>
        </Modal>
      )}
    </div>
  );
}
