import { Check, CornerDownRight, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button, IconButton, Textarea, cx, formatDateTime } from "@/components/ui";
import { mentionQuery, mentionsIn, personLabel, relationshipTitle, splitMentions, threadsOf, type Comment, type CommentTarget, type Person, type Thread } from "@/lib/cloud/collab";
import { addComment, changeComment, deleteComment, errorText, useCanComment, useSession } from "@/lib/cloud/session";
import type { Diagram, Workspace } from "@/lib/types";

export interface CommentAnchor {
  kind: CommentTarget;
  id: string;
}

/** A text box for a comment. Typing @ offers the workspace's members; Ctrl+Enter sends. */
function CommentBox({
  label,
  placeholder,
  submitLabel,
  initial = "",
  people,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  label: string;
  placeholder: string;
  submitLabel: string;
  initial?: string;
  people: Person[];
  autoFocus?: boolean;
  onSubmit: (body: string, mentions: string[]) => Promise<void>;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [caret, setCaret] = useState(initial.length);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [picked, setPicked] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);

  const asking = mentionQuery(body, caret);
  const matches = useMemo(() => {
    if (!asking) return [];
    const q = asking.query.toLowerCase();
    return people.filter((p) => personLabel(p).toLowerCase().includes(q) || p.email.toLowerCase().startsWith(q)).slice(0, 6);
  }, [asking, people]);
  useEffect(() => setPicked(0), [asking?.query]);

  const insert = (person: Person) => {
    if (!asking) return;
    const tag = `@${personLabel(person)} `;
    const next = body.slice(0, asking.start) + tag + body.slice(caret);
    const at = asking.start + tag.length;
    setBody(next);
    setCaret(at);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  };

  const send = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setProblem("");
    try {
      await onSubmit(text, mentionsIn(text, people));
      setBody("");
      setCaret(0);
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setPicked((i) => (i + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insert(matches[picked]);
        return;
      }
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void send();
    }
    if (event.key === "Escape" && onCancel) {
      event.stopPropagation();
      onCancel();
    }
  };

  return (
    <div className="relative">
      <Textarea
        ref={area}
        aria-label={label}
        rows={2}
        maxLength={4000}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
        }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
        onKeyDown={onKeyDown}
      />
      {matches.length > 0 && (
        <ul role="listbox" aria-label="People to mention" className="absolute z-20 left-0 right-0 mt-0.5 rounded-md border border-line bg-surface shadow-[0_8px_24px_rgba(22,35,58,0.16)] py-1">
          {matches.map((person, i) => (
            <li key={person.userId} role="option" aria-selected={i === picked}>
              <button
                type="button"
                className={cx("w-full text-left px-2.5 py-1.5", i === picked ? "bg-blueprint-soft" : "hover:bg-line-soft")}
                // The text box keeps the focus, so the caret stays where the name goes.
                onMouseDown={(e) => {
                  e.preventDefault();
                  insert(person);
                }}
              >
                <span className="font-medium">{personLabel(person)}</span>
                {person.name && <span className="ml-2 text-[13px] text-ink-soft">{person.email}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <p role="alert" className="mt-1.5 rounded-md bg-danger-soft text-danger px-2.5 py-1.5 text-[13px]">
          {problem}
        </p>
      )}
      <div className="mt-1.5 flex items-center gap-2">
        <span className="text-xs text-ink-faint">Type @ to mention someone</span>
        <span className="ml-auto flex gap-1.5">
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={!body.trim() || busy} onClick={() => void send()}>
            {submitLabel}
          </Button>
        </span>
      </div>
    </div>
  );
}

function CommentBody({ comment, people }: { comment: Comment; people: Person[] }) {
  return (
    <p className="whitespace-pre-wrap break-words">
      {splitMentions(comment.body, people, comment.mentions).map((part, i) =>
        part.mention ? (
          <span key={i} className="rounded bg-blueprint-soft text-blueprint-deep px-0.5 font-medium">
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </p>
  );
}

function CommentItem({ comment, people, isReply }: { comment: Comment; people: Person[]; isReply?: boolean }) {
  const me = useSession((s) => s.user);
  const role = useSession((s) => s.role);
  const canComment = useCanComment();
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState("");
  const author = people.find((p) => p.userId === comment.authorId);
  const mine = !!me && comment.authorId === me.id;
  const mayDelete = canComment && (mine || role === "owner");
  const what = isReply ? "reply" : "comment";
  return (
    <div className={cx(isReply && "pl-3 border-l-2 border-line-soft")}>
      <div className="flex items-baseline gap-2">
        <span className="font-medium truncate">{personLabel(author)}</span>
        <span className="text-xs text-ink-faint whitespace-nowrap">
          {formatDateTime(comment.createdAt)}
          {comment.editedAt && ", edited"}
        </span>
        <span className="ml-auto flex shrink-0">
          {mine && canComment && !editing && (
            <IconButton label={`Edit this ${what}`} className="!size-6" onClick={() => setEditing(true)}>
              <Pencil size={13} />
            </IconButton>
          )}
          {mayDelete && (
            <IconButton
              label={isReply ? "Delete this reply" : "Delete this comment and its replies"}
              className="!size-6"
              onClick={() => void deleteComment(comment.id).catch((e) => setProblem(errorText(e)))}
            >
              <Trash2 size={13} />
            </IconButton>
          )}
        </span>
      </div>
      {editing ? (
        <div className="mt-1">
          <CommentBox
            label={`Edit your ${what}`}
            placeholder=""
            submitLabel="Save"
            initial={comment.body}
            people={people}
            autoFocus
            onCancel={() => setEditing(false)}
            onSubmit={async (body, mentions) => {
              await changeComment(comment.id, { body, mentions });
              setEditing(false);
            }}
          />
        </div>
      ) : (
        <CommentBody comment={comment} people={people} />
      )}
      {problem && (
        <p role="alert" className="mt-1 text-[13px] text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}

function ThreadCard({ thread, people, targetLabel, active, onPick }: { thread: Thread; people: Person[]; targetLabel: string; active: boolean; onPick: () => void }) {
  const canComment = useCanComment();
  const [replying, setReplying] = useState(false);
  const [problem, setProblem] = useState("");
  const { root, replies } = thread;
  const card = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (active) card.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <li ref={card} data-thread={root.id} className={cx("rounded-md border px-3 py-2.5 space-y-2", active ? "border-blueprint bg-blueprint-soft/30" : "border-line", root.resolved && "bg-paper")}>
      <div className="flex items-center gap-2">
        <button type="button" className="min-w-0 truncate text-[13px] font-medium text-blueprint hover:underline" title="Show on the diagram" onClick={onPick}>
          {targetLabel}
        </button>
        {root.resolved && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-ok whitespace-nowrap">
            <Check size={12} /> Resolved
          </span>
        )}
      </div>
      <CommentItem comment={root} people={people} />
      {replies.map((reply) => (
        <CommentItem key={reply.id} comment={reply} people={people} isReply />
      ))}
      {problem && (
        <p role="alert" className="text-[13px] text-danger">
          {problem}
        </p>
      )}
      {canComment &&
        (replying ? (
          <CommentBox
            label="Reply"
            placeholder="Write a reply"
            submitLabel="Reply"
            people={people}
            autoFocus
            onCancel={() => setReplying(false)}
            onSubmit={async (body, mentions) => {
              await addComment({ diagramId: root.diagramId, targetKind: root.targetKind, targetId: root.targetId, parentId: root.id, body, mentions });
              setReplying(false);
            }}
          />
        ) : (
          <div className="flex gap-1.5">
            {!root.resolved && (
              <Button size="sm" variant="ghost" icon={<CornerDownRight size={13} />} onClick={() => setReplying(true)}>
                Reply
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={root.resolved ? <RotateCcw size={13} /> : <Check size={13} />}
              onClick={() => void changeComment(root.id, { resolved: !root.resolved }).catch((e) => setProblem(errorText(e)))}
            >
              {root.resolved ? "Reopen" : "Resolve"}
            </Button>
          </div>
        ))}
    </li>
  );
}

/** The comments of one diagram: on the diagram itself, on its boxes and on its arrows. */
export function CommentsPanel({
  ws,
  diagram,
  edgeIds,
  anchor,
  focusThread,
  onPick,
  onClose,
}: {
  ws: Workspace;
  diagram: Diagram;
  /** The arrows drawn on this diagram. */
  edgeIds: string[];
  /** The selected box or arrow, which a new comment will be about. */
  anchor: CommentAnchor | null;
  focusThread?: string | null;
  onPick: (anchor: CommentAnchor) => void;
  onClose: () => void;
}) {
  const all = useSession((s) => s.comments);
  const people = useSession((s) => s.people);
  const canComment = useCanComment();
  const [showResolved, setShowResolved] = useState(false);

  const threads = useMemo(() => threadsOf(commentsOn(Object.values(all), diagram, edgeIds)), [all, diagram, edgeIds]);
  const open = threads.filter((t) => !t.root.resolved);
  const resolved = threads.filter((t) => t.root.resolved);
  // A thread someone was sent to is shown even if it has been resolved since.
  const shown = showResolved || resolved.some((t) => t.root.id === focusThread) ? threads : open;
  const about = anchor ?? { kind: "diagram" as const, id: diagram.id };

  const label = (kind: CommentTarget, id: string): string => {
    if (kind === "object") return ws.objects[id]?.name ?? "A removed object";
    if (kind === "relationship") return ws.relationships[id] ? `Arrow: ${relationshipTitle(ws.relationships[id], ws.objects)}` : "A removed arrow";
    return "The whole diagram";
  };

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-2 pl-4 pr-2 h-12 border-b border-line-soft">
        <h2 className="font-semibold">Comments</h2>
        <span className="text-[13px] text-ink-soft">{open.length} open</span>
        <IconButton label="Close comments" className="ml-auto" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {canComment ? (
          <div>
            <p className="text-[13px] text-ink-soft mb-1">
              About: <span className="font-medium text-ink">{label(about.kind, about.id)}</span>
              {!anchor && <span className="text-ink-faint">. Select a box or an arrow to comment on it.</span>}
            </p>
            <CommentBox
              label="New comment"
              placeholder="Write a comment"
              submitLabel="Comment"
              people={people}
              onSubmit={async (body, mentions) => {
                await addComment({ diagramId: diagram.id, targetKind: about.kind, targetId: about.id, parentId: null, body, mentions });
              }}
            />
          </div>
        ) : (
          <p className="text-[13px] text-ink-soft">You have view access, so you can read comments but not write them. Ask an owner for comment access.</p>
        )}
        {shown.length === 0 ? (
          <p className="text-ink-soft pt-2">{threads.length === 0 ? "No comments on this diagram yet." : "Every comment on this diagram is resolved."}</p>
        ) : (
          <ul className="space-y-2.5">
            {shown.map((thread) => (
              <ThreadCard
                key={thread.root.id}
                thread={thread}
                people={people}
                targetLabel={label(thread.root.targetKind, thread.root.targetId)}
                active={thread.root.id === focusThread || (!!anchor && thread.root.targetKind === anchor.kind && thread.root.targetId === anchor.id)}
                onPick={() => onPick({ kind: thread.root.targetKind, id: thread.root.targetId })}
              />
            ))}
          </ul>
        )}
        {resolved.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? "Hide resolved" : `Show ${resolved.length} resolved`}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The comments that belong on a diagram: written about it, or about a box or arrow drawn on it. */
export function commentsOn(comments: Comment[], diagram: Diagram, edgeIds: string[]): Comment[] {
  const edges = new Set(edgeIds);
  return comments.filter((c) => {
    if (c.targetKind === "diagram") return c.targetId === diagram.id;
    if (c.targetKind === "object") return c.targetId in diagram.nodes;
    return edges.has(c.targetId);
  });
}

/** Open threads per box, for the markers on the canvas. */
export function openThreadsByObject(comments: Comment[], diagram: Diagram): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of comments) {
    if (c.parentId || c.resolved || c.targetKind !== "object" || !(c.targetId in diagram.nodes)) continue;
    counts[c.targetId] = (counts[c.targetId] ?? 0) + 1;
  }
  return counts;
}
