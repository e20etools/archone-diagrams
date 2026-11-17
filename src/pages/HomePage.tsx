import { Plus } from "lucide-react";
import { BuildButtons, StartModel, useBuildDialogs } from "@/components/DiagramBuild";
import { HomeOverview } from "@/components/HomeOverview";
import { Button, EmptyState } from "@/components/ui";
import { sortedDiagrams } from "@/lib/model";
import { useWorkspace } from "@/lib/store";

/** A greeting by the time of day, with the person's first name when known. */
function greeting(name: string): string {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const first = name.trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

/**
 * The start page: what to look at first in this model, the diagrams changed last, and the
 * ways to begin a new one. Every diagram is listed on the Diagrams page.
 */
export function HomePage() {
  const ws = useWorkspace();
  const { open, dialogs } = useBuildDialogs(ws);
  const diagrams = sortedDiagrams(ws);
  const blank = diagrams.length === 0 && Object.keys(ws.objects).length === 0;

  return (
    <div className="max-w-6xl mx-auto px-6 py-7">
      <div className="home-hero flex flex-wrap items-end justify-between gap-4">
        <div>
          {!blank && <p className="text-[13px] font-medium text-blueprint">{greeting(ws.userName)}</p>}
          <h1 className={blank ? "text-xl font-semibold" : "text-3xl font-semibold tracking-tight"}>{blank ? "Diagrams" : ws.name}</h1>
          <p className="text-ink-soft mt-0.5">Each diagram is a view of one shared model. Change a component once and every diagram follows.</p>
        </div>
        {!blank && <BuildButtons onOpen={open} />}
      </div>

      {blank ? (
        <StartModel ws={ws} onOpen={open} />
      ) : diagrams.length === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed border-ink-faint bg-surface">
          <EmptyState title="No diagrams yet" text="The model has objects, but nothing draws them. Create a diagram to see them.">
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => open("new")}>
              New diagram
            </Button>
          </EmptyState>
        </div>
      ) : (
        <HomeOverview ws={ws} diagrams={diagrams} />
      )}
      {dialogs}
    </div>
  );
}
