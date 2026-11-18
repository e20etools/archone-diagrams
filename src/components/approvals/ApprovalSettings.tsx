import { ImageUp, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Input, useNotice } from "@/components/ui";
import { FIELD_LABEL, ROLE_LABEL, type ApprovalRole, type ApprovalSettings } from "@/lib/approvals";
import { personLabel } from "@/lib/cloud/collab";
import { approvalStep, errorText, getBackend, useSession } from "@/lib/cloud/session";
import { nowIso } from "@/lib/model";
import { apply, useWorkspace } from "@/lib/store";
import { TITLE_BLOCK_FIELD_IDS, type Branding } from "@/lib/types";
import { readLogoFile } from "./TitleBlockSettings";

/** Settings: who approves diagrams for Enterprise Architecture and for Cybersecurity, and whether that comes before publishing. */
export function ApprovalSettingsCard() {
  const workspaceId = useSession((s) => s.workspaceId);
  const people = useSession((s) => s.people);
  const owner = useSession((s) => s.role) === "owner";
  const [settings, setSettings] = useState<ApprovalSettings | null>(null);
  const [required, setRequired] = useState(false);
  const [chosen, setChosen] = useState<Record<ApprovalRole, string[]>>({ ea: [], security: [] });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const { notify, view: notice } = useNotice();
  const take = (next: ApprovalSettings) => {
    setSettings(next);
    setRequired(next.required);
    setChosen({ ea: next.ea.map((a) => a.id), security: next.security.map((a) => a.id) });
  };
  useEffect(() => {
    if (!workspaceId) return;
    void getBackend()
      .then((b) => b.approvalSettings(workspaceId))
      .then(take, (e) => setProblem(errorText(e)));
  }, [workspaceId]);

  const toggle = (role: ApprovalRole, userId: string) => setChosen((c) => ({ ...c, [role]: c[role].includes(userId) ? c[role].filter((u) => u !== userId) : [...c[role], userId] }));
  const changed = !!settings && (required !== settings.required || (["ea", "security"] as const).some((r) => [...chosen[r]].sort().join() !== settings[r].map((a) => a.id).sort().join()));
  const save = () => {
    setBusy(true);
    setProblem("");
    approvalStep((backend, ws) => backend.setApprovalSettings(ws, required, chosen.ea, chosen.security)).then(
      (next) => {
        take(next);
        setBusy(false);
        notify(next.required ? "Diagrams now need both approvals before they are published." : "Approval settings saved.");
      },
      (e) => {
        setBusy(false);
        setProblem(errorText(e));
      },
    );
  };

  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4" aria-label="Diagram approval" data-approval-settings>
      <h2 className="text-base font-semibold">
        Diagram approval by EA and Cybersecurity{" "}
        {settings && <Badge tone={settings.required ? "green" : "neutral"}>{settings.required ? "Required before publishing" : "Optional"}</Badge>}
      </h2>
      <p className="text-ink-soft mt-0.5">
        An editor sends a diagram for approval. Each role approves it, changes and approves it, returns it with notes to fix, or rejects it. Once both approve, it becomes a new
        version. Any change afterwards needs approving again.
      </p>
      {!settings ? (
        <p className={problem ? "mt-3 text-danger" : "mt-3 text-ink-soft"}>{problem || "Reading the settings."}</p>
      ) : (
        <fieldset disabled={!owner || busy} className="mt-4 space-y-4">
          {!owner && <p className="text-[13px] text-ink-soft">Only an owner can change who approves diagrams.</p>}
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" className="accent-blueprint mt-1" checked={required} onChange={(e) => setRequired(e.target.checked)} data-approval-required />
            <span>
              <span className="font-medium">Approval comes before publishing</span>
              <span className="block text-[13px] text-ink-soft">Live links and verified copies then show only the last version both roles approved; an unapproved diagram is not published.</span>
            </span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            {(["ea", "security"] as const).map((role) => (
              <div key={role} data-approvers={role}>
                <h3 className="text-sm font-medium">{ROLE_LABEL[role]} approvers</h3>
                <ul className="mt-1.5 max-h-56 overflow-y-auto space-y-1 rounded-md border border-line px-2.5 py-2">
                  {people.map((p) => (
                    <li key={p.userId}>
                      <label className="flex items-center gap-2 text-[13px] cursor-pointer">
                        <input type="checkbox" className="accent-blueprint" checked={chosen[role].includes(p.userId)} onChange={() => toggle(role, p.userId)} data-approver={p.email} />
                        {personLabel(p)}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {problem && (
            <p role="alert" className="rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
              {problem}
            </p>
          )}
          {owner && (
            <Button variant="primary" disabled={!changed || busy} onClick={save} data-approval-save>
              Save approval settings
            </Button>
          )}
        </fieldset>
      )}
      {notice}
    </section>
  );
}

/** Settings: the company every information box names, and what every box must show. */
export function InformationBoxSection({ canChange }: { canChange: boolean }) {
  const ws = useWorkspace();
  const current = ws.branding?.workspace;
  const [company, setCompany] = useState(current?.company ?? "");
  const [logo, setLogo] = useState(current?.companyLogo ?? "");
  const [boxRequired, setBoxRequired] = useState(!!current?.boxRequired);
  const [fields, setFields] = useState<string[]>(current?.boxFields ?? []);
  const [problem, setProblem] = useState("");
  const [saved, setSaved] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setCompany(current?.company ?? "");
    setLogo(current?.companyLogo ?? "");
    setBoxRequired(!!current?.boxRequired);
    setFields(current?.boxFields ?? []);
  }, [current?.updatedAt]);
  const save = () => {
    const branding: Branding = {
      ...(current ?? { appName: "", logo: "", accent: "", theme: "blueprint", font: "" }),
      id: "workspace",
      company: company.trim().slice(0, 120),
      companyLogo: logo,
      boxRequired,
      boxFields: TITLE_BLOCK_FIELD_IDS.filter((f) => fields.includes(f)),
      updatedAt: nowIso(),
    };
    apply((w) => ({ ...w, branding: { workspace: branding }, updatedAt: nowIso() }));
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };
  return (
    <div className="space-y-4" data-settings-information-box>
      {!canChange && <p className="text-[13px] text-ink-soft">Only an owner can change these.</p>}
      <fieldset disabled={!canChange} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs text-ink-soft">Company named in every box</span>
            <Input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={120} placeholder={ws.name} aria-label="Company" data-box-company />
          </label>
          <div>
            <span className="mb-1 block text-xs text-ink-soft">Company logo</span>
            <div className="flex items-center gap-2">
              <span className="grid size-10 place-items-center rounded-md border border-line bg-paper">{logo ? <img src={logo} alt="The company logo" className="size-8 object-contain" /> : <ImageUp size={16} className="text-ink-faint" />}</span>
              <Button size="sm" icon={<ImageUp size={13} />} onClick={() => file.current?.click()}>
                {logo ? "Change" : "Upload a logo"}
              </Button>
              {logo && (
                <Button size="sm" icon={<Trash2 size={13} />} onClick={() => setLogo("")}>
                  Remove
                </Button>
              )}
              <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" className="sr-only" aria-label="Company logo image" data-box-logo-input onChange={(e) => readLogoFile(e.target.files?.[0], setLogo, setProblem)} />
            </div>
          </div>
        </div>
        <label className="flex items-start gap-2 cursor-pointer">
          <input type="checkbox" className="accent-blueprint mt-1" checked={boxRequired} onChange={(e) => setBoxRequired(e.target.checked)} data-box-required />
          <span>
            <span className="text-sm font-medium">Every diagram shows its information box</span>
            <span className="block text-[13px] text-ink-soft">Otherwise each diagram chooses, in its settings.</span>
          </span>
        </label>
        <div>
          <span className="block text-sm font-medium">Required fields</span>
          <span className="block text-[13px] text-ink-soft">A diagram can hide any other field of its box, but not these.</span>
          <ul className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-3 lg:grid-cols-5">
            {TITLE_BLOCK_FIELD_IDS.map((f) => (
              <li key={f}>
                <label className="flex items-center gap-1.5 text-[13px] cursor-pointer">
                  <input type="checkbox" className="accent-blueprint" checked={fields.includes(f)} onChange={(e) => setFields((list) => (e.target.checked ? [...list, f] : list.filter((x) => x !== f)))} data-box-field-required={f} />
                  {FIELD_LABEL[f]}
                </label>
              </li>
            ))}
          </ul>
        </div>
      </fieldset>
      {problem && (
        <p role="alert" className="text-[13px] text-danger">
          {problem}
        </p>
      )}
      {canChange && (
        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={save} data-box-save>
            Save
          </Button>
          {saved && (
            <span role="status" className="text-[13px] text-ok">
              Saved.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
