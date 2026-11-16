import { Check, Copy, Link2Off } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Input, formatDate } from "@/components/ui";
import type { LiveLink } from "@/lib/cloud/backend";
import { personLabel } from "@/lib/cloud/collab";
import { liveLinkUrl } from "@/lib/cloud/embed";
import { errorText, getBackend, useCanEdit, useSession } from "@/lib/cloud/session";
import type { Diagram } from "@/lib/types";

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

/** Live links of one diagram: create, copy as a link or as wiki embed code, and switch off. */
export function LiveLinks({ diagram }: { diagram: Diagram }) {
  const workspaceId = useSession((s) => s.workspaceId);
  const people = useSession((s) => s.people);
  const reviewOn = useSession((s) => s.review.required);
  const canEdit = useCanEdit();
  const [links, setLinks] = useState<LiveLink[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    setLinks(await (await getBackend()).listLiveLinks(workspaceId, diagram.id));
  }, [workspaceId, diagram.id]);
  useEffect(() => {
    void refresh().catch((e) => setProblem(errorText(e)));
  }, [refresh]);

  const run = async (work: (workspace: string) => Promise<void>) => {
    if (!workspaceId) return;
    setBusy(true);
    setProblem("");
    try {
      await work(workspaceId);
      await refresh();
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const embedCode = (url: string) => `<iframe src="${url}" title="${diagram.name.replace(/"/g, "&quot;")}" width="100%" height="600" style="border:1px solid #d5dbe5" loading="lazy"></iframe>`;

  return (
    <div className="space-y-4" data-live-links>
      <p className="text-ink-soft">
        Anyone with a live link sees this diagram as it is now, without an account, and cannot change anything. The link keeps up with later changes until you switch it off.
        {reviewOn && " Because review is on, it shows the last approved version."}
      </p>
      {!canEdit ? (
        <p className="text-ink-soft">Only owners and editors can create live links.</p>
      ) : (
        <Button variant="primary" disabled={busy} onClick={() => void run(async (ws) => (await getBackend()).createLiveLink(ws, diagram.id))}>
          Create a live link
        </Button>
      )}
      {problem && (
        <p role="alert" className="rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
          {problem}
        </p>
      )}
      {links && links.length > 0 && (
        <ul className="space-y-3">
          {links.map((link) => {
            const url = liveLinkUrl(window.location.origin, link.token);
            return (
              <li key={link.id} className="rounded-md border border-line px-3 py-2.5">
                <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Live link" />
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <CopyButton text={url} label="Copy link" />
                  <CopyButton text={embedCode(url)} label="Copy embed code" />
                  <span className="text-xs text-ink-faint">
                    Created {formatDate(link.createdAt)} by {personLabel(people.find((p) => p.userId === link.createdBy))}
                  </span>
                  <Button size="sm" variant="danger" className="ml-auto" icon={<Link2Off size={13} />} disabled={busy} onClick={() => void run(async (ws) => (await getBackend()).revokeLiveLink(ws, link.id))}>
                    Switch off
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[13px] text-ink-faint border-t border-line-soft pt-3">
        The embed code puts the diagram in a wiki page such as Confluence or SharePoint, wherever the wiki allows an iframe. A link shows the boxes on this diagram with their
        details; it does not open the rest of the model. Treat the link like a password: whoever has it can look.
      </p>
    </div>
  );
}
