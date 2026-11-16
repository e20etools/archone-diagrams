import { DiagramFileError, guessType } from "./diagramFile";
import { APPLICATION_LEVEL, type TextElement, type TextLink, type TextModel } from "./mermaid";

/**
 * Structurizr DSL: the model block of a workspace file, read into elements and links.
 * Views, styles and documentation are left out; included files are not followed.
 */

type Token = { kind: "word" | "text" | "{" | "}" | "=" | "->"; value: string };

export function isStructurizr(source: string): boolean {
  return /^\s*(?:\/\/[^\n]*\n|#[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*workspace\b[^\n]*\{/.test(source) || (/\bmodel\s*\{/.test(source) && /\b(softwareSystem|person)\b/i.test(source));
}

/** Lines of tokens. A line ends at a line break outside quotes; "{" and "}" stay on their line. */
function tokenize(source: string): Token[][] {
  const text = source
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\\\n/g, " ");
  const lines: Token[][] = [];
  for (const raw of text.split("\n")) {
    const line: Token[] = [];
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];
      if (/\s/.test(ch)) {
        i += 1;
      } else if (ch === "#" || raw.startsWith("//", i)) {
        break;
      } else if (ch === '"') {
        let value = "";
        i += 1;
        while (i < raw.length && raw[i] !== '"') {
          if (raw[i] === "\\" && i + 1 < raw.length) i += 1;
          value += raw[i];
          i += 1;
        }
        i += 1;
        line.push({ kind: "text", value });
      } else if (ch === "{" || ch === "}" || ch === "=") {
        line.push({ kind: ch, value: ch });
        i += 1;
      } else if (raw.startsWith("->", i)) {
        line.push({ kind: "->", value: "->" });
        i += 2;
      } else {
        let value = "";
        while (i < raw.length && !/[\s{}="]/.test(raw[i]) && !raw.startsWith("->", i)) {
          value += raw[i];
          i += 1;
        }
        line.push({ kind: "word", value });
      }
    }
    if (line.length) lines.push(line);
  }
  return lines;
}

const ELEMENTS: Record<string, string> = {
  person: "actor",
  softwaresystem: "system",
  container: "application",
  component: "component",
  deploymentnode: "server",
  infrastructurenode: "server",
  element: "application",
};
const GROUPS = new Set(["group", "enterprise", "deploymentenvironment", "deploymentgroup"]);
const INSTANCES = new Set(["softwaresysteminstance", "containerinstance"]);

interface Frame {
  /** The element this block belongs to, when it is one. */
  elementId: string | null;
  /** True for blocks whose content is not model: views, styles, properties and the like. */
  skip: boolean;
  word: string;
}

export function readStructurizr(source: string): TextModel {
  const lines = tokenize(source);
  if (!lines.some((l) => l[0]?.kind === "word" && /^(workspace|model)$/i.test(l[0].value))) {
    throw new DiagramFileError("This does not look like a Structurizr DSL file. It has to hold a workspace with a model block.");
  }
  const elements: TextElement[] = [];
  const byId = new Map<string, TextElement>();
  const lookup = new Map<string, string>(); // identifier as written, and its hierarchical form, to element id
  const pending: { from: string; to: string; scope: string[]; label: string; technology: string }[] = [];
  const hosted: { what: string; node: string; scope: string[] }[] = [];
  const skipped: string[] = [];
  const stack: Frame[] = [];
  let title = "";
  let includes = 0;
  let count = 0;

  const scopeIds = () => stack.map((f) => f.elementId).filter((id): id is string => !!id);
  const strings = (tokens: Token[]) => tokens.filter((t) => t.kind === "text" || t.kind === "word").map((t) => t.value);

  for (const line of lines) {
    const opens = line.at(-1)?.kind === "{";
    const tokens = opens ? line.slice(0, -1) : line;
    const inside = stack.at(-1);
    if (tokens[0]?.kind === "}") {
      stack.pop();
      continue;
    }
    if (inside?.skip) {
      if (opens) stack.push({ elementId: null, skip: true, word: "" });
      continue;
    }
    if (!tokens.length) {
      if (opens) stack.push({ elementId: null, skip: false, word: "" });
      continue;
    }
    const first = tokens[0].value.toLowerCase();
    const push = (elementId: string | null, skip = false) => opens && stack.push({ elementId, skip, word: first });

    if (first === "workspace") {
      title = tokens[1]?.kind === "text" ? tokens[1].value : "";
      push(null);
      continue;
    }
    if (first === "model") {
      push(null);
      continue;
    }
    if (first === "!include" || first === "!docs" || first === "!adrs") {
      if (first === "!include") includes += 1;
      continue;
    }
    if (first.startsWith("!")) {
      push(null, !["!extend", "!ref", "!element"].includes(first));
      continue;
    }
    if (["views", "configuration", "properties", "perspectives", "styles", "branding", "terminology", "healthcheck", "users"].includes(first)) {
      push(null, true);
      continue;
    }

    // A relationship: "a -> b", or "-> b" from the element whose block this is.
    const arrow = tokens.findIndex((t) => t.kind === "->");
    if (arrow >= 0) {
      const scope = scopeIds();
      const from = arrow === 0 ? "this" : tokens[arrow - 1].value;
      const to = tokens[arrow + 1]?.value;
      const rest = tokens.slice(arrow + 2).filter((t) => t.kind === "text").map((t) => t.value);
      if (to) pending.push({ from, to, scope, label: rest[0] ?? "", technology: rest[1] ?? "" });
      push(null, true);
      continue;
    }

    // "identifier = keyword ..." or "keyword ...".
    const named = tokens[1]?.kind === "=";
    const identifier = named ? tokens[0].value : null;
    const body = named ? tokens.slice(2) : tokens;
    const word = body[0]?.value.toLowerCase() ?? "";
    const args = strings(body.slice(1));
    const parent = stack.at(-1)?.elementId ?? null;

    if (GROUPS.has(word)) {
      // A group at the top of the model is an area of the business; deeper down it only draws a frame.
      const top = scopeIds().length === 0 && (word === "group" || word === "enterprise");
      if (top && args[0]) {
        const id = `e${++count}`;
        const element: TextElement = { id, name: args[0], typeId: "domain", description: "", technology: "", parentId: null, tags: [] };
        elements.push(element);
        byId.set(id, element);
        if (identifier) lookup.set(identifier.toLowerCase(), id);
        push(id);
      } else push(parent);
      continue;
    }
    if (INSTANCES.has(word)) {
      if (args[0] && parent) hosted.push({ what: args[0], node: parent, scope: scopeIds() });
      push(null, true);
      continue;
    }
    if (word in ELEMENTS) {
      const [name = identifier ?? "", second = "", third = "", fourth = ""] = args;
      // person and softwareSystem: name, description, tags. The others carry a technology before the tags.
      const short = word === "person" || word === "softwaresystem";
      const isNode = word === "deploymentnode" || word === "infrastructurenode";
      const description = second;
      const technology = short ? "" : third;
      const tags = (short ? third : fourth).split(",").map((t) => t.trim()).filter(Boolean);
      const id = `e${++count}`;
      const element: TextElement = { id, name, typeId: ELEMENTS[word], description, technology, parentId: parent, tags };
      elements.push(element);
      byId.set(id, element);
      if (identifier) {
        lookup.set(identifier.toLowerCase(), id);
        const path = [...scopeIds().map((s) => [...lookup].find(([, v]) => v === s)?.[0]).filter(Boolean), identifier.toLowerCase()].join(".");
        lookup.set(path, id);
      }
      (element as TextElement & { kind?: string }).kind = isNode ? "node" : word;
      push(id);
      continue;
    }
    // Inside an element: its own properties.
    const element = parent ? byId.get(parent) : undefined;
    if (element && word === "description" && args[0]) element.description = args[0];
    else if (element && word === "technology" && args[0]) element.technology = args[0];
    else if (element && word === "tags") element.tags.push(...args.flatMap((a) => a.split(",")).map((t) => t.trim()).filter(Boolean));
    push(parent, !element);
  }

  // What kind of thing an element is can depend on tags and technology set inside its block, so it is settled last.
  for (const element of elements) {
    const kind = (element as TextElement & { kind?: string }).kind;
    delete (element as TextElement & { kind?: string }).kind;
    const tags = element.tags.map((t) => t.toLowerCase());
    if (kind === "softwaresystem" && tags.some((t) => /^(external|existing system|third party|3rd party|saas)$/.test(t))) element.typeId = "external-system";
    if (kind === "container" || kind === "node" || kind === "element") {
      const guessed = guessType(`${element.tags.join(" ")} ${element.technology}`, element.name);
      element.typeId = guessed && APPLICATION_LEVEL.includes(guessed) ? guessed : kind === "node" ? "server" : "application";
    }
    element.tags = [...new Set(tags.filter((t) => !/^(element|person|software system|container|component|database|external)$/.test(t)))];
  }

  const resolve = (name: string, scope: string[]): string | null => {
    const key = name.toLowerCase();
    if (key === "this") return scope.at(-1) ?? null;
    // With hierarchical identifiers a short name means the nearest element of that name.
    for (let depth = scope.length; depth > 0; depth--) {
      const prefix = scope.slice(0, depth).map((s) => [...lookup].find(([k, v]) => v === s && !k.includes("."))?.[0]);
      if (prefix.every(Boolean)) {
        const found = lookup.get([...prefix, key].join("."));
        if (found) return found;
      }
    }
    return lookup.get(key) ?? lookup.get(key.split(".").at(-1)!) ?? null;
  };

  const links: TextLink[] = [];
  let loose = 0;
  for (const p of pending) {
    const sourceId = resolve(p.from, p.scope);
    const targetId = resolve(p.to, p.scope);
    if (sourceId && targetId && sourceId !== targetId) links.push({ sourceId, targetId, label: p.label, technology: p.technology });
    else loose += 1;
  }
  for (const h of hosted) {
    const sourceId = resolve(h.what, h.scope);
    if (sourceId && byId.has(h.node)) links.push({ sourceId, targetId: h.node, label: "", technology: "", kind: "hosted_on" });
    else loose += 1;
  }

  if (loose) skipped.push(`${loose} ${loose === 1 ? "relationship names" : "relationships name"} something that is not in the file`);
  if (includes) skipped.push(`${includes} included ${includes === 1 ? "file was" : "files were"} not followed`);
  if (!elements.length) throw new DiagramFileError("The model block of this file has no people, systems or containers to import.");
  return { title, elements, links, skipped };
}
