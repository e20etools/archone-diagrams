import { useState } from "react";
import { DiagramCanvas, type CanvasSelection } from "@/components/canvas/DiagramCanvas";
import { countOf } from "@/components/ui";
import { trustFacts } from "@/lib/trust";
import type { Workspace } from "@/lib/types";

/**
 * The body of the trust page: three statements drawn from the model, and one diagram.
 * Shown to the public on the page itself, and to the owner as a preview before it is switched on.
 */
export function TrustContent({ ws, diagramId }: { ws: Workspace; diagramId: string | null }) {
  const facts = trustFacts(ws);
  const [selection, setSelection] = useState<CanvasSelection>({ objectId: null, edgeId: null });
  const diagram = diagramId ? ws.diagrams[diagramId] : undefined;
  const holding = facts.regions.reduce((n, r) => n + r.systems, 0) + facts.unstated;
  return (
    <div className="space-y-9" data-trust-content>
      <section aria-labelledby="trust-where">
        <h2 id="trust-where" className="text-lg font-semibold">
          Where personal data is kept
        </h2>
        {holding === 0 ? (
          <p className="mt-1.5 text-ink-soft">No system is recorded as holding personal data.</p>
        ) : (
          <>
            <p className="mt-1.5 text-ink-soft">{countOf(holding, "system")} of ours {holding === 1 ? "holds" : "hold"} personal data.</p>
            <ul className="mt-3 divide-y divide-line-soft border-y border-line" data-trust-regions>
              {facts.regions.map((r) => (
                <li key={r.region} className="flex items-baseline justify-between gap-4 py-2.5">
                  <span className="font-medium">{r.region}</span>
                  <span className="text-ink-soft tabular-nums">{countOf(r.systems, "system")}</span>
                </li>
              ))}
              {facts.unstated > 0 && (
                <li className="flex items-baseline justify-between gap-4 py-2.5">
                  <span className="text-ink-soft">Region not yet recorded</span>
                  <span className="text-ink-soft tabular-nums">{countOf(facts.unstated, "system")}</span>
                </li>
              )}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="trust-who">
        <h2 id="trust-who" className="text-lg font-semibold">
          Outside parties that receive personal data
        </h2>
        {facts.processors.length === 0 ? (
          <p className="mt-1.5 text-ink-soft">No outside party is recorded as connected to a system that holds personal data.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left" data-trust-processors>
              <thead>
                <tr className="border-b border-line text-[13px] text-ink-soft">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Party
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    What it does for us
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Region
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {facts.processors.map((p) => (
                  <tr key={p.id}>
                    <th scope="row" className="py-2.5 pr-4 font-medium align-top">
                      {p.name}
                    </th>
                    <td className="py-2.5 pr-4 align-top">{p.purpose || <span className="text-ink-soft">Not stated</span>}</td>
                    <td className="py-2.5 align-top">{p.region || <span className="text-ink-soft">Not stated</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="trust-moves">
        <h2 id="trust-moves" className="text-lg font-semibold">
          Movement between regions
        </h2>
        {facts.transfers.length === 0 ? (
          <p className="mt-1.5 text-ink-soft">No connection is recorded that carries personal data from one region to another.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line-soft border-y border-line" data-trust-transfers>
            {facts.transfers.map((t) => (
              <li key={t.regions.join("|")} className="flex items-baseline justify-between gap-4 py-2.5">
                <span className="font-medium">
                  {t.regions[0]} and {t.regions[1]}
                </span>
                <span className="text-ink-soft tabular-nums">{countOf(t.connections, "connection")}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {diagram && (
        <section aria-labelledby="trust-picture">
          <h2 id="trust-picture" className="text-lg font-semibold">
            {diagram.name}
          </h2>
          <div className="mt-3 h-[440px] rounded-lg border border-line overflow-hidden bg-paper" data-trust-diagram>
            <DiagramCanvas key={diagram.id} ws={ws} diagram={diagram} readOnly selection={selection} onSelect={setSelection} />
          </div>
        </section>
      )}
    </div>
  );
}
