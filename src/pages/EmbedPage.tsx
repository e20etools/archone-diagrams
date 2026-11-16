import { useEffect, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Button, Field, Input, formatDateTime } from "@/components/ui";
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
  // The password a visitor typed is kept for this page only, to keep the picture current. It is never stored.
  const password = useRef("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    if (!typed) return;
    setBusy(true);
    const next = await fetchLiveView(token, typed);
    if (next.status === "ok") password.current = typed;
    setTyped("");
    setView(next);
    setBusy(false);
  };

  useEffect(() => {
    let live = true;
    const load = async () => {
      // A locked link is not asked again without a password: every empty ask would be one more request for nothing.
      const next = await fetchLiveView(token, password.current);
      // A passing network problem keeps the last good picture on screen.
      if (live) setView((current) => (next.status === "unreachable" && current?.status === "ok" ? current : current?.status === "locked" && next.status === "locked" ? current : next));
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
  if (view.status === "expired") return <Message title="This link has expired" text="It was set to stop working after a date that has passed. Ask the person who shared it for a new link." />;
  if (view.status === "throttled")
    return <Message title="Too many wrong passwords" text={`This link is shut for about ${view.minutes} ${view.minutes === 1 ? "minute" : "minutes"}. Check the password with the person who shared it, then open the link again.`} />;
  if (view.status === "locked") {
    return (
      <div className="h-full grid place-items-center p-6">
        <div className="w-full max-w-sm rounded-lg border border-line bg-surface px-6 py-5" data-embed-locked>
          <h1 className="text-base font-semibold">This diagram is protected</h1>
          <p className="mt-1.5 text-ink-soft">Enter the password you were given with the link.</p>
          <form onSubmit={unlock} className="mt-4 space-y-3">
            <Field label="Password">
              <Input type="password" autoFocus autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} aria-invalid={view.wrong} />
            </Field>
            {view.wrong && (
              <p role="alert" className="text-sm text-danger">
                That password does not open this link. After five wrong tries the link shuts for fifteen minutes.
              </p>
            )}
            <Button type="submit" variant="primary" disabled={!typed || busy}>
              {busy ? "Opening" : "Open diagram"}
            </Button>
          </form>
        </div>
      </div>
    );
  }
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
