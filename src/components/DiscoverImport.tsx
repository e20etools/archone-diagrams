import { FolderGit2, Radar, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Field, Input } from "@/components/ui";
import { saveProposal } from "@/lib/ai/proposals";
import { errorText, useSession } from "@/lib/cloud/session";
import { discover, discoveryStatus } from "@/lib/discover/client";
import type { RawDiscovery } from "@/lib/discover/fetchers";
import type { DiscoverStatus } from "@/lib/discover/http";
import { parseDiscovery } from "@/lib/discover/parse";
import { integrationOf, type IntegrationId } from "@/lib/integrations/catalog";
import { callIntegration, useConnected } from "@/lib/integrations/client";
import type { DirectoryGroup, DirectoryPerson } from "@/lib/integrations/connectors";
import { directoryToProposal } from "@/lib/integrations/drafts";
import { readRepositoryFiles, type Inventory } from "@/lib/inventory";
import { apply, useWorkspace } from "@/lib/store";

/**
 * Imports from connected services: what a cloud account or discovery tool reports (connected in
 * Settings → Integrations, or on the server), infrastructure as code in a GitHub repository, and
 * people and groups from the directory. Shown only for what is connected.
 */
export function DiscoverImport({ canEdit, onInventory, onDone }: { canEdit: boolean; onInventory: (inventory: Inventory, label: string, kind: "iac" | "discovery") => void; onDone: () => void }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const workspaceId = useSession((s) => s.workspaceId);
  const [status, setStatus] = useState<DiscoverStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const sources = useConnected("discover");
  const repos = useConnected("repository");
  const directories = useConnected("directory");
  const [repo, setRepo] = useState({ repository: "", path: "", ref: "" });

  useEffect(() => {
    let live = true;
    void discoveryStatus().then((s) => live && setStatus(s));
    return () => {
      live = false;
    };
  }, []);
  const github = repos[0];
  useEffect(() => {
    if (github?.settings.repository) setRepo((r) => (r.repository ? r : { ...r, repository: github.settings.repository }));
  }, [github?.settings.repository]);

  // A source connected in the workspace is used before the same source set up on the server.
  const fromWorkspace = new Set(sources.map((s) => s.provider as string));
  const fromServer = (status?.sources ?? []).filter((s) => s.configured && !fromWorkspace.has(s.id));
  if (!sources.length && !fromServer.length && !repos.length && !directories.length) return null;

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setProblem("");
    try {
      await work();
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(null);
    }
  };
  const fromIntegration = (id: IntegrationId) =>
    run(id, async () => {
      const { raw } = await callIntegration<{ raw: RawDiscovery }>(id, "discover");
      const inventory = parseDiscovery(raw);
      if (!inventory.items.length) throw new Error(`${raw.label} reported nothing to draw.`);
      onInventory(inventory, raw.label, "discovery");
    });
  const fromServerSource = (id: string) =>
    run(id, async () => {
      const { inventory, label } = await discover(id, workspaceId ?? "");
      if (!inventory.items.length) throw new Error(`${label} reported nothing to draw.`);
      onInventory(inventory, label, "discovery");
    });
  const fromRepository = () =>
    run("github", async () => {
      const answer = await callIntegration<{ repository: string; ref: string; path: string; files: { path: string; text: string }[]; notes: string[] }>("github", "repository", repo);
      const title = `${answer.repository}${answer.path ? `/${answer.path}` : ""} (${answer.ref})`;
      const inventory = readRepositoryFiles(answer.files, title);
      onInventory({ ...inventory, skipped: [...inventory.skipped, ...answer.notes] }, title, "iac");
    });
  const fromDirectory = (id: IntegrationId) =>
    run(id, async () => {
      const directory = await callIntegration<{ people: DirectoryPerson[]; groups: DirectoryGroup[] }>(id, "directory");
      const proposal = directoryToProposal(ws, directory, integrationOf(id)?.label ?? id);
      apply((w) => saveProposal(w, proposal));
      onDone();
      navigate(`/ai/${proposal.id}`);
    });

  return (
    <section className="space-y-3 rounded-lg border border-line px-4 py-3.5" data-discover-import>
      {(sources.length > 0 || fromServer.length > 0) && (
        <div className="flex items-start gap-3">
          <Radar size={18} className="mt-0.5 shrink-0 text-ink-soft" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Discover what is running</p>
            <p className="text-[13px] text-ink-soft">Asks a connected cloud account or discovery tool for its resources and how they connect, and shows what was found before a draft is made.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {sources.map((s) => (
                <Button key={s.provider} size="sm" disabled={!canEdit || !!busy} onClick={() => void fromIntegration(s.provider)} data-discover-source={s.provider}>
                  {busy === s.provider ? "Reading" : (integrationOf(s.provider)?.label ?? s.provider)}
                </Button>
              ))}
              {fromServer.map((s) => (
                <Button key={s.id} size="sm" disabled={!canEdit || !!busy} onClick={() => void fromServerSource(s.id)} data-discover-source={s.id}>
                  {busy === s.id ? `Reading ${s.label}` : s.label}
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}
      {github && (
        <div className="flex items-start gap-3" data-repository-import>
          <FolderGit2 size={18} className="mt-0.5 shrink-0 text-ink-soft" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">From a GitHub repository</p>
            <p className="text-[13px] text-ink-soft">Reads the Terraform, CloudFormation, Bicep, Kubernetes and Compose files under a folder, together.</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-[1.4fr_1fr_0.8fr]">
              <Field label="Repository">
                <Input value={repo.repository} placeholder="owner/name" onChange={(e) => setRepo({ ...repo, repository: e.target.value })} data-repository-name />
              </Field>
              <Field label="Folder">
                <Input value={repo.path} placeholder="infra/prod" onChange={(e) => setRepo({ ...repo, path: e.target.value })} data-repository-path />
              </Field>
              <Field label="Branch">
                <Input value={repo.ref} placeholder="default" onChange={(e) => setRepo({ ...repo, ref: e.target.value })} />
              </Field>
            </div>
            <Button size="sm" className="mt-2" disabled={!canEdit || !!busy || !repo.repository.trim()} onClick={() => void fromRepository()} data-repository-read>
              {busy === "github" ? "Reading the repository" : "Read the repository"}
            </Button>
          </div>
        </div>
      )}
      {directories.length > 0 && (
        <div className="flex items-start gap-3" data-directory-import>
          <Users size={18} className="mt-0.5 shrink-0 text-ink-soft" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">People and teams from the directory</p>
            <p className="text-[13px] text-ink-soft">Makes a draft of the directory&apos;s groups and people, to accept those who own or use what you model.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {directories.map((d) => (
                <Button key={d.provider} size="sm" disabled={!canEdit || !!busy} onClick={() => void fromDirectory(d.provider)} data-directory-source={d.provider}>
                  {busy === d.provider ? "Reading the directory" : (integrationOf(d.provider)?.label ?? d.provider)}
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}
      {busy && <p className="text-[13px] text-ink-soft">This can take up to a minute for a large account.</p>}
      {problem && (
        <p className="text-[13px] text-danger" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
