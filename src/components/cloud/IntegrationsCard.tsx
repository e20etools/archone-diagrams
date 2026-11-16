import { Check, Copy, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Badge, Button, Field, IconButton, Input, Select, formatDate, formatDateTime, useNotice } from "@/components/ui";
import type { ApiKeyInfo, KeyAccess, WebhookInfo } from "@/lib/cloud/backend";
import { useWorkspace } from "@/lib/store";
import { errorText, getBackend, useSession } from "@/lib/cloud/session";

/** A secret shown once, with a way to copy it. */
function Reveal({ title, value, note, onDone }: { title: string; value: string; note: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border border-signal/50 bg-signal-soft px-3.5 py-3" role="status" data-secret>
      <p className="font-medium">{title}</p>
      <div className="mt-1.5 flex gap-2">
        <Input readOnly value={value} className="font-mono !text-[13px]" onFocus={(e) => e.currentTarget.select()} aria-label={title} />
        <Button icon={copied ? <Check size={15} /> : <Copy size={15} />} onClick={() => navigator.clipboard.writeText(value).then(() => setCopied(true), () => setCopied(false))}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="mt-1.5 text-[13px]">{note}</p>
      <Button size="sm" className="mt-2" onClick={onDone}>
        I have saved it
      </Button>
    </div>
  );
}

/** Settings: keys for the REST API, and addresses that are told when the model changes. Owners only. */
const ACCESS_LABEL: Record<KeyAccess, string> = { read: "Read only", propose: "Read and propose", write: "Read and write" };

export function IntegrationsCard() {
  const workspaceId = useSession((s) => s.workspaceId);
  const owner = useSession((s) => s.role === "owner");
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [hooks, setHooks] = useState<WebhookInfo[]>([]);
  const [base, setBase] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [access, setAccess] = useState<KeyAccess>("propose");
  const [limit, setLimit] = useState<string[]>([]);
  const domains = useWorkspace().objects;
  const domainList = Object.values(domains).filter((o) => o.typeId === "domain").sort((a, b) => a.name.localeCompare(b.name));
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState<{ kind: "key" | "webhook"; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const { notify, view: notice } = useNotice();

  const refresh = useCallback(async () => {
    if (!workspaceId || !owner) return;
    const backend = await getBackend();
    setBase(backend.apiBaseUrl());
    const [k, h] = await Promise.all([backend.listApiKeys(workspaceId), backend.listWebhooks(workspaceId)]);
    setKeys(k);
    setHooks(h);
  }, [workspaceId, owner]);
  useEffect(() => {
    void refresh().catch((e) => setProblem(errorText(e)));
  }, [refresh]);

  if (!workspaceId || !owner) return null;
  const run = async (work: (workspace: string) => Promise<void>) => {
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
  const createKey = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    void run(async (ws) => {
      const made = await (await getBackend()).createApiKey(ws, name.trim(), access, access === "write" ? limit : null);
      setSecret({ kind: "key", value: made.key });
      setName("");
      setLimit([]);
    });
  };
  const addHook = (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    void run(async (ws) => {
      const made = await (await getBackend()).createWebhook(ws, url.trim());
      setSecret({ kind: "webhook", value: made.secret });
      setUrl("");
    });
  };
  const active = keys.filter((k) => !k.revokedAt);

  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4" aria-label="API and webhooks">
      <h2 className="text-base font-semibold">API and webhooks</h2>
      <p className="text-ink-soft mt-0.5">Let other systems read and change this workspace's model, and be told when it changes. Only owners see this.</p>

      {secret && (
        <div className="mt-3">
          <Reveal
            title={secret.kind === "key" ? "Your new API key" : "The signing secret of your new webhook"}
            value={secret.value}
            note={
              secret.kind === "key"
                ? "Copy it now. Only a fingerprint is stored, so it cannot be shown again. If it is lost, revoke it and create another."
                : "Copy it now; it is not shown again. Each delivery carries an X-ArchONE-Signature header: sha256= followed by the HMAC-SHA256 of the request body, keyed with this secret."
            }
            onDone={() => setSecret(null)}
          />
        </div>
      )}
      {problem && (
        <p role="alert" className="mt-3 rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
          {problem}
        </p>
      )}

      <h3 className="mt-4 text-sm font-semibold">API keys</h3>
      {base ? (
        <p className="text-[13px] text-ink-soft mt-0.5 break-all">
          The API is at <code className="bg-paper border border-line rounded px-1">{base}</code>. Send a key as <code className="bg-paper border border-line rounded px-1">Authorization: Bearer</code>.{" "}
          <a className="text-blueprint hover:underline" href={`${base}/openapi.json`} target="_blank" rel="noreferrer">
            Read the description (OpenAPI)
          </a>
          <span className="block mt-1" data-mcp-address>
            AI assistants connect with the same keys over MCP at <code className="bg-paper border border-line rounded px-1">{base.replace(/\/api\/v1$/, "/mcp")}</code>. A key that proposes lets an assistant read the model and send changes that
            wait under Review drafts until a person accepts them. A key that writes changes the model at once; each change is recorded in the audit log under the key's name.
          </span>
        </p>
      ) : (
        <p className="text-[13px] text-ink-soft mt-0.5">This trial backend has no API server, so keys made here are for looking at the screen only.</p>
      )}
      {active.length > 0 && (
        <table className="mt-2 w-full text-left">
          <thead className="text-[13px] text-ink-soft border-b border-line">
            <tr>
              <th className="font-medium py-1.5">Key</th>
              <th className="font-medium py-1.5 w-44">Access</th>
              <th className="font-medium py-1.5 w-44">Last used</th>
              <th className="py-1.5 w-10">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {active.map((k) => (
              <tr key={k.id} className="border-b border-line-soft last:border-b-0">
                <td className="py-2">
                  <span className="font-medium">{k.name}</span>
                  <span className="block text-[13px] text-ink-soft font-mono">{k.prefix}…</span>
                </td>
                <td className="py-2">
                  <Badge tone={k.access === "write" ? "amber" : k.access === "propose" ? "blue" : "neutral"}>{ACCESS_LABEL[k.access]}</Badge>
                  {k.domains && (
                    <span className="block mt-1 text-[13px] text-ink-soft" data-key-limit>
                      Only inside: {k.domains.map((d) => domains[d]?.name ?? "a deleted domain").join(", ")}
                    </span>
                  )}
                </td>
                <td className="py-2 text-[13px] text-ink-soft">{k.lastUsedAt ? formatDateTime(k.lastUsedAt) : `Never. Created ${formatDate(k.createdAt)}`}</td>
                <td className="py-2 text-right">
                  <IconButton label={`Revoke the key ${k.name}`} disabled={busy} onClick={() => void run(async (ws) => (await getBackend()).revokeApiKey(ws, k.id)).then(() => notify("Key revoked. It stops working at once."))}>
                    <Trash2 size={15} />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form onSubmit={createKey} className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="Name of a new key" className="flex-1 min-w-52">
          <Input value={name} maxLength={80} placeholder="For example: CMDB sync" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="It may" className="w-56">
          <Select value={access} onChange={(e) => setAccess(e.target.value as KeyAccess)}>
            <option value="read">Read only</option>
            <option value="propose">Read and propose changes</option>
            <option value="write">Read and write directly</option>
          </Select>
        </Field>
        {access === "write" && domainList.length > 0 && (
          <details className="basis-full" data-key-limit-choice>
            <summary className="cursor-pointer text-[13px] text-ink-soft">
              {limit.length ? `Limited to ${limit.length} ${limit.length === 1 ? "domain" : "domains"}` : "Limit this key to some domains (optional)"}
            </summary>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {domainList.map((d) => (
                <label key={d.id} className="inline-flex items-center gap-1.5 text-[13px]">
                  <input type="checkbox" checked={limit.includes(d.id)} onChange={(e) => setLimit((now) => (e.target.checked ? [...now, d.id] : now.filter((x) => x !== d.id)))} />
                  {d.name}
                </label>
              ))}
            </div>
          </details>
        )}
        <Button type="submit" disabled={busy || !name.trim()}>
          Create key
        </Button>
      </form>

      <h3 className="mt-6 text-sm font-semibold">Webhooks</h3>
      <p className="text-[13px] text-ink-soft mt-0.5">
        Each time a change to the model is saved, by a person or through the API, these addresses receive a signed note of which objects, relationships or diagrams changed.
      </p>
      {hooks.length > 0 && (
        <ul className="mt-2 divide-y divide-line-soft border-y border-line-soft">
          {hooks.map((h) => (
            <li key={h.id} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={h.url}>
                {h.url}
              </span>
              <Button size="sm" icon={<Send size={13} />} disabled={busy} onClick={() => void run(async (ws) => (await getBackend()).testWebhook(ws, h.id)).then(() => notify("Test sent. Look for an event named ping at that address."))}>
                Send a test
              </Button>
              <IconButton label={`Delete the webhook ${h.url}`} disabled={busy} onClick={() => void run(async (ws) => (await getBackend()).deleteWebhook(ws, h.id))}>
                <Trash2 size={15} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={addHook} className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="Address of a new webhook" hint="A public https address." className="flex-1 min-w-64">
          <Input value={url} maxLength={2000} placeholder="https://example.com/hooks/archone" onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Button type="submit" disabled={busy || !url.trim()} className="mb-5">
          Add webhook
        </Button>
      </form>
      {notice}
    </section>
  );
}
