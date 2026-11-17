import { escapeXml, parseXml, type XmlNode } from "../import/xml";
import type { DecisionTable } from "../types";

/**
 * DMN decision tables: rules a business rule step applies, written with FEEL unary tests in each
 * input cell (>= 18, "gold", [1..5], not("closed"), - for anything), tested in the app and saved
 * as DMN 1.3 for any DMN engine.
 */

type Value = string | number | boolean | null;

function literal(raw: string, type: string): Value {
  const v = raw.trim();
  if (/^".*"$/.test(v)) return v.slice(1, -1);
  if (v === "true" || v === "false") return v === "true";
  if (v === "null") return null;
  if (/^date\("(.+)"\)$/.test(v)) return Date.parse(v.match(/^date\("(.+)"\)$/)![1]);
  if (type === "date" && !Number.isNaN(Date.parse(v))) return Date.parse(v);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function input(raw: string, type: string): Value {
  const v = raw.trim();
  if (!v) return null;
  if (type === "number") return Number(v);
  if (type === "boolean") return /^(true|yes|1)$/i.test(v);
  if (type === "date") return Date.parse(v);
  return v;
}

/** Splits on commas outside quotes, brackets and parentheses. */
function splitTests(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    if (!quoted && "([".includes(c)) depth++;
    if (!quoted && ")]".includes(c)) depth--;
    if (c === "," && !quoted && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Whether a value passes a FEEL unary test. */
export function passes(test: string, value: Value, type = "string"): boolean {
  const t = test.trim();
  if (!t || t === "-") return true;
  const not = t.match(/^not\s*\((.*)\)$/s);
  if (not) return !passes(not[1], value, type);
  const tests = splitTests(t);
  if (tests.length > 1) return tests.some((x) => passes(x, value, type));
  const range = t.match(/^([[\](])\s*(.+?)\s*\.\.\s*(.+?)\s*([\])[])$/);
  if (range) {
    const lo = literal(range[2], type);
    const hi = literal(range[3], type);
    if (typeof value !== "number" || typeof lo !== "number" || typeof hi !== "number") return false;
    const lowOk = range[1] === "[" ? value >= lo : value > lo;
    const highOk = range[4] === "]" ? value <= hi : value < hi;
    return lowOk && highOk;
  }
  const cmp = t.match(/^(<=|>=|<|>|=|!=)\s*(.+)$/);
  if (cmp) {
    const other = literal(cmp[2], type);
    if (cmp[1] === "=") return value === other;
    if (cmp[1] === "!=") return value !== other;
    if (typeof value !== "number" || typeof other !== "number") return false;
    return cmp[1] === "<" ? value < other : cmp[1] === "<=" ? value <= other : cmp[1] === ">" ? value > other : value >= other;
  }
  const expected = literal(t, type);
  if (typeof expected === "string" && typeof value === "string") return expected.toLowerCase() === value.toLowerCase();
  return expected === value;
}

export interface Evaluation {
  /** Every rule whose conditions hold. */
  matched: number[];
  /** The rules the hit policy takes the answer from. */
  chosen: number[];
  outputs: Record<string, string>[];
  /** Said when the hit policy is broken: two rules where one may match, or none. */
  problem: string;
}

/** The rules that apply to these inputs, and what the table answers, by its hit policy. */
export function evaluate(table: DecisionTable, values: Record<string, string>): Evaluation {
  const matched: number[] = [];
  table.rules.forEach((rule, i) => {
    if (table.inputs.every((inp, j) => passes(rule.inputs[j] ?? "-", input(values[inp.id] ?? "", inp.type), inp.type))) matched.push(i);
  });
  const answer = (i: number) => Object.fromEntries(table.outputs.map((o, j) => [o.label, String(literal(table.rules[i].outputs[j] ?? "", o.type) ?? "")]));
  let problem = "";
  if (!matched.length) problem = "No rule applies to these values.";
  let chosen = matched;
  if (table.hitPolicy === "UNIQUE" && matched.length > 1) problem = `Rules ${matched.map((i) => i + 1).join(" and ")} both apply, but the table says only one may.`;
  if (table.hitPolicy === "ANY" && matched.length > 1 && new Set(matched.map((i) => JSON.stringify(answer(i)))).size > 1) problem = "The rules that apply give different answers, but the table says any of them may be taken.";
  if (["UNIQUE", "FIRST", "ANY", "PRIORITY"].includes(table.hitPolicy)) chosen = matched.slice(0, 1);
  return { matched, chosen, outputs: chosen.map(answer), problem };
}

/** Rules that can never be reached under FIRST, or that duplicate another: worth a look. */
export function tableFindings(table: DecisionTable): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  table.rules.forEach((r, i) => {
    const key = r.inputs.map((c) => c.trim() || "-").join("|");
    if (seen.has(key)) out.push(`Rule ${i + 1} has the same conditions as rule ${seen.get(key)! + 1}.`);
    else seen.set(key, i);
    if (table.hitPolicy === "FIRST" && i < table.rules.length - 1 && r.inputs.every((c) => !c.trim() || c.trim() === "-")) out.push(`Rule ${i + 1} applies to everything, so the rules after it are never used.`);
    if (r.outputs.some((c) => !c.trim())) out.push(`Rule ${i + 1} has an empty answer.`);
  });
  return out;
}

const typeRef = (t: string) => (t === "number" ? "number" : t === "boolean" ? "boolean" : t === "date" ? "date" : "string");
const ref = (raw: string) => raw.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1");

export function toDmn(table: DecisionTable): string {
  const id = ref(table.id);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="Definitions_${id}" name="${escapeXml(table.name)}" namespace="https://archone.app/dmn">`,
    `  <decision id="${id}" name="${escapeXml(table.name)}">`,
    `    <decisionTable id="${id}_table" hitPolicy="${table.hitPolicy === "RULE ORDER" ? "RULE ORDER" : table.hitPolicy === "OUTPUT ORDER" ? "OUTPUT ORDER" : table.hitPolicy}">`,
    ...table.inputs.map((i) => `      <input id="${ref(i.id)}" label="${escapeXml(i.label)}">\n        <inputExpression id="${ref(i.id)}_expr" typeRef="${typeRef(i.type)}">\n          <text>${escapeXml(ref(i.label))}</text>\n        </inputExpression>\n      </input>`),
    ...table.outputs.map((o) => `      <output id="${ref(o.id)}" label="${escapeXml(o.label)}" name="${escapeXml(ref(o.label))}" typeRef="${typeRef(o.type)}" />`),
    ...table.rules.map((r) =>
      [
        `      <rule id="${ref(r.id)}">`,
        ...(r.note ? [`        <description>${escapeXml(r.note)}</description>`] : []),
        ...table.inputs.map((_, j) => `        <inputEntry id="${ref(r.id)}_in${j}"><text>${escapeXml(r.inputs[j]?.trim() || "-")}</text></inputEntry>`),
        ...table.outputs.map((_, j) => `        <outputEntry id="${ref(r.id)}_out${j}"><text>${escapeXml(r.outputs[j] ?? "")}</text></outputEntry>`),
        `      </rule>`,
      ].join("\n"),
    ),
    `    </decisionTable>`,
    `  </decision>`,
    `</definitions>`,
    "",
  ].join("\n");
}

const find = (n: XmlNode, name: string): XmlNode[] => [...n.children.filter((c) => c.name === name), ...n.children.flatMap((c) => find(c, name))];
const textOf = (n: XmlNode | undefined) => (n ? (n.children.find((c) => c.name === "text")?.text ?? n.text ?? "").trim() : "");

/** The decision tables in a DMN file. */
export function fromDmn(source: string): DecisionTable[] {
  const root = parseXml(source);
  if (root.name !== "definitions") throw new Error("This is not a DMN file.");
  const asType = (t?: string): DecisionTable["inputs"][number]["type"] => (t === "number" || t === "integer" || t === "double" || t === "long" ? "number" : t === "boolean" ? "boolean" : t === "date" || t === "dateTime" ? "date" : "string");
  return find(root, "decision").flatMap((d) => {
    const t = find(d, "decisionTable")[0];
    if (!t) return [];
    const inputs = t.children.filter((c) => c.name === "input").map((i, k) => ({ id: i.attrs.id || `in${k}`, label: i.attrs.label || textOf(i.children.find((c) => c.name === "inputExpression")) || `Input ${k + 1}`, type: asType(i.children.find((c) => c.name === "inputExpression")?.attrs.typeRef) }));
    const outputs = t.children.filter((c) => c.name === "output").map((o, k) => ({ id: o.attrs.id || `out${k}`, label: o.attrs.label || o.attrs.name || `Output ${k + 1}`, type: asType(o.attrs.typeRef) }));
    const rules = t.children
      .filter((c) => c.name === "rule")
      .map((r, k) => ({ id: r.attrs.id || `rule${k}`, inputs: r.children.filter((c) => c.name === "inputEntry").map(textOf), outputs: r.children.filter((c) => c.name === "outputEntry").map(textOf), note: (r.children.find((c) => c.name === "description")?.text ?? "").trim() }));
    const policy = (t.attrs.hitPolicy || "UNIQUE").toUpperCase() as DecisionTable["hitPolicy"];
    return [{ id: d.attrs.id || `decision${rules.length}`, name: d.attrs.name || "Decision", hitPolicy: ["UNIQUE", "FIRST", "PRIORITY", "ANY", "COLLECT", "RULE ORDER", "OUTPUT ORDER"].includes(policy) ? policy : "UNIQUE", inputs, outputs, rules }];
  });
}
