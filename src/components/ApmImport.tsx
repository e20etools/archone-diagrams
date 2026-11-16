import { Building2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Field, Input } from "@/components/ui";
import { saveProposal } from "@/lib/ai/proposals";
import { apmStatus, fetchApm, type ApmStatus } from "@/lib/apm/client";
import { apmToProposal } from "@/lib/apm/map";
import { apply, useWorkspace } from "@/lib/store";

/** Bringing the application portfolio from APM & Landscape, as a draft to review. Shown only when the server knows where APM is. */
export function ApmImport({ canEdit, onDone }: { canEdit: boolean; onDone: () => void }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [status, setStatus] = useState<ApmStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    let live = true;
    void apmStatus().then((s) => live && setStatus(s));
    return () => {
      live = false;
    };
  }, []);
  if (!status?.configured) return null;

  const run = async () => {
    setBusy(true);
    setProblem("");
    try {
      const { proposal } = apmToProposal(ws, await fetchApm(token));
      if (!proposal.objects.length) throw new Error("APM sent no applications. Check that the feed token covers the applications dataset.");
      apply((w) => saveProposal(w, proposal));
      onDone();
      navigate(`/ai/${proposal.id}`);
    } catch (error) {
      setProblem(error instanceof Error && error.message ? error.message : "The import from APM failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-line px-4 py-3.5" data-apm-import>
      <div className="flex items-start gap-3">
        <Building2 size={18} className="mt-0.5 shrink-0 text-ink-soft" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">From APM & Landscape</p>
          <p className="text-[13px] text-ink-soft">
            Reads the applications and integrations {status.host} publishes and makes a draft of them. Applications already in the model are updated in their description, lifecycle and APM fields; nothing is deleted.
          </p>
          {!status.hasToken && (
            <div className="mt-2">
              <Field label="Feed token" hint="Create it in APM under Connections, as a Power BI or Excel feed. It is sent to this app's server for this import and is not kept.">
                <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="apmf_..." data-apm-token />
              </Field>
            </div>
          )}
          {problem && (
            <p role="alert" className="mt-2 rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
              {problem}
            </p>
          )}
          <div className="mt-2.5">
            <Button disabled={busy || !canEdit || (!status.hasToken && !token.trim())} onClick={() => void run()} data-apm-run>
              {busy ? "Reading APM" : "Read from APM"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
