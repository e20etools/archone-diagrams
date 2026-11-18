import { Download, Upload } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { IntegrationsCard } from "@/components/cloud/IntegrationsCard";
import { MembersCard } from "@/components/cloud/MembersCard";
import { TrustPageCard } from "@/components/cloud/TrustPageCard";
import { ReviewSettingsCard } from "@/components/cloud/ReviewSettingsCard";
import { ApprovalSettingsCard, InformationBoxSection } from "@/components/approvals/ApprovalSettings";
import { AiFairUseCard } from "@/components/cloud/AiFairUseCard";
import { ConnectedServicesCard } from "@/components/cloud/ConnectedServicesCard";
import { WizardSettingsCard } from "@/components/WizardSettings";
import { AppearanceSection, BrandingSection, MonitoringSection, PermissionsMatrix } from "@/components/SettingsSections";
import { Badge, Button, CommitInput, Field, Input, Modal, countOf, cx, useNotice } from "@/components/ui";
import { cloudEnabled } from "@/lib/cloud/config";
import { deleteCurrentWorkspace, errorText, renameCurrentWorkspace, updateMyName, useCanEdit, useSession } from "@/lib/cloud/session";
import { fetchAiStatus, getAccessCode, setAccessCode, type AiStatus } from "@/lib/ai/client";
import { addEnterpriseSample, hasEnterpriseSample } from "@/lib/enterpriseSample";
import { demoWorkspace } from "@/lib/demo";
import { downloadText, slugify, workspaceJson } from "@/lib/exporters";
import { emptyWorkspace } from "@/lib/model";
import { parseWorkspace } from "@/lib/repository";
import { apply, useStore, useWorkspace } from "@/lib/store";
import type { Workspace } from "@/lib/types";

/** A group of settings with its own place in the index. */
function Group({ id, title, text, children }: { id: string; title: string; text?: string; children: ReactNode }) {
  return (
    <section id={`settings-${id}`} className="scroll-mt-6 space-y-3" aria-labelledby={`settings-${id}-title`} data-settings-group={id}>
      <div>
        <h2 id={`settings-${id}-title`} className="text-lg font-semibold">
          {title}
        </h2>
        {text && <p className="text-[13px] text-ink-soft">{text}</p>}
      </div>
      {children}
    </section>
  );
}

function Card({ title, text, children }: { title?: string; text?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4">
      {title && <h2 className="text-base font-semibold">{title}</h2>}
      {text && <p className="text-ink-soft mt-0.5">{text}</p>}
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

const size = (ws: Workspace) =>
  `${countOf(Object.keys(ws.objects).length, "object")}, ${countOf(Object.keys(ws.relationships).length, "relationship")} and ${countOf(Object.keys(ws.diagrams).length, "diagram")}`;

export function SettingsPage() {
  const ws = useWorkspace();
  const replace = useStore((s) => s.replace);
  const navigate = useNavigate();
  const file = useRef<HTMLInputElement>(null);
  const { notify, view: notice } = useNotice();
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [incoming, setIncoming] = useState<Workspace | null>(null);
  const [confirm, setConfirm] = useState<"demo" | "reset" | null>(null);
  const [error, setError] = useState("");
  const [code, setCode] = useState(getAccessCode);
  const [removing, setRemoving] = useState<{ typed: string; busy: boolean; problem: string } | null>(null);
  const hasContent = Object.keys(ws.objects).length > 0 || Object.keys(ws.diagrams).length > 0;
  const canEdit = useCanEdit();
  const role = useSession((s) => s.role);
  const isOwner = !cloudEnabled || role === "owner";
  const everyone = cloudEnabled ? " for every member of this workspace" : " from this browser";
  const saveName = (userName: string) => {
    if (!cloudEnabled) return apply((w) => ({ ...w, userName: userName.trim() }));
    void updateMyName(userName).then(
      () => notify("Name saved."),
      (e) => notify(errorText(e)),
    );
  };
  const saveWorkspaceName = (name: string) => {
    if (!name.trim()) return;
    if (!cloudEnabled) return apply((w) => ({ ...w, name: name.trim() }));
    void renameCurrentWorkspace(name).then(
      () => notify("Workspace renamed."),
      (e) => notify(errorText(e)),
    );
  };

  const deleteWorkspace = () => {
    setRemoving((r) => r && { ...r, busy: true, problem: "" });
    // On success the workspace list replaces this page, so there is nothing left to update here.
    deleteCurrentWorkspace().then(
      () => navigate("/"),
      (e) => setRemoving((r) => r && { ...r, busy: false, problem: errorText(e) }),
    );
  };

  useEffect(() => {
    let live = true;
    fetchAiStatus().then((status) => live && setAi(status));
    return () => {
      live = false;
    };
  }, []);

  const readBackup = async (chosen: File | undefined) => {
    setError("");
    if (!chosen) return;
    try {
      const raw = JSON.parse(await chosen.text()) as Record<string, unknown>;
      const { format: _format, ...rest } = raw;
      const parsed = parseWorkspace(rest);
      if (!parsed) throw new Error("shape");
      setIncoming(parsed);
    } catch {
      setError(`"${chosen.name}" is not a workspace backup from this application. Choose a .json file made with "Download backup".`);
    }
    if (file.current) file.current.value = "";
  };

  const loadDemo = () => {
    replace(demoWorkspace(ws.userName));
    setConfirm(null);
    navigate("/");
  };

  const sections: { id: string; label: string; show: boolean }[] = [
    { id: "general", label: "You and this workspace", show: true },
    { id: "appearance", label: "Appearance", show: true },
    { id: "branding", label: "Branding", show: true },
    { id: "people", label: "People and permissions", show: cloudEnabled },
    { id: "review", label: "Review and approval", show: cloudEnabled },
    { id: "integrations", label: "Integrations", show: cloudEnabled },
    { id: "ai", label: "AI", show: true },
    { id: "wizard", label: "Diagram wizard", show: true },
    { id: "monitoring", label: "Monitoring and logs", show: true },
    { id: "data", label: "Data, backup and reset", show: true },
  ];
  const shown = sections.filter((x) => x.show);
  const [active, setActive] = useState("general");
  useEffect(() => {
    const seen = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id.replace("settings-", ""));
      },
      { rootMargin: "-10% 0px -70% 0px" },
    );
    for (const x of shown) {
      const el = document.getElementById(`settings-${x.id}`);
      if (el) seen.observe(el);
    }
    return () => seen.disconnect();
  }, [shown.length]);

  return (
    <div className="mx-auto flex max-w-6xl gap-8 px-6 py-7">
      <nav aria-label="Settings sections" className="sticky top-4 hidden h-fit w-56 shrink-0 lg:block" data-settings-index>
        <h1 className="mb-3 text-xl font-semibold">Settings</h1>
        <ul className="space-y-0.5">
          {shown.map((x) => (
            <li key={x.id}>
              <a
                href={`#settings-${x.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(`settings-${x.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                  setActive(x.id);
                }}
                className={cx("block rounded-md px-2.5 py-1.5 text-[13px]", active === x.id ? "bg-blueprint-soft font-medium text-blueprint-deep" : "text-ink-soft hover:bg-surface hover:text-ink")}
              >
                {x.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1 space-y-8">
        <div className="lg:hidden">
          <h1 className="text-xl font-semibold">Settings</h1>
        </div>
        <p className="text-ink-soft -mt-4 lg:mt-0">
          {cloudEnabled
            ? "This workspace is saved to your account as you work, and its members see each other's changes as they happen."
            : "This workspace lives in this browser on this device. Download a backup to move it or keep it safe."}
        </p>

        <Group id="general" title="You and this workspace">
          <Card>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Your name" hint="Recorded as the approver when you accept an AI draft, and shown on shared links.">
                <CommitInput value={ws.userName} onCommit={saveName} placeholder="For example: Sara Ahmed" maxLength={80} />
              </Field>
              <Field label="Workspace name" hint={isOwner ? undefined : "Only an owner can rename the workspace."}>
                <CommitInput value={ws.name} onCommit={saveWorkspaceName} disabled={!isOwner} maxLength={120} />
              </Field>
            </div>
          </Card>
        </Group>

        <Group id="appearance" title="Appearance" text="Ten themes, each with its own colours, font and moving background. What you choose here is yours; it does not change what others see.">
          <Card>
            <AppearanceSection branding={ws.branding?.workspace} />
          </Card>
        </Group>

        <Group id="branding" title="Branding" text="The workspace's name in the menu, its logo, accent colour, and the theme members start with.">
          <Card>
            <BrandingSection canChange={isOwner} />
          </Card>
          <Card title="Information box" text="The box a diagram can show in its corner, on live links, verified copies and exported pictures: company and logo, name, version, who made and changed it, its approvals and its authenticity seal.">
            <InformationBoxSection canChange={isOwner} />
          </Card>
        </Group>

        {cloudEnabled && (
          <Group id="people" title="People and permissions" text="Who is in this workspace, their role, and what each role may do.">
            <MembersCard />
            <Card title="What each role may do">
              <PermissionsMatrix />
            </Card>
          </Group>
        )}
        {cloudEnabled && (
          <Group id="review" title="Review and approval">
            <ApprovalSettingsCard />
            <ReviewSettingsCard />
          </Group>
        )}
        {cloudEnabled && (
          <Group id="integrations" title="Integrations" text="Connect AI providers, clouds, discovery tools, your directory, chat, email, Jira and Confluence; and other tools through the API, webhooks and MCP.">
            <ConnectedServicesCard />
            <IntegrationsCard />
            <TrustPageCard />
          </Group>
        )}

        <Group id="ai" title="AI">
      <Card title="AI drafting" text="AI drafts always wait for your review. The key stays on the server and is never sent to the browser.">
        {ai === null ? (
          <p className="text-ink-soft">Checking the server.</p>
        ) : ai.configured ? (
          <div className="space-y-3">
            <p>
              <Badge tone="green">Connected</Badge>{" "}
              <span className="ml-1" data-ai-engine>
                {ai.visionEngine
                  ? `Text drafts and answers use ${ai.engine}. Pictures are read by ${ai.visionEngine}.`
                  : `Drafts from text and from images use ${ai.engine ?? "the configured model"}.`}
              </span>
            </p>
            {ai.needsCode && (
              <Field label="AI access code" hint="This server only drafts for people who have the code. Ask whoever set it up. It is kept in this browser.">
                <CommitInput
                  type="password"
                  autoComplete="off"
                  className="max-w-xs"
                  value={code}
                  onCommit={(value) => {
                    setAccessCode(value);
                    setCode(value.trim());
                    notify(value.trim() ? "Access code saved." : "Access code removed.");
                  }}
                />
              </Field>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <p>
              <Badge tone="amber">No AI model connected</Badge>
            </p>
            <p className="text-ink-soft">
              Text drafts still work using built-in rules that read plainly stated components and connections. Drafting from an image needs a model. To connect one, set{" "}
              <code className="text-[13px] bg-paper border border-line rounded px-1">AI_PROVIDER</code> and{" "}
              <code className="text-[13px] bg-paper border border-line rounded px-1">AI_API_KEY</code> in the hosting settings and redeploy. The README lists every option.
            </p>
            <p className="text-ink-soft" data-ai-free>
              For training at no cost, create a key at{" "}
              <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className="text-blueprint hover:underline">
                console.groq.com
              </a>{" "}
              and set <code className="text-[13px] bg-paper border border-line rounded px-1">AI_PROVIDER=groq</code>. The default models need no other setting.
            </p>
          </div>
        )}
        <ul className="mt-4 grid gap-2 text-[13px] sm:grid-cols-2" data-ai-features>
          {[
            ["Draft a diagram from text, a picture or your voice", "/ai"],
            ["Ask questions about the architecture", "/ask"],
            ["Review what AI proposed before it enters the model", "/ai"],
            ["Write the architecture document", "/document"],
          ].map(([label, to]) => (
            <li key={label} className="rounded-md border border-line px-3 py-2">
              <a href={to} onClick={(e) => { e.preventDefault(); navigate(to); }} className="text-blueprint hover:underline">
                {label}
              </a>
            </li>
          ))}
        </ul>
      </Card>
          {cloudEnabled ? (
            <AiFairUseCard />
          ) : (
            <Card title="Fair use and limits" text="Limits per person and per workspace apply when people sign in with accounts, because each request is counted against the person who made it. In this browser-only copy, an AI access code keeps others from using the server's key.">
              <p className="text-[13px] text-ink-soft">Set AI_ACCESS_CODE on the server to ask for a code.</p>
            </Card>
          )}
        </Group>

        <Group id="wizard" title="Diagram wizard">
          <WizardSettingsCard />
        </Group>

        <Group id="monitoring" title="Monitoring and logs" text="How big the workspace is, whether everything is saved, what the checks find, and the latest changes.">
          <Card>
            <MonitoringSection />
          </Card>
        </Group>

        <Group id="data" title="Data, backup and reset">
      <Card title="Backup" text={`This workspace holds ${size(ws)}.`}>
        <div className="flex flex-wrap gap-2">
          <Button
            icon={<Download size={15} />}
            onClick={() => {
              downloadText(`${slugify(ws.name) || "workspace"}-backup.json`, workspaceJson(ws), "application/json");
              notify("Backup downloaded.");
            }}
          >
            Download backup
          </Button>
          <Button icon={<Upload size={15} />} disabled={!canEdit} onClick={() => file.current?.click()}>
            Restore from a backup
          </Button>
          <input ref={file} type="file" accept="application/json,.json" className="sr-only" aria-label="Backup file" onChange={(e) => void readBackup(e.target.files?.[0])} />
        </div>
        {error && (
          <p role="alert" className="mt-3 rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
            {error}
          </p>
        )}
      </Card>

      {canEdit && (
        <Card title="Sample model and reset" text={cloudEnabled && !isOwner ? "Only an owner can empty a shared workspace." : undefined}>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!isOwner && hasContent} onClick={() => (hasContent ? setConfirm("demo") : loadDemo())}>
              Load the sample model
            </Button>
            <Button
              data-enterprise-sample
              disabled={hasEnterpriseSample(ws)}
              title={hasEnterpriseSample(ws) ? "The bank sample is already in this workspace." : "Adds ten connected diagrams of a bank to what is here, without removing anything."}
              onClick={() => {
                const result = addEnterpriseSample(ws);
                if (result.added) {
                  apply(() => result.ws);
                  navigate("/map");
                }
              }}
            >
              Add the bank sample (10 diagrams)
            </Button>
            <Button variant="danger" disabled={!hasContent || !isOwner} onClick={() => setConfirm("reset")}>
              Delete everything
            </Button>
          </div>
        </Card>
      )}

      {cloudEnabled && isOwner && (
        <Card
          title="Delete this workspace"
          text="Removes the workspace itself: its model, diagrams and AI drafts, and every member's access to it. To keep the workspace and only empty it, use Delete everything above."
        >
          <Button variant="danger" onClick={() => setRemoving({ typed: "", busy: false, problem: "" })}>
            Delete workspace
          </Button>
        </Card>
      )}
        </Group>
      </div>

      {removing && (
        <Modal
          title={`Delete the workspace "${ws.name}"?`}
          onClose={() => !removing.busy && setRemoving(null)}
          footer={
            <>
              <Button disabled={removing.busy} onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button variant="danger" disabled={removing.busy || removing.typed.trim() !== ws.name.trim()} onClick={deleteWorkspace}>
                {removing.busy ? "Deleting" : "Delete workspace"}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <p>
              {size(ws)} will be removed for every member, and nobody will be able to open this workspace again. This cannot be undone. Download a backup first if you may
              need them.
            </p>
            <Field label="Type the workspace name to confirm" hint={`The name is: ${ws.name}`}>
              <Input
                value={removing.typed}
                autoComplete="off"
                onChange={(e) => setRemoving((r) => r && { ...r, typed: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !removing.busy && removing.typed.trim() === ws.name.trim()) deleteWorkspace();
                }}
              />
            </Field>
            {removing.problem && (
              <p role="alert" className="rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
                {removing.problem}
              </p>
            )}
          </div>
        </Modal>
      )}

      {incoming && (
        <Modal
          title="Replace this workspace with the backup?"
          onClose={() => setIncoming(null)}
          footer={
            <>
              <Button onClick={() => setIncoming(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  replace(incoming);
                  setIncoming(null);
                  notify("Backup restored.");
                }}
              >
                Replace workspace
              </Button>
            </>
          }
        >
          <p>
            The backup "{incoming.name}" holds {size(incoming)}. It replaces what is here now ({size(ws)}){cloudEnabled ? everyone : ""}. This cannot be undone, so download a
            backup of the current workspace first if you may need it.
          </p>
        </Modal>
      )}
      {confirm && (
        <Modal
          title={confirm === "demo" ? "Replace this workspace with the sample model?" : "Delete everything in this workspace?"}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (confirm === "demo") return loadDemo();
                  replace({ ...emptyWorkspace(ws.name), userName: ws.userName });
                  setConfirm(null);
                  notify("Workspace emptied.");
                }}
              >
                {confirm === "demo" ? "Replace workspace" : "Delete everything"}
              </Button>
            </>
          }
        >
          <p>
            {size(ws)} will be removed{everyone}. This cannot be undone. Download a backup first if you may need them.
          </p>
        </Modal>
      )}
      {notice}
    </div>
  );
}
