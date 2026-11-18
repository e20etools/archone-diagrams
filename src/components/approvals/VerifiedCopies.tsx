import { Check, Clock, Copy, Download, Eye, Link2Off, QrCode as QrIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Field, Input, Select, formatDateTime } from "@/components/ui";
import { STATUS_LABEL, verifyUrl, type DiagramRecord } from "@/lib/approvals";
import type { Publication } from "@/lib/cloud/backend";
import { errorText, getBackend, useCanEdit, useSession } from "@/lib/cloud/session";
import { slugify } from "@/lib/exporters";
import type { Diagram } from "@/lib/types";
import { QrCode, downloadQrPng } from "./QrCode";

const HOUR = 3_600_000;
/** How long a verified copy's link works. */
export const COPY_ENDS: { id: string; label: string; ms: number | null }[] = [
  { id: "1h", label: "1 hour", ms: HOUR },
  { id: "24h", label: "24 hours", ms: 24 * HOUR },
  { id: "7d", label: "7 days", ms: 7 * 24 * HOUR },
  { id: "30d", label: "30 days", ms: 30 * 24 * HOUR },
  { id: "custom", label: "Until a date and time", ms: null },
  { id: "never", label: "Until it is switched off", ms: null },
];

/** The end a choice stands for, as an ISO time; null for no end; undefined when the chosen date cannot be used. */
export function endOf(choice: string, custom: string, now = Date.now()): string | null | undefined {
  if (choice === "never") return null;
  if (choice === "custom") {
    const at = new Date(custom).getTime();
    return Number.isNaN(at) || at <= now + 5 * 60_000 || at > now + 365 * 24 * HOUR ? undefined : new Date(at).toISOString();
  }
  const ms = COPY_ENDS.find((c) => c.id === choice)?.ms;
  return ms ? new Date(now + ms).toISOString() : null;
}

/** What a verified copy of this diagram would show: its approved version while approval is required, otherwise the diagram as it is. */
export function copyScope(record: DiagramRecord | null): { allowed: boolean; text: string } {
  if (!record) return { allowed: false, text: "Reading where this diagram stands." };
  if (record.required) {
    if (!record.approvedVersion) return { allowed: false, text: "Nothing can be published yet: in this workspace Enterprise Architecture and Cybersecurity approve a diagram first." };
    return {
      allowed: true,
      text: record.status === "approved" ? `This publishes version ${record.approvedVersion}, approved by both roles.` : `This publishes version ${record.approvedVersion}, the last approved one. Changes made since are not in it.`,
    };
  }
  return { allowed: true, text: `This publishes the diagram as it is now: version ${record.version}, ${STATUS_LABEL[record.status].toLowerCase()}.` };
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      icon={copied ? <Check size={13} /> : <Copy size={13} />}
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          },
          () => setCopied(false),
        )
      }
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

/** Verified copies of one diagram: publish one with a QR code and an end, list them, switch them off. */
export function VerifiedCopies({ diagram, record }: { diagram: Diagram; record: DiagramRecord | null }) {
  const workspaceId = useSession((s) => s.workspaceId);
  const canEdit = useCanEdit();
  const [copies, setCopies] = useState<Publication[] | null>(null);
  const [end, setEnd] = useState("7d");
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [showQr, setShowQr] = useState<string | null>(null);
  const scope = copyScope(record);
  const ends = endOf(end, custom);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    setCopies(await (await getBackend()).listPublications(workspaceId, diagram.id));
  }, [workspaceId, diagram.id]);
  useEffect(() => {
    void refresh().catch((e) => setProblem(errorText(e)));
  }, [refresh]);

  const run = async (work: (backend: Awaited<ReturnType<typeof getBackend>>, ws: string) => Promise<void>) => {
    if (!workspaceId) return;
    setBusy(true);
    setProblem("");
    try {
      await work(await getBackend(), workspaceId);
      await refresh();
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const file = slugify(diagram.name) || "diagram";

  return (
    <div className="space-y-4" data-verified-copies>
      <p className="text-ink-soft">
        A verified copy freezes this diagram with its information box behind a link and a QR code. Anyone can open it without an account and see whether it is genuine,
        approved, and still current, and check a file they were sent against it.
      </p>
      {!canEdit ? (
        <p className="text-ink-soft">Only owners and editors can publish a verified copy.</p>
      ) : (
        <div className="rounded-md border border-line px-3 py-3 space-y-3" data-verified-copy-new>
          <p className={scope.allowed ? "text-[13px]" : "text-[13px] text-signal"} data-copy-scope={scope.allowed ? "allowed" : "blocked"}>
            {scope.text}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="The link works" hint={end === "custom" && ends === undefined ? "Choose a time between a few minutes and a year from now." : "Afterwards the link only says that it has expired."}>
              <Select aria-label="How long the verified copy's link works" value={end} onChange={(e) => setEnd(e.target.value)}>
                {COPY_ENDS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
            {end === "custom" ? (
              <Field label="Until">
                <Input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Date and time the link stops working" aria-invalid={ends === undefined} />
              </Field>
            ) : (
              <Field label="Note (optional)" hint="Shown on the copy's page.">
                <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="For example: for the 2026 audit" aria-label="Note on the verified copy" />
              </Field>
            )}
          </div>
          <Button
            variant="primary"
            icon={<QrIcon size={14} />}
            disabled={busy || !scope.allowed || ends === undefined}
            onClick={() =>
              void run(async (backend, ws) => {
                const made = await backend.publishDiagram(ws, diagram.id, { expiresAt: ends ?? null, note });
                setShowQr(made.id);
                setNote("");
              })
            }
            data-publish-copy
          >
            Publish a verified copy
          </Button>
        </div>
      )}
      {problem && (
        <p role="alert" className="rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
          {problem}
        </p>
      )}
      {copies && copies.length > 0 && (
        <ul className="space-y-3">
          {copies.map((copy) => {
            const url = verifyUrl(window.location.origin, copy.token);
            const expired = !!copy.expiresAt && new Date(copy.expiresAt).getTime() <= Date.now();
            const state = copy.revokedAt ? "off" : expired ? "expired" : "live";
            return (
              <li key={copy.id} className="rounded-md border border-line px-3 py-2.5" data-verified-copy={state}>
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <Badge tone={copy.version ? "green" : "amber"}>{copy.version ? `Approved version ${copy.version}` : "Not approved"}</Badge>
                  {state === "off" ? (
                    <Badge tone="red">Switched off {formatDateTime(copy.revokedAt!)}</Badge>
                  ) : (
                    <Badge tone={expired ? "red" : "neutral"}>
                      <Clock size={11} className="inline -mt-0.5 mr-1" aria-hidden />
                      {copy.expiresAt ? (expired ? `Expired ${formatDateTime(copy.expiresAt)}` : `Works until ${formatDateTime(copy.expiresAt)}`) : "Works until switched off"}
                    </Badge>
                  )}
                  {!copy.current && <Badge tone="amber">Diagram changed since</Badge>}
                  <span className="ml-auto inline-flex items-center gap-1 text-xs text-ink-faint">
                    <Eye size={12} aria-hidden /> {copy.views}
                  </span>
                </div>
                {state === "live" && (
                  <>
                    <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Link to the verified copy" />
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <CopyButton text={url} label="Copy link" />
                      <Button size="sm" icon={<QrIcon size={13} />} aria-pressed={showQr === copy.id} onClick={() => setShowQr(showQr === copy.id ? null : copy.id)}>
                        QR code
                      </Button>
                      <span className="text-xs text-ink-faint">
                        {formatDateTime(copy.createdAt)}
                        {copy.createdBy ? ` by ${copy.createdBy}` : ""}
                        {copy.files ? ` · ${copy.files} ${copy.files === 1 ? "file" : "files"} registered` : ""}
                      </span>
                      {canEdit && (
                        <Button size="sm" variant="danger" className="ml-auto" icon={<Link2Off size={13} />} disabled={busy} onClick={() => void run((backend, ws) => backend.revokePublication(ws, copy.id))}>
                          Switch off
                        </Button>
                      )}
                    </div>
                    {showQr === copy.id && (
                      <div className="mt-3 flex items-center gap-3" data-copy-qr>
                        <QrCode text={url} label={`QR code for the verified copy of ${diagram.name}`} />
                        <div className="space-y-2 text-[13px] text-ink-soft">
                          <p>Print it next to the diagram, or put it on a slide. A phone camera opens the copy's page.</p>
                          <Button size="sm" icon={<Download size={13} />} onClick={() => void downloadQrPng(url, `${file}-qr`)}>
                            Download the QR code
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[13px] text-ink-faint border-t border-line-soft pt-3">
        Exported pictures can carry the same QR code and register their file with a copy: choose it under Export. A copy is never updated; publish a new one after the next
        approval, and switch off the old one if it should stop working.
      </p>
    </div>
  );
}
