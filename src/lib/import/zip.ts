/**
 * Reads and writes zip archives, which is what .xlsx and .vsdx files are. Reading inflates with
 * the browser's own DecompressionStream; writing stores files uncompressed, which every reader
 * accepts. Kept small on purpose: no encryption, no zip64, no multi-part archives.
 */

export class ZipError extends Error {}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** Raw deflate, as used inside zip files and by draw.io's compressed diagrams. */
export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new ZipError("This browser cannot open compressed files. Use a current version of Chrome, Edge, Firefox or Safari.");
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new ZipError("The file is damaged: part of it could not be unpacked.");
  }
}

/** Upper bounds, so a small file cannot unpack into something that exhausts the browser. */
const MAX_ENTRIES = 5000;
const MAX_UNPACKED = 200 * 1024 * 1024;

/** The files in a zip archive, by path. Folders are left out. */
export async function readZip(bytes: Uint8Array, wanted: (path: string) => boolean = () => true): Promise<Map<string, Uint8Array>> {
  // The directory of a zip is at its end; find the record that points to it.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError("This is not a valid file of this type: its contents list is missing.");
  const count = u16(bytes, end + 10);
  let at = u32(bytes, end + 16);
  if (count > MAX_ENTRIES) throw new ZipError("The file holds too many parts to open safely.");
  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || u32(bytes, at) !== 0x02014b50) throw new ZipError("The file is damaged: its contents list cannot be read.");
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const packed = u32(bytes, at + 20);
    const unpacked = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const local = u32(bytes, at + 42);
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith("/") || !wanted(path)) continue;
    if (flags & 1) throw new ZipError("The file is password-protected. Save a copy without a password and import that.");
    if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) throw new ZipError("The file is damaged: one of its parts is missing.");
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    const data = bytes.subarray(start, start + packed);
    total += unpacked;
    if (total > MAX_UNPACKED) throw new ZipError("The file is too large to open here once unpacked.");
    if (method === 0) files.set(path, data);
    else if (method === 8) files.set(path, await inflateRaw(data));
    else throw new ZipError("The file uses a kind of compression this application cannot read.");
  }
  return files;
}

let crcTable: Uint32Array | undefined;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Builds a zip archive. Files are stored as they are unless `deflate` is given (the tests
 * use it to make archives like the ones Office writes).
 */
export function writeZip(files: Record<string, Uint8Array | string>, deflate?: (data: Uint8Array) => Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  const header = (size: number) => {
    const bytes = new Uint8Array(size);
    return { bytes, view: new DataView(bytes.buffer) };
  };
  for (const [path, content] of Object.entries(files)) {
    const data = typeof content === "string" ? encoder.encode(content) : content;
    const stored = deflate ? deflate(data) : data;
    const name = encoder.encode(path);
    const crc = crc32(data);
    const local = header(30);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x0800, true); // names are UTF-8
    local.view.setUint16(8, deflate ? 8 : 0, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, stored.length, true);
    local.view.setUint32(22, data.length, true);
    local.view.setUint16(26, name.length, true);
    parts.push(local.bytes, name, stored);

    const entry = header(46);
    entry.view.setUint32(0, 0x02014b50, true);
    entry.view.setUint16(4, 20, true);
    entry.view.setUint16(6, 20, true);
    entry.view.setUint16(8, 0x0800, true);
    entry.view.setUint16(10, deflate ? 8 : 0, true);
    entry.view.setUint32(16, crc, true);
    entry.view.setUint32(20, stored.length, true);
    entry.view.setUint32(24, data.length, true);
    entry.view.setUint16(28, name.length, true);
    entry.view.setUint32(42, offset, true);
    directory.push(entry.bytes, name);
    offset += 30 + name.length + stored.length;
  }
  const directorySize = directory.reduce((n, p) => n + p.length, 0);
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, Object.keys(files).length, true);
  end.view.setUint16(10, Object.keys(files).length, true);
  end.view.setUint32(12, directorySize, true);
  end.view.setUint32(16, offset, true);
  const all = [...parts, ...directory, end.bytes];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
