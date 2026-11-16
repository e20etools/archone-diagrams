/** Reads delimited text into rows of cells. The delimiter (comma, semicolon or tab) is worked out from the first lines. */

function splitRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/, 6).join("\n");
  let best = ",";
  let bestScore = 0;
  for (const candidate of [",", ";", "\t", "|"]) {
    const widths = splitRows(sample, candidate)
      .filter((r) => r.some((cell) => cell !== ""))
      .map((r) => r.length);
    if (!widths.length) continue;
    // A real delimiter gives several columns, and the same number on every line.
    const score = widths.every((w) => w === widths[0]) ? widths[0] * 2 : Math.min(...widths);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  return splitRows(text, detectDelimiter(text)).filter((row) => row.some((cell) => cell.trim() !== ""));
}

/** Excel saves CSV in the system's own encoding in some regions; UTF-8 is tried first and falls back cleanly. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
