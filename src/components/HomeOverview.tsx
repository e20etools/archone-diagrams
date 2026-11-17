import { ArrowUpRight, FileBarChart, FolderOpen, GalleryThumbnails, Lock, Network, Shapes, Sparkles, UserX, Zap } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CATEGORY_INFO, viewCategory } from "@/lib/categories";
import { RELATION_KIND_INFO, VIEW_TYPE_INFO } from "@/lib/catalog";
import { protocolByName } from "@/lib/library/protocols";
import { protocolsOf } from "@/lib/model";
import type { Diagram, Workspace } from "@/lib/types";
import { DiagramThumbnail } from "./DiagramThumbnail";
import { cx, formatDate } from "./ui";

/**
 * The top of the home page: what to look at first in this model, the places to go next, and the
 * diagrams changed last. Each figure links to where it can be acted on.
 */
export function HomeOverview({ ws, diagrams }: { ws: Workspace; diagrams: Diagram[] }) {
  const facts = useMemo(() => {
    const rels = Object.values(ws.relationships).filter((r) => ws.objects[r.sourceId] && ws.objects[r.targetId]);
    const into = new Map<string, number>();
    for (const r of rels) if (RELATION_KIND_INFO[r.kind]?.dependency) into.set(r.targetId, (into.get(r.targetId) ?? 0) + 1);
    const top = [...into].sort((a, b) => b[1] - a[1])[0];
    const objects = Object.values(ws.objects).filter((o) => o.typeId !== "diagram");
    const unowned = objects.filter((o) => !o.owner.trim() && !["actor", "task", "event", "decision"].includes(o.typeId)).length;
    const clear = rels.filter((r) => r.encrypted !== "yes" && protocolsOf(r).some((p) => protocolByName(p.name)?.secure === false)).length;
    const pending = Object.values(ws.proposals).filter((p) => p.status === "pending").length;
    return { top: top ? { object: ws.objects[top[0]], count: top[1] } : null, unowned, clear, pending, objects: objects.length, rels: rels.length };
  }, [ws]);
  const recent = useMemo(() => [...diagrams].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4), [diagrams]);

  const insights = [
    facts.top && {
      to: `/impact?object=${facts.top.object.id}`,
      icon: <Zap size={16} />,
      tone: "accent",
      title: "Most depended on",
      value: facts.top.object.name,
      hint: `${facts.top.count} components need it directly. See what stops if it does.`,
      data: "top",
    },
    {
      to: "/reports?report=ownership-gaps",
      icon: <UserX size={16} />,
      tone: facts.unowned ? "warn" : "ok",
      title: "Without an owner",
      value: facts.unowned ? `${facts.unowned} components` : "Every component",
      hint: facts.unowned ? "Nobody is called when these stop." : "has an owner.",
      data: "unowned",
    },
    {
      to: "/reports?report=clear-text",
      icon: <Lock size={16} />,
      tone: facts.clear ? "warn" : "ok",
      title: "Sent in clear text",
      value: facts.clear ? `${facts.clear} connections` : "No connection",
      hint: facts.clear ? "Over protocols that do not encrypt." : "is known to send data unencrypted.",
      data: "clear",
    },
    {
      to: "/ai",
      icon: <Sparkles size={16} />,
      tone: facts.pending ? "warn" : "ok",
      title: "AI drafts",
      value: facts.pending ? `${facts.pending} waiting` : "None waiting",
      hint: facts.pending ? "Nothing enters the model before a person accepts it." : "Draft a diagram from text, a picture or your voice.",
      data: "drafts",
    },
  ].filter(Boolean) as { to: string; icon: ReactNode; tone: string; title: string; value: string; hint: string; data: string }[];

  const routes = [
    { to: "/diagrams", label: "Every diagram, as cards", icon: <GalleryThumbnails size={15} /> },
    { to: "/map", label: "All diagrams on one map", icon: <Network size={15} /> },
    { to: "/impact", label: "Impact and what-if", icon: <Zap size={15} /> },
    { to: "/reports", label: "Reports", icon: <FileBarChart size={15} /> },
    { to: "/files", label: "File library", icon: <FolderOpen size={15} /> },
    { to: "/library", label: "Component library", icon: <Shapes size={15} /> },
  ];

  return (
    <div className="mt-6 space-y-6" data-home-overview>
      <section aria-label="What to look at first" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {insights.map((i) => (
          <Link key={i.data} to={i.to} data-home-insight={i.data} className="insight group relative overflow-hidden rounded-xl border border-line bg-surface px-4 py-3.5 transition hover:-translate-y-0.5 hover:border-blueprint hover:shadow-lg">
            <span className={cx("inline-flex size-8 items-center justify-center rounded-lg", i.tone === "accent" ? "bg-blueprint text-white" : i.tone === "warn" ? "bg-signal-soft text-signal" : "bg-ok-soft text-ok")}>{i.icon}</span>
            <span className="mt-2 block text-xs text-ink-soft">{i.title}</span>
            <span className="block truncate text-base font-semibold">{i.value}</span>
            <span className="mt-0.5 block text-xs leading-snug text-ink-soft">{i.hint}</span>
            <ArrowUpRight size={15} className="absolute right-3 top-3 text-ink-faint transition group-hover:text-blueprint" />
          </Link>
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <section aria-label="Changed last">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold">Pick up where you left off</h2>
            <Link to="/diagrams" className="text-[13px] text-blueprint hover:underline" data-home-all-diagrams>
              See all {diagrams.length} diagrams
            </Link>
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {recent.map((d) => (
              <li key={d.id}>
                <Link to={`/diagram/${d.id}`} className="flex items-center gap-3 rounded-lg border border-line bg-surface px-2.5 py-2 transition hover:border-blueprint" data-home-recent={d.id}>
                  <span className="block h-12 w-16 shrink-0 overflow-hidden rounded-md border border-line-soft bg-paper">
                    <DiagramThumbnail ws={ws} diagram={d} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{d.name}</span>
                    <span className="block truncate text-xs text-ink-soft">
                      {[...new Set([CATEGORY_INFO[viewCategory(d.viewType)].label, VIEW_TYPE_INFO[d.viewType].label])].join(" · ")} · {formatDate(d.updatedAt)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="Go to">
          <h2 className="mb-2 text-sm font-semibold">Go to</h2>
          <ul className="space-y-1">
            {routes.map((r) => (
              <li key={r.to}>
                <Link to={r.to} className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-ink-soft transition hover:bg-surface hover:text-blueprint">
                  {r.icon}
                  {r.label}
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-2 px-2.5 text-xs text-ink-faint">
            {facts.objects} components and {facts.rels} connections across {diagrams.length} diagrams.
          </p>
        </section>
      </div>
    </div>
  );
}
