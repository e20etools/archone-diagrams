import { evidenceHtml } from "@/lib/cloud/evidence";
import { downloadText, slugify } from "@/lib/exporters";
import { FileDown } from "lucide-react";
import { ArrowLeft, Check, CircleDashed, ClipboardCheck, Forward, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { WhoItTouches } from "@/components/cloud/WhoItTouches";
import { ComparisonList, VersionDiagrams, useVersionTables } from "@/components/cloud/ComparisonView";
import { Badge, Button, EmptyState, Field, Input, Modal, Select, Tabs, Textarea, cx, formatDateTime, useNotice } from "@/components/ui";
import { REVIEW_STATUS_LABEL, compareTables, currentStage, personLabel, type Review, type ReviewStatus } from "@/lib/cloud/collab";
import { decideReview, delegateReview, errorText, submitForReview, useCanEdit, useSession, withdrawReview } from "@/lib/cloud/session";
import { toTables } from "@/lib/cloud/tables";
import { useWorkspace } from "@/lib/store";

const STATUS_TONE: Record<ReviewStatus, "amber" | "green" | "red" | "neutral"> = { open: "amber", approved: "green", rejected: "red", withdrawn: "neutral" };

function useNames() {
  const people = useSession((s) => s.people);
  return (userId: string | null | undefined) => personLabel(people.find((p) => p.userId === userId));
}

/** "Stage 2 of 3: Security, waiting for Vera", or how it ended. */
function progress(review: Review, nameOf: (id: string | null) => string): string {
  const stage = currentStage(review);
  if (stage) return `Stage ${review.stageIndex + 1} of ${review.stages.length}: ${stage.name}, waiting for ${nameOf(stage.reviewerId)}`;
  const last = review.decisions.filter((d) => d.decision !== "delegated").at(-1);
  if (review.status === "approved") return `Approved by every stage${review.closedAt ? `, ${formatDateTime(review.closedAt)}` : ""}`;
  if (review.status === "rejected") return `Rejected at ${last?.stageName ?? "a stage"} by ${nameOf(last?.by ?? null)}`;
  return "Withdrawn before a decision";
}

function SubmitDialog({ onClose, onSubmitted }: { onClose: () => void; onSubmitted: (reviewId: string) => void }) {
  const ws = useWorkspace();
  const review = useSession((s) => s.review);
  const nameOf = useNames();
  const { tables: publishedTables } = useVersionTables(review.publishedVersionId);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const now = useMemo(() => toTables(ws), [ws]);
  const differs = publishedTables ? compareTables(publishedTables, now).total : null;
  const submit = () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setProblem("");
    submitForReview(title, note).then(onSubmitted, (e) => {
      setProblem(errorText(e));
      setBusy(false);
    });
  };
  return (
    <Modal
      title="Submit the model for review"
      width={640}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!title.trim() || busy || differs === 0} onClick={submit}>
            {busy ? "Submitting" : "Submit for review"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-ink-soft">
          The model as it is now is copied and sent through {review.stages.length === 1 ? "one stage" : `${review.stages.length} stages`}:{" "}
          {review.stages.map((s) => `${s.name} (${nameOf(s.reviewerId)})`).join(", then ")}. You can keep working; later changes are not part of this review.
        </p>
        <Field label="What is being submitted">
          <Input value={title} maxLength={120} placeholder="For example: Events queue for the Q3 release" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </Field>
        <Field label="Note for the reviewers" hint="Optional.">
          <Textarea rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div>
          <p className="text-[13px] font-medium text-ink-soft mb-1">Changes since the published version</p>
          <div className="max-h-56 overflow-y-auto rounded-md border border-line px-3 py-2">
            {!review.publishedVersionId ? (
              <p className="text-ink-soft">Nothing has been published yet, so everything in the model is new.</p>
            ) : !publishedTables ? (
              <p className="text-ink-soft">Comparing.</p>
            ) : (
              <ComparisonList before={publishedTables} after={now} emptyText="Nothing differs from the published version, so there is nothing to review." />
            )}
          </div>
          {publishedTables && differs !== 0 && (
            <div className="mt-3">
              <span className="block text-[13px] font-medium mb-1">Who this touches</span>
              <div className="max-h-40 overflow-y-auto rounded-md border border-line px-3 py-2">
                <WhoItTouches before={publishedTables} after={now} reviewerIds={review.stages.map((s) => s.reviewerId)} />
              </div>
            </div>
          )}
        </div>
        {problem && (
          <p role="alert" className="rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
            {problem}
          </p>
        )}
      </div>
    </Modal>
  );
}

export function ReviewsPage() {
  const settings = useSession((s) => s.review);
  const reviews = useSession((s) => s.reviews);
  const versions = useSession((s) => s.versions);
  const role = useSession((s) => s.role);
  const me = useSession((s) => s.user);
  const canEdit = useCanEdit();
  const nameOf = useNames();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const open = reviews.find((r) => r.status === "open");
  const published = versions.find((v) => v.id === settings.publishedVersionId);

  return (
    <div className="max-w-4xl mx-auto px-6 py-7">
      <div className="flex items-start gap-4">
        <div>
          <h1 className="text-xl font-semibold">Reviews</h1>
          <p className="text-ink-soft mt-0.5">
            {settings.required
              ? "Changes reach viewers and commenters only after every review stage approves them."
              : "Review before publishing is switched off, so every member sees changes as they are made."}
          </p>
        </div>
        {settings.required && canEdit && (
          <Button
            variant="primary"
            className="ml-auto"
            icon={<ClipboardCheck size={15} />}
            disabled={!!open}
            title={open ? "A review is already open. Finish or withdraw it first." : undefined}
            onClick={() => setSubmitting(true)}
          >
            Submit for review
          </Button>
        )}
      </div>

      {settings.required && (
        <p className="mt-4 rounded-lg border border-line bg-surface px-4 py-3">
          <span className="text-ink-soft">Published now: </span>
          {published ? (
            <>
              <Link to={`/versions/${published.id}`} className="font-medium text-blueprint hover:underline">
                {published.name}
              </Link>
              <span className="text-ink-soft">, saved {formatDateTime(published.createdAt)}</span>
            </>
          ) : settings.publishedVersionId ? (
            <span className="font-medium">the last approved version</span>
          ) : (
            <span className="font-medium">nothing yet</span>
          )}
        </p>
      )}

      {reviews.length === 0 ? (
        <EmptyState
          title={settings.required ? "Nothing has been submitted yet" : "Review is switched off"}
          text={
            settings.required
              ? canEdit
                ? "When the model is ready for others to rely on, submit it. Each stage's reviewer approves it or sends it back with a reason."
                : "Owners and editors submit the model for review. You will see it here when they do."
              : role === "owner"
                ? "Switch it on in Settings and name who reviews each stage."
                : "An owner can switch it on in Settings."
          }
        >
          {!settings.required && role === "owner" && (
            <Link to="/settings" className="font-medium text-blueprint hover:underline">
              Open Settings
            </Link>
          )}
        </EmptyState>
      ) : (
        <ul className="mt-5 rounded-lg border border-line bg-surface divide-y divide-line-soft">
          {reviews.map((r) => {
            const mine = currentStage(r)?.reviewerId === me?.id;
            return (
              <li key={r.id} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <Link to={`/reviews/${r.id}`} className="font-medium text-blueprint hover:underline truncate">
                    {r.title}
                  </Link>
                  <Badge tone={STATUS_TONE[r.status]}>{REVIEW_STATUS_LABEL[r.status]}</Badge>
                  {mine && <Badge tone="blue">Waiting for you</Badge>}
                </div>
                <p className="text-[13px] text-ink-soft mt-0.5">
                  {progress(r, nameOf)}. Submitted by {nameOf(r.submittedBy)}, {formatDateTime(r.submittedAt)}.
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {submitting && (
        <SubmitDialog
          onClose={() => setSubmitting(false)}
          onSubmitted={(reviewId) => {
            setSubmitting(false);
            navigate(`/reviews/${reviewId}`);
          }}
        />
      )}
    </div>
  );
}

function DecisionCard({ review }: { review: Review }) {
  const stage = currentStage(review)!;
  const people = useSession((s) => s.people);
  const me = useSession((s) => s.user);
  const [ticks, setTicks] = useState<boolean[]>(() => stage.checklist.map(() => false));
  const [reason, setReason] = useState("");
  const [handTo, setHandTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const { notify, view: notice } = useNotice();
  const run = (work: Promise<void>, done: string) => {
    setBusy(true);
    setProblem("");
    work.then(
      () => notify(done),
      (e) => {
        setProblem(errorText(e));
        setBusy(false);
      },
    );
  };
  const allTicked = ticks.every(Boolean);
  const others = people.filter((p) => p.userId !== me?.id);
  return (
    <section className="rounded-lg border border-blueprint bg-surface px-5 py-4" aria-label="Your decision">
      <h2 className="text-base font-semibold">Your decision for the {stage.name} stage</h2>
      {stage.checklist.length > 0 && (
        <fieldset className="mt-3">
          <legend className="text-[13px] font-medium text-ink-soft mb-1">Checklist. Tick every item to approve.</legend>
          <ul className="space-y-1">
            {stage.checklist.map((item, i) => (
              <li key={i}>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={ticks[i] ?? false} onChange={(e) => setTicks((t) => t.map((v, j) => (j === i ? e.target.checked : v)))} />
                  <span>{item}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      <Field label="Reason or note" hint="Needed to reject. Kept with the review's history." className="mt-3">
        <Textarea rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {problem && (
        <p role="alert" className="mt-3 rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
          {problem}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" icon={<Check size={15} />} disabled={busy || !allTicked} onClick={() => run(decideReview(review.id, true, reason, ticks), "Approved.")}>
          Approve
        </Button>
        <Button variant="danger" icon={<X size={15} />} disabled={busy || !reason.trim()} onClick={() => run(decideReview(review.id, false, reason, []), "Rejected.")}>
          Reject
        </Button>
        {others.length > 0 && (
          <span className="ml-auto flex items-center gap-1.5">
            <Select aria-label="Hand this stage to" className="!w-56" value={handTo} onChange={(e) => setHandTo(e.target.value)}>
              <option value="">Hand to someone else</option>
              {others.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {personLabel(p)}
                </option>
              ))}
            </Select>
            <Button icon={<Forward size={15} />} disabled={busy || !handTo} onClick={() => run(delegateReview(review.id, handTo), "Handed over.")}>
              Hand over
            </Button>
          </span>
        )}
      </div>
      {notice}
    </section>
  );
}

function StageList({ review }: { review: Review }) {
  const nameOf = useNames();
  return (
    <ol className="space-y-3">
      {review.stages.map((stage, i) => {
        const history = review.decisions.filter((d) => d.stageId === stage.id);
        const verdict = history.filter((d) => d.decision !== "delegated").at(-1);
        const waiting = review.status === "open" && i === review.stageIndex;
        const Icon = verdict?.decision === "approved" ? Check : verdict?.decision === "rejected" ? X : CircleDashed;
        return (
          <li key={stage.id} className="flex gap-3">
            <span
              className={cx(
                "mt-0.5 shrink-0 inline-grid place-items-center size-6 rounded-full",
                verdict?.decision === "approved" ? "bg-ok-soft text-ok" : verdict?.decision === "rejected" ? "bg-danger-soft text-danger" : waiting ? "bg-signal-soft text-signal" : "bg-paper text-ink-faint",
              )}
            >
              <Icon size={14} strokeWidth={2.25} aria-hidden />
            </span>
            <div className="min-w-0">
              <p>
                <span className="font-medium">{stage.name}</span>
                <span className="ml-2 text-[13px] text-ink-soft">
                  {verdict ? `${verdict.decision === "approved" ? "Approved" : "Rejected"} by ${nameOf(verdict.by)}, ${formatDateTime(verdict.at)}` : waiting ? `Waiting for ${nameOf(stage.reviewerId)}` : `Reviewer: ${nameOf(stage.reviewerId)}`}
                </span>
              </p>
              {history
                .filter((d) => d.decision === "delegated")
                .map((d, j) => (
                  <p key={j} className="text-[13px] text-ink-soft">
                    {nameOf(d.by)} handed it to {nameOf(d.to)}, {formatDateTime(d.at)}
                  </p>
                ))}
              {verdict?.reason && <p className="mt-0.5 whitespace-pre-wrap break-words">{verdict.reason}</p>}
              {verdict?.decision === "approved" && stage.checklist.length > 0 && <p className="text-[13px] text-ink-soft">Checklist confirmed: {stage.checklist.join("; ")}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function ReviewPage() {
  const { id = "" } = useParams();
  const reviews = useSession((s) => s.reviews);
  const me = useSession((s) => s.user);
  const role = useSession((s) => s.role);
  const people = useSession((s) => s.people);
  const versions = useSession((s) => s.versions);
  const ownRules = useWorkspace().rules;
  const workspaceName = useWorkspace().name;
  const nameOf = useNames();
  const review = reviews.find((r) => r.id === id);
  const [tab, setTab] = useState<"changes" | "diagrams">("changes");
  const [handTo, setHandTo] = useState("");
  const [problem, setProblem] = useState("");
  const candidate = useVersionTables(review ? review.versionId : null, review ? `${review.stageIndex}:${review.status}` : "");
  const base = useVersionTables(review?.baseVersionId ?? null);

  if (!review) {
    return (
      <EmptyState title="This review cannot be opened" text="It may belong to another workspace.">
        <Link to="/reviews" className="font-medium text-blueprint hover:underline">
          Go to reviews
        </Link>
      </EmptyState>
    );
  }
  const stage = currentStage(review);
  const mine = !!stage && stage.reviewerId === me?.id;
  const mayWithdraw = review.status === "open" && (review.submittedBy === me?.id || role === "owner");
  const mayReassign = !!stage && !mine && role === "owner";
  const act = (work: Promise<void>) => {
    setProblem("");
    work.catch((e) => setProblem(errorText(e)));
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-7 space-y-5">
      <div>
        <Link to="/reviews" className="inline-flex items-center gap-1 text-[13px] text-ink-soft hover:text-ink">
          <ArrowLeft size={14} /> Reviews
        </Link>
        <div className="mt-2 flex items-start gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold break-words">
              {review.title} <Badge tone={STATUS_TONE[review.status]}>{REVIEW_STATUS_LABEL[review.status]}</Badge>
            </h1>
            <p className="text-ink-soft mt-0.5">
              Submitted by {nameOf(review.submittedBy)}, {formatDateTime(review.submittedAt)}.
              {review.status === "approved" && " This is now the published version."}
              {review.status === "rejected" && " The published version did not change."}
            </p>
            {review.note && <p className="mt-1 whitespace-pre-wrap">{review.note}</p>}
          </div>
          {mayWithdraw && (
            <Button className="ml-auto" onClick={() => act(withdrawReview(review.id))}>
              Withdraw
            </Button>
          )}
          {review.status !== "open" && (
            <Button
              className="ml-auto"
              icon={<FileDown size={15} />}
              disabled={!candidate.tables}
              title="One file for auditors: the diagrams as reviewed, who approved what and when, the checklists, what changed, and the findings of the checks."
              onClick={() => {
                if (!candidate.tables) return;
                const html = evidenceHtml({
                  workspaceName,
                  review,
                  version: versions.find((v) => v.id === review.versionId),
                  tables: candidate.tables,
                  base: review.baseVersionId ? (base.tables ?? null) : null,
                  people,
                  rules: ownRules,
                  generatedBy: me?.name || me?.email || "A member",
                  generatedAt: new Date().toISOString(),
                });
                downloadText(`evidence-${slugify(review.title)}.html`, html, "text/html");
              }}
            >
              Evidence pack
            </Button>
          )}
        </div>
      </div>

      {problem && (
        <p role="alert" className="rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
          {problem}
        </p>
      )}

      {mine && <DecisionCard key={`${review.id}:${review.stageIndex}`} review={review} />}

      <section className="rounded-lg border border-line bg-surface px-5 py-4">
        <h2 className="text-base font-semibold mb-3">Stages</h2>
        <StageList review={review} />
        {mayReassign && (
          <div className="mt-4 flex items-center gap-1.5 border-t border-line-soft pt-3">
            <span className="text-[13px] text-ink-soft">If {nameOf(stage.reviewerId)} is away:</span>
            <Select aria-label="Hand this stage to" className="!w-48" value={handTo} onChange={(e) => setHandTo(e.target.value)}>
              <option value="">Choose a member</option>
              {people
                .filter((p) => p.userId !== stage.reviewerId)
                .map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {personLabel(p)}
                  </option>
                ))}
            </Select>
            <Button
              icon={<Forward size={15} />}
              disabled={!handTo}
              onClick={() => {
                act(delegateReview(review.id, handTo));
                setHandTo("");
              }}
            >
              Hand over
            </Button>
          </div>
        )}
      </section>

      <section>
        <Tabs
          tabs={[
            { id: "changes", label: "What it changes" },
            { id: "diagrams", label: "Diagrams" },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="mt-4">
          {candidate.problem ? (
            <p className="text-ink-soft">You can open the submitted version when the review reaches you, or once it is published.</p>
          ) : !candidate.tables ? (
            <p className="text-ink-soft">Opening the submitted version.</p>
          ) : tab === "diagrams" ? (
            <VersionDiagrams tables={candidate.tables} name={review.title} />
          ) : !review.baseVersionId ? (
            <p className="text-ink-soft">Nothing was published before this, so everything in it is new. See the Diagrams tab.</p>
          ) : base.problem ? (
            <p className="text-ink-soft">The version this was compared with has been deleted. See the Diagrams tab.</p>
          ) : !base.tables ? (
            <p className="text-ink-soft">Comparing.</p>
          ) : (
            <div className="rounded-lg border border-line bg-surface px-5 py-4">
              <p className="text-[13px] text-ink-soft mb-3">Compared with what was published when it was submitted.</p>
              <ComparisonList before={base.tables} after={candidate.tables} emptyText="Nothing differs from what was published." />
              <h3 className="mt-5 pt-4 border-t border-line-soft font-semibold">Who this touches</h3>
              <div className="mt-1">
                <WhoItTouches before={base.tables} after={candidate.tables} reviewerIds={review.stages.map((s) => s.reviewerId)} />
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
