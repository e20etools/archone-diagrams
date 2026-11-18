import { Check, CornerUpLeft, PencilLine, Send, Undo2, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, IconButton, Textarea, cx, formatDateTime } from "@/components/ui";
import { APPROVAL_ROLES, EVENT_LABEL, ROLE_LABEL, STATUS_LABEL, STATUS_TONE, roleCell, sealOf, type ApprovalRole, type DiagramRecord } from "@/lib/approvals";
import type { ApprovalDecision } from "@/lib/cloud/backend";
import { approvalStep, errorText, useSession } from "@/lib/cloud/session";
import type { Diagram } from "@/lib/types";

const BADGE_TONE = { ok: "green", warn: "amber", danger: "red", muted: "neutral", blue: "blue" } as const;

/**
 * The approval of one diagram: where it stands, what each role said, and what this person can do
 * now: send it, send it again after a return, withdraw it, or decide for the role they approve for.
 */
export function ApprovalPanel({ diagram, record, problem, canEdit, onRecord, onClose }: { diagram: Diagram; record: DiagramRecord | null; problem: string; canEdit: boolean; onRecord: (record: DiagramRecord) => void; onClose: () => void }) {
  const me = useSession((s) => s.user);
  const role = useSession((s) => s.role);
  const sync = useSession((s) => s.sync.kind);
  const [note, setNote] = useState("");
  const [notes, setNotes] = useState<Record<ApprovalRole, string>>({ ea: "", security: "" });
  const [editing, setEditing] = useState<ApprovalRole | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saving = sync === "saving" || sync === "offline";

  const run = async (work: Parameters<typeof approvalStep<DiagramRecord>>[0]) => {
    setBusy(true);
    setError("");
    try {
      onRecord(await approvalStep(work));
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const decide = async (which: ApprovalRole, decision: ApprovalDecision) => {
    if (await run((backend, ws) => backend.decideDiagram(ws, diagram.id, which, decision, notes[which]))) {
      setNotes((n) => ({ ...n, [which]: "" }));
      setEditing(null);
    }
  };

  const header = (
    <div className="flex items-start gap-2 px-4 py-3.5 border-b border-line">
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold">Approval</h2>
        <p className="text-[13px] text-ink-soft mt-0.5">Enterprise Architecture and Cybersecurity approve each version of this diagram.</p>
      </div>
      <IconButton label="Close panel" onClick={onClose}>
        <X size={16} />
      </IconButton>
    </div>
  );
  if (!record)
    return (
      <div className="h-full flex flex-col" data-approval-panel="loading">
        {header}
        <p className={cx("px-4 py-3 text-[13px]", problem ? "text-danger" : "text-ink-soft")}>{problem || "Reading where this diagram stands."}</p>
      </div>
    );

  const configured = record.approvers.ea.length > 0 && record.approvers.security.length > 0;
  const request = record.request;
  const open = record.status === "pending" || record.status === "returned";
  const mayWithdraw = open && ((request?.requestedById === me?.id && canEdit) || role === "owner");
  const mayDecide = APPROVAL_ROLES.filter((r) => record.mine[r] && record.status === "pending" && record.roles[r].state !== "approved");
  const seal = sealOf(record);
  const returnedNotes = record.status === "returned" ? APPROVAL_ROLES.filter((r) => record.roles[r].state === "returned") : [];

  return (
    <div className="h-full flex flex-col" data-approval-panel={record.status}>
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 py-3 space-y-2 border-b border-line-soft">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold" data-approval-version={record.version}>
              Version {record.version}
            </span>
            <Badge tone={BADGE_TONE[STATUS_TONE[record.status]]}>{STATUS_LABEL[record.status]}</Badge>
          </div>
          {record.status === "changed" && <p className="text-[13px] text-signal">Changed since version {record.approvedVersion} was approved. Send it for approval to make it version {record.version}.</p>}
          {record.required && <p className="text-[13px] text-ink-soft">In this workspace a diagram is published only once both roles approve it. Live links and verified copies show the last approved version.</p>}
          {request && open && (
            <p className="text-[13px] text-ink-soft" data-approval-request>
              Sent by {request.requestedBy || "someone"} on {formatDateTime(request.requestedAt)}
              {request.round > 1 ? `, for the ${request.round === 2 ? "second" : request.round === 3 ? "third" : `${request.round}th`} time` : ""}.
              {request.note && <span className="block mt-1 whitespace-pre-wrap text-ink">“{request.note}”</span>}
            </p>
          )}
          {seal.code && (
            <p className="text-[13px]">
              <span className="text-ink-soft">Seal </span>
              <span className="font-mono tabular-nums" data-approval-seal>
                {seal.code}
              </span>
              <span className={cx("ml-1", seal.tone === "ok" ? "text-ok" : seal.tone === "warn" ? "text-signal" : "text-ink-faint")}>{seal.text}</span>
            </p>
          )}
        </div>

        <ul className="divide-y divide-line-soft border-b border-line-soft">
          {APPROVAL_ROLES.map((r) => {
            const standing = record.roles[r];
            const cell = roleCell(standing);
            return (
              <li key={r} className="px-4 py-2.5" data-approval-role={r} data-state={standing.state}>
                <div className="flex items-center gap-2">
                  <span className={cx("grid size-5 shrink-0 place-items-center rounded-full text-white", cell.yes ? "bg-ok" : "bg-danger")} aria-hidden>
                    {cell.yes ? <Check size={12} strokeWidth={3} /> : <X size={12} strokeWidth={3} />}
                  </span>
                  <span className="text-sm font-medium">{ROLE_LABEL[r]}</span>
                  <span className="ml-auto text-xs font-medium">{cell.yes ? "Yes" : "No"}</span>
                </div>
                <p className="mt-0.5 pl-7 text-[13px] text-ink-soft">
                  {cell.text}
                  {standing.at && standing.state !== "waiting" ? `, ${formatDateTime(standing.at)}` : ""}
                </p>
                {standing.note && (standing.state === "returned" || standing.state === "rejected" || standing.state === "approved") && (
                  <p className="mt-1 ml-7 rounded bg-paper px-2 py-1 text-[13px] whitespace-pre-wrap">{standing.note}</p>
                )}
                <p className="mt-0.5 pl-7 text-xs text-ink-faint">
                  {record.approvers[r].length ? `Approvers: ${record.approvers[r].map((a) => a.name || "a member").join(", ")}` : "No approver named yet"}
                </p>
              </li>
            );
          })}
        </ul>

        <div className="px-4 py-3 space-y-3">
          {!configured ? (
            <p className="text-[13px] text-ink-soft">
              An owner names the Enterprise Architecture and Cybersecurity approvers in{" "}
              <Link to="/settings" className="text-blueprint hover:underline">
                Settings
              </Link>
              , under Review and approval.
            </p>
          ) : (
            <>
              {returnedNotes.length > 0 && (
                <div className="rounded-md border border-signal/30 bg-signal-soft px-3 py-2 text-[13px]" data-approval-returned>
                  <p className="font-medium">Returned for changes</p>
                  <p className="text-ink-soft">Fix what the approvers asked for on the canvas, then send it again.</p>
                </div>
              )}
              {canEdit && (record.status === "draft" || record.status === "changed" || record.status === "rejected" || record.status === "returned") && (
                <div className="space-y-2" data-approval-send>
                  <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder={record.status === "returned" ? "What you changed (optional)" : "What this version is for (optional)"} aria-label="Note for the approvers" />
                  <Button
                    variant="primary"
                    icon={<Send size={14} />}
                    disabled={busy || saving}
                    onClick={() => void run((backend, ws) => backend.submitDiagram(ws, diagram.id, note)).then((ok) => ok && setNote(""))}
                  >
                    {record.status === "returned" ? "Send again" : "Send for approval"}
                  </Button>
                </div>
              )}
              {mayDecide.map((r) => (
                <div key={r} className="rounded-md border border-line px-3 py-2.5 space-y-2" data-approval-decide={r}>
                  <p className="text-[13px] font-medium">Your decision for {ROLE_LABEL[r]}</p>
                  {editing === r && (
                    <p className="text-[13px] text-ink-soft" data-approval-editing>
                      Change the diagram on the canvas; your changes are saved as you go. Then approve it as you changed it. {record.roles[r === "ea" ? "security" : "ea"].state === "approved" ? `${ROLE_LABEL[r === "ea" ? "security" : "ea"]} will be asked to approve the changed diagram again.` : ""}
                    </p>
                  )}
                  <Textarea rows={2} value={notes[r]} onChange={(e) => setNotes((n) => ({ ...n, [r]: e.target.value }))} maxLength={2000} placeholder="Notes: what to fix, or what you changed" aria-label={`Notes from ${ROLE_LABEL[r]}`} />
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="primary" icon={<Check size={13} />} disabled={busy || saving} onClick={() => void decide(r, "approve")} data-approve={r}>
                      {editing === r ? "Approve with my changes" : "Approve"}
                    </Button>
                    {canEdit && editing !== r && (
                      <Button size="sm" icon={<PencilLine size={13} />} disabled={busy} onClick={() => setEditing(r)} data-edit-then-approve={r}>
                        Edit, then approve
                      </Button>
                    )}
                    <Button size="sm" icon={<CornerUpLeft size={13} />} disabled={busy || saving || !notes[r].trim()} title={notes[r].trim() ? undefined : "Write what has to change first"} onClick={() => void decide(r, "return")} data-return={r}>
                      Return with notes
                    </Button>
                    <Button size="sm" variant="danger" disabled={busy || saving || !notes[r].trim()} title={notes[r].trim() ? undefined : "Write the reason first"} onClick={() => void decide(r, "reject")} data-reject={r}>
                      Reject
                    </Button>
                  </div>
                </div>
              ))}
              {APPROVAL_ROLES.some((r) => record.mine[r]) && record.status === "returned" && <p className="text-[13px] text-ink-soft">It can be decided again once its sender sends it back.</p>}
              {mayWithdraw && (
                <Button size="sm" variant="ghost" icon={<Undo2 size={13} />} disabled={busy} onClick={() => void run((backend, ws) => backend.withdrawDiagram(ws, diagram.id))} data-approval-withdraw>
                  Withdraw the request
                </Button>
              )}
              {saving && <p className="text-xs text-ink-faint">Saving your latest changes first.</p>}
            </>
          )}
          {error && (
            <p role="alert" className="rounded-md bg-danger-soft text-danger px-3 py-2 text-[13px]">
              {error}
            </p>
          )}
        </div>

        {record.history.length > 0 && (
          <div className="px-4 pb-4">
            <h3 className="text-xs font-medium text-ink-soft mb-1.5">History</h3>
            <ol className="space-y-2 border-l border-line pl-3" data-approval-history>
              {record.history.map((h, i) => (
                <li key={i} className="text-[13px]" data-event={h.kind}>
                  <span className="font-medium">{EVENT_LABEL[h.kind]}</span>
                  {h.role && <span className="text-ink-soft"> · {ROLE_LABEL[h.role]}</span>}
                  <span className="text-ink-soft">
                    {" "}
                    · version {h.version}
                    {h.by ? ` · ${h.by}` : ""} · {formatDateTime(h.at)}
                  </span>
                  {h.note && <span className="block whitespace-pre-wrap text-ink-soft">{h.note}</span>}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
