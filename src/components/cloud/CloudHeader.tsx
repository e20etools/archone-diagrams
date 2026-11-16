import { AtSign, Check, ChevronDown, CloudOff, LoaderCircle, LogOut, RefreshCw, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { cx, formatDateTime } from "@/components/ui";
import { personLabel } from "@/lib/cloud/collab";
import { ROLE_INFO, canEditRole } from "@/lib/cloud/backend";
import { ownerColor } from "@/lib/catalog";
import { setPresence, showWorkspaceList, signOut, useSession } from "@/lib/cloud/session";
import { useWorkspace } from "@/lib/store";

const initials = (name: string) =>
  name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("") || "?";

function SaveStatus() {
  const sync = useSession((s) => s.sync);
  const live = useSession((s) => s.live);
  const base = "flex items-center gap-1.5 text-[13px] whitespace-nowrap";
  if (sync.kind === "saving") {
    return (
      <span className={cx(base, "text-ink-soft")} role="status">
        <LoaderCircle size={14} className="animate-spin" /> Saving
      </span>
    );
  }
  if (sync.kind === "offline") {
    return (
      <span className={cx(base, "text-signal")} role="status" title="Your changes are kept in this tab and saved when the connection returns. Keep the tab open.">
        <CloudOff size={14} /> Offline, {sync.pending} {sync.pending === 1 ? "change" : "changes"} waiting
      </span>
    );
  }
  if (sync.kind === "error") {
    return (
      <span className={cx(base, "text-danger")} role="alert" title={sync.message}>
        <CloudOff size={14} /> Not saved
      </span>
    );
  }
  if (sync.kind === "readonly") return null;
  if (!live) {
    return (
      <span className={cx(base, "text-signal")} role="status" title="Other people's changes will appear when the connection returns.">
        <RefreshCw size={14} /> Reconnecting
      </span>
    );
  }
  return (
    <span className={cx(base, "text-ink-faint")} role="status">
      <Check size={14} /> Saved
    </span>
  );
}

function Peers() {
  const peers = useSession((s) => s.peers);
  const ws = useWorkspace();
  const location = useLocation();
  const here = location.pathname.startsWith("/diagram/") ? location.pathname.split("/")[2] : null;
  useEffect(() => setPresence(here), [here]);
  if (!peers.length) return null;
  // One person with several tabs open is shown once.
  const people = [...new Map(peers.map((p) => [p.userId, p])).values()];
  return (
    <ul className="flex -space-x-1.5" aria-label="People in this workspace now">
      {people.slice(0, 5).map((peer) => {
        const same = !!here && peer.diagramId === here;
        const where = same ? "on this diagram" : peer.diagramId && ws.diagrams[peer.diagramId] ? `on "${ws.diagrams[peer.diagramId].name}"` : "in this workspace";
        return (
          <li
            key={peer.userId}
            title={`${peer.name} is ${where}`}
            className={cx("grid place-items-center size-7 rounded-full text-[11px] font-semibold text-white border-2", same ? "border-blueprint" : "border-surface")}
            style={{ background: ownerColor(peer.userId) }}
          >
            <span aria-hidden>{initials(peer.name)}</span>
            <span className="sr-only">
              {peer.name} is {where}
            </span>
          </li>
        );
      })}
      {people.length > 5 && <li className="grid place-items-center size-7 rounded-full text-[11px] font-semibold bg-line text-ink border-2 border-surface">+{people.length - 5}</li>}
    </ul>
  );
}

const seenKey = (workspaceId: string, userId: string) => `archone.mentionsSeen:${workspaceId}:${userId}`;

/** Open comment threads that mention the signed-in person, newest first. */
function Mentions() {
  const user = useSession((s) => s.user);
  const workspaceId = useSession((s) => s.workspaceId);
  const comments = useSession((s) => s.comments);
  const people = useSession((s) => s.people);
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const key = user && workspaceId ? seenKey(workspaceId, user.id) : "";
  useEffect(() => {
    try {
      setSeen((key && localStorage.getItem(key)) || "");
    } catch {
      setSeen("");
    }
  }, [key]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);
  if (!user) return null;

  const mine = Object.values(comments)
    .filter((c) => c.mentions.includes(user.id) && c.authorId !== user.id && !(comments[c.parentId ?? c.id]?.resolved ?? false))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const fresh = mine.filter((c) => c.createdAt > seen).length;
  /** The diagram the comment was written on, or any diagram that shows the thing it is about. */
  const placeOf = (diagramId: string | null, targetKind: string, targetId: string) => {
    if (diagramId && ws.diagrams[diagramId]) return diagramId;
    if (targetKind === "diagram") return ws.diagrams[targetId] ? targetId : null;
    return Object.values(ws.diagrams).find((d) => (targetKind === "object" ? targetId in d.nodes : ws.relationships[targetId] && ws.relationships[targetId].sourceId in d.nodes))?.id ?? null;
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next || !mine.length) return;
    // Opening the list is reading it.
    const now = new Date().toISOString();
    setSeen(now);
    try {
      localStorage.setItem(key, now);
    } catch {
      // Not remembered; the count comes back after a reload.
    }
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={fresh ? `Mentions, ${fresh} new` : "Mentions"}
        title="Comments that mention you"
        aria-expanded={open}
        onClick={toggle}
        className="relative inline-grid place-items-center size-8 rounded-md text-ink-soft hover:bg-line-soft hover:text-ink"
      >
        <AtSign size={16} />
        {fresh > 0 && (
          <span className="absolute -top-0.5 -right-0.5 grid place-items-center min-w-[16px] h-4 px-1 rounded-full bg-blueprint text-white text-[10px] font-semibold" aria-hidden>
            {fresh}
          </span>
        )}
      </button>
      {open && (
        <div aria-label="Comments that mention you" className="absolute right-0 top-full mt-1 z-40 w-80 max-h-96 overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-[0_10px_30px_rgba(22,35,58,0.14)]">
          {mine.length === 0 ? (
            <p className="px-3 py-3 text-ink-soft">No open comment mentions you.</p>
          ) : (
            <ul>
              {mine.map((c) => {
                const place = placeOf(c.diagramId, c.targetKind, c.targetId);
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      disabled={!place}
                      className="block w-full text-left px-3 py-2 hover:bg-line-soft disabled:opacity-60"
                      onClick={() => {
                        setOpen(false);
                        if (place) navigate(`/diagram/${place}?thread=${c.parentId ?? c.id}`);
                      }}
                    >
                      <span className="block text-[13px] text-ink-soft">
                        <span className="font-medium text-ink">{personLabel(people.find((p) => p.userId === c.authorId))}</span>
                        {place ? ` on ${ws.diagrams[place].name}` : ""}, {formatDateTime(c.createdAt)}
                      </span>
                      <span className="block truncate">{c.body}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function AccountMenu() {
  const user = useSession((s) => s.user);
  const role = useSession((s) => s.role);
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  const item = "flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-line-soft";
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 h-8 pl-2 pr-1.5 rounded-md text-[13px] hover:bg-line-soft max-w-[230px]"
      >
        <span className="truncate font-medium">{ws.name}</span>
        <ChevronDown size={14} className="shrink-0 text-ink-faint" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1 z-40 w-64 rounded-md border border-line bg-surface py-1 shadow-[0_10px_30px_rgba(22,35,58,0.14)]">
          <div className="px-3 py-2 border-b border-line-soft">
            <div className="font-medium truncate">{user?.name || user?.email}</div>
            {user?.name && <div className="text-[13px] text-ink-soft truncate">{user.email}</div>}
            {role && <div className="mt-1 text-[13px] text-ink-soft">{ROLE_INFO[role].label} of this workspace</div>}
          </div>
          <Link role="menuitem" to="/settings" className={item} onClick={() => setOpen(false)}>
            <Users size={15} className="text-ink-soft" /> Members and settings
          </Link>
          <button
            role="menuitem"
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              showWorkspaceList();
            }}
          >
            <RefreshCw size={15} className="text-ink-soft" /> Switch workspace
          </button>
          <button role="menuitem" type="button" className={item} onClick={() => void signOut()}>
            <LogOut size={15} className="text-ink-soft" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** The hosted-mode part of the top bar: who else is here, whether work is saved, and the account menu. */
export function CloudHeader() {
  return (
    <>
      <Peers />
      <SaveStatus />
      <Mentions />
      <AccountMenu />
    </>
  );
}

export function ReadOnlyBanner() {
  const role = useSession((s) => s.role);
  const published = useSession((s) => s.published);
  if (canEditRole(role)) return null;
  const can = role === "commenter" ? "You can look around, comment and export, but not change the model." : "You can look around and export, but changes are not saved.";
  return (
    <p role="status" className="shrink-0 px-4 py-1.5 bg-signal-soft text-[13px] text-ink border-b border-line">
      {published
        ? published.version
          ? `You are reading the published version, "${published.version.name}" from ${formatDateTime(published.version.createdAt)}. Changes still being worked on or in review are not shown. ${can}`
          : `Nothing has been published in this workspace yet. The model appears here once its first review is approved. ${can}`
        : `You have ${role === "commenter" ? "comment" : "view"} access to this workspace. ${can} Ask an owner for edit access.`}
    </p>
  );
}
