import { Copy, ShieldAlert, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button, Input, formatDateTime } from "@/components/ui";
import { anchorCode, parseAnchor, type AuditCheck } from "@/lib/cloud/audit";
import { errorText, verifyAudit } from "@/lib/cloud/session";

/**
 * Checks that the audit log has not been altered. Every entry carries a hash of itself and
 * of the entry before it; the newest hash, kept somewhere else, pins the whole log down.
 */
export function AuditChainCard() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AuditCheck | null>(null);
  const [problem, setProblem] = useState("");
  const [saved, setSaved] = useState("");
  const [copied, setCopied] = useState(false);
  const anchor = parseAnchor(saved);

  const run = (against?: { id: number; hash: string }) => {
    setBusy(true);
    setProblem("");
    setCopied(false);
    verifyAudit(against)
      .then(setResult, (e) => setProblem(errorText(e)))
      .finally(() => setBusy(false));
  };
  const copy = async () => {
    if (!result?.head) return;
    try {
      await navigator.clipboard.writeText(anchorCode(result.head));
      setCopied(true);
    } catch {
      setProblem("The code could not be copied. Select it and copy it by hand.");
    }
  };

  return (
    <section aria-label="Tamper check" className="mt-5 rounded-lg border border-line bg-surface px-5 py-4" data-audit-chain>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-80">
          <h2 className="font-semibold">Has the log been altered?</h2>
          <p className="text-[13px] text-ink-soft mt-0.5">
            Each entry is sealed with a hash of itself and of the entry before it. Changing or removing one breaks the chain from there on. Keep the code of the newest entry somewhere outside this system, and a later check against it also
            shows whether the end of the log was cut off.
          </p>
        </div>
        <Button variant="primary" icon={<ShieldCheck size={15} />} disabled={busy} onClick={() => run()}>
          {busy ? "Checking" : "Check the log"}
        </Button>
      </div>
      {problem && (
        <p role="alert" className="mt-3 rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
          {problem}
        </p>
      )}
      {result && (
        <div className="mt-3 border-t border-line-soft pt-3" data-audit-result={result.ok ? "ok" : "broken"}>
          {result.brokenAt !== null ? (
            <p className="flex items-start gap-2 text-danger">
              <ShieldAlert size={17} className="mt-0.5 shrink-0" />
              <span>
                <span className="font-medium">The chain is broken at entry {result.brokenAt}.</span> The {result.entries} entries before it are intact. That entry, or the one before it, was changed or removed after it was written.
              </span>
            </p>
          ) : (
            <p className="flex items-start gap-2 text-ok">
              <ShieldCheck size={17} className="mt-0.5 shrink-0" />
              <span>
                <span className="font-medium">{result.entries === 0 ? "The log is empty." : `All ${result.entries} entries follow from one another.`}</span>
                {result.head && <span className="text-ink-soft"> The newest is entry {result.head.id}, written {formatDateTime(result.head.at)}.</span>}
              </span>
            </p>
          )}
          {result.anchor && (
            <p className={`mt-2 ${result.anchor === "match" ? "text-ok" : "text-danger"}`} data-audit-anchor={result.anchor}>
              {result.anchor === "match"
                ? "The saved code matches: that entry is still there, unchanged, and so is everything before it."
                : result.anchor === "missing"
                  ? "The entry of the saved code is no longer in the log. Entries were removed from the end, or the code belongs to another workspace."
                  : "The entry of the saved code now has a different hash. The log was rewritten after the code was saved."}
            </p>
          )}
          {result.head && (
            <div className="mt-3">
              <span className="block text-[13px] font-medium mb-1">Code of the newest entry</span>
              <div className="flex gap-2">
                <code className="min-w-0 flex-1 rounded-md border border-line bg-paper px-2.5 py-1.5 text-xs break-all" data-audit-code>
                  {anchorCode(result.head)}
                </code>
                <Button icon={<Copy size={14} />} onClick={() => void copy()}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (anchor) run(anchor);
        }}
      >
        <label className="block min-w-0 flex-1 basis-80">
          <span className="block text-[13px] font-medium mb-1">Check against a code you saved earlier</span>
          <Input value={saved} onChange={(e) => setSaved(e.target.value)} placeholder="For example 1532-9f2c…" aria-invalid={!!saved.trim() && !anchor} spellCheck={false} />
        </label>
        <Button type="submit" disabled={busy || !anchor}>
          Check against it
        </Button>
        {saved.trim() && !anchor && <p className="basis-full text-[13px] text-danger">A code is an entry number, a dash, and 64 letters and digits.</p>}
      </form>
    </section>
  );
}
