import { X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { DiagramCanvas, type CanvasSelection } from "@/components/canvas/DiagramCanvas";
import { FlowBar, NO_FLOW, useFlowCursor, useFlowKeys } from "@/components/Flows";
import { TypeIcon } from "@/components/icons";
import { Badge, Button, Field, IconButton, Input, formatDate } from "@/components/ui";
import { LIFECYCLE_INFO, RELATION_KIND_INFO, VIEW_TYPE_INFO, objectType } from "@/lib/catalog";
import { relationshipsOf } from "@/lib/model";
import { ShareError, decodeShare, isProtectedShare, payloadToWorkspace, type SharePayload } from "@/lib/share";
import type { Diagram, Workspace } from "@/lib/types";

type State = { status: "loading" } | { status: "locked"; wrong: boolean } | { status: "invalid" } | { status: "ready"; payload: SharePayload };

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full grid place-items-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface px-6 py-5">{children}</div>
    </div>
  );
}

export function SharedViewPage() {
  const token = useMemo(() => window.location.hash.replace(/^#/, ""), []);
  const [state, setState] = useState<State>({ status: "loading" });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return setState({ status: "invalid" });
    if (isProtectedShare(token)) return setState({ status: "locked", wrong: false });
    decodeShare(token)
      .then((payload) => setState({ status: "ready", payload }))
      .catch(() => setState({ status: "invalid" }));
  }, [token]);

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    if (!password) return;
    setBusy(true);
    try {
      setState({ status: "ready", payload: await decodeShare(token, password) });
    } catch (error) {
      setState(error instanceof ShareError && error.code === "wrong-password" ? { status: "locked", wrong: true } : { status: "invalid" });
    } finally {
      setBusy(false);
    }
  };

  const ws = useMemo(() => (state.status === "ready" ? payloadToWorkspace(state.payload) : null), [state]);

  if (state.status === "loading") {
    return (
      <Frame>
        <p className="text-ink-soft">Opening the shared diagram.</p>
      </Frame>
    );
  }
  if (state.status === "invalid") {
    return (
      <Frame>
        <h1 className="text-base font-semibold">This link cannot be opened</h1>
        <p className="mt-1.5 text-ink-soft">The link is incomplete or damaged. Ask the person who shared it to copy the whole link and send it again.</p>
      </Frame>
    );
  }
  if (state.status === "locked") {
    return (
      <Frame>
        <h1 className="text-base font-semibold">This diagram is protected</h1>
        <p className="mt-1.5 text-ink-soft">Enter the password you were given with the link.</p>
        <form onSubmit={unlock} className="mt-4 space-y-3">
          <Field label="Password">
            <Input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={state.wrong} />
          </Field>
          {state.wrong && (
            <p role="alert" className="text-sm text-danger">
              That password does not open this link. Check it and try again.
            </p>
          )}
          <Button type="submit" variant="primary" disabled={!password || busy}>
            {busy ? "Opening" : "Open diagram"}
          </Button>
        </form>
      </Frame>
    );
  }

  const { payload } = state;
  return (
    <DiagramViewer
      ws={ws!}
      diagram={ws!.diagrams[payload.diagram.id]}
      subtitle={`${VIEW_TYPE_INFO[payload.diagram.viewType].label} view${payload.sharedBy ? `, shared by ${payload.sharedBy}` : ""} on ${formatDate(payload.sharedAt)}`}
      note="A snapshot from the day it was shared. Later changes are not shown."
    />
  );
}

/** A diagram to look at, with the details of whichever box is selected. Used by snapshot links and live links. */
export function DiagramViewer({ ws, diagram, subtitle, note, badge = "View only" }: { ws: Workspace; diagram: Diagram; subtitle: string; note: string; badge?: string }) {
  const [selection, setSelection] = useState<CanvasSelection>({ objectId: null, edgeId: null });
  const flows = useFlowCursor(ws, diagram);
  useFlowKeys(!!flows.flow, flows.move, () => flows.setCursor(NO_FLOW));
  const object = selection.objectId ? ws.objects[selection.objectId] : undefined;
  // Only what the diagram draws: a live link also carries bare ids of nested objects, which have no name to show.
  const drawn = (id: string) => id in diagram.nodes;
  const all = object ? relationshipsOf(ws, object.id) : null;
  const links = all ? { outgoing: all.outgoing.filter((r) => drawn(r.targetId)), incoming: all.incoming.filter((r) => drawn(r.sourceId)) } : null;
  return (
    <div className="h-full flex flex-col">
      <header className="shrink-0 flex flex-wrap items-center gap-x-4 gap-y-1 min-h-14 px-5 py-2 bg-surface border-b border-line">
        <div className="min-w-0">
          <h1 className="text-base font-semibold truncate">{diagram.name}</h1>
          <p className="text-[13px] text-ink-soft">{subtitle}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge>{badge}</Badge>
          <span className="text-[13px] text-ink-soft">{note}</span>
        </div>
      </header>
      <div className="min-h-0 flex-1 flex">
        <div className="relative min-w-0 flex-1">
          <DiagramCanvas ws={ws} diagram={diagram} readOnly minimap selection={selection} onSelect={setSelection} spotlight={flows.spotlight} />
          <FlowBar ws={ws} diagram={diagram} cursor={flows.cursor} onCursor={flows.setCursor} />
        </div>
        {object && links && (
          <aside className="w-[320px] shrink-0 overflow-y-auto bg-surface border-l border-line" aria-label="Object details">
            <div className="flex items-start gap-2.5 px-4 py-3.5">
              <span className="mt-0.5 text-ink-soft">
                <TypeIcon typeId={object.typeId} size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold break-words">{object.name}</h2>
                <p className="text-[13px] text-ink-soft">{objectType(object.typeId).label}</p>
              </div>
              <IconButton label="Close panel" onClick={() => setSelection({ objectId: null, edgeId: null })}>
                <X size={16} />
              </IconButton>
            </div>
            <dl className="px-4 pb-4 space-y-3 text-sm">
              {object.description && (
                <div>
                  <dt className="text-[13px] text-ink-soft">Description</dt>
                  <dd className="whitespace-pre-wrap">{object.description}</dd>
                </div>
              )}
              {object.technology && (
                <div>
                  <dt className="text-[13px] text-ink-soft">Technology</dt>
                  <dd>{object.technology}</dd>
                </div>
              )}
              {object.owner && (
                <div>
                  <dt className="text-[13px] text-ink-soft">Owner</dt>
                  <dd>{object.owner}</dd>
                </div>
              )}
              <div>
                <dt className="text-[13px] text-ink-soft">Lifecycle</dt>
                <dd>{LIFECYCLE_INFO[object.lifecycle].label}</dd>
              </div>
              {object.tags.length > 0 && (
                <div>
                  <dt className="text-[13px] text-ink-soft">Tags</dt>
                  <dd className="flex flex-wrap gap-1 mt-0.5">
                    {object.tags.map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </dd>
                </div>
              )}
              {links.outgoing.length + links.incoming.length > 0 && (
                <div>
                  <dt className="text-[13px] text-ink-soft">Relationships on this diagram</dt>
                  <dd>
                    <ul className="mt-1 space-y-1">
                      {links.outgoing.map((r) => (
                        <li key={r.id}>
                          <span className="text-ink-soft">{r.label || RELATION_KIND_INFO[r.kind].verb}</span>{" "}
                          <button type="button" className="font-medium text-blueprint hover:underline" onClick={() => setSelection({ objectId: r.targetId, edgeId: null })}>
                            {ws.objects[r.targetId]?.name}
                          </button>
                        </li>
                      ))}
                      {links.incoming.map((r) => (
                        <li key={r.id}>
                          <button type="button" className="font-medium text-blueprint hover:underline" onClick={() => setSelection({ objectId: r.sourceId, edgeId: null })}>
                            {ws.objects[r.sourceId]?.name}
                          </button>{" "}
                          <span className="text-ink-soft">{r.label || RELATION_KIND_INFO[r.kind].verb} this</span>
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
            </dl>
          </aside>
        )}
      </div>
    </div>
  );
}
