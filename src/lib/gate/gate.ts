import { mayConnect, type Verdict } from "../mcp/mayConnect";

/**
 * The gate for a pull request: a repository says which systems its code connects to, and the
 * gate asks the architecture model about each one, with the same rules may_connect uses.
 *
 * It checks a declaration, not the code. A connection the code makes and the file does not
 * declare is not seen; keeping the file true is the repository's job.
 */

export interface Declaration {
  /** The system this repository is, by id or exact name in the model. */
  system: string;
  connections: { to: string; protocol?: string; kind?: string; why?: string }[];
}

export interface GateRow {
  system: string;
  to: string;
  protocol: string;
  answer: Verdict["answer"];
  summary: string;
  /** Both ends are in the model and nothing forbids the connection: it can be proposed. */
  proposable: { sourceId: string; targetId: string; kind: string; protocol: string } | null;
}
export interface GateReport {
  rows: GateRow[];
  counts: { yes: number; no: number; unknown: number };
  /** True when the pull request should not go in as it stands. */
  failed: boolean;
  problems: string[];
}

const KINDS = ["calls", "depends_on", "reads_writes", "hosted_on", "routes_to", "replicates_to", "flows_to"];

/** Reads the declaration file: one declaration, or several under "systems". Says what is wrong with it in plain words. */
export function readDeclarations(text: string): { declarations: Declaration[]; problems: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { declarations: [], problems: ["The declaration file is not valid JSON."] };
  }
  const list = Array.isArray((parsed as { systems?: unknown })?.systems) ? (parsed as { systems: unknown[] }).systems : [parsed];
  const declarations: Declaration[] = [];
  const problems: string[] = [];
  list.forEach((entry, i) => {
    const item = (entry ?? {}) as { system?: unknown; connections?: unknown };
    const where = list.length > 1 ? `systems[${i}]` : "The file";
    if (typeof item.system !== "string" || !item.system.trim()) return void problems.push(`${where} needs "system": the name or id of this system in the model.`);
    if (!Array.isArray(item.connections)) return void problems.push(`${where} needs "connections": a list, which may be empty.`);
    const connections: Declaration["connections"] = [];
    item.connections.forEach((c, j) => {
      const row = (c ?? {}) as Record<string, unknown>;
      if (typeof row.to !== "string" || !row.to.trim()) return void problems.push(`${where}: connections[${j}] needs "to".`);
      if (row.kind !== undefined && !KINDS.includes(String(row.kind))) return void problems.push(`${where}: connections[${j}] has an unknown "kind". Use one of ${KINDS.join(", ")}.`);
      connections.push({ to: row.to.trim(), protocol: typeof row.protocol === "string" ? row.protocol.trim() : "", kind: typeof row.kind === "string" ? row.kind : undefined, why: typeof row.why === "string" ? row.why.trim() : "" });
    });
    declarations.push({ system: item.system.trim(), connections });
  });
  return { declarations, problems };
}

export function runGate(model: unknown, declarations: Declaration[], options: { unknown: "fail" | "warn" } = { unknown: "warn" }): GateReport {
  const rows: GateRow[] = [];
  for (const d of declarations) {
    for (const c of d.connections) {
      const verdict = mayConnect(model, { source: d.system, target: c.to, protocol: c.protocol });
      const open = verdict.answer === "unknown" && verdict.source && verdict.target && !verdict.existing && verdict.source.id !== verdict.target.id;
      rows.push({
        system: verdict.source?.name ?? d.system,
        to: verdict.target?.name ?? c.to,
        protocol: c.protocol ?? "",
        answer: verdict.answer,
        summary: verdict.summary,
        proposable: open ? { sourceId: verdict.source!.id, targetId: verdict.target!.id, kind: c.kind ?? "calls", protocol: c.protocol ?? "" } : null,
      });
    }
  }
  const counts = { yes: 0, no: 0, unknown: 0 };
  for (const row of rows) counts[row.answer] += 1;
  return { rows, counts, failed: counts.no > 0 || (options.unknown === "fail" && counts.unknown > 0), problems: [] };
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const MARK = { yes: "Yes", no: "No", unknown: "Not known" } as const;

/** The report as Markdown, for the pull request's check summary. */
export function gateMarkdown(report: GateReport, proposal?: { id?: string; filed: boolean; note?: string }): string {
  const lines = ["## Architecture gate", ""];
  if (report.problems.length) lines.push(...report.problems.map((p) => `- ${p}`), "");
  if (!report.rows.length && !report.problems.length) lines.push("The declaration lists no connections, so there was nothing to check.", "");
  if (report.rows.length) {
    lines.push(`${report.counts.yes} agreed, ${report.counts.no} not allowed, ${report.counts.unknown} not known to the model.`, "", "| From | To | Protocol | Model says | Why |", "|---|---|---|---|---|");
    for (const row of report.rows) lines.push(`| ${cell(row.system)} | ${cell(row.to)} | ${cell(row.protocol) || "not stated"} | ${MARK[row.answer]} | ${cell(row.summary)} |`);
    lines.push("");
  }
  if (proposal?.filed) lines.push(`The connections the model does not know were filed as a proposal${proposal.id ? ` (${proposal.id})` : ""} for a person to review in ArchONE Diagrams.`, "");
  else if (proposal?.note) lines.push(proposal.note, "");
  lines.push(report.failed ? "**The gate did not pass.**" : "**The gate passed.**", "", "This checks the connections the repository declares against the architecture model. It does not read the code.");
  return lines.join("\n");
}

/** The body of a proposal for the connections the model does not have yet, or null when there are none. */
export function gateProposal(report: GateReport, source: string): { title: string; notes: string; relationships: { sourceKey: string; targetKey: string; kind: string; protocol: string }[] } | null {
  const seen = new Set<string>();
  const relationships = report.rows
    .filter((row) => row.proposable)
    .map((row) => row.proposable!)
    .filter((r) => !seen.has(`${r.sourceId}>${r.targetId}`) && !!seen.add(`${r.sourceId}>${r.targetId}`))
    .map((r) => ({ sourceKey: r.sourceId, targetKey: r.targetId, kind: r.kind, protocol: r.protocol }));
  if (!relationships.length) return null;
  const from = [...new Set(report.rows.filter((r) => r.proposable).map((r) => r.system))].join(", ");
  return { title: `Connections declared by ${from}`.slice(0, 200), notes: `Declared in a pull request and not yet in the model. Source: ${source || "not given"}.`, relationships };
}
