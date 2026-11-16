import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { formatDateTime } from "@/components/ui";
import { VIEW_TYPE_INFO } from "@/lib/catalog";
import { fetchLiveView, type LiveView } from "@/lib/cloud/embed";
import { DiagramViewer } from "@/pages/SharedViewPage";

const REFRESH_MS = 30_000;

function Message({ title, text }: { title: string; text: string }) {
  return (
    <div className="h-full grid place-items-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface px-6 py-5">
        <h1 className="text-base font-semibold">{title}</h1>
        <p className="mt-1.5 text-ink-soft">{text}</p>
      </div>
    </div>
  );
}

/** A live link: one diagram, read-only, kept up to date. Opened on its own or inside a wiki page. */
export function EmbedPage() {
  const { token = "" } = useParams();
  const [view, setView] = useState<LiveView | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      const next = await fetchLiveView(token);
      // A passing network problem keeps the last good picture on screen.
      if (live) setView((current) => (next.status === "unreachable" && current?.status === "ok" ? current : next));
    };
    void load();
    // Refreshed while the page is visible; a hidden wiki tab does not keep asking.
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), REFRESH_MS);
    const onShow = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [token]);

  if (!view) return <Message title="Opening the diagram" text="One moment." />;
  if (view.status === "gone") return <Message title="This link no longer works" text="It was switched off, or the diagram was deleted. Ask the person who shared it for a new link." />;
  if (view.status === "unpublished") return <Message title="Nothing to show yet" text="This diagram is waiting for review. It appears here once it is approved." />;
  if (view.status === "unreachable") return <Message title="The diagram could not be loaded" text="Check your connection. This page tries again by itself." />;
  const diagram = view.ws.diagrams[view.diagramId];
  return (
    <DiagramViewer
      ws={view.ws}
      diagram={diagram}
      subtitle={`${VIEW_TYPE_INFO[diagram.viewType].label} view${view.source === "published" ? ", the approved version" : ""}`}
      badge="Live, view only"
      note={`Up to date as of ${formatDateTime(view.at)}.`}
    />
  );
}
