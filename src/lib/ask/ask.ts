import { LIFECYCLE_INFO, OBJECT_TYPES, RELATION_KIND_INFO, objectType } from "../catalog";
import { impactOf, traverse } from "../graph";
import { allOwners, allTags, ancestorsOf, childrenOf, diagramsUsing, normalizeName, relationshipsOf } from "../model";
import { LIFECYCLES, type Lifecycle, type ModelObject, type Workspace } from "../types";

/**
 * Ask the architecture (PRD AI-05): a question in plain words, answered from the model, with
 * links to the objects the answer rests on.
 *
 * Questions the model can answer exactly (what depends on what, who owns what, what a change
 * would touch, lists and counts) are worked out here, in the browser, by reading the model:
 * nothing is guessed and nothing leaves the device. Other questions go to the AI model when
 * one is configured, together with the model as text.
 */

export interface Answer {
  /** Plain text. An object is written as [[its id]] and drawn as a link with its name. */
  text: string;
  /** Every object the answer mentions, in the order mentioned. */
  objectIds: string[];
  diagramIds: string[];
  /** computed: read from the model by rule. ai: written by the AI model. search: no answer, only objects whose words match. */
  source: "computed" | "ai" | "search";
  engine: string;
}

export const RULES_ANSWER_ENGINE = "Read from the model";

const tag = (id: string) => `[[${id}]]`;
const TAG = /\[\[([^\][\s]{1,80})\]\]/g;

/** The object ids written in an answer, in order, keeping only those that exist. */
export function citedObjects(ws: Workspace, text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(TAG)) if (ws.objects[match[1]] && !ids.includes(match[1])) ids.push(match[1]);
  return ids;
}

/** An answer split into text and object links, for drawing. A tag for an object that does not exist is dropped. */
export function answerParts(ws: Workspace, text: string): ({ text: string } | { objectId: string; name: string })[] {
  const parts: ({ text: string } | { objectId: string; name: string })[] = [];
  let at = 0;
  for (const match of text.matchAll(TAG)) {
    if (match.index > at) parts.push({ text: text.slice(at, match.index) });
    const object = ws.objects[match[1]];
    if (object) parts.push({ objectId: object.id, name: object.name });
    else parts.push({ text: "an object that is not in the model" });
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/* ---------- the model as text, for the AI model ---------- */

const oneLine = (value: string, limit: number) => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

/**
 * The model written out compactly. When it would not fit, descriptions go first, then the
 * lists are cut and the text says so, so the AI model knows it is not seeing everything.
 */
export function modelContext(ws: Workspace, budget = 200_000): { text: string; complete: boolean } {
  const objects = Object.values(ws.objects).sort((a, b) => a.name.localeCompare(b.name));
  const relationships = Object.values(ws.relationships).filter((r) => ws.objects[r.sourceId] && ws.objects[r.targetId]);
  const diagrams = Object.values(ws.diagrams).sort((a, b) => a.name.localeCompare(b.name));

  const build = (describe: number, maxObjects: number, maxRelationships: number) => {
    const lines: string[] = [`Workspace: ${oneLine(ws.name, 120)}`, "", "OBJECTS: id | name | type | owner | lifecycle | technology | tags | inside (id) | description"];
    for (const o of objects.slice(0, maxObjects)) {
      lines.push(
        [o.id, oneLine(o.name, 120), objectType(o.typeId).label, oneLine(o.owner, 60) || "-", o.lifecycle, oneLine(o.technology, 60) || "-", o.tags.join(",") || "-", o.parentId ?? "-", describe ? oneLine(o.description, describe) || "-" : "-"].join(" | "),
      );
    }
    if (objects.length > maxObjects) lines.push(`(${objects.length - maxObjects} more objects are not listed)`);
    lines.push("", "RELATIONSHIPS: source id -> target id | kind | label | protocol | port");
    for (const r of relationships.slice(0, maxRelationships)) {
      lines.push(`${r.sourceId} -> ${r.targetId} | ${RELATION_KIND_INFO[r.kind].verb} | ${oneLine(r.label, 80) || "-"} | ${oneLine(r.protocol, 30) || "-"} | ${oneLine(r.port, 20) || "-"}`);
    }
    if (relationships.length > maxRelationships) lines.push(`(${relationships.length - maxRelationships} more relationships are not listed)`);
    lines.push("", "DIAGRAMS: name | object ids shown");
    for (const d of diagrams.slice(0, 200)) lines.push(`${oneLine(d.name, 100)} | ${Object.keys(d.nodes).filter((id) => ws.objects[id]).join(",") || "-"}`);
    return lines.join("\n");
  };

  for (const describe of [240, 80, 0]) {
    const text = build(describe, objects.length, relationships.length);
    if (text.length <= budget) return { text, complete: true };
  }
  // Too large even without descriptions: keep as many objects and relationships as fit.
  let share = 0.8;
  for (let i = 0; i < 12; i++) {
    const text = build(0, Math.floor(objects.length * share), Math.floor(relationships.length * share));
    if (text.length <= budget) return { text, complete: false };
    share *= 0.75;
  }
  return { text: build(0, 200, 400).slice(0, budget), complete: false };
}

/* ---------- answers worked out from the model ---------- */

interface Mention {
  object: ModelObject;
  /** Where in the question the name was found. */
  at: number;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The objects named in a question. Longer names are matched first, so "Order service" is not read as "Order". */
export function mentionedObjects(ws: Workspace, question: string): { mentions: Mention[]; rest: string } {
  let rest = ` ${question.toLowerCase().replace(/\s+/g, " ")} `;
  const mentions: Mention[] = [];
  const candidates = Object.values(ws.objects)
    .filter((o) => normalizeName(o.name).length >= 2)
    .sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name));
  for (const object of candidates) {
    const name = normalizeName(object.name);
    // A name counts when it stands as whole words, optionally in quotes.
    const found = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "u").exec(rest);
    if (!found) continue;
    if (mentions.some((m) => normalizeName(m.object.name) === name)) continue;
    mentions.push({ object, at: found.index });
    rest = `${rest.slice(0, found.index)}${"\u0001".repeat(name.length)}${rest.slice(found.index + name.length)}`;
  }
  mentions.sort((a, b) => a.at - b.at);
  // Each name becomes a numbered marker, so the wording around it can be read.
  let marked = rest;
  mentions.forEach((m, i) => {
    marked = marked.replace(new RegExp(`\u0001{${normalizeName(m.object.name).length}}`), `<${i}>`);
  });
  return { mentions, rest: marked.replace(/["'“”‘’]/g, "").replace(/\s+/g, " ").trim() };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const SHOWN = 20;
function listed(ids: string[]): string {
  const shown = ids.slice(0, SHOWN).map((id) => `- ${tag(id)}`);
  if (ids.length > SHOWN) shown.push(`- and ${ids.length - SHOWN} more`);
  return shown.join("\n");
}
const byName = (ws: Workspace) => (a: string, b: string) => ws.objects[a].name.localeCompare(ws.objects[b].name);

function answer(ws: Workspace, text: string, diagramIds: string[] = []): Answer {
  return { text, objectIds: citedObjects(ws, text), diagramIds, source: "computed", engine: RULES_ANSWER_ENGINE };
}

function describe(ws: Workspace, o: ModelObject): Answer {
  const { outgoing, incoming } = relationshipsOf(ws, o.id);
  const inside = childrenOf(ws, o.id);
  const diagrams = diagramsUsing(ws, o.id);
  const lines = [
    `${tag(o.id)} is a ${objectType(o.typeId).label.toLowerCase()}${o.parentId && ws.objects[o.parentId] ? ` inside ${tag(o.parentId)}` : ""}.`,
    o.description.trim() && oneLine(o.description, 400),
    `Owner: ${o.owner.trim() || "none recorded"}. Lifecycle: ${LIFECYCLE_INFO[o.lifecycle].label.toLowerCase()}.${o.technology.trim() ? ` Technology: ${o.technology.trim()}.` : ""}${o.tags.length ? ` Tags: ${o.tags.join(", ")}.` : ""}`,
    `It has ${plural(outgoing.length, "relationship")} going out and ${incoming.length} coming in${inside.length ? `, and ${plural(inside.length, "object")} inside it` : ""}. It is shown on ${plural(diagrams.length, "diagram")}.`,
  ];
  return answer(ws, lines.filter(Boolean).join("\n"), diagrams.map((d) => d.id));
}

function dependents(ws: Workspace, o: ModelObject): Answer {
  const all = traverse(ws, o.id, "downstream");
  if (!all.length) return answer(ws, `Nothing in the model depends on ${tag(o.id)}.`);
  const direct = all.filter((r) => r.distance === 1).map((r) => r.id).sort(byName(ws));
  const indirect = all.filter((r) => r.distance > 1).map((r) => r.id).sort(byName(ws));
  return answer(
    ws,
    [`${plural(direct.length, "object depends", "objects depend")} on ${tag(o.id)} directly:`, listed(direct), indirect.length ? `\nAnother ${indirect.length} depend on it through those:\n${listed(indirect)}` : ""].filter(Boolean).join("\n"),
  );
}

function dependencies(ws: Workspace, o: ModelObject): Answer {
  const all = traverse(ws, o.id, "upstream");
  if (!all.length) return answer(ws, `${tag(o.id)} depends on nothing else in the model.`);
  const direct = all.filter((r) => r.distance === 1).map((r) => r.id).sort(byName(ws));
  const indirect = all.filter((r) => r.distance > 1).map((r) => r.id).sort(byName(ws));
  return answer(
    ws,
    [`${tag(o.id)} depends directly on ${plural(direct.length, "object")}:`, listed(direct), indirect.length ? `\nThrough those it also depends on ${indirect.length} more:\n${listed(indirect)}` : ""].filter(Boolean).join("\n"),
  );
}

function impact(ws: Workspace, o: ModelObject, retiring: boolean): Answer {
  const report = impactOf(ws, o.id, retiring ? "retiring" : "changing");
  if (!report || !report.affected.length) return answer(ws, `Nothing in the model depends on ${tag(o.id)}, so ${retiring ? "retiring it" : "a failure or change"} affects nothing else that is recorded.`);
  const owners = report.owners.filter((x) => x.owner).map((x) => `${x.owner} (${x.count})`);
  const unowned = report.owners.find((x) => !x.owner)?.count ?? 0;
  const lines = [
    `${retiring ? "Retiring" : "A failure of or change to"} ${tag(o.id)} affects ${plural(report.affected.length, "object")}:`,
    ...report.affected.slice(0, SHOWN).map((a) => `- ${tag(a.object.id)}${a.distance > 1 ? `, ${a.distance} steps away` : ""}`),
    report.affected.length > SHOWN ? `- and ${report.affected.length - SHOWN} more` : "",
    owners.length || unowned ? `\nOwners to tell: ${[...owners, unowned ? `${unowned} with no owner recorded` : ""].filter(Boolean).join(", ")}.` : "",
    retiring && report.brokenRelationships.length ? `${plural(report.brokenRelationships.length, "relationship")} would stop working.` : "",
    `${plural(report.diagrams.length, "diagram shows", "diagrams show")} it or something affected.`,
  ];
  return answer(ws, lines.filter(Boolean).join("\n"), report.diagrams.map((d) => d.id));
}

/** The shortest chain of relationships of any kind from one object to another, following their direction. */
function chain(ws: Workspace, fromId: string, toId: string): string[] | null {
  const next = new Map<string, string[]>();
  for (const r of Object.values(ws.relationships)) next.set(r.sourceId, [...(next.get(r.sourceId) ?? []), r.targetId]);
  const previous = new Map<string, string>([[fromId, ""]]);
  let frontier = [fromId];
  while (frontier.length && !previous.has(toId)) {
    const upcoming: string[] = [];
    for (const id of frontier) {
      for (const other of next.get(id) ?? []) {
        if (previous.has(other) || !ws.objects[other]) continue;
        previous.set(other, id);
        upcoming.push(other);
      }
    }
    frontier = upcoming;
  }
  if (!previous.has(toId)) return null;
  const path: string[] = [];
  for (let id = toId; id; id = previous.get(id) ?? "") path.unshift(id);
  return path;
}

function connection(ws: Workspace, a: ModelObject, b: ModelObject): Answer {
  const forward = chain(ws, a.id, b.id);
  const backward = forward ? null : chain(ws, b.id, a.id);
  const path = forward ?? backward;
  if (!path) return answer(ws, `The model records no chain of relationships between ${tag(a.id)} and ${tag(b.id)}, in either direction.`);
  const steps = path.length - 1;
  return answer(ws, `${tag(path[0])} reaches ${tag(path[path.length - 1])} in ${plural(steps, "step")}:\n${path.map(tag).join(" → ")}`);
}

const TYPE_WORDS = new Map<string, string>();
for (const t of OBJECT_TYPES) {
  for (const word of [t.id.replace(/-/g, " "), t.label.toLowerCase(), ...t.label.toLowerCase().split(/ or /)]) {
    TYPE_WORDS.set(word, t.id);
    TYPE_WORDS.set(`${word}s`, t.id);
  }
}
const LIFECYCLE_WORDS: [Lifecycle, RegExp][] = LIFECYCLES.map((l) => [l, new RegExp(`\\b${l}\\b`)]);

/** A question with no object in it: a list or a count, narrowed by the words that name a type, lifecycle, owner, tag or gap. */
function listing(ws: Workspace, text: string): Answer | null {
  // Only a request for a list or a count; "why is the database slow" is not one.
  const words = text.replace(/[?.!]/g, "").trim().split(" ").filter(Boolean);
  const asksForList = /^(which|what|list|show|give|find|count|how many|are there|is there|do we have|any|all|every)\b/.test(text) || words.length <= 4;
  if (!asksForList || /\b(why|how (do|to|can|should|does)|should|could|best|better|recommend\w*|improve\w*|risk\w*)\b/.test(text)) return null;
  const filters: string[] = [];
  let objects = Object.values(ws.objects);

  const typeWord = [...TYPE_WORDS.keys()].sort((a, b) => b.length - a.length).find((w) => new RegExp(`\\b${escapeRegExp(w)}\\b`).test(text));
  const typeId = typeWord ? TYPE_WORDS.get(typeWord)! : null;
  if (typeId) {
    objects = objects.filter((o) => o.typeId === typeId);
    filters.push(`of type ${objectType(typeId).label}`);
  }
  const lifecycle = LIFECYCLE_WORDS.find(([, pattern]) => pattern.test(text))?.[0];
  if (lifecycle) {
    objects = objects.filter((o) => o.lifecycle === lifecycle);
    filters.push(`with lifecycle ${lifecycle}`);
  }
  if (/\b(no|without|missing|lack\w*)\b.{0,20}\bowners?\b|\bunowned\b/.test(text)) {
    objects = objects.filter((o) => !o.owner.trim());
    filters.push("with no owner recorded");
  } else {
    const owner = allOwners(ws)
      .sort((a, b) => b.length - a.length)
      .find((name) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name.toLowerCase())}(?![\\p{L}\\p{N}])`, "u").test(text));
    if (owner) {
      objects = objects.filter((o) => o.owner.trim().toLowerCase() === owner.toLowerCase());
      filters.push(`owned by ${owner}`);
    }
  }
  if (/\b(no|without|missing|lack\w*)\b.{0,20}\bdescriptions?\b/.test(text)) {
    objects = objects.filter((o) => !o.description.trim());
    filters.push("with no description");
  }
  const tagged = allTags(ws).find((t) => new RegExp(`\\b(tag(ged)?|label(led)?)\\b.{0,12}\\b${escapeRegExp(t)}\\b|\\b${escapeRegExp(t)}\\b.{0,8}\\btag`).test(text));
  if (tagged) {
    objects = objects.filter((o) => o.tags.includes(tagged));
    filters.push(`tagged ${tagged}`);
  }
  const technology = [...new Set(Object.values(ws.objects).map((o) => o.technology.trim()).filter((t) => t.length >= 2))]
    .sort((a, b) => b.length - a.length)
    .find((t) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(t.toLowerCase())}(?![\\p{L}\\p{N}])`, "u").test(text));
  if (technology) {
    objects = objects.filter((o) => o.technology.trim().toLowerCase() === technology.toLowerCase());
    filters.push(`using ${technology}`);
  }

  if (!filters.length) return null;
  const what = filters.join(", ");
  const ids = objects.sort((a, b) => a.name.localeCompare(b.name)).map((o) => o.id);
  if (!ids.length) return answer(ws, `The model holds no objects ${what}.`);
  return answer(ws, `${plural(ids.length, "object")} ${what}:\n${listed(ids)}`);
}

function overview(ws: Workspace): Answer {
  const objects = Object.values(ws.objects);
  const byType = new Map<string, number>();
  for (const o of objects) byType.set(o.typeId, (byType.get(o.typeId) ?? 0) + 1);
  const types = [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([typeId, n]) => `${n} ${objectType(typeId).label.toLowerCase()}`);
  const unowned = objects.filter((o) => !o.owner.trim()).length;
  return answer(
    ws,
    [
      `The model holds ${plural(objects.length, "object")}, ${plural(Object.keys(ws.relationships).length, "relationship")} and ${plural(Object.keys(ws.diagrams).length, "diagram")}.`,
      types.length ? `By type: ${types.join(", ")}.` : "",
      objects.length ? `${unowned} of the objects have no owner recorded.` : "",
    ].filter(Boolean).join("\n"),
  );
}

function owners(ws: Workspace): Answer {
  const counts = new Map<string, number>();
  for (const o of Object.values(ws.objects)) counts.set(o.owner.trim(), (counts.get(o.owner.trim()) ?? 0) + 1);
  const named = [...counts.entries()].filter(([owner]) => owner).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!named.length) return answer(ws, "No object in the model has an owner recorded.");
  return answer(ws, [`${plural(named.length, "owner")}:`, ...named.map(([owner, n]) => `- ${owner}: ${plural(n, "object")}`), counts.get("") ? `${counts.get("")} objects have no owner recorded.` : ""].filter(Boolean).join("\n"));
}

/**
 * Answers a question by reading the model, or returns null when the question is not one of
 * the kinds it can work out exactly. It never falls back to a loose guess.
 */
export function answerFromModel(ws: Workspace, question: string): Answer | null {
  const { mentions, rest: text } = mentionedObjects(ws, question);
  const [first, second] = mentions.map((m) => m.object);

  if (first && second && /\b(path|route|connect\w*|reach\w*|between|link\w*|talk\w*|get to|from <\d> to <\d>|how does <\d>.*<\d>)\b/.test(text)) return connection(ws, first, second);

  if (first) {
    const o = first;
    if (/\b(fail\w*|goes down|go down|is down|outage|break\w*|unavailable|impact\w*|affect\w*|blast radius|retir\w*|remov\w*|decommission\w*|switch\w* off|turn\w* off|shut\w* down|delet\w*|chang\w*)\b/.test(text)) {
      return impact(ws, o, /\b(retir\w*|remov\w*|decommission\w*|switch\w* off|turn\w* off|shut\w* down|delet\w*)\b/.test(text));
    }
    if (/\b(who owns|owner of|owners? for|owned by|who is responsible|responsible for|who runs|who maintains)\b/.test(text) || /\bwho\b.*\bowns?\b/.test(text)) {
      return answer(ws, o.owner.trim() ? `${tag(o.id)} is owned by ${o.owner.trim()}.` : `No owner is recorded for ${tag(o.id)}.`);
    }
    if (/\b(which|what|how many) diagrams?\b|\bwhere\b.*\b(shown|drawn|appear\w*|used)\b|\bdiagrams? (show\w*|with|contain\w*|includ\w*)\b/.test(text)) {
      const diagrams = diagramsUsing(ws, o.id);
      return answer(ws, diagrams.length ? `${tag(o.id)} is shown on ${plural(diagrams.length, "diagram")}:\n${diagrams.map((d) => `- ${d.name}`).join("\n")}` : `${tag(o.id)} is not shown on any diagram.`, diagrams.map((d) => d.id));
    }
    // "what does X depend on" asks for what X needs; "what depends on X" asks for what needs X.
    const needs = /\b(depend\w*|rel(y|ies)|need\w*|requir\w*|use[sd]?|using|call\w*|consum\w*|read\w*|writ\w*|talk\w*|hosted|runs? on)\b/;
    if (needs.test(text)) {
      const outward =
        /\bdoes <0>\b/.test(text) ||
        /\bdependenc(y|ies) (of|for) <0>/.test(text) ||
        /<0>s? dependenc(y|ies)/.test(text) ||
        /<0> (depend\w*|rel(y|ies)|need\w*|requir\w*|use[sd]?|call\w*|consum\w*|read\w*|writ\w*|talk\w*|is hosted|runs?)\b/.test(text) ||
        /\bupstream (of|from) <0>/.test(text);
      return outward ? dependencies(ws, o) : dependents(ws, o);
    }
    if (/\b(downstream|consumers?|clients?|callers?|users) (of|from)\b/.test(text)) return dependents(ws, o);
    if (/\bupstream\b/.test(text)) return dependencies(ws, o);
    if (/\b(inside|contain\w*|made of|consist\w*|parts? of|components? of|children|what is in)\b/.test(text)) {
      const inside = childrenOf(ws, o.id).map((c) => c.id);
      const around = ancestorsOf(ws, o.id);
      return answer(
        ws,
        [inside.length ? `${plural(inside.length, "object sits", "objects sit")} directly inside ${tag(o.id)}:\n${listed(inside)}` : `Nothing sits inside ${tag(o.id)}.`, around.length ? `It is itself inside ${around.map(tag).join(", inside ")}.` : ""].filter(Boolean).join("\n"),
      );
    }
    if (mentions.length === 1 && (/\b(what is|whats|tell me about|describe|explain|details?|info\w*|about)\b/.test(text) || text.replace(/<0>|[?.!]/g, "").trim().split(" ").filter(Boolean).length <= 2)) return describe(ws, o);
    return null;
  }

  if (/\b(who owns what|list (the )?owners|which owners|all owners|owners\?*$)\b/.test(text) || /^(who are the )?owners\??$/.test(text)) return owners(ws);
  if (/\b(overview|summary|summari[sz]e|how big|how large|size of the model|what is in the model)\b/.test(text) || /\bhow many (objects|relationships|diagrams|things)\b/.test(text)) {
    return listing(ws, text) ?? overview(ws);
  }
  return listing(ws, text);
}

/** When nothing can answer: the objects whose names or details share words with the question. */
export function searchFallback(ws: Workspace, question: string, reason: string): Answer {
  const words = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w));
  const scored = Object.values(ws.objects)
    .map((o) => {
      const hay = `${o.name} ${o.technology} ${o.owner} ${o.tags.join(" ")} ${o.description}`.toLowerCase();
      const name = o.name.toLowerCase();
      return { o, score: words.reduce((n, w) => n + (name.includes(w) ? 3 : hay.includes(w) ? 1 : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.o.name.localeCompare(b.o.name))
    .slice(0, 8);
  const text = scored.length
    ? `${reason}\nThese objects share words with your question:\n${scored.map((x) => `- ${tag(x.o.id)}`).join("\n")}`
    : `${reason}\nNo object in the model shares a word with your question.`;
  return { text, objectIds: scored.map((x) => x.o.id), diagramIds: [], source: "search", engine: RULES_ANSWER_ENGINE };
}
const STOP = new Set("the and for with what which who whom does that this are was were has have had our your their from into about how many much any all can could would should will there here when where why not you its it's than then them they also only just most more less very each every some".split(" "));

/** Questions that are answered by reading the model, shown as examples. Built from what the model actually holds. */
export function exampleQuestions(ws: Workspace): string[] {
  const objects = Object.values(ws.objects);
  if (!objects.length) return [];
  // The most connected object makes the most telling example.
  const degree = new Map<string, number>();
  for (const r of Object.values(ws.relationships)) {
    degree.set(r.sourceId, (degree.get(r.sourceId) ?? 0) + 1);
    degree.set(r.targetId, (degree.get(r.targetId) ?? 0) + 1);
  }
  const ranked = [...objects].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.name.localeCompare(b.name));
  const hub = ranked[0];
  const depended = objects.map((o) => ({ o, n: traverse(ws, o.id, "downstream", { maxDepth: 1 }).length })).sort((a, b) => b.n - a.n)[0];
  const examples = [`What depends on ${depended.n ? depended.o.name : hub.name}?`, `What happens if ${depended.n ? depended.o.name : hub.name} fails?`, `What does ${hub.name} depend on?`, `Who owns ${hub.name}?`];
  if (objects.some((o) => o.typeId === "database")) examples.push("Which databases are there?");
  if (objects.some((o) => o.lifecycle === "deprecated")) examples.push("What is deprecated?");
  if (objects.some((o) => !o.owner.trim())) examples.push("Which objects have no owner?");
  return [...new Set(examples)].slice(0, 6);
}
