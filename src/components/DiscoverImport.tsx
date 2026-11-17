import { Radar } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { useSession } from "@/lib/cloud/session";
import { discover, discoveryStatus } from "@/lib/discover/client";
import type { DiscoverStatus } from "@/lib/discover/http";
import type { Inventory } from "@/lib/inventory";

/**
 * Discovering what is running in a connected cloud account or discovery tool. Shown only when
 * this app's server has credentials for at least one source; they are added in the hosting
 * environment, never in the browser.
 */
export function DiscoverImport({ canEdit, onInventory }: { canEdit: boolean; onInventory: (inventory: Inventory, label: string) => void }) {
  const workspaceId = useSession((s) => s.workspaceId);
  const [status, setStatus] = useState<DiscoverStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    let live = true;
    void discoveryStatus().then((s) => live && setStatus(s));
    return () => {
      live = false;
    };
  }, []);
  const connected = status?.sources.filter((s) => s.configured) ?? [];
  if (!connected.length) return null;

  const run = async (id: string) => {
    setBusy(id);
    setProblem("");
    try {
      const { inventory, label } = await discover(id, workspaceId ?? "");
      if (!inventory.items.length) throw new Error(`${label} reported nothing to draw.`);
      onInventory(inventory, label);
    } catch (error) {
      setProblem(error instanceof Error && error.message ? error.message : "Discovery failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-lg border border-line px-4 py-3.5" data-discover-import>
      <div className="flex items-start gap-3">
        <Radar size={18} className="mt-0.5 shrink-0 text-ink-soft" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">Discover what is running</p>
          <p className="text-[13px] text-ink-soft">
            Asks a connected cloud account or discovery tool for its resources and how they connect, and shows what was found before a draft is made. The connection details stay on this
            app&apos;s server.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {connected.map((source) => (
              <Button key={source.id} size="sm" disabled={!canEdit || !!busy} onClick={() => void run(source.id)} data-discover-source={source.id}>
                {busy === source.id ? `Reading ${source.label}` : source.label}
              </Button>
            ))}
          </div>
          {busy && <p className="mt-1.5 text-[13px] text-ink-soft">This can take up to a minute for a large account.</p>}
          {problem && (
            <p className="mt-1.5 text-[13px] text-danger" role="alert">
              {problem}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
