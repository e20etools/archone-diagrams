import { allText, child, children, descendants, escapeXml, parseXml } from "./xml";
import { readZip, writeZip } from "./zip";

/** Reads and writes Excel workbooks (.xlsx) as plain rows of text: what a bulk import or export needs, nothing more. */

export interface Sheet {
  name: string;
  rows: string[][];
}

export class SheetError extends Error {}

const text = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : "");

/** "A" is 0, "Z" is 25, "AA" is 26. */
function columnIndex(reference: string): number {
  let n = 0;
  for (const ch of reference) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}
function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** Excel stores dates as a count of days; number formats tell which numbers are dates. */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
function serialToDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(serial);
  const iso = date.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
}

const MAX_ROWS = 20000;
const MAX_COLUMNS = 200;

export async function readXlsx(bytes: Uint8Array): Promise<Sheet[]> {
  const files = await readZip(bytes, (path) => path.startsWith("xl/") && !path.includes("/media/"));
  const workbookXml = files.get("xl/workbook.xml");
  if (!workbookXml) throw new SheetError("This does not look like an Excel workbook. Save it as .xlsx or .csv and try again.");
  const workbook = parseXml(text(workbookXml));

  const shared: string[] = [];
  const sharedXml = files.get("xl/sharedStrings.xml");
  if (sharedXml) for (const item of children(parseXml(text(sharedXml)), "si")) shared.push(richText(item));

  // Which numbers are dates: the cell style points at a number format.
  const dateStyles = new Set<number>();
  const stylesXml = files.get("xl/styles.xml");
  if (stylesXml) {
    const styles = parseXml(text(stylesXml));
    const custom = new Map<number, string>();
    for (const f of children(child(styles, "numFmts"), "numFmt")) custom.set(Number(f.attrs.numFmtId), f.attrs.formatCode ?? "");
    children(child(styles, "cellXfs"), "xf").forEach((xf, i) => {
      const id = Number(xf.attrs.numFmtId ?? 0);
      const code = (custom.get(id) ?? "").replace(/\[[^\]]*\]|"[^"]*"/g, "");
      if (DATE_FORMATS.has(id) || (custom.has(id) && /[dyhs]|mm/i.test(code) && !/[0#]/.test(code))) dateStyles.add(i);
    });
  }

  // Sheet names live in the workbook; the file of each sheet is found through the relationships part.
  const targets = new Map<string, string>();
  const relsXml = files.get("xl/_rels/workbook.xml.rels");
  if (relsXml) for (const r of children(parseXml(text(relsXml)), "Relationship")) targets.set(r.attrs.Id, r.attrs.Target ?? "");
  const sheets: Sheet[] = [];
  const listed = children(child(workbook, "sheets"), "sheet");
  for (const [index, entry] of listed.entries()) {
    if (entry.attrs.state === "hidden" || entry.attrs.state === "veryHidden") continue;
    const target = targets.get(entry.attrs.id ?? "") ?? `worksheets/sheet${index + 1}.xml`;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    const sheetXml = files.get(path);
    if (!sheetXml) continue;
    const rows: string[][] = [];
    for (const row of children(child(parseXml(text(sheetXml)), "sheetData"), "row")) {
      const rowIndex = row.attrs.r ? Number(row.attrs.r) - 1 : rows.length;
      if (rowIndex >= MAX_ROWS) throw new SheetError(`The sheet "${entry.attrs.name}" has more than ${MAX_ROWS} rows. Split it into smaller files.`);
      const cells: string[] = [];
      let next = 0;
      for (const cell of children(row, "c")) {
        const column = cell.attrs.r ? columnIndex(cell.attrs.r) : next;
        next = column + 1;
        if (column < 0 || column >= MAX_COLUMNS) continue;
        cells[column] = cellText(cell, shared, dateStyles);
      }
      while (rows.length < rowIndex) rows.push([]);
      rows[rowIndex] = Array.from(cells, (c) => c ?? "");
    }
    const filled = rows.filter((r) => r.some((c) => c.trim() !== ""));
    if (filled.length) sheets.push({ name: entry.attrs.name ?? `Sheet ${index + 1}`, rows: filled });
  }
  return sheets;
}

function richText(item: Parameters<typeof allText>[0]): string {
  // Phonetic guides (rPh) sit beside the text in some languages and are not part of it.
  const direct = child(item, "t");
  if (direct && !children(item, "r").length) return allText(direct);
  return item.children
    .filter((c) => c.name === "t" || c.name === "r")
    .map((c) => (c.name === "t" ? allText(c) : descendants(c, "t").map(allText).join("")))
    .join("");
}

function cellText(cell: Parameters<typeof allText>[0], shared: string[], dateStyles: Set<number>): string {
  const type = cell.attrs.t ?? "n";
  if (type === "inlineStr") return richText(child(cell, "is") ?? cell);
  const value = child(cell, "v");
  if (!value) return "";
  const raw = allText(value);
  if (type === "s") return shared[Number(raw)] ?? "";
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  if (type === "e") return "";
  if (type === "n" && raw !== "") {
    const number = Number(raw);
    if (!Number.isFinite(number)) return raw;
    if (dateStyles.has(Number(cell.attrs.s ?? -1))) return serialToDate(number);
    // 0.1 + 0.2 is stored as 0.30000000000000004; show what the person typed.
    return String(Number(number.toPrecision(15)));
  }
  return raw;
}

/** Writes a workbook where every cell is text and the first row of each sheet is a bold, frozen header. */
export function writeXlsx(sheets: Sheet[]): Uint8Array {
  const safeName = (name: string, i: number) => (name.replace(/[\\/?*[\]:]/g, " ").trim() || `Sheet ${i + 1}`).slice(0, 31);
  const files: Record<string, string> = {};
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  files["[Content_Types].xml"] =
    `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    "</Types>";
  files["_rels/.rels"] = `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  files["xl/workbook.xml"] =
    `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>` +
    sheets.map((s, i) => `<sheet name="${escapeXml(safeName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    "</sheets></workbook>";
  files["xl/_rels/workbook.xml.rels"] =
    `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  files["xl/styles.xml"] =
    `${head}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  sheets.forEach((sheet, index) => {
    const widths = (sheet.rows[0] ?? []).map((_, c) => Math.min(60, Math.max(10, ...sheet.rows.slice(0, 200).map((r) => (r[c] ?? "").length + 2))));
    const rows = sheet.rows
      .map((row, r) => `<row r="${r + 1}">${row.map((value, c) => (value === "" ? "" : `<c r="${columnName(c)}${r + 1}" t="inlineStr" s="${r === 0 ? 1 : 0}"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`)).join("")}</row>`)
      .join("");
    files[`xl/worksheets/sheet${index + 1}.xml`] =
      `${head}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
      `${widths.length ? `<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : ""}<sheetData>${rows}</sheetData></worksheet>`;
  });
  return writeZip(files);
}
