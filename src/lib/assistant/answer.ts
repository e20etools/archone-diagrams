/**
 * The assistant's answer as blocks to draw: paragraphs, headings, lists, small tables and code,
 * with object tags [[id]] and diagram tags [[d:id]] as links. Only this small part of Markdown is
 * read; everything else stays text, so nothing in an answer can become markup.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "object"; id: string }
  | { kind: "diagram"; id: string }
  | { kind: "break" };

export type Block =
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "heading"; inline: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; items: { inline: Inline[]; level: number }[] }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "code"; text: string };

const TOKEN = /(\[\[(d:)?([^\][\s]{1,80})\]\])|(\*\*([^*\n]+?)\*\*)|(`([^`\n]+)`)/g;

export function parseInline(text: string, bold = true): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > at) out.push({ kind: "text", text: text.slice(at, m.index) });
    if (m[1]) out.push(m[2] ? { kind: "diagram", id: m[3] } : { kind: "object", id: m[3] });
    else if (m[4]) out.push(bold ? { kind: "bold", children: parseInline(m[5], false) } : { kind: "text", text: m[5] });
    else if (m[6]) out.push({ kind: "code", text: m[7] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

const BULLET = /^(\s*)([-*•])\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => parseInline(c.trim()));

export function parseAnswer(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (!paragraph.length) return;
    const inline: Inline[] = [];
    paragraph.forEach((line, i) => {
      if (i > 0) inline.push({ kind: "break" });
      inline.push(...parseInline(line.trim()));
    });
    blocks.push({ kind: "paragraph", inline });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim() || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", inline: parseInline(heading[1].replace(/#+\s*$/, "").trim()) });
      continue;
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      flush();
      const header = cells(line);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flush();
      const m = (bullet ?? numbered)!;
      const ordered = !!numbered;
      const item = { inline: parseInline(m[3]), level: m[1].replace(/\t/g, "  ").length >= 2 ? 1 : 0 };
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list" && (last.ordered === ordered || item.level > 0)) last.items.push(item);
      else blocks.push({ kind: "list", ordered, start: numbered ? Number(numbered[2]) : 1, items: [item] });
      continue;
    }
    // A line that carries on a list item, indented under it.
    const last = blocks[blocks.length - 1];
    if (!paragraph.length && last?.kind === "list" && /^\s{2,}\S/.test(line)) {
      last.items[last.items.length - 1].inline.push({ kind: "break" }, ...parseInline(line.trim()));
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** The objects and diagrams an answer names, in order, once each. */
export function tagsIn(text: string): { objectIds: string[]; diagramIds: string[] } {
  const objectIds: string[] = [];
  const diagramIds: string[] = [];
  for (const m of text.matchAll(/\[\[(d:)?([^\][\s]{1,80})\]\]/g)) {
    const list = m[1] ? diagramIds : objectIds;
    if (!list.includes(m[2])) list.push(m[2]);
  }
  return { objectIds, diagramIds };
}
