// Writes src/components/libraryIcons.ts: one import per icon the component library names.
// Run after adding components: node scripts/library-icons.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lucide = createRequire(import.meta.url)("lucide-react");
const have = new Set(Object.keys(lucide.icons));
const source = ["src/lib/library/generic.ts", "src/lib/library/cloud.ts"].map((f) => readFileSync(join(root, f), "utf8")).join("\n");
const used = new Set(["Cloud"]);
for (const m of source.matchAll(/\[\s*"[^"]+",\s*"([A-Z][A-Za-z0-9]+)"/g)) used.add(m[1]);
for (const m of source.matchAll(/icon: "([A-Z][A-Za-z0-9]+)"/g)) used.add(m[1]);
const missing = [...used].filter((n) => !have.has(n));
if (missing.length) {
  console.error(`Not Lucide icons: ${missing.join(", ")}`);
  process.exit(1);
}
const names = [...used].sort();
writeFileSync(
  join(root, "src/components/libraryIcons.ts"),
  `/**
 * The icons the component library draws with, imported one by one so the bundle carries only
 * these. Written by scripts/library-icons.mjs from the names used in src/lib/library; a test
 * checks that every name the library uses is here.
 */
import {
${names.map((n) => `  ${n},`).join("\n")}
  type LucideIcon,
} from "lucide-react";

export const LIBRARY_ICONS: Record<string, LucideIcon> = {
${names.map((n) => `  ${n},`).join("\n")}
};
`,
);
console.log(`${names.length} icons`);
