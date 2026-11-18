import { Check, X } from "lucide-react";
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Badge, EmptyState, cx, formatDateTime } from "@/components/ui";
import { APPROVAL_ROLES, ROLE_LABEL, ROLE_SHORT, roleCell, waitsFor, type ApprovalRole, type QueueItem } from "@/lib/approvals";
import { refreshApprovals, useSession } from "@/lib/cloud/session";

const RECENT_LABEL = { approved: "Approved", rejected: "Rejected", withdrawn: "Withdrawn" } as const;
const RECENT_TONE = { approved: "green", rejected: "red", withdrawn: "neutral" } as const;

function RoleMark({ item, role }: { item: QueueItem; role: ApprovalRole }) {
  const cell = roleCell(item[role]);
  return (
    <span className="inline-flex items-center gap-1.5" title={cell.text} data-queue-role={role} data-state={item[role].state}>
      <span className={cx("grid size-4 place-items-center rounded-full text-white", cell.yes ? "bg-ok" : "bg-danger")} aria-hidden>
        {cell.yes ? <Check size={10} strokeWidth={3} /> : <X size={10} strokeWidth={3} />}
      </span>
      <span className="text-[13px]">{cell.yes ? "Yes" : item[role].state === "returned" ? "Returned" : item[role].state === "stale" ? "Again" : "No"}</span>
    </span>
  );
}

function QueueTable({ items, label }: { items: QueueItem[]; label: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full text-sm" aria-label={label}>
        <thead className="text-left text-[13px] text-ink-soft">
          <tr className="border-b border-line">
            <th className="px-4 py-2 font-medium">Diagram</th>
            <th className="px-3 py-2 font-medium">Version</th>
            <th className="px-3 py-2 font-medium">Sent by</th>
            {APPROVAL_ROLES.map((r) => (
              <th key={r} className="px-3 py-2 font-medium">
                {ROLE_SHORT[r]}
              </th>
            ))}
            <th className="px-3 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.requestId} className="border-b border-line-soft last:border-0" data-queue-item={item.diagramId}>
              <td className="px-4 py-2.5">
                <Link to={`/diagram/${item.diagramId}?approval`} className="font-medium text-blueprint hover:underline">
                  {item.name}
                </Link>
                {item.note && <span className="block text-[13px] text-ink-soft truncate max-w-md">{item.note}</span>}
              </td>
              <td className="px-3 py-2.5 tabular-nums">{item.version}</td>
              <td className="px-3 py-2.5">
                {item.requestedBy || "—"}
                <span className="block text-xs text-ink-faint">{formatDateTime(item.round > 1 ? item.updatedAt : item.requestedAt)}</span>
              </td>
              {APPROVAL_ROLES.map((r) => (
                <td key={r} className="px-3 py-2.5">
                  <RoleMark item={item} role={r} />
                </td>
              ))}
              <td className="px-3 py-2.5">
                <Badge tone={item.status === "returned" ? "amber" : "blue"}>{item.status === "returned" ? "Returned for changes" : "Waiting for approval"}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Every diagram waiting for Enterprise Architecture and Cybersecurity, what waits for this person first, and what was decided lately. */
export function ApprovalsPage() {
  const queue = useSession((s) => s.approvals);
  const myId = useSession((s) => s.user?.id);
  useEffect(() => {
    void refreshApprovals().catch(() => undefined);
  }, []);
  if (!queue) return <EmptyState title="Approvals" text="Reading what is waiting for approval." />;
  const myRoles = APPROVAL_ROLES.filter((r) => queue.mine[r]);
  const forMe = queue.open.filter((item) => myRoles.some((r) => waitsFor(item, r)));
  const mineBack = queue.open.filter((item) => item.status === "returned" && item.requestedById === myId);
  return (
    <div className="mx-auto max-w-6xl px-6 py-7 space-y-7" data-approvals-page>
      <div>
        <h1 className="text-xl font-semibold">Approvals</h1>
        <p className="text-ink-soft mt-1">
          Diagrams sent for approval by Enterprise Architecture and Cybersecurity.{" "}
          {myRoles.length ? `You approve for ${myRoles.map((r) => ROLE_LABEL[r]).join(" and ")}.` : "You are not an approver in this workspace."}
        </p>
      </div>
      {myRoles.length > 0 && (
        <section className="space-y-2" aria-label="Waiting for you">
          <h2 className="text-base font-semibold">
            Waiting for you <span className="text-ink-soft font-normal tabular-nums">{forMe.length}</span>
          </h2>
          {forMe.length ? <QueueTable items={forMe} label="Waiting for your decision" /> : <p className="text-ink-soft">Nothing is waiting for your decision.</p>}
        </section>
      )}
      {mineBack.length > 0 && (
        <section className="space-y-2" aria-label="Returned to you">
          <h2 className="text-base font-semibold">Returned to you for changes</h2>
          <QueueTable items={mineBack} label="Returned to you" />
        </section>
      )}
      <section className="space-y-2" aria-label="All open requests">
        <h2 className="text-base font-semibold">
          All open requests <span className="text-ink-soft font-normal tabular-nums">{queue.open.length}</span>
        </h2>
        {queue.open.length ? (
          <QueueTable items={queue.open} label="All open requests" />
        ) : (
          <p className="text-ink-soft">No diagram is waiting. Open a diagram and choose Approval to send it.</p>
        )}
      </section>
      {queue.recent.length > 0 && (
        <section className="space-y-2" aria-label="Recently decided">
          <h2 className="text-base font-semibold">Recently decided</h2>
          <ul className="rounded-lg border border-line bg-surface divide-y divide-line-soft">
            {queue.recent.map((r) => (
              <li key={r.requestId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm" data-recent={r.status}>
                <Link to={`/diagram/${r.diagramId}?approval`} className="font-medium text-blueprint hover:underline">
                  {r.name}
                </Link>
                <span className="text-ink-soft">version {r.version}</span>
                <Badge tone={RECENT_TONE[r.status]}>{RECENT_LABEL[r.status]}</Badge>
                <span className="ml-auto text-[13px] text-ink-faint">
                  sent by {r.requestedBy || "—"} · {formatDateTime(r.closedAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
