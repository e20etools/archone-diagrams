import { RELATION_KIND_INFO, objectType } from "../catalog";
import { PACKS, ruleById, rulesOf, runChecks, type PackId } from "../checks/checks";
import { emptyWorkspace } from "../model";
import type { Diagram, Workspace } from "../types";
import { visibleEdges } from "../views";
import { REVIEW_STATUS_LABEL, compareTables, personLabel, type Person, type Review, type VersionInfo } from "./collab";
import { fromTables, type Tables } from "./tables";

/**
 * The evidence pack (PRD FR-56): one file an auditor can read without an account. It holds
 * the reviewed version's diagrams, who approved what and when, each checklist as it was
 * ticked, what the review changed, and the findings of the checks on that version.
 *
 * It is a copy made at one moment. The review and the audit log in the workspace stay the
 * record; the file says so.
 */

export interface EvidenceInput {
  workspaceName: string;
  review: Review;
  version: VersionInfo | undefined;
  /** The model as it was submitted. */
  tables: Tables;
  /** The published model it was compared with, or null when there was none. */
  base: Tables | null;
  people: Person[];
  generatedBy: string;
  generatedAt: string;
}

const esc = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** A date and time that reads the same wherever the file is opened. */
const when = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "");
const asWorkspace = (name: string, tables: Tables): Workspace => ({ ...emptyWorkspace(name), ...fromTables(tables) });

const BOX = { w: 216, h: 78 };
/** Where a line from the centre of one box towards another leaves the box. */
function edgePoint(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number } {
  const [cx, cy] = [from.x + BOX.w / 2, from.y + BOX.h / 2];
  const [dx, dy] = [to.x + BOX.w / 2 - cx, to.y + BOX.h / 2 - cy];
  if (!dx && !dy) return { x: cx, y: cy };
  const scale = Math.min(Math.abs(dx) ? BOX.w / 2 / Math.abs(dx) : Infinity, Math.abs(dy) ? BOX.h / 2 / Math.abs(dy) : Infinity);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/** A diagram as a plain drawing: boxes where they were placed, straight arrows between them. */
export function diagramSvg(ws: Workspace, diagram: Diagram): string {
  const shown = Object.entries(diagram.nodes).filter(([id]) => ws.objects[id]);
  if (!shown.length) return "";
  const minX = Math.min(...shown.map(([, n]) => n.x)) - 24;
  const minY = Math.min(...shown.map(([, n]) => n.y)) - 24;
  const width = Math.max(...shown.map(([, n]) => n.x)) + BOX.w + 24 - minX;
  const height = Math.max(...shown.map(([, n]) => n.y)) + BOX.h + 24 - minY;
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const lines = visibleEdges(ws, diagram)
    .filter((e) => diagram.nodes[e.sourceId] && diagram.nodes[e.targetId])
    .map((e) => {
      const a = edgePoint(diagram.nodes[e.sourceId], diagram.nodes[e.targetId]);
      const b = edgePoint(diagram.nodes[e.targetId], diagram.nodes[e.sourceId]);
      const text = e.label.trim() || RELATION_KIND_INFO[e.kind].verb;
      return `<line x1="${a.x.toFixed(0)}" y1="${a.y.toFixed(0)}" x2="${b.x.toFixed(0)}" y2="${b.y.toFixed(0)}" stroke="#5b6b84" stroke-width="1.5"${e.implied ? ' stroke-dasharray="6 4"' : ""} marker-end="url(#arrow)"/><text x="${((a.x + b.x) / 2).toFixed(0)}" y="${((a.y + b.y) / 2 - 5).toFixed(0)}" font-size="11" fill="#4a5870" text-anchor="middle">${esc(clip(text, 28))}</text>`;
    });
  const boxes = shown.map(([id, n]) => {
    const o = ws.objects[id];
    return `<g><rect x="${n.x.toFixed(0)}" y="${n.y.toFixed(0)}" width="${BOX.w}" height="${BOX.h}" rx="6" fill="#ffffff" stroke="#8a96a8"/><text x="${(n.x + 12).toFixed(0)}" y="${(n.y + 33).toFixed(0)}" font-size="14" font-weight="600" fill="#16233a">${esc(clip(o.name, 26))}</text><text x="${(n.x + 12).toFixed(0)}" y="${(n.y + 53).toFixed(0)}" font-size="12" fill="#4a5870">${esc(clip([objectType(o.typeId).label, o.technology].filter(Boolean).join(" · "), 32))}</text></g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX.toFixed(0)} ${minY.toFixed(0)} ${width.toFixed(0)} ${height.toFixed(0)}" role="img" aria-label="${esc(diagram.name)}" font-family="system-ui, sans-serif"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#5b6b84"/></marker></defs>${lines.join("")}${boxes.join("")}</svg>`;
}

const table = (head: string[], rows: string[][]) =>
  `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

export function evidenceHtml(input: EvidenceInput): string {
  const { review, version, people } = input;
  const who = (userId: string | null | undefined) => personLabel(people.find((p) => p.userId === userId));
  const model = asWorkspace(input.workspaceName, input.tables);
  const packs = PACKS.map((p) => p.id) as PackId[];
  const findings = runChecks(model, null, packs);
  const diagrams = Object.values(model.diagrams).sort((a, b) => a.name.localeCompare(b.name));
  const changes = input.base ? compareTables(input.base, input.tables) : null;

  const history = review.stages.map((stage, index) => {
    const decisions = review.decisions.filter((d) => d.stageId === stage.id);
    const reached = index <= review.stageIndex || decisions.length > 0;
    const body = decisions.length
      ? decisions
          .map((d) => {
            const list = stage.checklist.length && d.decision !== "delegated" ? `<ul class="checklist">${stage.checklist.map((item, i) => `<li>${d.checklist[i] ? "☑" : "☐"} ${esc(item)}</li>`).join("")}</ul>` : "";
            const what = d.decision === "delegated" ? `Handed to ${esc(who(d.to))}` : d.decision === "approved" ? "Approved" : "Rejected";
            return `<div class="decision"><p><strong>${what}</strong> by ${esc(who(d.by))}, ${when(d.at)}</p>${d.reason ? `<p>Reason: ${esc(d.reason)}</p>` : ""}${list}</div>`;
          })
          .join("")
      : `<p class="muted">${reached && review.status === "open" ? "Waiting for a decision." : "Not reached."}</p>`;
    return `<section class="stage"><h3>Stage ${index + 1}: ${esc(stage.name)}</h3><p class="muted">Reviewer: ${esc(who(stage.reviewerId))}</p>${body}</section>`;
  });

  const changeList = (title: string, names: string[]) => (names.length ? `<p><strong>${title} (${names.length}):</strong> ${names.map(esc).join(", ")}</p>` : "");
  const relName = (r: { sourceId: string; targetId: string }) => `${model.objects[r.sourceId]?.name ?? input.base?.objects[r.sourceId]?.name ?? "?"} → ${model.objects[r.targetId]?.name ?? input.base?.objects[r.targetId]?.name ?? "?"}`;
  const changed = !changes
    ? '<p class="muted">Nothing had been published before this review, so there is nothing to compare it with.</p>'
    : changes.total === 0
      ? '<p class="muted">Nothing differs from the version that was published when this was submitted.</p>'
      : [
          changeList("Objects added", changes.objects.added.map((o) => o.name)),
          changeList("Objects removed", changes.objects.removed.map((o) => o.name)),
          changeList("Objects changed", changes.objects.changed.map((c) => `${c.after.name} (${c.fields.map((f) => f.field).join(", ")})`)),
          changeList("Relationships added", changes.relationships.added.map(relName)),
          changeList("Relationships removed", changes.relationships.removed.map(relName)),
          changeList("Relationships changed", changes.relationships.changed.map((c) => relName(c.after))),
          changeList("Diagrams added", changes.diagrams.added.map((d) => d.name)),
          changeList("Diagrams removed", changes.diagrams.removed.map((d) => d.name)),
          changeList("Diagrams changed", changes.diagrams.changed.map((c) => c.after.name)),
        ].join("");

  const findingRows = findings.map((f) => [esc(f.severity), esc(ruleById(f.ruleId)?.title ?? f.ruleId), esc(f.message)]);
  const counts = (["high", "medium", "low"] as const).map((s) => `${findings.filter((f) => f.severity === s).length} ${s}`).join(", ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Evidence pack: ${esc(review.title)}</title>
<style>
  body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #16233a; margin: 0; background: #f3f5f8; }
  main { max-width: 960px; margin: 0 auto; padding: 32px 28px 56px; background: #fff; }
  h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 36px 0 10px; padding-top: 14px; border-top: 1px solid #d5dbe5; } h3 { font-size: 15px; margin: 0 0 2px; }
  p { margin: 4px 0; } .muted { color: #4a5870; } .outcome { display: inline-block; padding: 1px 10px; border: 1px solid #16233a; border-radius: 12px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 14px; } th, td { text-align: left; vertical-align: top; padding: 6px 10px 6px 0; border-bottom: 1px solid #e6eaf0; } th { color: #4a5870; font-weight: 500; }
  dl { display: grid; grid-template-columns: 11rem 1fr; gap: 4px 16px; margin: 12px 0 0; } dt { color: #4a5870; } dd { margin: 0; }
  .stage { margin: 14px 0; padding: 12px 14px; border: 1px solid #d5dbe5; border-radius: 6px; break-inside: avoid; } .decision { margin-top: 8px; padding-top: 8px; border-top: 1px dashed #d5dbe5; }
  .checklist { list-style: none; padding: 0; margin: 6px 0 0; } figure { margin: 18px 0; break-inside: avoid; } figcaption { font-weight: 600; margin-bottom: 6px; } svg { width: 100%; height: auto; border: 1px solid #d5dbe5; border-radius: 6px; background: #fbfcfd; }
  footer { margin-top: 40px; font-size: 13px; color: #4a5870; }
  @media print { body { background: #fff; } main { padding: 0; max-width: none; } }
</style>
</head>
<body>
<main>
<h1>Evidence pack</h1>
<p class="muted">${esc(input.workspaceName)}</p>
<dl>
  <dt>Review</dt><dd>${esc(review.title)}</dd>
  <dt>Outcome</dt><dd><span class="outcome" data-outcome="${esc(review.status)}">${esc(REVIEW_STATUS_LABEL[review.status])}</span></dd>
  <dt>Submitted</dt><dd>${esc(who(review.submittedBy))}, ${when(review.submittedAt)}</dd>
  ${review.closedAt ? `<dt>Closed</dt><dd>${when(review.closedAt)}</dd>` : ""}
  <dt>Version reviewed</dt><dd>${esc(version?.name ?? "A version that has since been deleted")}${version ? `, saved ${when(version.createdAt)}` : ""}: ${Object.keys(model.objects).length} objects, ${Object.keys(model.relationships).length} relationships, ${diagrams.length} diagrams</dd>
  ${review.note ? `<dt>Submitter's note</dt><dd>${esc(review.note)}</dd>` : ""}
  <dt>Pack made</dt><dd>${esc(input.generatedBy)}, ${when(input.generatedAt)}</dd>
</dl>

<h2>Approval history</h2>
${history.join("") || '<p class="muted">This review had no stages.</p>'}

<h2>What the review changed</h2>
${changed}

<h2>Findings of the checks</h2>
<p class="muted">${rulesOf(packs).length} rules from the packs ${PACKS.map((p) => esc(p.name)).join(", ")} were run against the reviewed version: ${counts}. The rules read only what the model records; a clean result is not a certificate of compliance.</p>
${findingRows.length ? table(["Severity", "Rule", "Finding"], findingRows) : "<p>No findings.</p>"}

<h2>Diagrams as reviewed</h2>
${diagrams.length ? diagrams.map((d) => `<figure><figcaption>${esc(d.name)}</figcaption>${diagramSvg(model, d) || '<p class="muted">This diagram shows no objects.</p>'}</figure>`).join("") : '<p class="muted">The reviewed version holds no diagrams.</p>'}

<footer>
<p>This file is a copy made on ${when(input.generatedAt)} from the review and the stored version in ArchONE Diagrams. The diagrams are redrawn in a plain style from the stored positions. The record itself, with the audit log of every change, stays in the workspace; if the two differ, the workspace is right.</p>
</footer>
</main>
</body>
</html>
`;
}
