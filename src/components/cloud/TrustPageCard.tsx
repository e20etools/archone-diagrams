import { Check, Copy, ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { TrustContent } from "@/components/TrustContent";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { errorText, saveTrustPage, trustPage, useSession } from "@/lib/cloud/session";
import { fromTables, toTables, withoutDangling } from "@/lib/cloud/tables";
import { trustPageUrl } from "@/lib/cloud/trustView";
import { emptyWorkspace, sortedDiagrams } from "@/lib/model";
import { useWorkspace } from "@/lib/store";
import { PUBLIC_PURPOSE_FIELD, redactForTrust, type TrustPage, type TrustPageInput } from "@/lib/trust";

const BLANK: TrustPageInput = { enabled: false, title: "", intro: "", contact: "", diagramId: null };

/** Settings for the public trust page, with a preview of exactly what it will show. Owners only. */
export function TrustPageCard() {
  const ws = useWorkspace();
  const role = useSession((s) => s.role);
  const reviewOn = useSession((s) => s.review.required);
  const [saved, setSaved] = useState<TrustPage | null>(null);
  const [form, setForm] = useState<TrustPageInput>(BLANK);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState(false);
  const isOwner = role === "owner";

  useEffect(() => {
    if (!isOwner) return;
    let live = true;
    trustPage().then(
      (page) => {
        if (!live) return;
        setSaved(page);
        if (page) setForm({ enabled: page.enabled, title: page.title, intro: page.intro, contact: page.contact, diagramId: page.diagramId });
        setLoaded(true);
      },
      (e) => live && (setProblem(errorText(e)), setLoaded(true)),
    );
    return () => {
      live = false;
    };
  }, [isOwner]);

  const diagrams = sortedDiagrams(ws);
  const diagramId = form.diagramId && ws.diagrams[form.diagramId] ? form.diagramId : null;
  // The preview is built from the same cut the public page receives, so nothing appears there that is not here.
  const cut = useMemo(() => ({ ...emptyWorkspace(form.title), ...fromTables(withoutDangling(redactForTrust(toTables(ws), diagramId))) }), [ws, diagramId, form.title]);
  if (!isOwner) return null;

  const dirty = !saved || saved.enabled !== form.enabled || saved.title !== form.title.trim() || saved.intro !== form.intro.trim() || saved.contact !== form.contact.trim() || saved.diagramId !== diagramId;
  const save = (enabled: boolean) => {
    setBusy(true);
    setProblem("");
    saveTrustPage({ ...form, enabled, diagramId })
      .then((page) => {
        setSaved(page);
        setForm({ enabled: page.enabled, title: page.title, intro: page.intro, contact: page.contact, diagramId: page.diagramId });
      })
      .catch((e) => setProblem(errorText(e)))
      .finally(() => setBusy(false));
  };
  const url = saved ? trustPageUrl(window.location.origin, saved.token) : "";
  const copy = () =>
    navigator.clipboard.writeText(url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => setProblem("The address could not be copied. Select it and copy it by hand."),
    );

  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4" data-trust-card>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <h2 className="font-semibold">Public trust page</h2>
        <span className={`text-[13px] font-medium ${saved?.enabled ? "text-ok" : "text-ink-soft"}`} data-trust-state>
          {saved?.enabled ? "On: anyone with the address can read it" : "Off"}
        </span>
      </div>
      <p className="text-[13px] text-ink-soft mt-0.5 max-w-2xl">
        A page for customers and auditors that says where personal data is kept, which outside parties receive it and between which regions it moves. It is worked out from the data fields on your objects and changes when the model does.
        {reviewOn ? " Because this workspace requires review, the page shows the approved version." : ""}
      </p>

      {!loaded ? (
        <p className="mt-3 text-ink-soft">Reading the settings</p>
      ) : (
        <div className="mt-4 space-y-3">
          <Field label="Heading">
            <Input value={form.title} maxLength={160} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="For example: How Acme handles your data" data-trust-title />
          </Field>
          <Field label="Opening paragraph" hint="Optional. Shown under the heading.">
            <Textarea rows={3} value={form.intro} maxLength={4000} onChange={(e) => setForm({ ...form, intro: e.target.value })} />
          </Field>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Contact" hint="Optional. An email address or a web address.">
              <Input value={form.contact} maxLength={300} onChange={(e) => setForm({ ...form, contact: e.target.value })} placeholder="privacy@example.com" />
            </Field>
            <Field label="Diagram to show" hint="Optional. Its boxes are shown by name.">
              <Select value={diagramId ?? ""} onChange={(e) => setForm({ ...form, diagramId: e.target.value || null })} data-trust-diagram-choice>
                <option value="">No diagram</option>
                {diagrams.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <p className="text-[13px] text-ink-soft max-w-2xl">
            What leaves the workspace: the names of outside systems connected to personal data, with their region and their "{PUBLIC_PURPOSE_FIELD}" field; the regions of systems that hold personal data, without their names; and the chosen
            diagram's box names and arrow labels. Descriptions, owners, tags, technology and all other fields stay private.
          </p>

          {problem && (
            <p role="alert" className="rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
              {problem}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {saved?.enabled ? (
              <>
                <Button variant="primary" disabled={busy || !dirty || !form.title.trim()} onClick={() => save(true)} data-trust-save>
                  {busy ? "Saving" : "Save changes"}
                </Button>
                <Button disabled={busy} onClick={() => save(false)} data-trust-off>
                  Switch the page off
                </Button>
              </>
            ) : (
              <>
                <Button variant="primary" disabled={busy || !form.title.trim()} onClick={() => save(true)} data-trust-on>
                  {busy ? "Saving" : "Switch the page on"}
                </Button>
                <Button disabled={busy || !dirty} onClick={() => save(false)}>
                  Save without switching on
                </Button>
              </>
            )}
            <Button onClick={() => setPreview((p) => !p)} aria-expanded={preview} data-trust-preview-toggle>
              {preview ? "Hide the preview" : "Preview what it will show"}
            </Button>
          </div>

          {saved?.enabled && (
            <div className="flex flex-wrap items-center gap-2" data-trust-link>
              <Input readOnly value={url} className="!w-auto flex-1 min-w-64 font-mono text-[13px]" onFocus={(e) => e.currentTarget.select()} aria-label="Address of the trust page" />
              <Button size="sm" icon={copied ? <Check size={13} /> : <Copy size={13} />} onClick={copy}>
                {copied ? "Copied" : "Copy address"}
              </Button>
              <a className="inline-flex items-center gap-1 text-[13px] font-medium text-blueprint hover:underline" href={url} target="_blank" rel="noreferrer">
                Open <ExternalLink size={13} aria-hidden />
              </a>
            </div>
          )}

          {preview && (
            <div className="rounded-lg border border-line px-5 py-5" data-trust-preview>
              <p className="text-[13px] text-ink-soft mb-4">{reviewOn ? "Preview of the working model. The public page shows the approved version, which may differ." : "Preview. The public page shows exactly this, under your heading."}</p>
              <TrustContent ws={cut} diagramId={diagramId} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
