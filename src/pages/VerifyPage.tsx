import { FileCheck2, FileX2, ShieldAlert, ShieldCheck, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useParams } from "react-router-dom";
import { TitleBlockCard, viewOfRecord } from "@/components/approvals/TitleBlock";
import { DiagramCanvas, type CanvasSelection } from "@/components/canvas/DiagramCanvas";
import { cx, formatDateTime } from "@/components/ui";
import { sealCode, sha256Hex } from "@/lib/approvals";
import { fetchPublication, type PublicationView } from "@/lib/cloud/verify";

function Message({ title, text }: { title: string; text: string }) {
  return (
    <div className="h-full grid place-items-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface px-6 py-5" data-verify-message>
        <h1 className="text-base font-semibold">{title}</h1>
        <p className="mt-1.5 text-ink-soft">{text}</p>
      </div>
    </div>
  );
}

type Verdict = { tone: "ok" | "warn"; title: string; text: string };
function verdictOf(view: Extract<PublicationView, { status: "ok" }>): Verdict {
  const approved = view.record.status === "approved" && view.version !== null;
  if (view.current === "removed") return { tone: "warn", title: "Genuine copy of a diagram since deleted", text: "This copy was published from the workspace, but the diagram is no longer there." };
  if (!approved)
    return { tone: "warn", title: "Genuine copy, not approved", text: "It was published from the workspace before Enterprise Architecture and Cybersecurity approved it." };
  const newer = view.latestVersion && view.latestVersion > (view.version ?? 0) ? ` Version ${view.latestVersion} has been approved since.` : "";
  if (view.current === "same") return { tone: "ok", title: `Genuine and approved: version ${view.version}`, text: "Approved by Enterprise Architecture and Cybersecurity, and the diagram has not changed since." };
  return { tone: "warn", title: `Genuine, approved version ${view.version}`, text: `The diagram has changed in its workspace since this copy was published.${newer}` };
}

/** Checks a file someone was sent against the files exported with this copy. */
function FileCheck({ files }: { files: { sha256: string; name: string; at: string }[] }) {
  const [result, setResult] = useState<{ name: string; match: { name: string; at: string } | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const check = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const hash = await sha256Hex(file);
      setResult({ name: file.name, match: files.find((f) => f.sha256 === hash) ?? null });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void check(e.dataTransfer.files?.[0]);
  };
  return (
    <section aria-label="Check a file" data-verify-file-check>
      <h2 className="text-sm font-semibold">Check a file you were sent</h2>
      {files.length === 0 ? (
        <p className="mt-1 text-[13px] text-ink-soft">No exported file was registered with this copy. Compare the seal code printed on your copy instead.</p>
      ) : (
        <>
          <p className="mt-1 text-[13px] text-ink-soft">
            {files.length === 1 ? "One file was" : `${files.length} files were`} exported with this copy. The file is checked in your browser; it is not uploaded.
          </p>
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={drop}
            className={cx("mt-2 flex cursor-pointer flex-col items-center gap-1 rounded-md border border-dashed px-3 py-4 text-center text-[13px]", over ? "border-blueprint bg-blueprint-soft" : "border-ink-faint")}
          >
            <Upload size={18} className="text-ink-soft" aria-hidden />
            {busy ? "Checking" : "Drop the PNG or PDF here, or choose it"}
            <input ref={input} type="file" className="sr-only" aria-label="File to check" onChange={(e) => void check(e.target.files?.[0])} data-verify-file />
          </label>
          {result && (
            <p role="status" className={cx("mt-2 flex items-start gap-2 rounded-md px-3 py-2 text-[13px]", result.match ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger")} data-verify-file-result={result.match ? "match" : "no-match"}>
              {result.match ? <FileCheck2 size={16} className="mt-px shrink-0" /> : <FileX2 size={16} className="mt-px shrink-0" />}
              <span>
                {result.match
                  ? `"${result.name}" is exactly the file exported with this copy on ${formatDateTime(result.match.at)}.`
                  : `"${result.name}" does not match any file exported with this copy. It was changed after it was exported, or it is another file.`}
              </span>
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** A verified copy of a diagram, opened from its link or its QR code: is it genuine, approved and still current? */
export function VerifyPage() {
  const { token = "" } = useParams();
  const [view, setView] = useState<PublicationView | null>(null);
  const [selection, setSelection] = useState<CanvasSelection>({ objectId: null, edgeId: null });
  useEffect(() => {
    let live = true;
    void fetchPublication(token).then((next) => live && setView(next));
    return () => {
      live = false;
    };
  }, [token]);
  const box = useMemo(() => (view?.status === "ok" ? viewOfRecord(view.record) : null), [view]);

  if (!view) return <Message title="Checking the copy" text="One moment." />;
  if (view.status === "gone") return <Message title="This copy is not available" text="The link is mistyped, or the copy was switched off. Ask whoever sent it for a new one." />;
  if (view.status === "expired")
    return <Message title="This link has expired" text={`The copy of "${view.name}"${view.company ? ` from ${view.company}` : ""} could be checked until ${formatDateTime(view.expiredAt)}. Ask whoever sent it for a new link.`} />;
  if (view.status === "unreachable") return <Message title="The copy could not be checked" text="Check your connection and open the link again." />;
  const diagram = view.ws.diagrams[view.diagramId];
  const verdict = verdictOf(view);
  const Icon = verdict.tone === "ok" ? ShieldCheck : ShieldAlert;
  return (
    <div className="h-full flex flex-col bg-paper" data-verify-page data-verdict={verdict.tone} data-current={view.current}>
      <header className="shrink-0 flex flex-wrap items-center gap-3 border-b border-line bg-surface px-5 py-2.5">
        {view.record.logo && <img src={view.record.logo} alt="" className="size-8 object-contain" />}
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{view.record.name}</h1>
          <p className="text-[13px] text-ink-soft">
            Verified copy{view.record.company ? ` from ${view.record.company}` : ""}, published {formatDateTime(view.publishedAt)}
            {view.publishedBy ? ` by ${view.publishedBy}` : ""}
          </p>
        </div>
      </header>
      <div className={cx("shrink-0 flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-5 py-3", verdict.tone === "ok" ? "border-ok/30 bg-ok-soft" : "border-signal/30 bg-signal-soft")} role="status" data-verify-verdict>
        <Icon size={28} className={cx("shrink-0", verdict.tone === "ok" ? "text-ok" : "text-signal")} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className={cx("font-semibold", verdict.tone === "ok" ? "text-ok" : "text-signal")}>{verdict.title}</p>
          <p className="text-[13px] text-ink">{verdict.text}</p>
        </div>
        <div className="text-right">
          <div className="text-[11px] text-ink-soft">Seal code</div>
          <div className="font-mono text-lg font-semibold tabular-nums tracking-wide" data-verify-seal>
            {sealCode(view.fingerprint)}
          </div>
          <div className="text-[11px] text-ink-soft">Matches the code printed on a genuine copy</div>
        </div>
      </div>
      <div className="min-h-0 flex-1 flex flex-col lg:flex-row">
        <div className="relative min-h-[360px] min-w-0 flex-1">
          {diagram && <DiagramCanvas ws={view.ws} diagram={diagram} readOnly minimap selection={selection} onSelect={setSelection} />}
        </div>
        <aside className="w-full lg:w-[380px] shrink-0 overflow-y-auto border-t lg:border-t-0 lg:border-l border-line bg-surface px-4 py-4 space-y-5">
          {box && <TitleBlockCard view={box} collapsible={false} className="!w-full" />}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
            <dt className="text-ink-soft">Published</dt>
            <dd>
              {formatDateTime(view.publishedAt)}
              {view.publishedBy ? ` by ${view.publishedBy}` : ""}
            </dd>
            <dt className="text-ink-soft">Link works</dt>
            <dd data-verify-expires>{view.expiresAt ? `until ${formatDateTime(view.expiresAt)}` : "until it is switched off"}</dd>
            <dt className="text-ink-soft">Checked</dt>
            <dd>{formatDateTime(view.at)}</dd>
          </dl>
          {view.note && <p className="rounded-md bg-paper px-3 py-2 text-[13px] whitespace-pre-wrap">{view.note}</p>}
          <FileCheck files={view.files} />
        </aside>
      </div>
    </div>
  );
}
