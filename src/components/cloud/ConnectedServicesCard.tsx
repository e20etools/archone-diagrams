import { ExternalLink, KeyRound, PlugZap } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge, Button, Field, Input, Modal, Select, Textarea, formatDateTime } from "@/components/ui";
import { errorText, getBackend, useSession } from "@/lib/cloud/session";
import { AI_PROVIDERS, INTEGRATIONS, INTEGRATION_GROUPS, aiProviderOf, fieldShown, missingFields, splitFields, type IntegrationDef, type IntegrationInfo } from "@/lib/integrations/catalog";
import { callIntegration, refreshIntegrations, useIntegrations } from "@/lib/integrations/client";

/**
 * Settings → Integrations: the outside services this workspace connects to. Owners connect them;
 * keys, passwords and tokens are kept encrypted in the database and never shown again. Owners and
 * editors can test a connection. Everything else in the app offers a service once it is connected.
 */
export function ConnectedServicesCard() {
  const role = useSession((s) => s.role);
  const owner = role === "owner";
  const editor = owner || role === "editor";
  const { list, loaded } = useIntegrations();
  const [editing, setEditing] = useState<IntegrationDef | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Kept until the next one: a test's answer can be long enough to need reading.
  const [notice, show] = useState("");
  const byId = useMemo(() => new Map(list.map((i) => [i.provider, i])), [list]);

  const test = async (def: IntegrationDef) => {
    setBusy(def.id);
    try {
      const answer = await callIntegration<{ message?: string }>(def.id, "test");
      show(answer.message ?? `${def.label} is connected.`);
    } catch (error) {
      show(errorText(error));
    } finally {
      setBusy(null);
    }
  };
  const sendTest = async (def: IntegrationDef) => {
    setBusy(def.id);
    try {
      const answer = await callIntegration<{ sent: { ok: boolean; message: string }[] }>(def.id, "notify", { event: "test", appUrl: window.location.origin });
      show(answer.sent[0]?.ok ? `A test message was sent through ${def.label}.` : (answer.sent[0]?.message ?? "Nothing was sent."));
    } catch (error) {
      show(errorText(error));
    } finally {
      setBusy(null);
      void refreshIntegrations();
    }
  };
  const toggle = async (def: IntegrationDef, info: IntegrationInfo) => {
    const workspaceId = useSession.getState().workspaceId;
    if (!workspaceId) return;
    try {
      await (await getBackend()).saveIntegration(workspaceId, def.id, info.settings, {}, !info.enabled);
      await refreshIntegrations();
    } catch (error) {
      show(errorText(error));
    }
  };

  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4" data-connected-services>
      <h2 className="text-base font-semibold">Connected services</h2>
      <p className="mt-0.5 text-[13px] text-ink-soft">
        Connect the tools your organisation already uses. {owner ? "You add the keys here;" : "Owners add the keys;"} they are kept encrypted in this workspace&apos;s database and are never shown
        again, and nothing has to be set up on the hosting.
      </p>
      {notice && (
        <p className="mt-2 rounded-md bg-blueprint-soft px-3 py-2 text-[13px] text-blueprint-deep" role="status" data-integration-notice>
          {notice}
        </p>
      )}
      {!loaded ? (
        <p className="mt-3 text-ink-soft">Loading.</p>
      ) : (
        <div className="mt-3 space-y-4">
          {INTEGRATION_GROUPS.map((group) => (
            <div key={group}>
              <h3 className="mb-1.5 text-[13px] font-semibold text-ink-soft">{group}</h3>
              <ul className="divide-y divide-line rounded-md border border-line">
                {INTEGRATIONS.filter((d) => d.group === group).map((def) => {
                  const info = byId.get(def.id);
                  const detail = def.id === "ai" && info?.settings.provider ? `${aiProviderOf(info.settings.provider)?.label ?? info.settings.provider}${info.settings.model ? ` · ${info.settings.model}` : ""}` : "";
                  return (
                    <li key={def.id} className="flex flex-wrap items-start gap-3 px-3 py-2.5" data-integration={def.id}>
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{def.label}</span>
                          <StatusBadge info={info} />
                          {detail && <span className="text-[13px] text-ink-soft">{detail}</span>}
                        </p>
                        <p className="text-[13px] text-ink-soft">{def.what}</p>
                        {info && info.status !== "untested" && info.statusMessage && (
                          <p className={info.status === "failed" ? "text-[13px] text-danger" : "text-[13px] text-ink-soft"} data-integration-status>
                            {info.statusMessage}
                            {info.checkedAt ? ` (${formatDateTime(info.checkedAt)})` : ""}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-1.5">
                        {info && editor && (
                          <Button size="sm" disabled={busy === def.id || !info.enabled} onClick={() => void (def.use === "notify" ? sendTest(def) : test(def))} data-integration-test>
                            {busy === def.id ? "Testing" : def.use === "notify" ? "Send a test" : "Test"}
                          </Button>
                        )}
                        {info && owner && (
                          <Button size="sm" onClick={() => void toggle(def, info)} data-integration-toggle>
                            {info.enabled ? "Turn off" : "Turn on"}
                          </Button>
                        )}
                        {owner && (
                          <Button size="sm" variant={info ? "secondary" : "primary"} icon={info ? undefined : <PlugZap size={14} />} onClick={() => setEditing(def)} data-integration-edit>
                            {info ? "Edit" : "Connect"}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
      {editing && <IntegrationForm def={editing} info={byId.get(editing.id)} onClose={() => setEditing(null)} onSaved={(text) => show(text)} />}
    </section>
  );
}

function StatusBadge({ info }: { info: IntegrationInfo | undefined }) {
  if (!info) return <Badge>Not connected</Badge>;
  if (!info.enabled) return <Badge tone="amber">Turned off</Badge>;
  if (info.status === "failed") return <Badge tone="red">Failed</Badge>;
  if (info.status === "ok") return <Badge tone="green">Connected</Badge>;
  return <Badge tone="blue">Saved, not tested</Badge>;
}

/** Connecting or editing one service. Secrets already kept are shown as kept, never their values. */
function IntegrationForm({ def, info, onClose, onSaved }: { def: IntegrationDef; info: IntegrationInfo | undefined; onClose: () => void; onSaved: (text: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(info?.settings ?? {}), ...(def.id === "ai" && !info ? { provider: "groq" } : {}), ...(def.id === "email" && !info ? { service: "resend" } : {}) }));
  const [cleared, setCleared] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [confirming, setConfirming] = useState(false);
  const kept = (info?.secretFields ?? []).filter((k) => !cleared.includes(k));
  const missing = missingFields(def.id, values, kept);
  const provider = def.id === "ai" ? aiProviderOf(values.provider) : undefined;
  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));

  const save = async (andTest: boolean) => {
    const workspaceId = useSession.getState().workspaceId;
    if (!workspaceId) return;
    setBusy(true);
    setProblem("");
    try {
      const { settings, secrets } = splitFields(def.id, values);
      const sent: Record<string, string | null> = { ...secrets };
      for (const k of cleared) if (!(k in sent)) sent[k] = null;
      // Secrets of fields that no longer apply (a Mailgun domain after choosing Resend) are dropped.
      for (const f of def.fields) if (f.secret && !fieldShown(f, values) && kept.includes(f.key)) sent[f.key] = null;
      await (await getBackend()).saveIntegration(workspaceId, def.id, settings, sent, info?.enabled ?? true);
      await refreshIntegrations();
      let text = `${def.label} is saved.`;
      if (andTest) {
        try {
          const answer = await callIntegration<{ message?: string; sent?: { ok: boolean; message: string }[] }>(def.id, def.use === "notify" ? "notify" : "test", def.use === "notify" ? { event: "test", appUrl: window.location.origin } : {});
          text = answer.sent ? (answer.sent[0]?.ok ? `${def.label} is saved, and a test message was sent.` : `${def.label} is saved, but the test failed: ${answer.sent[0]?.message ?? "nothing was sent"}`) : (answer.message ?? text);
        } catch (error) {
          text = `${def.label} is saved, but the test failed: ${errorText(error)}`;
        }
      }
      onSaved(text);
      onClose();
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const loadModels = async () => {
    setBusy(true);
    setProblem("");
    try {
      setModels((await callIntegration<{ models: string[] }>("ai", "models")).models);
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const workspaceId = useSession.getState().workspaceId;
    if (!workspaceId) return;
    // Asked in the window itself: the first click arms the button, the second removes.
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    try {
      await (await getBackend()).removeIntegration(workspaceId, def.id);
      await refreshIntegrations();
      onSaved(`${def.label} was removed.`);
      onClose();
    } catch (error) {
      setProblem(errorText(error));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={info ? `${def.label} settings` : `Connect ${def.label}`}
      width={600}
      onClose={onClose}
      footer={
        <>
          {info && (
            <Button variant="danger" className="mr-auto" disabled={busy} onClick={() => void remove()} data-integration-remove title={confirming ? "Its keys are deleted, and it stops working until it is connected again." : undefined}>
              {confirming ? "Remove it and its keys" : "Remove"}
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button disabled={busy || missing.length > 0} onClick={() => void save(false)} data-integration-save>
            Save
          </Button>
          <Button variant="primary" disabled={busy || missing.length > 0} onClick={() => void save(true)} data-integration-save-test>
            {busy ? "Working" : "Save and test"}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-integration-form={def.id}>
        <p className="text-[13px] text-ink-soft">
          {def.what} <span className="font-medium text-ink">Access to give it:</span> {def.access}
        </p>
        {def.id === "ai" && (
          <div className="grid gap-1.5 sm:grid-cols-2" role="radiogroup" aria-label="AI providers" data-ai-providers>
            {AI_PROVIDERS.map((p) => (
              <label key={p.id} className={`flex cursor-pointer gap-2 rounded-md border px-2.5 py-2 text-[13px] ${values.provider === p.id ? "border-blueprint bg-blueprint-soft/50" : "border-line"} ${p.paid ? "sm:col-span-2" : ""}`}>
                <input
                  type="radio"
                  name="ai-provider"
                  className="mt-0.5"
                  checked={values.provider === p.id}
                  onChange={() => setValues((v) => ({ ...v, provider: p.id, model: "", visionModel: "", reasoningEffort: p.efforts ? "low" : "" }))}
                  data-ai-provider={p.id}
                />
                <span>
                  <span className="font-medium">{p.label}</span> {p.paid ? <Badge tone="amber">Paid</Badge> : <Badge tone="green">Free plan</Badge>}
                  <span className="block text-ink-soft">{p.free}</span>
                </span>
              </label>
            ))}
          </div>
        )}
        {provider?.picks && (
          <fieldset className="space-y-1.5" data-ai-model-picks>
            <legend className="mb-1 text-xs text-ink-soft">Model: one of the newest, or type another below</legend>
            {provider.picks.map((m) => {
              const chosen = (values.model || provider.model) === m.id;
              return (
                <label key={m.id} className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 text-[13px] ${chosen ? "border-blueprint bg-blueprint-soft/50" : "border-line"}`}>
                  <input type="radio" name="ai-model" className="mt-0.5" checked={chosen} onChange={() => setValues((v) => ({ ...v, model: m.id, visionModel: "" }))} data-ai-model={m.id} />
                  <span>
                    <span className="font-medium">{m.label}</span> <code className="text-[12px] text-ink-soft">{m.id}</code>
                    {m.id === provider.model && <span className="ml-1 text-xs text-ink-faint">suggested</span>}
                    <span className="block text-ink-soft">{m.note}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}
        {provider && (
          <p className="text-[13px]">
            <a href={provider.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blueprint underline">
              Get a {provider.label} key <ExternalLink size={12} aria-hidden />
            </a>
          </p>
        )}
        {def.fields
          .filter((f) => fieldShown(f, values) && !(def.id === "ai" && f.key === "provider"))
          .map((f) => {
            const isKept = !!f.secret && kept.includes(f.key);
            const placeholder = isKept ? "Kept. Leave empty to keep it." : f.key === "model" && provider ? provider.model : f.key === "visionModel" && provider?.visionModel ? provider.visionModel : f.placeholder;
            return (
              <Field key={f.key} label={`${f.label}${f.required ? "" : " (optional)"}`} hint={f.hint}>
                {f.options ? (
                  <Select value={values[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} data-integration-field={f.key}>
                    {!f.required && <option value="">Not set</option>}
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                ) : f.multiline ? (
                  <Textarea rows={f.secret ? 4 : 3} value={values[f.key] ?? ""} placeholder={placeholder} onChange={(e) => set(f.key, e.target.value)} spellCheck={false} data-integration-field={f.key} className={f.secret ? "font-mono !text-[12px]" : undefined} />
                ) : (
                  <div className="flex gap-2">
                    <Input
                      type={f.secret ? "password" : "text"}
                      autoComplete={f.secret ? "new-password" : "off"}
                      value={values[f.key] ?? ""}
                      placeholder={placeholder}
                      onChange={(e) => set(f.key, e.target.value)}
                      list={f.key === "model" || f.key === "visionModel" ? "integration-models" : undefined}
                      data-integration-field={f.key}
                    />
                    {isKept && !f.required && (
                      <Button size="sm" onClick={() => setCleared((c) => [...c, f.key])}>
                        Forget
                      </Button>
                    )}
                    {f.key === "model" && info?.secretFields.includes("apiKey") && (
                      <Button size="sm" disabled={busy} onClick={() => void loadModels()} data-load-models>
                        Load models
                      </Button>
                    )}
                  </div>
                )}
              </Field>
            );
          })}
        <datalist id="integration-models">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {models.length > 0 && <p className="text-[13px] text-ink-soft">{models.length} models are available with this key; start typing in the model field to choose one.</p>}
        {missing.length > 0 && (
          <p className="text-[13px] text-ink-soft" data-integration-missing>
            Still needed: {missing.map((f) => f.label).join(", ")}.
          </p>
        )}
        <p className="flex items-center gap-1.5 text-[13px] text-ink-soft">
          <KeyRound size={13} aria-hidden /> Keys and passwords are encrypted in the database. This form never shows them again.
        </p>
        {problem && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {problem}
          </p>
        )}
      </div>
    </Modal>
  );
}
