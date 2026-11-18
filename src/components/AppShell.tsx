import { BadgeCheck, FileBarChart, FolderOpen, Network, Zap, Boxes, Workflow, Pickaxe, ClipboardCheck, FileText, GitBranch, HeartPulse, History, GalleryThumbnails, LayoutGrid, MessageCircleQuestion, Redo2, Scale, ScrollText, Search, Settings, Shapes, ShieldCheck, Sparkles, Undo2, Waypoints } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { CloudHeader, ReadOnlyBanner } from "@/components/cloud/CloudHeader";
import { TypeIcon } from "@/components/icons";
import { IconButton, countOf, cx } from "@/components/ui";
import { VIEW_TYPE_INFO, objectType } from "@/lib/catalog";
import { currentStage } from "@/lib/cloud/collab";
import { APPROVAL_ROLES, waitsFor } from "@/lib/approvals";
import { cloudEnabled } from "@/lib/cloud/config";
import { useSession } from "@/lib/cloud/session";
import { searchWorkspace } from "@/lib/search";
import { useApplyAppearance } from "@/lib/appearance";
import { useStore, useWorkspace } from "@/lib/store";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutGrid;
  end?: boolean;
  ownerOnly?: boolean;
}
/** The menu in groups, in the order work happens: build the model, analyse it, govern it, work together. */
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  { label: "", items: [{ to: "/", label: "Home", icon: LayoutGrid, end: true }] },
  {
    label: "Build",
    items: [
      { to: "/model", label: "Model", icon: Boxes },
      { to: "/library", label: "Library", icon: Shapes },
      { to: "/files", label: "Files", icon: FolderOpen },
      { to: "/ai", label: "Drafts", icon: Sparkles },
    ],
  },
  {
    label: "Processes",
    items: [
      { to: "/processes", label: "Process landscape", icon: Workflow },
      { to: "/process-mining", label: "Process mining", icon: Pickaxe },
    ],
  },
  {
    label: "Analyse",
    items: [
      { to: "/map", label: "All diagrams", icon: Network },
      { to: "/diagrams", label: "Diagrams", icon: GalleryThumbnails },
      { to: "/impact", label: "Impact", icon: Zap },
      { to: "/analysis", label: "Dependencies", icon: Waypoints },
      { to: "/health", label: "Health", icon: HeartPulse },
      { to: "/checks", label: "Checks", icon: ShieldCheck },
    ],
  },
  {
    label: "Govern",
    items: [
      { to: "/decisions", label: "Decisions", icon: Scale },
      { to: "/reports", label: "Reports", icon: FileBarChart },
      { to: "/document", label: "Document", icon: FileText },
      { to: "/ask", label: "Ask", icon: MessageCircleQuestion },
    ],
  },
  // Versions and reviews need the hosted backend.
  ...(cloudEnabled
    ? [
        {
          label: "Work together",
          items: [
            { to: "/versions", label: "Versions", icon: History },
            { to: "/approvals", label: "Approvals", icon: BadgeCheck },
            { to: "/reviews", label: "Reviews", icon: ClipboardCheck },
            { to: "/scenarios", label: "Scenarios", icon: GitBranch },
            { to: "/audit", label: "Audit log", icon: ScrollText, ownerOnly: true },
          ],
        },
      ]
    : []),
];
const SETTINGS: NavItem = { to: "/settings", label: "Settings", icon: Settings };

function Mark() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
      <rect x="1.5" y="1.5" width="10" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="14.5" y="14.5" width="10" height="10" rx="2" fill="currentColor" />
      <path d="M11.5 6.5h5a3 3 0 0 1 3 3v5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function GlobalSearch() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchWorkspace(ws, query), [ws, query]);
  const empty = !results.objects.length && !results.diagrams.length;

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    const click = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", click);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("mousedown", click);
    };
  }, []);

  const go = (path: string) => {
    setOpen(false);
    setQuery("");
    input.current?.blur();
    navigate(path);
  };
  const first = results.objects[0] ? `/model?object=${results.objects[0].id}` : results.diagrams[0] ? `/diagram/${results.diagrams[0].id}` : null;

  return (
    <div ref={root} className="relative w-full max-w-md">
      <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
      <input
        ref={input}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && first) go(first);
          if (e.key === "Escape") {
            setOpen(false);
            input.current?.blur();
          }
        }}
        aria-label="Search objects and diagrams"
        placeholder="Search objects and diagrams"
        className="w-full h-8.5 rounded-md border border-line bg-paper pl-8 pr-14 text-sm placeholder:text-ink-faint focus:bg-surface focus:border-blueprint focus:outline-none focus:ring-2 focus:ring-blueprint-soft"
      />
      <kbd className="absolute right-2 top-1/2 -translate-y-1/2 rounded border border-line bg-surface px-1.5 text-[11px] text-ink-faint">Ctrl K</kbd>
      {open && query.trim() && (
        <div className="absolute left-0 right-0 top-full mt-1 z-40 rounded-md border border-line bg-surface shadow-[0_12px_32px_rgba(22,35,58,0.14)] overflow-hidden">
          {empty && (
            <p className="px-3 py-3 text-[13px] text-ink-soft">
              Nothing matches "{query.trim()}". Try a name, or a filter such as tag:tier-1, type:database or owner:platform.
            </p>
          )}
          {results.objects.length > 0 && (
            <div className="py-1">
              <div className="px-3 py-1 text-xs text-ink-faint">Objects</div>
              {results.objects.map((o) => (
                <button key={o.id} type="button" onClick={() => go(`/model?object=${o.id}`)} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-line-soft">
                  <span className="text-ink-soft">
                    <TypeIcon typeId={o.typeId} componentId={o.componentId} size={15} />
                  </span>
                  <span className="font-medium truncate">{o.name}</span>
                  <span className="ml-auto text-xs text-ink-faint shrink-0">{objectType(o.typeId).label}</span>
                </button>
              ))}
            </div>
          )}
          {results.diagrams.length > 0 && (
            <div className="py-1 border-t border-line-soft">
              <div className="px-3 py-1 text-xs text-ink-faint">Diagrams</div>
              {results.diagrams.map((d) => (
                <button key={d.id} type="button" onClick={() => go(`/diagram/${d.id}`)} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-line-soft">
                  <LayoutGrid size={15} className="text-ink-soft" />
                  <span className="font-medium truncate">{d.name}</span>
                  <span className="ml-auto text-xs text-ink-faint shrink-0">{VIEW_TYPE_INFO[d.viewType].label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NavItemLink({ item, compact, badge, badgeTitle }: { item: NavItem; compact: boolean; badge: number; badgeTitle: string }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={compact ? item.label : undefined}
      className={({ isActive }) =>
        cx(
          "nav-link relative flex items-center gap-2.5 h-9 rounded-md text-sm",
          compact ? "justify-center" : "px-2.5",
          isActive ? "bg-nav-ink/12 text-nav-ink font-medium" : "hover:bg-nav-ink/8 hover:text-nav-ink",
        )
      }
    >
      <Icon size={17} strokeWidth={1.75} aria-hidden />
      {!compact && <span>{item.label}</span>}
      {compact && <span className="sr-only">{item.label}</span>}
      {badge > 0 && (
        <span title={badgeTitle} className={cx("grid place-items-center rounded-full bg-[#f2b93b] text-[#16233a] text-[11px] font-semibold min-w-[18px] h-[18px] px-1", compact ? "absolute -top-0.5 right-1" : "ml-auto")}>
          {badge}
        </span>
      )}
    </NavLink>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const ws = useWorkspace();
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const location = useLocation();
  // The editor needs the width, so the navigation shrinks to icons there.
  const compact = location.pathname.startsWith("/diagram/");
  const pending = Object.values(ws.proposals).filter((p) => p.status === "pending").length;
  const isOwner = useSession((s) => s.role) === "owner";
  const myId = useSession((s) => s.user?.id);
  const waitingForMe = useSession((s) => s.reviews).filter((r) => !!myId && currentStage(r)?.reviewerId === myId).length;
  const approvals = useSession((s) => s.approvals);
  const approvalsForMe = approvals ? approvals.open.filter((item) => APPROVAL_ROLES.some((r) => approvals.mine[r] && waitsFor(item, r))).length : 0;
  const look = useApplyAppearance(ws.branding?.workspace);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // The process modeler keeps its own undo.
      if (target.closest("input, textarea, select, [contenteditable], [data-own-undo]")) return;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [undo, redo]);

  return (
    <div className="h-full flex">
      <div className="ambient" data-ambient={look.theme.ambient} aria-hidden>
        <span />
        <span />
        <span />
        <span />
      </div>
      <nav aria-label="Main" className={cx("shrink-0 flex flex-col bg-nav text-nav-ink/80", compact ? "w-[60px]" : "w-[212px]")}>
        <Link to="/" className={cx("flex items-center gap-2.5 h-14 text-nav-ink", compact ? "justify-center" : "px-4")} aria-label={`${look.appName} home`} data-brand>
          {look.logo ? <img src={look.logo} alt="" className="size-7 rounded object-contain" data-brand-logo /> : <Mark />}
          {!compact && (
            <span className="min-w-0 leading-tight">
              <span className="block truncate font-semibold tracking-tight" data-brand-name>
                {look.appName}
              </span>
              <span className="block text-xs text-nav-ink/60">Diagrams</span>
            </span>
          )}
        </Link>
        <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {NAV_GROUPS.map((group) => {
            const items = group.items.filter((item) => !item.ownerOnly || isOwner);
            if (!items.length) return null;
            return (
              <div key={group.label || "home"} className={group.label ? (compact ? "mt-2 border-t border-nav-ink/10 pt-2" : "mt-3") : ""} role="group" aria-label={group.label || "Home"} data-nav-group={group.label || "home"}>
                {group.label && !compact && <p className="mb-0.5 px-2.5 text-[11px] font-medium text-nav-ink/45">{group.label}</p>}
                <ul className="space-y-0.5">
                  {items.map((item) => (
                    <li key={item.to}>
                      <NavItemLink item={item} compact={compact} badge={item.to === "/reviews" ? waitingForMe : item.to === "/approvals" ? approvalsForMe : item.to === "/ai" ? pending : 0} badgeTitle={item.to === "/reviews" ? `${waitingForMe} waiting for your decision` : item.to === "/approvals" ? `${approvalsForMe} ${approvalsForMe === 1 ? "diagram waits" : "diagrams wait"} for your approval` : `${pending} waiting for review`} />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
        <div className="border-t border-nav-ink/10 px-2 py-2">
          <NavItemLink item={SETTINGS} compact={compact} badge={0} badgeTitle="" />
          {!compact && (
            <p className="mt-2 px-2.5 text-xs text-nav-ink/45 leading-snug">
              {countOf(Object.keys(ws.objects).length, "object")} and {countOf(Object.keys(ws.relationships).length, "relationship")} in this model
            </p>
          )}
        </div>
      </nav>
      <div className="min-w-0 flex-1 flex flex-col">
        <header className="shrink-0 h-14 flex items-center gap-3 px-4 bg-surface border-b border-line">
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-1">
            <IconButton label="Undo (Ctrl Z)" disabled={!canUndo} onClick={undo}>
              <Undo2 size={17} />
            </IconButton>
            <IconButton label="Redo (Ctrl Shift Z)" disabled={!canRedo} onClick={redo}>
              <Redo2 size={17} />
            </IconButton>
            {cloudEnabled ? (
              <span className="ml-2 flex items-center gap-3">
                <CloudHeader />
              </span>
            ) : (
              <Link to="/settings" className="ml-2 text-[13px] text-ink-soft hover:text-ink">
                {ws.userName.trim() || "Add your name"}
              </Link>
            )}
          </div>
        </header>
        {cloudEnabled && <ReadOnlyBanner />}
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
