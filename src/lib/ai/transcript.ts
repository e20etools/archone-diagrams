import { findByName, newId, normalizeName, nowIso } from "../model";
import type { Proposal, ProposedObject, ProposedRelationship, Workspace } from "../types";
import { RULES_ENGINE, draftFromText } from "./heuristic";

/**
 * From what was said in a meeting to a proposal on the model. Each sentence is read by the
 * built-in rules on its own, so every object and relationship that comes out carries the
 * sentence it came from and who said it. Nothing reaches the model until a person accepts it.
 */

export interface Utterance {
  speaker: string;
  text: string;
}

// "Olivia: ...", "[00:12] Olivia: ...", "00:12:03 Olivia Smith: ...", "Olivia (PM) 10:02: ..."
const SPOKEN = /^\s*(?:\[?\(?\d{1,2}:\d{2}(?::\d{2})?\)?\]?\s*[-–]?\s*)?([\p{L}][\p{L}\p{M}'’. -]{0,40}?)(?:\s*\([^)]{0,30}\))?(?:\s+\[?\d{1,2}:\d{2}(?::\d{2})?\]?)?\s*:\s+(.+)$/u;

/** Splits a transcript into who said what. A line without a speaker continues the one before. */
export function parseTranscript(text: string): Utterance[] {
  const out: Utterance[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const spoken = SPOKEN.exec(line);
    // A URL or a time at the start of a sentence is not a speaker.
    if (spoken && !/^(https?|ftp)$/i.test(spoken[1].trim())) out.push({ speaker: spoken[1].trim(), text: spoken[2].trim() });
    else if (out.length) out[out.length - 1].text += ` ${line}`;
    else out.push({ speaker: "", text: line });
  }
  return out;
}

const sentences = (text: string) =>
  text
    .split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"'(])/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);

const quote = (speaker: string, sentence: string) => `${speaker ? `${speaker}: ` : ""}"${sentence.length > 240 ? `${sentence.slice(0, 238).trimEnd()}…` : sentence}"`;

export function transcriptToProposal(ws: Workspace, text: string, targetDiagramId: string | null = null): Proposal {
  const utterances = parseTranscript(text);
  const objects: ProposedObject[] = [];
  const keyByName = new Map<string, string>();
  const relationships: ProposedRelationship[] = [];
  const seen = new Set<string>();

  for (const utterance of utterances) {
    for (const sentence of sentences(utterance.text)) {
      const draft = draftFromText(sentence);
      if (!draft.relationships.length && draft.objects.length < 2) continue; // a sentence that names one thing in passing decides nothing
      const evidence = quote(utterance.speaker, sentence);
      const local = new Map<string, string>();
      for (const o of draft.objects) {
        const name = normalizeName(o.name);
        let key = keyByName.get(name);
        if (!key) {
          key = `o${objects.length + 1}`;
          keyByName.set(name, key);
          objects.push({ key, name: o.name, typeId: o.typeId, description: o.description, technology: o.technology, parentKey: null, decision: "pending", matchId: findByName(ws, o.name)?.id ?? null, evidence });
        } else {
          const known = objects.find((x) => x.key === key)!;
          if (!known.technology && o.technology) known.technology = o.technology;
        }
        local.set(o.key, key);
      }
      for (const o of draft.objects) {
        const own = objects.find((x) => x.key === local.get(o.key));
        const parent = o.parentKey ? local.get(o.parentKey) : undefined;
        if (own && parent && parent !== own.key && !own.parentKey) own.parentKey = parent;
      }
      for (const r of draft.relationships) {
        const sourceKey = local.get(r.sourceKey);
        const targetKey = local.get(r.targetKey);
        if (!sourceKey || !targetKey || sourceKey === targetKey) continue;
        const signature = `${sourceKey}>${targetKey}>${r.kind}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        relationships.push({ key: `r${relationships.length + 1}`, sourceKey, targetKey, kind: r.kind, label: r.label, decision: "pending", evidence });
      }
    }
  }

  const speakers = new Set(utterances.map((u) => u.speaker).filter(Boolean));
  const already = objects.filter((o) => o.matchId).length;
  return {
    id: newId("prop"),
    origin: "ai-prompt",
    sourceKind: "transcript",
    source: `Meeting transcript: ${utterances.length} ${utterances.length === 1 ? "turn" : "turns"}${speakers.size ? `, ${speakers.size} ${speakers.size === 1 ? "speaker" : "speakers"}` : ""}`,
    engine: RULES_ENGINE,
    notes:
      `Read sentence by sentence with the built-in rules, without an AI model. It finds what was named and how the things were said to connect; it does not understand a decision, a doubt or a "no". Each item shows the sentence it came from.` +
      (already ? ` ${already} of the objects ${already === 1 ? "is" : "are"} already in the model and will be reused.` : ""),
    createdAt: nowIso(),
    status: "pending",
    targetDiagramId: targetDiagramId && ws.diagrams[targetDiagramId] ? targetDiagramId : null,
    objects,
    relationships,
  };
}
