import type { RelationKind } from "../types";
import { DiagramFileError, guessType, plainLabel } from "./diagramFile";

/**
 * Diagrams written as text, read into elements and links. Mermaid flowcharts and C4 diagrams
 * are read here; Structurizr DSL has its own reader. Neither says where a box sits, so the
 * imported diagram is laid out afresh.
 */

export interface TextElement {
  id: string;
  name: string;
  typeId: string;
  description: string;
  technology: string;
  parentId: string | null;
  tags: string[];
}
export interface TextLink {
  sourceId: string;
  targetId: string;
  label: string;
  technology: string;
  /** Set when the file says what kind of link it is; otherwise it is guessed from the label. */
  kind?: RelationKind;
}
export interface TextModel {
  title: string;
  elements: TextElement[];
  links: TextLink[];
  /** What was left out, in words, for the person to read before importing. */
  skipped: string[];
}

const SUPPORTED = /^\s*(flowchart|graph|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/;

/** The Mermaid diagrams in a file: the file itself, or each ```mermaid block of a Markdown file. */
export function mermaidBlocks(source: string): string[] {
  const text = source.replace(/\r\n?/g, "\n");
  const fenced = [...text.matchAll(/^[ \t]*(?:```|~~~)[ \t]*mermaid[^\n]*\n([\s\S]*?)^[ \t]*(?:```|~~~)[ \t]*$/gm)].map((m) => m[1]);
  return fenced.length ? fenced : [text];
}

const withoutPreamble = (text: string) =>
  text
    .replace(/^\s*---\n[\s\S]*?\n---[ \t]*\n/, "") // front matter
    .replace(/%%\{[\s\S]*?\}%%/g, "") // directives
    .replace(/^[ \t]*%%.*$/gm, ""); // comments

export function isMermaid(source: string): boolean {
  return mermaidBlocks(source).some((block) => SUPPORTED.test(withoutPreamble(block)));
}

const label = (raw: string) => {
  let text = raw.trim();
  if (/^".*"$/s.test(text)) text = text.slice(1, -1);
  if (/^`.*`$/s.test(text)) text = text.slice(1, -1);
  return plainLabel(text.replace(/#quot;/g, '"').replace(/#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))));
};

/* ---------- flowcharts ---------- */

/** Opening bracket, the brackets that can close it, and what the shape suggests. */
const SHAPES: [string, string[], string][] = [
  ["(((", [")))"], "circle"],
  ["((", ["))"], "circle"],
  ["([", ["])"], "stadium"],
  ["[(", [")]"], "database cylinder"],
  ["[[", ["]]"], "subroutine service"],
  ["{{", ["}}"], "hexagon"],
  ["[/", ["/]", "\\]"], "parallelogram"],
  ["[\\", ["\\]", "/]"], "parallelogram"],
  ["[", ["]"], ""],
  ["(", [")"], ""],
  ["{", ["}"], "decision"],
  [">", ["]"], ""],
];
const ID = /^[\p{L}\p{N}_]+(?:[-.][\p{L}\p{N}_]+)*/u;
// A whole arrow: at least a head, or three strokes. Two bare strokes open an arrow with its text inside.
const ARROW = /^\s*([<ox])?(?:(?:-{2,}|={2,})(?:>|[ox](?![\p{L}\p{N}_]))|-{3,}|={3,}|-\.+-[>ox]?|~{3,})/u;
const ARROW_WITH_TEXT = /^\s*([<ox])?(?:--|==|-\.)\s*([^\n]*?)\s*(?:-{2,}|={2,}|\.+-)([>ox])?(?![-=.>])/;

interface FlowNode {
  id: string;
  text: string | null;
  hint: string;
  parentId: string | null;
}

function readFlowchart(source: string, skipped: string[]): TextModel {
  const nodes = new Map<string, FlowNode>();
  const links: TextLink[] = [];
  const stack: string[] = [];
  const groups = new Set<string>();
  let title = "";
  let unread = 0;

  const touch = (id: string, text: string | null, hint: string) => {
    const known = nodes.get(id);
    if (known) {
      if (text !== null && known.text === null) known.text = text;
      if (hint && !known.hint) known.hint = hint;
      return;
    }
    nodes.set(id, { id, text, hint, parentId: stack.at(-1) ?? null });
  };

  /** Reads one node at the start of `rest`; returns its id and what follows. */
  const readNode = (rest: string): { id: string; rest: string } | null => {
    const found = ID.exec(rest);
    if (!found) return null;
    const id = found[0];
    let after = rest.slice(id.length);
    let text: string | null = null;
    let hint = "";
    if (after.startsWith("@{")) {
      const end = after.indexOf("}");
      if (end < 0) return null;
      const body = after.slice(2, end);
      text = /label:\s*"([^"]*)"/.exec(body)?.[1] ?? null;
      hint = /shape:\s*([\w-]+)/.exec(body)?.[1] ?? "";
      if (/^(cyl|cylinder|database|db|das|lin-cyl|disk)$/.test(hint)) hint = "database cylinder";
      after = after.slice(end + 1);
    } else {
      const shape = SHAPES.find(([open]) => after.startsWith(open));
      if (shape) {
        const [open, closers, shapeHint] = shape;
        const inner = after.slice(open.length);
        let end = -1;
        let closer = "";
        if (/^\s*"/.test(inner)) {
          const quote = inner.indexOf('"', inner.indexOf('"') + 1);
          for (const c of closers) {
            const at = quote < 0 ? -1 : inner.indexOf(c, quote);
            if (at >= 0 && (end < 0 || at < end)) [end, closer] = [at, c];
          }
        } else {
          for (const c of closers) {
            const at = inner.indexOf(c);
            if (at >= 0 && (end < 0 || at < end)) [end, closer] = [at, c];
          }
        }
        if (end < 0) return null;
        text = label(inner.slice(0, end));
        hint = shapeHint;
        after = inner.slice(end + closer.length);
      }
    }
    after = after.replace(/^:::[\w-]+/, "");
    touch(id, text, hint);
    return { id, rest: after };
  };

  const readGroup = (rest: string): { ids: string[]; rest: string } | null => {
    const ids: string[] = [];
    let at = rest.replace(/^\s+/, "");
    for (;;) {
      const node = readNode(at);
      if (!node) return null;
      ids.push(node.id);
      at = node.rest;
      const more = /^\s*&\s*/.exec(at);
      if (!more) return { ids, rest: at };
      at = at.slice(more[0].length);
    }
  };

  const statements = source
    .split("\n")
    .flatMap((line) => line.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/))
    .map((s) => s.trim())
    .filter(Boolean);

  for (const statement of statements.slice(1)) {
    if (/^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/.test(statement)) continue;
    if (/^title\b/i.test(statement)) {
      title = label(statement.replace(/^title\s*:?\s*/i, ""));
      continue;
    }
    if (/^end\b/.test(statement)) {
      stack.pop();
      continue;
    }
    const group = /^subgraph\s+(.*)$/.exec(statement);
    if (group) {
      const head = group[1].trim();
      const withTitle = /^([\p{L}\p{N}_][\p{L}\p{N}_.-]*)\s*\[(.*)\]$/su.exec(head);
      const id = withTitle ? withTitle[1] : /^[\p{L}\p{N}_.-]+$/u.test(head) ? head : `group_${groups.size + 1}`;
      const text = withTitle ? label(withTitle[2]) : label(head);
      nodes.set(id, { id, text, hint: "group", parentId: stack.at(-1) ?? null });
      groups.add(id);
      stack.push(id);
      continue;
    }
    let from = readGroup(statement);
    if (!from) {
      unread += 1;
      continue;
    }
    for (;;) {
      let rest = from.rest;
      let text = "";
      let reversed = false;
      const plain = ARROW.exec(rest);
      const worded = plain ? null : ARROW_WITH_TEXT.exec(rest);
      if (plain) {
        reversed = plain[1] === "<" && !/[>ox]$/.test(plain[0]);
        rest = rest.slice(plain[0].length);
        const piped = /^\s*\|([^|]*)\|/.exec(rest);
        if (piped) {
          text = label(piped[1]);
          rest = rest.slice(piped[0].length);
        }
      } else if (worded) {
        reversed = worded[1] === "<" && !worded[3];
        text = label(worded[2]);
        rest = rest.slice(worded[0].length);
      } else {
        if (rest.trim()) unread += 1;
        break;
      }
      const to = readGroup(rest);
      if (!to) {
        unread += 1;
        break;
      }
      for (const a of from.ids) for (const b of to.ids) if (a !== b) links.push(reversed ? { sourceId: b, targetId: a, label: text, technology: "" } : { sourceId: a, targetId: b, label: text, technology: "" });
      from = to;
    }
  }

  if (unread) skipped.push(`${unread} ${unread === 1 ? "line" : "lines"} could not be read`);
  // A group that holds groups is an area of the business; a group of boxes is a system.
  const holdsGroup = new Set([...groups].map((g) => nodes.get(g)!.parentId).filter((p): p is string => !!p));
  const elements: TextElement[] = [...nodes.values()].map((n) => {
    const name = (n.text ?? n.id).split("\n")[0];
    const typeId = groups.has(n.id) ? (holdsGroup.has(n.id) ? "domain" : "system") : (guessType(n.hint, n.text ?? n.id) ?? "application");
    return { id: n.id, name, typeId, description: (n.text ?? "").split("\n").slice(1).join(" "), technology: "", parentId: n.parentId, tags: [] };
  });
  return { title, elements, links, skipped };
}

/* ---------- C4 ---------- */

/** Splits "a, "b, c", $x="y"" at the commas outside quotes. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out.map((a) => a.trim());
}

const C4_TYPES: [RegExp, string][] = [
  [/^Person(_Ext)?$/, "actor"],
  [/^System(Db|Queue)?_Ext$/, "external-system"],
  [/^System(Db|Queue)?$/, "system"],
  [/^ContainerDb(_Ext)?$/, "database"],
  [/^ContainerQueue(_Ext)?$/, "queue"],
  [/^Container(_Ext)?$/, "application"],
  [/^Component(Db|Queue)?(_Ext)?$/, "component"],
  [/^Enterprise_Boundary$/, "domain"],
  [/^System_Boundary$/, "system"],
  [/^Container_Boundary$/, "application"],
  [/^Boundary$/, "system"],
  [/^(Deployment_)?Node(_L|_R)?$/, "server"],
];

export const APPLICATION_LEVEL = ["application", "web-app", "mobile-app", "service", "database", "queue", "cache", "storage", "gateway", "server", "cluster", "network"];

function readC4(source: string, skipped: string[]): TextModel {
  const elements: TextElement[] = [];
  const links: TextLink[] = [];
  const stack: string[] = [];
  let title = "";
  let unread = 0;
  const lines = source.split("\n").map((l) => l.trim());
  for (const line of lines.slice(1)) {
    if (!line) continue;
    if (/^title\b/.test(line)) {
      title = label(line.replace(/^title\s*/, ""));
      continue;
    }
    if (line === "}") {
      stack.pop();
      continue;
    }
    const call = /^(\w+)\s*\((.*)\)\s*(\{)?\s*$/.exec(line);
    if (!call) {
      unread += 1;
      continue;
    }
    const [, word, body, opens] = call;
    if (/^(Update\w+|Lay_\w+|SHOW_\w+|HIDE_\w+|Add\w+Tag|LAYOUT_\w+)$/.test(word)) continue;
    const args = splitArgs(body);
    const named = (key: string) => {
      const found = args.find((a) => a.startsWith(`$${key}=`));
      return found ? label(found.slice(key.length + 2)) : "";
    };
    const plain = args.filter((a) => !a.startsWith("$")).map(label);
    if (/^(BiRel|Rel)(_\w+)?$/.test(word) || word === "RelIndex") {
      const at = word === "RelIndex" ? 1 : 0;
      const [sourceId, targetId, text = "", technology = ""] = plain.slice(at);
      if (sourceId && targetId) links.push(word === "Rel_Back" ? { sourceId: targetId, targetId: sourceId, label: text, technology } : { sourceId, targetId, label: text, technology: technology || named("techn") });
      continue;
    }
    const typed = C4_TYPES.find(([pattern]) => pattern.test(word));
    if (!typed || !plain[0]) {
      unread += 1;
      continue;
    }
    const isNode = /Node/.test(word);
    const isContainer = /^(Container|Component)/.test(word) && !/Boundary/.test(word);
    const name = plain[1] || plain[0];
    // Person and System take (alias, label, description); Container and Component put the technology in between.
    const technology = isContainer ? (plain[2] ?? "") : isNode ? (plain[2] ?? "") : named("techn");
    const description = isContainer ? (plain[3] ?? "") : isNode ? (plain[3] ?? "") : /Boundary/.test(word) ? "" : (plain[2] ?? "");
    let typeId = typed[1];
    // A container or a node says only that it is one; what kind is guessed from its technology and name.
    if (word === "Container" || word === "Container_Ext" || isNode) {
      const guessed = guessType(technology, name);
      typeId = guessed && APPLICATION_LEVEL.includes(guessed) ? guessed : isNode ? "server" : "application";
    }
    elements.push({ id: plain[0], name: name.split("\n")[0], typeId, description: description || named("descr"), technology, parentId: stack.at(-1) ?? null, tags: [] });
    if (opens) stack.push(plain[0]);
  }
  if (unread) skipped.push(`${unread} ${unread === 1 ? "line" : "lines"} could not be read`);
  return { title, elements, links, skipped };
}

/** Reads the first flowchart or C4 diagram of a Mermaid or Markdown file. */
export function readMermaid(source: string): TextModel {
  const blocks = mermaidBlocks(source).map(withoutPreamble);
  const supported = blocks.filter((b) => SUPPORTED.test(b));
  if (!supported.length) {
    const kind = /^\s*([A-Za-z][\w-]*)/.exec(blocks[0] ?? "")?.[1];
    throw new DiagramFileError(
      kind && blocks.length && /^(sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey|mindmap|timeline|gitGraph)/.test(kind)
        ? `This is a Mermaid ${kind}. Only flowcharts (flowchart, graph) and C4 diagrams can be imported, because they are the ones that show systems and what connects them.`
        : "No Mermaid flowchart or C4 diagram was found in this file. It has to start with flowchart, graph or one of the C4 diagram names.",
    );
  }
  const skipped: string[] = [];
  if (supported.length > 1) skipped.push(`the file holds ${supported.length} diagrams and only the first was read`);
  const text = supported[0].replace(/^\s*\n/, "");
  const model = /^\s*C4/.test(text) ? readC4(text, skipped) : readFlowchart(text, skipped);
  if (!model.elements.length) throw new DiagramFileError("The diagram has no boxes to import.");
  return model;
}
