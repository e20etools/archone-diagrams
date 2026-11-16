// Entry for the bundled pull-request gate (see scripts/build-api.mjs). Runs on Node 20 or newer, with no dependencies.
import { appendFileSync, readFileSync } from "node:fs";
import { gateMarkdown, gateProposal, readDeclarations, runGate, type GateReport } from "../src/lib/gate/gate";

const HELP = `archone-gate: checks the connections a repository declares against the architecture model.

Usage: node archone-gate.mjs [--file archone.json] [--unknown warn|fail] [--propose]

  --file      The declaration: {"system": "...", "connections": [{"to": "...", "protocol": "HTTPS"}]}. Default: archone.json
  --unknown   What a connection the model does not know does to the result. Default: warn
  --propose   File the connections the model does not know as a proposal for a person to review.

Environment:
  ARCHONE_API_URL   The REST API of the workspace, for example https://<project>.supabase.co/functions/v1/api/v1
  ARCHONE_API_KEY   An API key of the workspace. Read access is enough; --propose needs a key that may propose.
  ARCHONE_SOURCE    Optional: where the change comes from. In GitHub Actions the pull request's address is used.

Exit code: 0 passed, 1 did not pass, 2 could not run.`;

function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith("--") ? process.argv[at + 1] : fallback;
}
function finish(markdown: string, code: number): never {
  console.log(markdown);
  // GitHub Actions shows this file's content on the run's summary page.
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    } catch {
      // The summary is a convenience; the log above has the same text.
    }
  }
  process.exit(code);
}
const stopped = (problem: string): never => finish(gateMarkdown({ rows: [], counts: { yes: 0, no: 0, unknown: 0 }, failed: true, problems: [problem] }), 2);

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  const file = option("file", "archone.json");
  const unknown = option("unknown", "warn") === "fail" ? "fail" : "warn";
  const base = (process.env.ARCHONE_API_URL ?? "").replace(/\/$/, "");
  const key = process.env.ARCHONE_API_KEY ?? "";
  if (!base || !key) stopped("Set ARCHONE_API_URL and ARCHONE_API_KEY. Run with --help for what they are.");

  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    stopped(`The declaration file ${file} could not be read.`);
  }
  const { declarations, problems } = readDeclarations(text);
  if (problems.length) finish(gateMarkdown({ rows: [], counts: { yes: 0, no: 0, unknown: 0 }, failed: true, problems }), 2);

  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    return { status: response.status, data };
  };
  let model: Awaited<ReturnType<typeof call>>;
  try {
    model = await call("GET", "/model");
  } catch {
    return stopped("The architecture model could not be reached. Check ARCHONE_API_URL.");
  }
  if (model.status !== 200) stopped(`The model could not be read (status ${model.status}): ${model.data?.error?.message ?? "no reason given"}.`);

  const report: GateReport = runGate(model.data, declarations, { unknown });
  let proposal: { id?: string; filed: boolean; note?: string } | undefined;
  if (process.argv.includes("--propose")) {
    const pull = /^refs\/pull\/(\d+)\//.exec(process.env.GITHUB_REF ?? "")?.[1];
    const source = process.env.ARCHONE_SOURCE || (process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}${pull ? `/pull/${pull}` : ""}` : "");
    const body = gateProposal(report, source);
    if (body) {
      const filed = await call("POST", "/proposals", body).catch(() => null);
      proposal = filed && filed.status === 201 ? { filed: true, id: String((filed.data as { id?: unknown } | null)?.id ?? "") } : { filed: false, note: `The proposal could not be filed${filed ? ` (status ${filed.status}): ${filed.data?.error?.message ?? ""}` : ""}.` };
    }
  }
  finish(gateMarkdown(report, proposal), report.failed ? 1 : 0);
}

main().catch((error: unknown) => stopped(`The gate stopped: ${error instanceof Error ? error.message : String(error)}`));
