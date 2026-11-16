/**
 * A small XML reader for the files this application imports (Excel, Visio, draw.io). It reads
 * well-formed XML into a tree of elements. It does not validate, resolve external entities or
 * load anything from the network, so a hostile file can do nothing but fail to parse.
 */

export class XmlError extends Error {}

export interface XmlNode {
  /** The tag name without a namespace prefix: "c" for both <c> and <x:c>. */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** The text directly inside this element, with entities decoded. */
  text: string;
}

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED[body] ?? whole;
  });
}

const local = (name: string) => (name.includes(":") ? name.slice(name.indexOf(":") + 1) : name);

export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = source.length;
  while (i < n) {
    const open = source.indexOf("<", i);
    const top = stack[stack.length - 1];
    if (open < 0) {
      top.text += decodeEntities(source.slice(i));
      break;
    }
    if (open > i) top.text += decodeEntities(source.slice(i, open));
    if (source.startsWith("<!--", open)) {
      const close = source.indexOf("-->", open + 4);
      if (close < 0) throw new XmlError("The file is damaged: a comment is not closed.");
      i = close + 3;
    } else if (source.startsWith("<![CDATA[", open)) {
      const close = source.indexOf("]]>", open + 9);
      if (close < 0) throw new XmlError("The file is damaged: a text block is not closed.");
      top.text += source.slice(open + 9, close);
      i = close + 3;
    } else if (source.startsWith("<?", open)) {
      const close = source.indexOf("?>", open + 2);
      if (close < 0) throw new XmlError("The file is damaged: its header is not closed.");
      i = close + 2;
    } else if (source.startsWith("<!", open)) {
      // A document type declaration. Skipped whole, including any internal subset: entities it declares are never expanded.
      let depth = 0;
      let j = open + 2;
      for (; j < n; j++) {
        if (source[j] === "[") depth++;
        else if (source[j] === "]") depth--;
        else if (source[j] === ">" && depth <= 0) break;
      }
      i = j + 1;
    } else if (source[open + 1] === "/") {
      const close = source.indexOf(">", open + 2);
      if (close < 0 || stack.length < 2) throw new XmlError("The file is damaged: a closing tag has no opening tag.");
      stack.pop();
      i = close + 1;
    } else {
      // An opening tag. Attribute values may contain ">" so the end is found by walking the quotes.
      let j = open + 1;
      let quote = "";
      for (; j < n; j++) {
        const ch = source[j];
        if (quote) {
          if (ch === quote) quote = "";
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === ">") break;
      }
      if (j >= n) throw new XmlError("The file is damaged: a tag is not closed.");
      const selfClosing = source[j - 1] === "/";
      const body = source.slice(open + 1, selfClosing ? j - 1 : j);
      const space = body.search(/\s/);
      const node: XmlNode = { name: local(space < 0 ? body : body.slice(0, space)), attrs: {}, children: [], text: "" };
      if (space >= 0) {
        const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(body.slice(space)))) node.attrs[local(match[1])] = decodeEntities(match[2] ?? match[3] ?? "");
      }
      top.children.push(node);
      if (!selfClosing) {
        if (stack.length > 400) throw new XmlError("The file is nested too deeply to read.");
        stack.push(node);
      }
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw new XmlError("The file is damaged: a tag is not closed.");
  const first = root.children[0];
  if (!first) throw new XmlError("The file is empty.");
  return first;
}

export const child = (node: XmlNode | undefined, name: string): XmlNode | undefined => node?.children.find((c) => c.name === name);
export const children = (node: XmlNode | undefined, name: string): XmlNode[] => node?.children.filter((c) => c.name === name) ?? [];
/** Every element with this name anywhere below the node, in document order. */
export function descendants(node: XmlNode, name: string, found: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.name === name) found.push(c);
    descendants(c, name, found);
  }
  return found;
}
/** All the text inside an element, including the text of the elements inside it. */
export function allText(node: XmlNode): string {
  return node.text + node.children.map(allText).join("");
}

export const escapeXml = (text: string) =>
  text
    // Characters XML does not allow at all.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
