// End-to-end check of the built app in a real browser: `npm run build && npm run test:browser`.
// It serves the production build twice with `vite preview`: once without an AI key (built-in rules),
// and once pointed at a local stand-in for an AI provider, so the AI path runs without a real key.
// Set CHROME_PATH if Chrome is not at the default location. Screenshots go to ./screenshots.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import puppeteer from "puppeteer-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shots = join(root, "screenshots");
const chrome =
  process.env.CHROME_PATH ||
  ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
if (!chrome) throw new Error("Chrome was not found. Set CHROME_PATH to its location.");
if (!existsSync(join(root, "dist/index.html"))) throw new Error("Build the app first: npm run build");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function preview(port, env = {}) {
  const child = spawn(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("vite preview did not start")), 20000);
    child.stdout.on("data", (d) => {
      if (String(d).includes(String(port))) {
        clearTimeout(timer);
        ok(child);
      }
    });
    child.on("exit", (code) => fail(new Error(`vite preview exited with ${code}`)));
  });
}

/** A stand-in for an OpenAI-compatible provider. It records what it was sent. */
function fakeProvider(port) {
  const seen = [];
  const draft = {
    objects: [
      { key: "o1", name: "Clinic portal", typeId: "application", description: "Patients book visits here", technology: "React", parentKey: null },
      { key: "o2", name: "Booking service", typeId: "service", description: "", technology: "Node.js", parentKey: null },
      { key: "o3", name: "Appointments database", typeId: "database", description: "", technology: "PostgreSQL", parentKey: null },
    ],
    relationships: [
      { sourceKey: "o1", targetKey: "o2", kind: "calls", label: "books visits" },
      { sourceKey: "o2", targetKey: "o3", kind: "reads_writes", label: "" },
    ],
    notes: "",
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const sent = JSON.parse(body || "{}");
      seen.push({ url: req.url, auth: req.headers.authorization, body: sent });
      res.setHeader("content-type", "application/json");
      // A question about the model: answer by citing an object found in the model text that came with it.
      if (String(sent.messages?.[0]?.content ?? "").startsWith("You answer questions")) {
        const sentContent = sent.messages[1].content;
        const text = typeof sentContent === "string" ? sentContent : sentContent[0].text;
        const id = /^(\S+) \| Booking service \|/m.exec(text)?.[1] ?? "missing";
        res.end(JSON.stringify({ choices: [{ message: { content: `Nothing in the model says so.\n- [[${id}]] holds the bookings.\n- [[obj_invented]] is made up.` } }] }));
        return;
      }
      // The assistant hides a connection, shows it again from what the app says is not drawn, and is asked to delete the diagram.
      if (String(sent.messages?.[0]?.content ?? "").includes("EDITING THE DIAGRAM\n") && /أخف الاتصال|أظهر الاتصال|احذف المخطط/.test(String(sent.messages.at(-1).content))) {
        const system = sent.messages[0].content;
        const asked = String(sent.messages.at(-1).content);
        const hiddenId = /connection id (rel_\w+)[^\n]*\| not drawn: hidden on this diagram/.exec(system)?.[1] ?? "missing";
        const plan = asked.includes("أخف")
          ? { apply: [{ op: "hide_connection", from: "Web server 1", to: "Booking service" }] }
          : asked.includes("أظهر")
            ? { apply: [{ op: "show_connection", id: hiddenId }] }
            : { apply: [{ op: "delete_diagram" }] };
        const content = `${asked.includes("احذف") ? "حذف المخطط كاملاً يحتاج موافقتك." : "تم."}\n\n\`\`\`archone-changes\n${JSON.stringify(plan)}\n\`\`\``;
        res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 900 } }));
        return;
      }
      // The assistant asked to change the diagram on screen: add a server and connect it, hold a removal for a yes, suggest two fixes.
      if (String(sent.messages?.[0]?.content ?? "").includes("EDITING THE DIAGRAM\n") && /خادم ويب|web server/i.test(String(sent.messages.at(-1).content))) {
        const system = sent.messages[0].content;
        const booking = /^\s*\[\[(\S+?)\]\] Booking service \|/m.exec(system)?.[1] ?? "missing";
        const portal = /^\s*\[\[(\S+?)\]\] Clinic portal \|/m.exec(system)?.[1] ?? "missing";
        const plan = {
          apply: [
            { op: "add_object", ref: "n1", name: "Web server 1", type: "server", technology: "IIS 10", fields: { "IP address": "10.0.1.5", "Operating system": "Windows Server 2022" } },
            { op: "connect", from: "n1", to: booking, kind: "calls", protocols: [{ name: "HTTP", port: 80, transport: "TCP" }], encrypted: "no" },
          ],
          confirm: [{ op: "hide_object", id: portal }],
          suggest: [
            { op: "update_connection", from: "n1", to: booking, protocols: [{ name: "HTTPS", port: "443", transport: "TCP" }], encrypted: "yes" },
            { say: "Give Web server 1 an owner", ops: [{ op: "update_object", id: "n1", owner: "Infrastructure" }] },
          ],
        };
        const content = `أضفت خادم الويب وربطته بخدمة [[${booking}]].\n\n**تنبيه:** الاتصال غير مشفر، وهذا يخالف ضوابط NCA ECC.\n\nهل تريد إخفاء [[${portal}]] من هذا المخطط؟\n\n\`\`\`archone-changes\n${JSON.stringify(plan)}\n\`\`\``;
        res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 1500 } }));
        return;
      }
      // The assistant: answer from the workspace that came in the instruction, naming the diagram on screen and an object on it.
      if (String(sent.messages?.[0]?.content ?? "").startsWith("You are the assistant inside ArchONE Diagrams")) {
        const system = sent.messages[0].content;
        const diagram = /^DIAGRAM \[\[d:(\S+?)\]\]/m.exec(system)?.[1] ?? /^\[\[d:(\S+?)\]\]/m.exec(system)?.[1] ?? "missing";
        const object = /^\s*\[\[(\S+?)\]\] Booking service \|/m.exec(system)?.[1] ?? "missing";
        const last = sent.messages.at(-1).content;
        const content = /[؀-ۿ]/.test(last)
          ? `يعرض المخطط [[d:${diagram}]] الخدمة [[${object}]].\n- **البروتوكولات**: غير مسجلة\n\n| Object | Owner |\n|---|---|\n| [[${object}]] | - |`
          : `**[[d:${diagram}]]** shows [[${object}]] and two more objects.\n- Nothing records its protocols yet.\n- [[obj_invented]] is not real.`;
        res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 1200 } }));
        return;
      }
      // A business process described in words: answer with steps, lanes and flows.
      if (String(sent.messages?.[0]?.content ?? "").startsWith("You turn a description of a business process")) {
        const process = {
          name: "Clinic visit",
          lanes: ["Reception", "Doctor"],
          steps: [
            { id: "s", name: "Patient arrives", type: "startEvent", lane: "Reception" },
            { id: "a", name: "Check the patient in", type: "userTask", lane: "Reception", minutes: 5 },
            { id: "b", name: "Examine the patient", type: "userTask", lane: "Doctor", minutes: 20 },
            { id: "e", name: "Visit done", type: "endEvent", lane: "Doctor" },
          ],
          flows: [{ from: "s", to: "a" }, { from: "a", to: "b" }, { from: "b", to: "e" }],
          notes: "Assumed one doctor.",
        };
        res.end(JSON.stringify({ choices: [{ message: { content: "```json\n" + JSON.stringify(process) + "\n```" } }] }));
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { content: "```json\n" + JSON.stringify(draft) + "\n```" } }] }));
    });
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, seen })));
}

/** Opens the Export window if it is not open, downloads one format, and waits until it is made. */
const exportAs = async (page, id) => {
  if (!(await page.$("[data-export-window]"))) {
    await page.click("[data-export-open]");
    await page.waitForSelector("[data-export-window]");
  }
  await page.click(`[data-export="${id}"]`);
  await page.waitForFunction(() => !document.querySelector("[data-export]:disabled"), { timeout: 60000 });
};
const closeExport = (page) => page.evaluate(() => [...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim() === "Done")?.click());
const clickText = (page, text, selector = "button, a, [role=menuitem], [role=tab]") =>
  page.evaluate(
    (text, selector) => {
      const el = [...document.querySelectorAll(selector)].find((e) => e.textContent.trim() === text && !e.disabled);
      if (!el) return false;
      el.click();
      return true;
    },
    text,
    selector,
  );
const waitText = (page, text, timeout = 8000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
const hasText = (page, text) => page.evaluate((t) => document.body.innerText.includes(t), text);
const count = (page, selector) => page.$$eval(selector, (els) => els.length);
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) });

async function newPage(browser, errors) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // A host without an AI key answers 501 on purpose; the browser logs that as a failed request.
    if (m.type() === "error" && !/status of 501/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return page;
}

await mkdir(shots, { recursive: true });
const downloads = await mkdtemp(join(tmpdir(), "archone-dl-"));
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const servers = [];
const errors = [];

try {
  /* ---------- pass 1: no AI key ---------- */
  const base = "http://127.0.0.1:4311";
  servers.push(await preview(4311, { AI_PROVIDER: "", AI_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", LOVABLE_API_KEY: "" }));
  const page = await newPage(browser, errors);
  const session = await page.createCDPSession();
  await session.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });

  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("archone.workspace.v1")));
  await page.goto(base, { waitUntil: "networkidle0" });
  await waitText(page, "Start your architecture model");
  check("first visit shows a way to start", true);
  await shot(page, "01-empty");

  await clickText(page, "Load the sample model");
  await page.waitForSelector(".object-node");
  await sleep(600);
  const sampleNodes = await count(page, ".object-node");
  check("sample model opens on a diagram with boxes and arrows", sampleNodes >= 4 && (await count(page, ".react-flow__edge")) >= 3, `${sampleNodes} boxes`);
  check("scoped diagram draws its boundary", (await count(page, ".boundary-node")) === 1);
  const sampleEdges = await count(page, ".react-flow__edge");
  await shot(page, "02-editor");

  // A connection: which way it goes, moving on the canvas, and its protocols and ports.
  {
    const movingBefore = await count(page, ".react-flow__edge.traffic-out");
    const edgeId = await page.$eval(".react-flow__edge.traffic", (e) => e.getAttribute("data-id"));
    await page.evaluate((id) => {
      const path = document.querySelector(`.react-flow__edge[data-id="${id}"] .react-flow__edge-interaction`) ?? document.querySelector(`.react-flow__edge[data-id="${id}"] path`);
      path.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }, edgeId);
    await page.waitForSelector("[data-connection-properties]");
    await page.$eval('[data-connection-properties] [data-flow="both"]', (b) => b.click());
    await page.type('[data-connection-properties] input[aria-label="Add a protocol"]', "LDAPS");
    await page.click("[data-protocol-add]");
    await page.type('[data-connection-properties] input[aria-label="Add a protocol"]', "HTTP");
    await page.click("[data-protocol-add]");
    await sleep(400);
    const rel = (await stored()).relationships[edgeId];
    const drawn = await page.$eval(`.react-flow__edge[data-id="${edgeId}"]`, (e) => ({ both: e.classList.contains("traffic-both"), markers: !!e.querySelector("path[marker-start]") && !!e.querySelector("path[marker-end]") }));
    const labelText = await page.evaluate(() => [...document.querySelectorAll(".edge-label")].map((l) => l.textContent).join(" | "));
    const warning = await page.$eval("[data-connection-properties]", (e) => e.innerText.includes("does not encrypt by itself"));
    await shot(page, "02b-connection");
    check(
      "a connection goes both ways, moves on the canvas, and carries more than one protocol and port",
      movingBefore > 0 && rel.flow === "both" && rel.protocols?.map((p) => `${p.name}:${p.port}`).join(",") === "LDAPS:636,HTTP:80" && drawn.both && drawn.markers && labelText.includes("LDAPS 636/TCP") && warning,
      JSON.stringify({ movingBefore, flow: rel.flow, protocols: rel.protocols, drawn, warning }),
    );
    // The network it runs over gives the line its colour, explained in a legend on the canvas.
    const runsOver = '[data-connection-properties] input[aria-label="Runs over"]';
    await page.click(runsOver);
    await page.type(runsOver, "mpls vpn");
    await page.keyboard.press("Tab");
    await page.waitForSelector(`.react-flow__edge.network-edge[data-id="${edgeId}"]`);
    const stroke = await page.$eval(`.react-flow__edge[data-id="${edgeId}"] .react-flow__edge-path`, (p) => getComputedStyle(p).stroke);
    const legend = await page.$$eval("[data-network-kind]", (items) => items.map((i) => i.getAttribute("data-network-kind")));
    const said = await page.$eval("[data-network-shown]", (e) => e.getAttribute("data-network-shown"));
    await shot(page, "02c-network-colour");
    check("a line takes the colour of the network it runs over, named in a legend", stroke === "rgb(14, 116, 144)" && legend.join() === "MPLS" && said === "MPLS", `${stroke}; ${legend.join()}; ${said}`);
    await page.click(runsOver, { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => !document.querySelector("[data-network-legend]"));
    await page.$eval('[data-connection-properties] [data-flow="out"]', (b) => b.click());
    await page.evaluate(() => document.querySelectorAll('[data-connection-properties] [aria-label^="Remove "]').forEach((b) => b.click()));
    await page.evaluate(() => document.querySelector('[data-connection-properties] [aria-label^="Remove "]')?.click());
    await sleep(300);
    await page.keyboard.press("Escape");
  }

  // Select a box and edit it in the inspector.
  await page.click(".object-node");
  await page.waitForSelector('aside[aria-label="Details"] h2');
  const picked = await page.$eval('aside[aria-label="Details"] h2', (e) => e.textContent);
  check("clicking a box opens its details", !!picked, picked);
  await shot(page, "03-inspector");

  // Add a new object from the palette, then undo it.
  const before = await count(page, ".object-node");
  await clickText(page, "Database");
  await page.waitForFunction((n) => document.querySelectorAll(".object-node").length === n + 1, {}, before);
  check("adding a type from the palette creates an object", true);
  await page.click('button[aria-label="Undo (Ctrl Z)"]');
  await page.waitForFunction((n) => document.querySelectorAll(".object-node").length === n, {}, before);
  check("undo removes it again", true);

  // Tidy layout must not lose anything.
  await clickText(page, "Tidy layout");
  await sleep(500);
  check("tidy layout keeps every box", (await count(page, ".object-node")) === before);

  // Exports.
  for (const id of ["mermaid", "plantuml", "csv-objects", "csv-relationships", "json", "png", "svg", "pdf"]) {
    await exportAs(page, id);
    await sleep(id === "pdf" ? 1500 : 600);
  }
  const exportGroups = await page.$$eval("[data-export-window] h3", (hs) => hs.map((h) => h.textContent));
  const exportIds = await page.$$eval("[data-export]", (bs) => bs.map((b) => b.dataset.export));
  await shot(page, "34-export-window");
  check(
    "the Export window offers every format, grouped",
    exportGroups.length === 4 && ["png", "svg", "pdf", "pptx", "html", "gif", "video", "json", "mermaid", "xlsx", "drawio", "structurizr", "archimate", "calm", "plantuml"].every((id) => exportIds.includes(id)),
    exportIds.join(","),
  );
  for (const id of ["pptx", "html", "gif", "video", "xlsx", "drawio", "structurizr", "archimate"]) {
    await exportAs(page, id);
    await sleep(500);
  }
  await closeExport(page);
  const files = await readdir(downloads);
  const has = (ext) => files.some((f) => f.endsWith(ext));
  const fileOf = (end) => files.find((f) => f.endsWith(end));
  const pptxFile = fileOf(".pptx");
  const pptxZip = pptxFile ? await JSZip.loadAsync(await readFile(join(downloads, pptxFile))) : null;
  const exportSlides = pptxZip ? Object.keys(pptxZip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length : 0;
  const htmlText = fileOf(".html") ? await readFile(join(downloads, fileOf(".html")), "utf8") : "";
  const gifBytes = fileOf(".gif") ? await readFile(join(downloads, fileOf(".gif"))) : Buffer.alloc(0);
  const videoFile = files.find((f) => f.endsWith(".mp4") || f.endsWith(".webm"));
  const videoSize = videoFile ? (await readFile(join(downloads, videoFile))).length : 0;
  const drawioText = fileOf(".drawio") ? await readFile(join(downloads, fileOf(".drawio")), "utf8") : "";
  const dslText = fileOf(".dsl") ? await readFile(join(downloads, fileOf(".dsl")), "utf8") : "";
  const archimateText = fileOf("-archimate.xml") ? await readFile(join(downloads, fileOf("-archimate.xml")), "utf8") : "";
  const xlsxFile = fileOf(".xlsx");
  check(
    "PowerPoint, interactive HTML, GIF, video, Excel, draw.io, Structurizr and ArchiMate come out as real files",
    exportSlides >= 4 &&
      htmlText.startsWith("<!doctype html>") && htmlText.includes('id="data"') && htmlText.includes("\\u003csvg") &&
      gifBytes.subarray(0, 6).toString() === "GIF89a" && gifBytes.length > 5000 &&
      videoSize > 5000 &&
      drawioText.includes("<mxGraphModel") && (drawioText.match(/vertex="1"/g) ?? []).length >= 3 &&
      dslText.startsWith("workspace") && dslText.includes("views {") &&
      archimateText.includes("http://www.opengroup.org/xsd/archimate") &&
      !!xlsxFile,
    `${exportSlides} slides, gif ${gifBytes.length} bytes, ${videoFile} ${videoSize} bytes, html ${htmlText.startsWith("<!doctype html>")}/${htmlText.includes('id="data"')}, drawio ${(drawioText.match(/vertex="1"/g) ?? []).length}, dsl ${dslText.slice(0, 20)}, archimate ${archimateText.slice(0, 160).replace(/\s+/g, " ")}, xlsx ${!!xlsxFile}`,
  );
  // The interactive page opens on its own and shows a box's details on a click.
  {
    const viewer = await newPage(browser, errors);
    await viewer.goto(`file://${join(downloads, fileOf(".html"))}`);
    await viewer.waitForSelector("#stage svg g");
    const box = await viewer.$eval("#stage svg g rect", (r) => { const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
    await viewer.mouse.click(box.x, box.y);
    await sleep(200);
    const shown = await viewer.$eval("#side h2", (h) => h.textContent).catch(() => "");
    await viewer.type("#q", "a");
    check("the interactive HTML opens offline and shows a box's details when clicked", !!shown, shown);
    await viewer.close();
  }
  check(
    "all eight export formats download as files",
    has(".mmd") && has(".puml") && has("-objects.csv") && has("-relationships.csv") && has(".json") && has(".png") && has(".svg") && has(".pdf"),
    files.join(", "),
  );
  // The later checks look for their own slides and pages; these are put aside.
  for (const f of await readdir(downloads)) if (/\.(pptx|html|gif|mp4|webm|xlsx|drawio|dsl)$|-archimate\.xml$/.test(f)) await rm(join(downloads, f));
  const svg = files.find((f) => f.endsWith(".svg"));
  if (svg) check("SVG export contains the drawing", (await readFile(join(downloads, svg), "utf8")).includes("<svg"));
  const pdf = files.find((f) => f.endsWith(".pdf"));
  if (pdf) check("PDF export is a PDF", (await readFile(join(downloads, pdf))).subarray(0, 5).toString() === "%PDF-");
  const mermaid = files.find((f) => f.endsWith(".mmd"));
  if (mermaid) check("Mermaid export is a flowchart", (await readFile(join(downloads, mermaid), "utf8")).startsWith("flowchart"));
  const png = files.find((f) => f.endsWith(".png"));
  if (png) {
    check("PNG export is a real image", (await readFile(join(downloads, png))).length > 8000);
    await copyFile(join(downloads, png), join(shots, "export-sample.png"));
  }

  // Notations: the same diagram drawn in ArchiMate and in BPMN.
  const drawnBefore = await count(page, ".object-node");
  await page.click('button[aria-label="Diagram settings"]');
  await page.waitForSelector('select[aria-label="Notation"]');
  await page.select('select[aria-label="Notation"]', "archimate");
  await sleep(300);
  const layers = await page.$$eval('.object-node[data-notation="archimate"]', (els) => [...new Set(els.map((e) => e.dataset.layer))].sort().join());
  const notationOf = async () => Object.values((await stored()).diagrams).find((d) => d.notation && d.notation !== "plain")?.notation;
  check("a diagram switches to ArchiMate: boxes take their layer and name their element", (await count(page, '.object-node[data-notation="archimate"]')) === drawnBefore && layers.includes("application") && (await hasText(page, "Application component")) && (await notationOf()) === "archimate", layers);
  await shot(page, "15-archimate");
  await page.select('select[aria-label="Notation"]', "bpmn");
  await sleep(300);
  await exportAs(page, "bpmn");
  await closeExport(page);
  await sleep(500);
  const bpmnFile = (await readdir(downloads)).find((f) => f.endsWith(".bpmn"));
  check("a diagram drawn in BPMN exports as a BPMN 2.0 file", !!bpmnFile && (await readFile(join(downloads, bpmnFile), "utf8")).includes("http://www.omg.org/spec/BPMN/20100524/MODEL") && (await notationOf()) === "bpmn");
  await page.select('select[aria-label="Notation"]', "plain");
  await sleep(200);
  check("back in plain boxes nothing of the notation remains", (await count(page, ".object-node[data-notation]")) === 0 && (await count(page, ".object-node")) === drawnBefore);
  await clickText(page, "Close panel", "button[aria-label]").catch(() => {});
  await page.evaluate(() => document.querySelector('button[aria-label="Close panel"]')?.click());

  // Share link, open and password-protected.
  await clickText(page, "Share");
  await waitText(page, "Create link");
  await clickText(page, "Create link");
  await page.waitForSelector('input[aria-label="Share link"]');
  const openLink = await page.$eval('input[aria-label="Share link"]', (e) => e.value);
  await page.type('input[type="password"]', "blueprint-42");
  await clickText(page, "Create link");
  await page.waitForSelector('input[aria-label="Share link"]');
  const lockedLink = await page.$eval('input[aria-label="Share link"]', (e) => e.value);
  check("share links are created", openLink.includes("/share#1p.") && lockedLink.includes("/share#1e."), `${openLink.length} characters`);
  await clickText(page, "Done");

  const viewer = await newPage(await browser.createBrowserContext(), errors);
  await viewer.goto(openLink, { waitUntil: "networkidle0" });
  await viewer.waitForSelector(".object-node");
  await sleep(500);
  check("open link shows the same diagram to someone with no data", (await count(viewer, ".object-node")) === before, `${await count(viewer, ".object-node")} boxes`);
  check("the shared view draws the same arrows", (await count(viewer, ".react-flow__edge")) === sampleEdges, `${await count(viewer, ".react-flow__edge")} of ${sampleEdges} arrows`);
  check("shared view is marked view only and has no editing tools", (await viewer.evaluate(() => document.body.innerText.includes("View only") && !document.body.innerText.includes("Tidy layout"))));
  await shot(viewer, "04-shared-view");
  await viewer.goto("about:blank");
  await viewer.goto(lockedLink, { waitUntil: "networkidle0" });
  await waitText(viewer, "This diagram is protected");
  await viewer.type('input[type="password"]', "wrong");
  await clickText(viewer, "Open diagram");
  await waitText(viewer, "That password does not open this link");
  await viewer.focus('input[type="password"]');
  await viewer.keyboard.down("Control");
  await viewer.keyboard.press("KeyA");
  await viewer.keyboard.up("Control");
  await viewer.keyboard.press("Backspace");
  await viewer.type('input[type="password"]', "blueprint-42");
  await clickText(viewer, "Open diagram");
  await viewer.waitForSelector(".object-node");
  check("protected link opens only with the right password", true);
  await viewer.goto("about:blank");
  await viewer.goto(`${base}/share#1p.not-a-real-link`, { waitUntil: "networkidle0" });
  await waitText(viewer, "This link cannot be opened");
  check("a damaged link is explained instead of crashing", true);
  await viewer.close();

  // A second view of the same model, then editing on the canvas.
  await page.goto(base, { waitUntil: "networkidle0" });
  await clickText(page, "New diagram");
  await page.waitForSelector("[data-new-kind]");
  await sleep(200);
  // The keyboard starts on the chosen kind; arrows move through the kinds and Enter goes on.
  check("the dialog opens with the keyboard on the chosen kind of diagram", await page.evaluate(() => !!document.activeElement?.matches('[role=dialog] [data-view-type="landscape"]')));
  await page.keyboard.press("ArrowRight");
  const movedTo = await page.evaluate(() => document.activeElement?.getAttribute("data-view-type"));
  await page.keyboard.press("ArrowLeft");
  const kindView = await page.evaluate(() => ({
    categories: [...document.querySelectorAll("[data-view-category]")].map((e) => e.getAttribute("data-view-category")).join(","),
    kinds: [...document.querySelectorAll("[data-view-type]")].map((e) => e.getAttribute("data-view-type")).join(","),
    thumbs: document.querySelectorAll("[data-view-type] svg").length,
    name: document.querySelector('input[aria-label="Diagram name"]').value,
    starts: document.querySelector("[data-starts-with]").textContent,
  }));
  await shot(page, "29-new-diagram-kind");
  check(
    "the kinds are shown by category with a picture each, a suggested name and what the diagram starts with",
    movedTo === "context" && kindView.categories === "applications,data,infrastructure,business,custom" && kindView.kinds === "landscape,context,container" && kindView.thumbs === 3 && kindView.name === "System landscape" && /Starts with \d+ objects/.test(kindView.starts),
    JSON.stringify({ movedTo, ...kindView }),
  );
  await page.$eval("[data-view-category=business]", (b) => b.click());
  const businessDefaults = await page.evaluate(() => ({ kind: document.querySelector("[data-view-type][aria-checked=true]")?.getAttribute("data-view-type"), direction: document.querySelector("[data-direction][aria-checked=true]")?.getAttribute("data-direction"), name: document.querySelector('input[aria-label="Diagram name"]').value }));
  check("choosing Business picks its kind, reads left to right and names it", businessDefaults.kind === "business" && businessDefaults.direction === "LR" && businessDefaults.name === "Business process", JSON.stringify(businessDefaults));
  await page.$eval("[data-view-category=applications]", (b) => b.click());
  await page.$eval('[data-view-type="landscape"]', (b) => b.click());
  await page.$eval('input[aria-label="Diagram name"]', (e) => e.select());
  await page.keyboard.press("Backspace");
  const nameRequired = await page.evaluate(() => ({ note: !!document.querySelector("[data-name-required]"), blocked: document.querySelector("[data-new-next]").disabled }));
  check("a diagram cannot be made without a name", nameRequired.note && nameRequired.blocked, JSON.stringify(nameRequired));
  await page.type('input[aria-label="Diagram name"]', "Landscape check");
  await page.$eval('[data-view-type="landscape"]', (b) => b.focus());
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-new-ways]");
  const ways = await page.$$eval("[data-new-ways] [data-way]", (els) => els.map((e) => e.dataset.way));
  check("after the kind, nine ways to build the diagram are offered", ways.join(",") === "manual,wizard,existing,template,text,voice,image,import,archived", ways.join(","));
  await shot(page, "30-new-diagram-ways");
  await page.click('[data-way="manual"]');
  await page.waitForSelector(".object-node");
  await sleep(600);
  const landscapeNodes = await count(page, ".object-node");
  check("a new landscape view fills itself from the model", landscapeNodes >= 3, `${landscapeNodes} boxes`);
  const landscape = async () => Object.values((await stored()).diagrams).find((d) => d.name === "Landscape check");

  const movedId = await page.$eval(".react-flow__node-object", (e) => e.dataset.id);
  const movedBox = await (await page.$(`.react-flow__node[data-id="${movedId}"]`)).boundingBox();
  const start = (await landscape()).nodes[movedId];
  await page.mouse.move(movedBox.x + movedBox.width / 2, movedBox.y + movedBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(movedBox.x + movedBox.width / 2 + 120, movedBox.y + movedBox.height / 2 + 70, { steps: 10 });
  await page.mouse.up();
  await sleep(600);
  const placed = (await landscape()).nodes[movedId];
  check("dragging a box moves it and remembers the place", placed.pinned && (placed.x !== start.x || placed.y !== start.y), `${start.x},${start.y} to ${placed.x},${placed.y}`);
  await clickText(page, "Tidy layout");
  await sleep(600);
  const tidied = (await landscape()).nodes;
  check("tidy layout leaves the hand-placed box where it is", tidied[movedId].x === placed.x && tidied[movedId].y === placed.y);

  const objectCount = Object.keys((await stored()).objects).length;
  await page.evaluate((mime) => {
    const target = document.querySelector(".react-flow").parentElement;
    const data = new DataTransfer();
    data.setData(mime, JSON.stringify({ kind: "type", id: "queue" }));
    const rect = target.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, clientX: rect.left + 180, clientY: rect.top + 160, dataTransfer: data };
    target.dispatchEvent(new DragEvent("dragover", init));
    target.dispatchEvent(new DragEvent("drop", init));
  }, "application/x-archone-item");
  await page.waitForFunction((n) => document.querySelectorAll(".object-node").length === n + 1, {}, landscapeNodes);
  await sleep(500);
  const afterDrop = await stored();
  const droppedObject = Object.values(afterDrop.objects).find((o) => o.typeId === "queue" && o.name === "New queue or stream");
  check("dropping a type on the canvas creates a model object where it was dropped", Object.keys(afterDrop.objects).length === objectCount + 1 && !!droppedObject && (await landscape()).nodes[droppedObject.id].pinned);

  // Draw a relationship by dragging from one box to another.
  const relationshipCount = Object.keys(afterDrop.relationships).length;
  const from = await (await page.$(`.react-flow__node[data-id="${movedId}"] .react-flow__handle.source`)).boundingBox();
  const to = await (await page.$(`.react-flow__node[data-id="${droppedObject.id}"] .react-flow__handle.target`)).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  await sleep(600);
  const afterConnect = await stored();
  const drawn = Object.values(afterConnect.relationships).find((r) => r.sourceId === movedId && r.targetId === droppedObject.id);
  check("dragging from one box to another stores a relationship", Object.keys(afterConnect.relationships).length === relationshipCount + 1 && !!drawn, drawn ? drawn.kind : "");
  check("the new arrow opens for editing", await page.evaluate(() => document.querySelector('aside[aria-label="Details"]')?.innerText.includes("Relationship")));
  await shot(page, "04b-editing");

  // Model page and search.
  await page.goto(`${base}/model`, { waitUntil: "networkidle0" });
  await waitText(page, "Every component and dependency");
  const rows = await count(page, "tbody tr");
  check("model lists the objects", rows >= 8, `${rows} rows`);
  await page.type('input[aria-label="Filter the list"]', "type:database");
  await sleep(300);
  const filtered = await count(page, "tbody tr");
  check("type: filter narrows the list", filtered > 0 && filtered < rows, `${filtered} rows`);
  await page.click("tbody tr");
  await page.waitForSelector('aside[aria-label="Object details"]');
  await shot(page, "05-model");

  // Dependencies and impact.
  await clickText(page, "Dependencies", 'aside[aria-label="Object details"] button');
  await waitText(page, "What needs it");
  await page.waitForSelector(".object-node");
  await sleep(500);
  check("dependency page draws a map around the chosen object", (await count(page, '.object-node[data-highlight="focus"]')) === 1);
  check("the dependency map draws the arrows between the boxes", (await count(page, ".react-flow__edge")) >= (await count(page, ".object-node")) - 1, `${await count(page, ".react-flow__edge")} arrows`);
  await shot(page, "06-dependencies");
  await clickText(page, "Impact of a change", "[role=tab]");
  await waitText(page, "Objects affected");
  await page.evaluate(() => [...document.querySelectorAll("label")].find((l) => l.textContent.includes("is retired"))?.click());
  await waitText(page, "Relationships that break");
  check("impact report lists who is affected", (await count(page, "tbody tr")) >= 1);
  await shot(page, "07-impact");

  // Impact and dependencies: five levels, across diagrams, and what if it stops.
  const impactObject = new URL(page.url()).searchParams.get("object");
  await page.goto(`${base}/impact?object=${impactObject}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-impact-links]");
  await page.waitForSelector(".object-node");
  await sleep(400);
  const impactCount = () => page.$eval('[data-impact-stat="impact"] .text-2xl', (e) => Number(e.textContent));
  const impactAll = await impactCount();
  check("the impact page marks the component and what depends on it on a map", impactAll >= 1 && (await count(page, '.object-node[data-highlight="focus"]')) >= 1 && (await count(page, '.object-node[data-highlight="down"]')) >= 1, `${impactAll} depend on it`);
  await page.click('[data-impact-levels="1"]');
  await sleep(300);
  const impactOne = await impactCount();
  check("one level shows only what depends on it directly", impactOne >= 1 && impactOne <= impactAll && (await count(page, '[data-impact-list="impact"] [data-impact-step]')) === impactOne, `${impactOne} at level 1, ${impactAll} in five`);
  await page.click('[data-impact-levels="5"]');
  await shot(page, "07b-impact-levels");
  await clickText(page, "What if it stops", "[role=tab]");
  await page.waitForSelector("[data-whatif-risk]");
  const riskRank = { low: 0, medium: 1, high: 2, critical: 3 };
  const riskNow = () => page.$eval("[data-whatif-risk]", (e) => e.getAttribute("data-whatif-risk"));
  const riskBefore = await riskNow();
  await page.select("[data-whatif-likelihood]", "5");
  await sleep(200);
  const riskAfter = await riskNow();
  const whatIfCounts = await page.evaluate(() => ({ affected: Number(document.querySelector("[data-whatif-affected]").getAttribute("data-whatif-affected")), remedies: Number(document.querySelector("[data-whatif-remedies]").getAttribute("data-whatif-remedies")) }));
  check("what if it stops lists the affected components with how bad, and what to do", whatIfCounts.affected >= 1 && whatIfCounts.remedies >= 1, `${whatIfCounts.affected} affected, ${whatIfCounts.remedies} remedies`);
  check("a likelier failure is a higher risk", riskRank[riskAfter] >= riskRank[riskBefore] && riskAfter !== "low", `${riskBefore} then ${riskAfter}`);
  await page.select("[data-whatif-impact]", "1");
  await sleep(200);
  check("the impact level can be set by hand, and the risk follows", (await riskNow()) === "low" || (await riskNow()) === "medium");
  await page.click("[data-whatif-export=md]");
  let report = "";
  for (let i = 0; i < 25 && !report; i++) {
    await sleep(200);
    report = (await readdir(downloads)).find((f) => f.startsWith("what-if-") && f.endsWith(".md")) ?? "";
  }
  const reportText = report ? await readFile(join(downloads, report), "utf8") : "";
  check("the scenario is downloaded as a report with risk, affected and what to do", reportText.includes("Risk:") && reportText.includes("## Affected") && reportText.includes("## What to do"), report || "no file");
  if (report) await rm(join(downloads, report));
  await page.click("[data-whatif-save]");
  await sleep(200);
  check("a scenario can be saved and is listed", (await count(page, "[data-whatif-saved] li button.text-blueprint")) === 1);
  await shot(page, "07c-what-if");
  await clickText(page, "Diagram", "[data-impact-picker] [role=tab]");
  await page.waitForSelector("[data-impact-option]");
  await page.click("[data-impact-option]");
  await page.waitForFunction(() => document.querySelector("[data-impact-subject]")?.textContent.startsWith("Diagram"));
  await page.waitForSelector("[data-whatif-stopped]");
  check("a whole diagram can be stopped in a scenario", new URL(page.url()).searchParams.has("diagram") && (await count(page, "[data-whatif-stopped]")) === 1);
  await clickText(page, "Library component", "[data-impact-picker] [role=tab]");
  await page.waitForSelector("[data-impact-option]");
  await page.click("[data-impact-option]");
  await page.waitForFunction(() => document.querySelector("[data-impact-subject]")?.textContent.startsWith("Library component"));
  await clickText(page, "Dependencies and impact", "[role=tab]");
  await page.waitForSelector("[data-impact-links]");
  check("a library component is analysed through every object that uses it", new URL(page.url()).searchParams.has("component") && (await count(page, '[data-impact-stat]')) === 4);

  // All diagrams on one map.
  await page.goto(`${base}/map`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-map-node]");
  await sleep(500);
  const liveDiagrams = Object.values((await stored()).diagrams).filter((d) => !d.archive?.archived).length;
  const mapNodes = await count(page, "[data-map-node]");
  check("the map shows every diagram, with the links between them", mapNodes === liveDiagrams && (await count(page, ".react-flow__edge")) >= 1, `${mapNodes} diagrams, ${await count(page, ".react-flow__edge")} links`);
  const mapIds = await page.$$eval("[data-map-node]", (els) => els.map((e) => e.getAttribute("data-map-node")));
  await page.click(`[data-map-node="${mapIds[0]}"]`);
  await page.waitForSelector("[data-map-selected]");
  check("a diagram picked shows what it impacts and depends on, and dims the rest", (await hasText(page, "Impacts (")) && (await hasText(page, "Depends on (")) && (await count(page, '[data-map-node][data-highlight="focus"]')) === 1);
  await page.keyboard.down("Shift");
  await page.click(`[data-map-node="${mapIds[1]}"]`);
  await page.keyboard.up("Shift");
  await page.waitForSelector("[data-map-picked]");
  check("shift-click picks several and lists the links between them", (await page.$eval("[data-map-picked]", (e) => e.getAttribute("data-map-picked"))) === "2" && (await hasText(page, "Links between them")));
  await page.click("[data-map-only-selected]");
  await sleep(300);
  check("the map can show only the diagrams picked", (await count(page, "[data-map-node]")) === 2);
  await page.click("[data-map-only-selected]");
  await page.click("[data-map-clear]");
  await sleep(200);
  const toggle = await page.$("[data-map-toggle]");
  if (toggle) {
    await toggle.click();
    await page.waitForSelector("[data-map-components] li");
  }
  check("a diagram opens to show the components that link it to others", !!toggle && (await count(page, "[data-map-components] li")) >= 1);
  const mapCategories = await page.$$eval("[data-map-node]", (els) => els.length);
  await page.click('[data-map-category="applications"]');
  await sleep(300);
  const withoutApps = await count(page, "[data-map-node]");
  await page.click('[data-map-category="applications"]');
  check("kinds of diagram can be hidden from the map", withoutApps < mapCategories, `${mapCategories} then ${withoutApps}`);
  await page.click("[data-map-reset]");
  await sleep(400);
  await page.click("[data-map-export-open]");
  await page.waitForSelector("[data-map-export-menu]");
  const mapFiles = [];
  for (const id of ["csv", "mermaid", "drawio", "png"]) {
    if (!(await page.$("[data-map-export-menu]"))) await page.click("[data-map-export-open]");
    await page.waitForSelector(`[data-map-export="${id}"]`);
    await page.click(`[data-map-export="${id}"]`);
    let got = "";
    const ext = { csv: ".csv", mermaid: ".mmd", drawio: ".drawio", png: ".png" }[id];
    for (let i = 0; i < 40 && !got; i++) {
      await sleep(200);
      got = (await readdir(downloads)).find((f) => f.startsWith("all-diagrams-") && f.endsWith(ext)) ?? "";
    }
    if (got) mapFiles.push(got);
  }
  const mapCsv = mapFiles.find((f) => f.endsWith(".csv"));
  const mapCsvText = mapCsv ? await readFile(join(downloads, mapCsv), "utf8") : "";
  check("the map exports as CSV, Mermaid, draw.io and PNG", mapFiles.length === 4 && mapCsvText.startsWith("From diagram,To diagram,Kind"), mapFiles.join(", "));
  for (const f of mapFiles) await rm(join(downloads, f));
  await page.click("[data-map-fullscreen]");
  await sleep(500);
  const wentFull = await page.evaluate(() => !!document.fullscreenElement);
  if (wentFull) {
    await page.click("[data-map-fullscreen]");
    await sleep(300);
  }
  check("the map goes full screen and back", wentFull && !(await page.evaluate(() => !!document.fullscreenElement)));
  await shot(page, "07d-all-diagrams");

  // AI draft from text, with no key: the built-in rules answer, and nothing is saved before review.
  await page.goto(`${base}/ai`, { waitUntil: "networkidle0" });
  const objectsBefore = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("archone.workspace.v1")).objects).length);
  await clickText(page, "Draft with AI");
  await waitText(page, "the built-in rules will read your text");
  await clickText(page, "Use an example");
  await clickText(page, "Create draft");
  await waitText(page, "Review the draft");
  await sleep(400);
  check("a draft adds nothing to the model before review", Object.keys((await stored()).objects).length === objectsBefore);
  check("the review names the engine and warns that rules were used", await page.evaluate(() => document.body.innerText.includes("Built-in rules") && document.body.innerText.includes("Check each line")));
  await shot(page, "08-review");
  check("save is disabled until something is accepted", await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save accepted to the model").disabled));
  await clickText(page, "Accept all");
  await page.click('button[aria-label^="Reject"]'); // reject the first object; its relationships must not be saved
  await sleep(200);
  await clickText(page, "Save accepted to the model");
  await page.waitForSelector(".object-node");
  await sleep(600);
  const after = await stored();
  const drafted = Object.values(after.objects).filter((o) => o.provenance.origin === "ai-prompt");
  check("accepted items are saved with their origin and approver", drafted.length >= 4 && drafted.every((o) => o.provenance.approvedBy && o.provenance.engine && o.provenance.source), `${drafted.length} objects`);
  const proposal = Object.values(after.proposals)[0];
  const acceptedCount = proposal.objects.filter((o) => o.decision === "accepted").length;
  const rejected = proposal.objects.find((o) => o.decision === "rejected");
  const reused = proposal.objects.filter((o) => o.decision === "accepted" && o.matchId).length;
  check(
    "the diagram shows exactly the accepted objects; the rejected one was not saved",
    (await count(page, ".object-node")) === acceptedCount &&
      Object.keys(after.objects).length === objectsBefore + drafted.length &&
      !!rejected &&
      !drafted.some((o) => o.name === rejected.name),
    `${acceptedCount} accepted, ${reused} of them already in the model and reused`,
  );
  check("relationships of the rejected object were not saved", proposal.relationships.filter((r) => r.sourceKey === rejected.key || r.targetKey === rejected.key).every((r) => r.decision === "rejected"));
  await shot(page, "09-drafted-diagram");

  // Persistence across a reload.
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector(".object-node");
  check("work is still there after a reload", (await count(page, ".object-node")) === acceptedCount);

  // Global search.
  await page.type('input[aria-label="Search objects and diagrams"]', "postgres");
  await sleep(300);
  check("global search finds objects by technology or name", await page.evaluate(() => document.body.innerText.includes("Objects")));

  // Ask the architecture: answers read from the model, with links to the objects.
  await page.goto(`${base}/ask`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-ask-examples] button");
  check("the ask page opens with the keyboard in the question field", await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Your question"));
  const firstExample = await page.evaluate(() => document.querySelector("[data-ask-examples] button").textContent.trim());
  await clickText(page, firstExample);
  await page.waitForSelector('[data-answer="computed"]');
  check("an example question is answered by reading the model", (await count(page, '[data-answer="computed"] [data-answer-object]')) >= 1, firstExample);
  await page.type('input[aria-label="Your question"]', "Who owns Order service?");
  await page.keyboard.press("Enter");
  await waitText(page, "is owned by Digital team.");
  check("a typed question is answered, newest first, and the field is cleared", await page.evaluate(() => document.querySelector("[data-answer]").innerText.includes("Order service is owned by Digital team.") && document.querySelector('input[aria-label="Your question"]').value === ""));
  await page.type('input[aria-label="Your question"]', "What happens if the Orders database fails?");
  await page.keyboard.press("Enter");
  await waitText(page, "Owners to tell");
  check("an impact question lists what is affected, with the objects and diagrams it rests on", await page.evaluate(() => { const card = document.querySelector("[data-answer]"); return card.querySelectorAll("[data-answer-sources] li").length >= 3 && !!card.querySelector('a[href^="/diagram/"]'); }));
  await page.type('input[aria-label="Your question"]', "Is the payment flow PCI compliant?");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-answer="search"]');
  check("a question it cannot work out gets matching objects, not a guess, and says no AI model is set up", await page.evaluate(() => { const card = document.querySelector('[data-answer="search"]'); return card.innerText.includes("no AI model is configured") && card.innerText.includes("Payment service"); }));
  await shot(page, "12-ask");
  const askedObject = await page.evaluate(() => { const a = [...document.querySelectorAll("[data-answer-object]")].find((x) => x.textContent === "Order service"); a.click(); return a.dataset.answerObject; });
  await sleep(300);
  check("an object in an answer links to that object in the model", page.url().endsWith(`/model?object=${askedObject}`) && (await hasText(page, "Order service")));
  await clickText(page, "Ask", "nav a, aside a, a");
  await page.waitForSelector("[data-answer]");
  check("the answers are still there after visiting the object", (await count(page, "[data-answer]")) === 4);

  // The assistant in the corner, without an AI model: the built-in reader answers what it can.
  await page.goto(base, { waitUntil: "networkidle0" });
  await page.click("[data-assistant-launcher]");
  await page.waitForSelector("[data-assistant-panel] [data-assistant-suggestions] button");
  check("the assistant opens from the corner, says no AI model is set up, and offers questions it can answer", (await page.$eval("[data-assistant-engine]", (e) => e.textContent)) === "Reads the model; no AI model is set up" && (await hasText(page, "No AI model is set up, so only questions")));
  await page.type("[data-assistant-input]", "Who owns Order service?");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-assistant-kind="computed"]');
  check("a question the built-in reader understands is answered from the model, with a link to the object", (await page.$eval('[data-assistant-kind="computed"]', (e) => e.innerText)).includes("Order service is owned by Digital team.") && (await count(page, '[data-assistant-kind="computed"] [data-assistant-object]')) === 1);
  await page.type("[data-assistant-input]", "Is the payment flow PCI compliant?");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-assistant-kind="search"]');
  check("anything else gets the matching objects and says how to connect an AI model", (await page.$eval('[data-assistant-kind="search"]', (e) => e.innerText)).includes("Settings → Integrations"));
  await page.keyboard.press("Escape");
  await sleep(100);
  check("Escape closes the assistant and the keyboard goes back to its button", !(await page.$("[data-assistant-panel]")) && (await page.evaluate(() => document.activeElement?.hasAttribute("data-assistant-launcher"))));

  // Checks and the data map.
  await page.goto(`${base}/checks`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-findings]");
  const wholeModel = await count(page, "[data-findings] [data-rule] li");
  check("checks run against the whole model and explain each rule", wholeModel > 3 && (await count(page, '[data-rule="deprecated-in-use"]')) === 1 && (await hasText(page, "is not a certificate of compliance")), `${wholeModel} findings`);
  const someDiagram = await page.$eval('select[aria-label="What to check"] option:nth-child(2)', (o) => o.value);
  await page.select('select[aria-label="What to check"]', someDiagram);
  await sleep(200);
  check("checking one diagram reports only what that diagram shows", (await count(page, "[data-findings] [data-rule] li")) < wholeModel && page.url().includes(`diagram=${someDiagram}`));
  const ordersDb = Object.values((await stored()).objects).find((o) => o.name === "Orders database").id;
  await page.goto(`${base}/model?object=${ordersDb}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-data-lens] select");
  const lensSelects = await page.$$("[data-data-lens] select");
  await lensSelects[0].select("Confidential");
  await lensSelects[1].select("yes");
  await page.type("[data-data-lens] input", "EU");
  await page.keyboard.press("Tab");
  await sleep(300);
  const lensFields = (await stored()).objects[ordersDb].fields;
  check("classification, personal data and where it is kept are saved with the object", lensFields["Data classification"] === "Confidential" && lensFields["Personal data"] === "Yes" && lensFields["Data residency"] === "EU", JSON.stringify(lensFields));
  check("the data fields are not repeated among the custom fields", (await count(page, 'input[aria-label="Field name"]')) === 0);
  await page.goto(`${base}/checks?view=data`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-data-map]");
  check("the data map lists the data stores and where personal data may travel", (await page.$eval("[data-data-map] tbody tr", (r) => r.innerText.replace(/\s+/g, " "))).includes("Orders database") && (await count(page, "[data-data-flows] li")) >= 1);
  await shot(page, "14-data-map");

  // AI agents: an agent that reads from outside, reaches the confidential database and can send outside.
  await page.evaluate((db) => {
    const ws = JSON.parse(localStorage.getItem("archone.workspace.v1"));
    const like = ws.objects[db];
    const outside = Object.values(ws.objects).find((o) => o.typeId === "external-system");
    const edge = Object.values(ws.relationships)[0];
    ws.objects.agent1 = { ...like, id: "agent1", name: "Support assistant", typeId: "ai-agent", parentId: null, fields: {}, tags: [], technology: "" };
    ws.relationships.ra1 = { ...edge, id: "ra1", sourceId: "agent1", targetId: db, kind: "reads_writes", label: "", protocol: "TLS" };
    ws.relationships.ra2 = { ...edge, id: "ra2", sourceId: "agent1", targetId: outside.id, kind: "calls", label: "", protocol: "HTTPS" };
    // The app saves what it holds when the page is left; this runs after that and wins.
    const put = () => localStorage.setItem("archone.workspace.v1", JSON.stringify(ws));
    window.addEventListener("pagehide", put);
    window.addEventListener("beforeunload", put);
  }, ordersDb);
  await page.goto(`${base}/checks`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-findings]");
  await page.evaluate(() => [...document.querySelectorAll("fieldset label")].find((l) => l.innerText.trim() === "AI agents")?.querySelector("input:not(:checked)")?.click());
  await sleep(300);
  const trifecta = await page.$$eval('[data-rule="agent-trifecta"] li', (items) => items.map((i) => i.innerText).join(" "));
  check("the AI agents pack finds an agent with private data, untrusted content and a way out", trifecta.includes("Support assistant has all three") && trifecta.includes("Orders database"), trifecta.slice(0, 120));
  await shot(page, "15-agent-check");
  await page.goto(`${base}/model?object=agent1`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-agent-lens] select");
  await (await page.$$("[data-agent-lens] select"))[1].select("no");
  await sleep(300);
  check("saying an agent cannot send outside is saved with it", (await stored()).objects.agent1.fields["Can send outside"] === "No");
  await page.goto(`${base}/checks`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-findings]");
  check("and the finding goes away, because one of the three is gone", (await count(page, '[data-rule="agent-trifecta"]')) === 0 && (await count(page, '[data-rule="agent-undeclared"]')) === 1);

  // The decision log.
  await page.goto(`${base}/decisions`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-adr-list]");
  const adrsOf = async () => Object.values((await stored()).adrs).sort((a, b) => a.number - b.number);
  check("the sample model comes with a decided and an open decision", (await count(page, "[data-adr-list] a")) === 2 && (await adrsOf()).map((a) => a.status).join() === "accepted,proposed");
  await page.evaluate(() => [...document.querySelectorAll("[data-adr-list] a")].find((a) => a.textContent.includes("ADR-1")).click());
  await page.waitForSelector("[data-adr] [data-adr-section=decision]");
  check("a decided record shows its text and cannot be edited", (await count(page, "[data-adr] textarea")) === 0 && (await hasText(page, "Supersede with a new decision")) && (await hasText(page, "We will publish order events to the event bus")));
  await shot(page, "16-decisions");
  await clickText(page, "New decision");
  await page.waitForSelector("[data-adr] textarea[data-adr-section=decision]");
  check("a new record opens with its title ready to be typed over", await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Title"));
  await page.keyboard.type("Keep card data out of the order service");
  await page.keyboard.press("Tab");
  check("a new record cannot be accepted before its decision is written", await page.$eval("[data-adr] footer button", (b) => b.textContent.trim() === "Accept" && b.disabled));
  await page.type("[data-adr] textarea[data-adr-section=decision]", "We will send card details straight to the payment service.");
  await page.keyboard.press("Tab");
  await sleep(450);
  await page.type('[data-adr-objects] input[aria-label="Link an object by name"]', "Payment serv");
  await page.waitForSelector("[data-adr-objects] ul.absolute button");
  await page.click("[data-adr-objects] ul.absolute button");
  await clickText(page, "Accept", "[data-adr] footer button");
  await sleep(450);
  const third = (await adrsOf())[2];
  check("accepting a record fixes its text and keeps what it is about", third.number === 3 && third.status === "accepted" && third.title === "Keep card data out of the order service" && third.objectIds.length === 1 && !!third.decidedAt && (await count(page, "[data-adr] textarea")) === 0, `${third.status}, ${third.objectIds.length} linked, "${third.title}", ${third.decidedAt}, ${await count(page, "[data-adr] textarea")} textareas`);
  await clickText(page, "Supersede with a new decision");
  await page.waitForSelector("[data-adr] textarea[data-adr-section=context]");
  await sleep(450);
  const afterSupersede = await adrsOf();
  check("superseding writes a new proposed record and marks the old one", afterSupersede.length === 4 && afterSupersede[2].status === "superseded" && afterSupersede[2].supersededBy === afterSupersede[3].id && afterSupersede[3].context === "Replaces ADR-3: Keep card data out of the order service." && page.url().endsWith(afterSupersede[3].id));
  await clickText(page, "Discard");
  await sleep(450);
  check("discarding the replacement makes the old record the accepted one again", (await adrsOf()).length === 3 && (await adrsOf())[2].status === "accepted" && (await adrsOf())[2].supersededBy === null);
  await clickText(page, "Whole log");
  await sleep(600);
  const logFile = (await readdir(downloads)).find((f) => f === "decision-log.md");
  check("the log downloads as Markdown, oldest first", !!logFile && /^# ADR-1: Publish order events[\s\S]*# ADR-3: Keep card data/.test(await readFile(join(downloads, logFile), "utf8")));
  const paymentService = Object.values((await stored()).objects).find((o) => o.name === "Payment service");
  await page.goto(`${base}/model?object=${paymentService.id}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-object-decisions]");
  check("an object lists the decisions that are about it", (await page.$eval("[data-object-decisions]", (e) => e.innerText)).includes("ADR-3: Keep card data out of the order service"));
  await clickText(page, "Record a decision", "[data-object-decisions] a");
  await page.waitForSelector("[data-adr] textarea[data-adr-section=decision]");
  await sleep(450);
  const fromObject = (await adrsOf()).at(-1);
  check("recording a decision from an object starts one that is linked to it", fromObject.number === 4 && fromObject.objectIds.join() === paymentService.id && !page.url().includes("about="));
  await clickText(page, "Discard");

  // Picking several boxes, lining them up, and presenting.
  const landscapeId = Object.values((await stored()).diagrams).find((d) => d.name === "System landscape").id;
  await page.goto(`${base}/diagram/${landscapeId}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".object-node");
  await sleep(500);
  const boxes = await page.$$eval(".react-flow__node:not(.react-flow__node-boundary)", (els) => els.slice(0, 3).map((e) => { const r = e.getBoundingClientRect(); return { id: e.getAttribute("data-id"), x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
  await page.mouse.click(boxes[0].x, boxes[0].y);
  check("one click picks nothing to arrange", (await count(page, "[data-arrange]")) === 0);
  await page.keyboard.down("Shift");
  await page.mouse.click(boxes[1].x, boxes[1].y);
  await page.mouse.click(boxes[2].x, boxes[2].y);
  await page.keyboard.up("Shift");
  await page.waitForSelector("[data-arrange]");
  check("Shift-click picks boxes together and offers to arrange them", (await page.$eval("[data-arrange]", (e) => e.innerText)).includes("3 picked") && (await count(page, ".react-flow__node.selected")) === 3);
  await page.click('[data-arrange] [data-align="top"]');
  await sleep(450);
  const placedNow = (await stored()).diagrams[landscapeId].nodes;
  const tops = boxes.map((b) => placedNow[b.id].y);
  check("lining up the top edges puts the picked boxes on one line", new Set(tops).size === 1 && boxes.some((b) => placedNow[b.id].pinned), tops.join());
  await page.click('[data-arrange] [data-distribute="horizontal"]');
  await sleep(450);
  const spaced = (await stored()).diagrams[landscapeId].nodes;
  const sortedXs = boxes.map((b) => spaced[b.id].x).sort((a, b) => a - b);
  check("spacing out leaves equal gaps and no overlap", Math.abs(sortedXs[1] - sortedXs[0] - (sortedXs[2] - sortedXs[1])) <= 1 && sortedXs[1] - sortedXs[0] >= 200, sortedXs.join());
  await shot(page, "17-arrange");
  await clickText(page, "Present");
  await page.waitForSelector("[data-present]");
  await sleep(400);
  const diagramCount = Object.keys((await stored()).diagrams).length;
  const presented = () => page.$eval("[data-present]", (e) => e.getAttribute("data-present"));
  const firstShown = await presented();
  check("presenting shows the diagram alone, with no tools to change it", firstShown === landscapeId && (await count(page, 'nav[aria-label="Main"]')) === 0 && !(await hasText(page, "Tidy layout")) && (await count(page, ".object-node")) > 0 && (await page.$eval("[data-present-count]", (e) => e.textContent.trim())).endsWith(`of ${diagramCount}`));
  await shot(page, "18-present");
  await page.keyboard.press("ArrowRight");
  await sleep(300);
  const secondShown = await presented();
  await page.keyboard.press("ArrowLeft");
  await sleep(300);
  check("the arrow keys walk through the diagrams", secondShown !== firstShown && (await presented()) === firstShown);
  await page.keyboard.press("Escape");
  await page.waitForSelector('nav[aria-label="Main"]');
  check("Escape returns to the editor", page.url().endsWith(`/diagram/${landscapeId}`));

  // A diagram written as text.
  await writeFile(join(downloads, "shop.md"), "# Shop\n\n```mermaid\nflowchart LR\n  subgraph loyalty [Loyalty programme]\n    points[Points service] --> pointsdb[(Points database)]\n  end\n  web2[Web storefront] -->|REST| points\n```\n");
  await page.goto(base, { waitUntil: "networkidle0" });
  await clickText(page, "Import");
  await waitText(page, "The file becomes a draft.");
  await (await page.$('input[aria-label="File to import"]')).uploadFile(join(downloads, "shop.md"));
  await page.waitForSelector("[data-import-summary]");
  const mermaidSummary = await page.$eval("[data-import-summary]", (e) => e.innerText.replace(/\s+/g, " "));
  check("a Mermaid flowchart inside a Markdown file is read as a draft", (await hasText(page, "A Mermaid diagram with 4 elements and 2 links")) && mermaidSummary.includes("4 objects and 2 relationships") && mermaidSummary.includes("1 of the objects is already in the model") && mermaidSummary.includes("laid out afresh"), mermaidSummary.slice(0, 160));
  await clickText(page, "Create draft to review");
  await waitText(page, "Imported from this file");
  await clickText(page, "Accept all");
  await clickText(page, "Save accepted to the model");
  await page.waitForSelector(".object-node");
  await sleep(400);
  const afterMermaid = await stored();
  const pointsDb = Object.values(afterMermaid.objects).find((o) => o.name === "Points database");
  const loyalty = Object.values(afterMermaid.objects).find((o) => o.name === "Loyalty programme");
  check("accepting it adds typed objects inside their group and reuses the one that existed", pointsDb?.typeId === "database" && loyalty?.typeId === "system" && pointsDb.parentId === loyalty.id && Object.values(afterMermaid.objects).filter((o) => o.name === "Web storefront").length === 1 && pointsDb.provenance.origin === "import");
  await writeFile(join(downloads, "bank.dsl"), 'workspace "Bank" {\n  model {\n    teller = person "Teller"\n    core = softwareSystem "Core banking" {\n      ledger2 = container "Ledger API" "Posts entries" "Java"\n    }\n    teller -> ledger2 "Posts entries with" "HTTPS"\n  }\n  views {\n    systemContext core { include * }\n  }\n}\n');
  await page.goto(base, { waitUntil: "networkidle0" });
  await clickText(page, "Import");
  await waitText(page, "The file becomes a draft.");
  await (await page.$('input[aria-label="File to import"]')).uploadFile(join(downloads, "bank.dsl"));
  await page.waitForSelector("[data-import-summary]");
  check("a Structurizr workspace is read from its model block", (await hasText(page, "A Structurizr workspace with 3 elements and 1 link")) && (await page.$eval("[data-import-summary]", (e) => e.innerText)).includes("3 objects and 1 relationship"));
  await page.keyboard.press("Escape");

  // Infrastructure as code: a Terraform file becomes resources from the library, inside their networks.
  await page.goto(base, { waitUntil: "networkidle0" });
  await clickText(page, "Import");
  await waitText(page, "The file becomes a draft.");
  check("the import dialog offers infrastructure as code and discovery results", !!(await page.$("[data-import-iac]")) && !!(await page.$("[data-import-discovery]")) && !(await page.$("[data-discover-import]")));
  await (await page.$('input[aria-label="File to import"]')).uploadFile(join(root, "src/lib/inventory/fixtures/main.tf"));
  await page.waitForSelector("[data-import-inventory]");
  const iacSummary = await page.$eval("[data-import-inventory]", (e) => e.innerText.replace(/\s+/g, " "));
  check("a Terraform configuration is read as resources, relationships and networks", iacSummary.includes("A Terraform configuration with 7 resources and 2 relationships, networks drawn as zones") && iacSummary.includes("1 data source"), iacSummary.slice(0, 200));
  await clickText(page, "Create draft to review");
  await waitText(page, "Read from infrastructure as code");
  await clickText(page, "Accept all");
  await clickText(page, "Save accepted to the model");
  await page.waitForSelector(".object-node");
  await sleep(400);
  {
    const objects = Object.values((await stored()).objects);
    const web = objects.find((o) => o.name === "web-1");
    const subnet = objects.find((o) => o.name === "app-subnet");
    check("accepting it adds library components inside their subnet, with the resource's fields", web?.componentId === "aws.ec2" && subnet?.typeId === "zone" && web.parentId === subnet.id && web.fields?.instance_type === "t3.small", JSON.stringify({ c: web?.componentId, p: web?.parentId === subnet?.id, f: web?.fields?.instance_type }));
  }

  // Health: what stops, what can be delivered, what is confirmed and what is still true.
  const objectNamed = async (name) => Object.values((await stored()).objects).find((o) => o.name === name);
  const setAvailability = async (name, value) => {
    await page.goto(`${base}/model?object=${(await objectNamed(name)).id}`, { waitUntil: "networkidle0" });
    await page.waitForSelector("[data-truth]");
    const input = await page.evaluateHandle(() => [...document.querySelectorAll("label")].find((l) => l.textContent.includes("Availability it promises")).querySelector("input"));
    await input.click({ clickCount: 3 });
    await page.keyboard.type(value);
    await page.keyboard.press("Tab");
    await sleep(450);
  };
  await page.goto(`${base}/health`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-single-points]");
  const worst = await page.$eval("[data-single-points] tbody tr td", (e) => e.innerText.split("\n")[0]);
  check("Health ranks the objects whose failure takes the most with it", (await count(page, "[data-single-points] tbody tr")) >= 3 && worst.length > 0, worst);
  await page.type('input[aria-label="Object to switch off"]', "Payment prov");
  await page.waitForSelector("[data-failure] ul.absolute button");
  await page.click("[data-failure] ul.absolute button");
  await page.waitForSelector("[data-failure-report]");
  await sleep(400);
  const stopped = await page.$$eval("[data-casualty]", (rows) => rows.map((r) => r.getAttribute("data-casualty")));
  const because = await page.$eval('[data-casualty="Order service"] td:last-child', (e) => e.innerText);
  check("switching an object off lists what stops, and why", stopped.includes("Payment service") && stopped.includes("Order service") && stopped.includes("Support agent") && !stopped.includes("Customer") && because === "Order service needs Payment service needs Payment provider" && (await hasText(page, "Tier-1 hit:")) && (await count(page, "[data-failure-report] .object-node")) === stopped.length + 1, `${stopped.length} stop`);
  await shot(page, "19-failure");
  await setAvailability("Payment provider", "99.5");
  await setAvailability("Payment service", "99.9");
  await setAvailability("Order service", "99,9 %");
  await page.goto(`${base}/health?tab=availability`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-availability]");
  const ordersRow = await page.$eval('[data-resilience="Order service"]', (e) => [...e.querySelectorAll("td")].map((td) => td.innerText.replace(/\s+/g, " ")));
  check("an object's real availability is its own times its chain's, with the weakest link named", ordersRow[1] === "99.9%" && ordersRow[2] === "99.301%" && ordersRow[4] === "Payment provider (99.5%)" && /days a year/.test(ordersRow[3]), ordersRow.join(" | "));
  await page.goto(`${base}/health?tab=confirmations`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-confirmations]");
  const waiting = await count(page, "[data-pending-handshake]");
  await clickText(page, "Confirm", "[data-pending-handshake] button");
  await sleep(450);
  const confirmedNow = Object.values((await stored()).relationships).filter((r) => r.acknowledgement);
  check("a dependency on another team waits to be confirmed, and confirming records who and when", waiting >= 5 && (await count(page, "[data-pending-handshake]")) === waiting - 1 && confirmedNow.length === 1 && !!confirmedNow[0].acknowledgement.at && (await hasText(page, `1 of ${waiting} dependencies`)), `${waiting} waiting`);
  await page.goto(`${base}/checks`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-findings]");
  check("the checks list the dependencies nobody on the other side has confirmed", (await count(page, '[data-rule="dependency-unconfirmed"]')) === 1 && (await count(page, '[data-rule="truth-stale"]')) === 0);
  await page.goto(`${base}/model?object=${(await objectNamed("Order service")).id}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-truth]");
  const truthBefore = await page.$eval("[data-truth]", (e) => e.innerText.replace(/\s+/g, " "));
  await clickText(page, "Confirm", "[data-truth] button");
  await sleep(450);
  const verified = (await objectNamed("Order service")).fields;
  check("an object says when it was last confirmed, and confirming it records the day", truthBefore.includes("Nobody has confirmed it since it was added") && truthBefore.includes("Due every 90 days, because it is tier-1") && !!Date.parse(verified["Verified on"]) && !!verified["Verified by"] && (await page.$eval("[data-truth]", (e) => e.innerText)).includes("Confirmed today"));
  await page.goto(`${base}/health?tab=freshness`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-freshness]");
  check("freshness says nothing is due in a model that was just made", await hasText(page, "Nothing is due."));

  // A rule of the workspace's own: written as a sentence, read back, tried, then run with the checks.
  await page.goto(`${base}/checks/rules`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-rule-new]");
  await page.click("[data-rule-new]");
  await page.type("[data-rule-text]", "Traffic from customers to databases must pass through a gateway");
  await page.click("[data-rule-read]");
  await page.waitForFunction(() => document.querySelector("[data-rule-kind]")?.value === "journey");
  const journeyRead = await page.$eval("[data-rule-sentence]", (e) => e.textContent.trim());
  check("a journey test written as a sentence is read into a rule and shown back", journeyRead === "Every way from people to databases passes through gateways." && (await count(page, "[data-selector]")) === 3, journeyRead);
  await page.$eval("[data-rule-text]", (e) => e.select());
  await page.keyboard.press("Backspace");
  await page.type("[data-rule-text]", "Every database in the blue zone must have an owner");
  await page.click("[data-rule-read]");
  await page.waitForFunction(() => document.querySelector("[data-rule-kind]")?.value === "object");
  const ownerRule = await page.evaluate(() => ({ sentence: document.querySelector("[data-rule-sentence]").textContent.trim(), found: document.querySelector("[data-rule-found]").textContent.trim(), unread: document.querySelector("[data-rule-unread]")?.textContent ?? "" }));
  const wouldFind = Number(/would find (\d+) thing/.exec(ownerRule.found)?.[1] ?? 0);
  check("before it is kept, a rule says what it would find and which words it did not read", ownerRule.sentence === "All databases must have an owner." && wouldFind > 0 && ownerRule.unread.includes("blue zone"), `${ownerRule.found} ${ownerRule.unread}`);
  await page.evaluate(() => document.querySelector("[data-rule-editor]").scrollIntoView());
  await shot(page, "16-rule-editor");
  await page.click("[data-rule-save]");
  await page.waitForSelector("[data-rules] [data-rule-row]");
  await sleep(450);
  const keptRule = Object.values((await stored()).rules)[0];
  check("the rule is kept with the sentence it was written as", keptRule?.title === "All databases must have an owner." && keptRule.text.includes("blue zone") && (await page.$eval("[data-rule-count]", (e) => e.textContent.trim())) === `${wouldFind} findings`);
  await shot(page, "15-own-rules");
  await page.goto(`${base}/checks`, { waitUntil: "networkidle0" });
  await page.waitForSelector(`[data-rule="${keptRule.id}"]`);
  check("it runs with the built-in checks, under its own name", (await count(page, `[data-rule="${keptRule.id}"] li`)) === wouldFind && (await page.$eval("[data-own-rules]", (e) => e.textContent.trim())) === "Your rules (1 on)");
  await page.goto(`${base}/checks/rules`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-rule-row] input[type=checkbox]");
  await page.click("[data-rule-row] input[type=checkbox]");
  await page.goto(`${base}/checks`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-findings]");
  check("switched off, it no longer runs", (await count(page, `[data-rule="${keptRule.id}"]`)) === 0);
  await page.goto(`${base}/checks/rules`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-rule-row]");
  await page.click('[data-rule-row] button[aria-label^="Delete"]');
  await sleep(450);

  // A diagram of 400 boxes: only what is in view is drawn, and a picture still shows all of it.
  {
    const at = new Date().toISOString();
    const big = { version: 1, name: "Large", userName: "", objects: {}, relationships: {}, diagrams: {}, proposals: {}, adrs: {}, rules: {}, updatedAt: at };
    const nodes = {};
    for (let i = 0; i < 400; i++) {
      const id = `big_${i}`;
      big.objects[id] = { id, typeId: i % 3 ? "service" : "database", name: `Service ${i}`, description: "", owner: "", lifecycle: "active", tags: [], parentId: null, technology: "", fields: {}, provenance: { origin: "manual" }, createdAt: at, updatedAt: at };
      nodes[id] = { x: (i % 20) * 280, y: Math.floor(i / 20) * 140, pinned: true };
      if (i) big.relationships[`bigr_${i}`] = { id: `bigr_${i}`, sourceId: `big_${i - 1}`, targetId: id, kind: "calls", label: "", protocol: "", port: "", description: "", provenance: { origin: "manual" }, createdAt: at, updatedAt: at };
    }
    big.diagrams.bigd = { id: "bigd", name: "Four hundred", description: "", viewType: "custom", scopeId: null, direction: "LR", hiddenRelationshipIds: [], edgeKinds: null, colorBy: "type", nodes, createdAt: at, updatedAt: at };
    // Another origin for the same server, so this model does not replace the one the rest of the run uses.
    const other = base.replace("127.0.0.1", "localhost");
    const large = await newPage(browser, errors);
    await large.evaluateOnNewDocument((json) => {
      if (!sessionStorage.getItem("seeded")) {
        localStorage.setItem("archone.workspace.v1", json);
        sessionStorage.setItem("seeded", "1");
      }
    }, JSON.stringify(big));
    const started = Date.now();
    await large.goto(`${other}/diagram/bigd`, { waitUntil: "domcontentloaded" });
    await large.waitForSelector(".object-node");
    const opened = Date.now() - started;
    await sleep(600);
    const fitted = await count(large, ".object-node");
    // Fitted to the window every box is in view; zoomed in, most of them are not.
    for (let i = 0; i < 6; i++) await large.click(".react-flow__controls-zoomin");
    await sleep(700);
    const drawn = await count(large, ".object-node");
    check("a diagram of 400 boxes opens quickly, and zoomed in draws only the boxes in view", fitted === 400 && drawn > 0 && drawn < 200 && opened < 8000, `${drawn} of 400 drawn when zoomed in, opened in ${opened} ms`);
    for (const f of await readdir(downloads)) if (f.endsWith(".png")) await rm(join(downloads, f));
    await large.click("[data-export-open]");
    await large.waitForSelector("[data-export-window]");
    await large.click('[data-export="png"]');
    let bigPng;
    for (let i = 0; i < 60 && !bigPng; i++) {
      await sleep(500);
      bigPng = (await readdir(downloads)).find((f) => f.endsWith(".png"));
    }
    await sleep(500);
    const bigWidth = bigPng ? (await readFile(join(downloads, bigPng))).readUInt32BE(16) : 0;
    check("its picture still shows the whole diagram", bigWidth >= 10000, `${bigWidth} pixels wide`);
    if (bigPng) await rm(join(downloads, bigPng));
    await large.close();
  }

  // A template: a typical architecture put into the model with one diagram of it.
  await page.goto(base, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-template-open]");
  const templateBase = Object.keys((await stored()).objects).length;
  await page.click("[data-template-open]");
  await page.waitForSelector("[data-templates] [data-template]");
  const templatesOffered = await count(page, "[data-templates] [data-template]");
  const previews = await count(page, "[data-templates] [data-template] [data-template-preview] rect");
  const firstCard = await page.$eval("[data-templates] [data-template]", (b) => ({ text: b.innerText.split("\n")[0], previewBelowName: b.querySelector("[data-template-preview]").getBoundingClientRect().top > b.querySelector("span").getBoundingClientRect().top }));
  await shot(page, "27-template-picker");
  const perspectiveCounts = await page.$$eval("[data-template-perspectives] [data-perspective]", (els) => els.map((e) => e.innerText));
  await page.click('[data-perspective="infrastructure"]');
  await sleep(200);
  const infraOnly = await count(page, "[data-templates] [data-template]");
  await page.type('input[aria-label="Search templates"]', "dmz");
  await sleep(200);
  const dmzFound = await page.$$eval("[data-templates] [data-template]", (els) => els.map((e) => e.getAttribute("data-template")));
  check(
    "the template picker shows 115 templates as small pictures under their names, by perspective and by search",
    templatesOffered === 115 && previews > 450 && firstCard.previewBelowName && infraOnly === 40 && dmzFound.includes("dmz") && perspectiveCounts.length === 5,
    `${templatesOffered} templates, ${previews} boxes drawn, infrastructure ${infraOnly}, search ${dmzFound.join(",")} :: ${perspectiveCounts.join(" / ")}`,
  );
  await page.$eval('input[aria-label="Search templates"]', (e) => e.select());
  await page.keyboard.press("Backspace");
  await page.click('[data-perspective="all"]');
  await page.$eval('[data-template="ai-agent"]', (b) => b.click());
  await page.waitForSelector('[data-template-picked="ai-agent"]');
  check("picking a template shows what it holds before it is used", (await page.$eval("[data-template-picked]", (e) => e.innerText)).includes("AI agent with tools"));
  await page.$eval("[data-template-use]", (b) => b.click());
  await page.waitForFunction(() => location.pathname.startsWith("/diagram/"));
  await page.waitForSelector(".object-node");
  await sleep(500);
  const templated = await stored();
  check(
    "a template adds its objects to the model and opens a diagram of them",
    Object.keys(templated.objects).length === templateBase + 7 && (await count(page, ".object-node")) === 6 && Object.values(templated.diagrams).some((d) => d.name === "AI agent with tools"),
    `${templatesOffered} templates, ${Object.keys(templated.objects).length - templateBase} objects added, ${await count(page, ".object-node")} boxes`,
  );
  await page.click(".object-node");
  await page.waitForSelector("#technology-options option");
  check("the technology field offers cloud service names", (await page.$$eval("#technology-options option", (o) => o.map((x) => x.value))).includes("Amazon S3"));
  await shot(page, "18-template");

  // Any diagram can become a template of the workspace, under the perspective chosen for it.
  {
    await page.click('[aria-label="Diagram settings"]');
    await page.waitForSelector("[data-save-as-template]");
    await page.$eval("[data-save-as-template]", (b) => b.click());
    await page.waitForSelector("[data-save-template-dialog]");
    await page.$eval('input[aria-label="Template name"]', (e) => e.select());
    await page.type('input[aria-label="Template name"]', "Our agent setup");
    await page.$eval('[data-perspective-choice="data"]', (b) => b.click());
    const counted = await page.$eval("[data-template-counts]", (e) => e.innerText);
    await shot(page, "28-save-as-template");
    await page.$eval("[data-save-template]", (b) => b.click());
    await sleep(300);
    const kept = Object.values((await stored()).templates ?? {});
    const savedTemplate = kept[0];
    const allLibrary = savedTemplate && savedTemplate.objects.every((o) => typeof o.componentId === "string" && o.componentId.includes("."));
    check(
      "a diagram is saved as a template under the perspective chosen, holding only library components",
      kept.length === 1 && savedTemplate.name === "Our agent setup" && savedTemplate.perspective === "data" && savedTemplate.objects.length === 6 && allLibrary && counted.startsWith("6 boxes"),
      `${kept.length} saved, ${savedTemplate?.perspective}, ${savedTemplate?.objects.length} boxes :: ${counted}`,
    );
    await page.goto(base, { waitUntil: "networkidle0" });
    await page.click("[data-template-open]");
    await page.waitForSelector("[data-template-own]");
    await page.$eval("[data-template-own]", (b) => b.click());
    await page.waitForFunction(() => document.querySelectorAll("[data-templates] [data-template]").length === 1);
    const ownCard = await page.$eval("[data-templates] [data-template]", (b) => ({ id: b.getAttribute("data-template"), text: b.innerText }));
    await page.$eval('[data-perspective="data"]', (b) => b.click());
    const inData = await count(page, "[data-templates] [data-template]");
    await shot(page, "29-saved-template-in-picker");
    await page.$eval("[data-templates] [data-template]", (b) => b.click());
    await page.$eval("[data-template-use]", (b) => b.click());
    await page.waitForFunction(() => location.pathname.startsWith("/diagram/"));
    await page.waitForSelector(".object-node");
    await sleep(400);
    const reused = await stored();
    const reusedDiagram = Object.values(reused.diagrams).filter((d) => d.name === "Our agent setup");
    check(
      "a saved template is offered under its perspective, marked as saved here, and makes a diagram of its boxes where they stood",
      ownCard.id === savedTemplate.id && ownCard.text.includes("Saved here") && inData === 1 && reusedDiagram.length === 1 && Object.keys(reusedDiagram[0].nodes).length === 6 && (await count(page, ".object-node")) === 6,
      `${ownCard.id} :: ${ownCard.text.replace(/\n/g, " | ")} :: in data ${inData}, ${reusedDiagram.length} diagrams`,
    );
    await page.goto(base, { waitUntil: "networkidle0" });
    await page.click("[data-template-open]");
    await page.waitForSelector("[data-template-own]");
    await page.$eval("[data-template-own]", (b) => b.click());
    await page.waitForFunction(() => document.querySelectorAll("[data-templates] [data-template]").length === 1);
    await page.$eval("[data-templates] [data-template]", (b) => b.click());
    await page.$eval("[data-template-delete]", (b) => b.click());
    await page.$eval("[data-template-delete-confirm]", (b) => b.click());
    await sleep(300);
    check("a saved template can be deleted after confirming", Object.keys((await stored()).templates ?? {}).length === 0 && !(await page.$("[data-template-own]")));
    await page.keyboard.press("Escape");
  }

  // New diagram: the kind first, then one of the ways to build it.
  {
    const startNew = async (name, kind) => {
      await page.goto(base, { waitUntil: "networkidle0" });
      await page.click("[data-new-diagram]");
      await page.waitForSelector("[data-new-kind]");
      const area = { landscape: "applications", context: "applications", container: "applications", dataflow: "data", deployment: "infrastructure", business: "business", custom: "custom" }[kind];
      await page.$eval(`[data-view-category="${area}"]`, (e) => e.click());
      await page.$eval(`[data-view-type="${kind}"]`, (e) => e.click());
      if (kind === "container" || kind === "context") {
        await page.waitForSelector('input[aria-label="Which system"]');
        const system = await page.$eval("#new-diagram-systems", (list) => [...list.options].find((o) => o.textContent.includes("Software system"))?.value ?? list.options[0].value);
        await page.type('input[aria-label="Which system"]', system);
      }
      await page.$eval('input[aria-label="Diagram name"]', (e) => e.select());
      await page.type('input[aria-label="Diagram name"]', name);
      await page.click("[data-new-next]");
      await page.waitForSelector("[data-new-ways]");
    };
    // 02 The wizard, for a C4 Level 2 diagram.
    await startNew("Wizard check", "container");
    await page.click('[data-way="wizard"]');
    await page.waitForSelector('[data-wizard-step="system"]');
    const answer = async (stepTitle, name) => {
      await page.type(`input[aria-label="${stepTitle} 1"]`, name);
      await page.click("[data-wizard-next]");
    };
    const systemPrefilled = await page.$eval('input[aria-label="The system 1"]', (e) => e.value);
    await page.click("[data-wizard-next]");
    await answer("People", "Wizard shopper");
    await answer("Front ends", "Wizard web shop");
    await answer("Services", "Wizard basket service");
    await answer("Data stores", "Wizard basket DB");
    await answer("Other systems", "Wizard card network");
    await page.waitForSelector("[data-wizard-review]");
    await shot(page, "31-wizard-review");
    await page.click("[data-wizard-create]");
    await page.waitForFunction(() => location.pathname.startsWith("/diagram/"));
    await page.waitForSelector(".object-node");
    await sleep(400);
    let model = await stored();
    const wizardDiagram = Object.values(model.diagrams).find((d) => d.name === "Wizard check");
    const wizardObjects = Object.values(model.objects).filter((o) => o.name.startsWith("Wizard "));
    const wizardLines = Object.values(model.relationships).filter((r) => wizardObjects.some((o) => o.id === r.sourceId));
    check(
      "the wizard builds a connected diagram of the chosen kind, every box a library component",
      !!systemPrefilled && wizardDiagram?.viewType === "container" && wizardObjects.length === 5 && wizardObjects.every((o) => o.componentId) && wizardLines.length >= 4,
      `${systemPrefilled} :: ${wizardDiagram?.viewType}, ${wizardObjects.length} objects, ${wizardLines.length} lines`,
    );
    // The wizard's steps are set in Settings: a step added there is asked next time.
    await page.goto(`${base}/settings`, { waitUntil: "networkidle0" });
    await page.waitForSelector("[data-wizard-settings]");
    await page.$eval('[data-wizard-kind="container"]', (b) => b.click());
    await page.click("[data-wizard-add]");
    await page.waitForSelector('[data-wizard-step-editor] input[aria-label="Step title"]');
    await page.$eval('[data-wizard-step-editor] input[aria-label="Step title"]', (e) => e.select());
    await page.type('[data-wizard-step-editor] input[aria-label="Step title"]', "Monitoring");
    await page.type('[data-wizard-step-editor] input[aria-label="Question"]', "What watches it?");
    await page.$eval('[data-wizard-step-editor] [data-wizard-kind-option="application"]', (b) => b.click());
    await page.$eval('[data-wizard-step-editor] [data-wizard-kind-option="service"]', (b) => b.click());
    await page.$eval('[data-wizard-step-editor] input[aria-label="Usual component"]', (e) => e.select());
    await page.type('[data-wizard-step-editor] input[aria-label="Usual component"]', "Back-end service");
    await page.$eval('[data-wizard-step-row="system"] [data-wizard-step-remove]', (b) => b.click()).catch(() => undefined);
    const problemsShown = await page.$("[data-wizard-problems]");
    await page.click("[data-wizard-step-row] [data-wizard-step-open='system']").catch(() => undefined);
    // Removing the system step was refused by the checks? It is allowed: the steps that sat inside it simply no longer do.
    await shot(page, "33-wizard-settings");
    await page.click("[data-wizard-save]");
    await sleep(300);
    const kept = (await stored()).wizards?.container?.steps.map((s) => s.title) ?? [];
    check("an owner changes the wizard's steps in Settings: adds one, removes one", kept.includes("Monitoring") && !kept.includes("The system") && !problemsShown, kept.join(", "));
    await startNew("Wizard with own steps", "container");
    await page.click('[data-way="wizard"]');
    await page.waitForSelector("[data-wizard-step]");
    const askedSteps = await page.$$eval('ol[aria-label="Steps"] li', (els) => els.map((e) => e.textContent.trim()));
    check("the wizard asks the workspace's own steps", askedSteps.includes("Monitoring") && !askedSteps.includes("The system"), askedSteps.join(" | "));
    await page.keyboard.press("Escape");
    await page.goto(`${base}/settings`, { waitUntil: "networkidle0" });
    await page.$eval('[data-wizard-kind="container"]', (b) => b.click());
    await page.waitForSelector("[data-wizard-reset]");
    await page.click("[data-wizard-reset]");
    await sleep(400);
    check("the built-in steps come back with one click", !(await stored()).wizards?.container, JSON.stringify(Object.keys((await stored()).wizards ?? {})));

    // 03 A copy with separate objects; the original stays as it is.
    await startNew("Copy check", "custom");
    await page.click('[data-way="existing"]');
    await page.waitForSelector("[data-copy-source]");
    await page.$eval(`[data-copy-source="${wizardDiagram.id}"]`, (b) => b.click());
    await page.$eval("[data-copy-separate]", (b) => b.click());
    await page.click("[data-copy-create]");
    await page.waitForFunction(() => location.pathname.startsWith("/diagram/"));
    await sleep(400);
    model = await stored();
    const copy = Object.values(model.diagrams).find((d) => d.name === "Copy check");
    const copiedIds = Object.keys(copy?.nodes ?? {});
    const originalIds = Object.keys(model.diagrams[wizardDiagram.id].nodes);
    check(
      "a diagram is copied with objects of its own, and the original keeps its own",
      copiedIds.length === originalIds.length && copiedIds.every((id) => !originalIds.includes(id) && model.objects[id].name.endsWith("(target)")),
      `${copiedIds.length} boxes`,
    );
    // 09 Archiving and restoring, each with a reason.
    await page.goto(`${base}/diagrams`, { waitUntil: "networkidle0" });
    await page.waitForSelector(`[data-archive="${copy.id}"]`);
    await page.$eval(`[data-archive="${copy.id}"]`, (b) => b.click());
    await page.type('textarea[aria-label="Reason for archiving"]', "Option not chosen");
    await page.click("[data-archive-confirm]");
    await page.waitForSelector("[data-archived-open]");
    const listedAfter = await page.$$eval("[data-diagram-card] [data-diagram-name]", (links) => links.map((a) => a.textContent.trim()));
    await page.click("[data-archived-open]");
    await page.waitForSelector(`[data-archived="${copy.id}"]`);
    const archivedText = await page.$eval(`[data-archived="${copy.id}"]`, (e) => e.innerText);
    await shot(page, "32-archived");
    await page.click(`[data-restore="${copy.id}"]`);
    await page.type('textarea[aria-label="Reason for restoring"]', "Back on the table");
    await page.click("[data-restore-confirm]");
    await sleep(300);
    const restored = (await stored()).diagrams[copy.id];
    check(
      "a diagram is archived with a reason, leaves the list, and comes back with a reason",
      !listedAfter.includes("Copy check") && archivedText.includes("Option not chosen") && restored.archive?.archived === false && restored.archive.history.length === 2,
      archivedText.replace(/\n/g, " | "),
    );
    // 06 Voice: the words, said or typed, become a text draft with English names.
    await startNew("Voice check", "custom");
    await page.click('[data-way="voice"]');
    await page.waitForSelector('textarea[aria-label="What you said"]');
    await page.type('textarea[aria-label="What you said"]', "The portal calls the billing service");
    await page.click("[data-voice-continue]");
    await waitText(page, "Voice to Architecture");
    check("voice to architecture hands what was said to a draft for review", await page.evaluate(() => [...document.querySelectorAll("[role=dialog] textarea")].some((t) => t.value.includes("billing service"))));
    await page.keyboard.press("Escape");
  }

  // The Diagrams page: every diagram as a card with a small picture of what it holds.
  {
    const model = await stored();
    const live = Object.values(model.diagrams).filter((d) => !d.archive?.archived);
    await page.goto(base, { waitUntil: "networkidle0" });
    await page.waitForSelector("[data-home-all-diagrams]");
    const menu = await page.$$eval('[data-nav-group="Analyse"] a', (links) => links.map((a) => a.textContent.trim()));
    const homeHasNoTable = !(await page.$("[data-home-overview] table, [data-diagram-grid]"));
    const recentPictures = await count(page, "[data-home-recent] [data-thumbnail]");
    check(
      "the menu lists Diagrams right under All diagrams, and home keeps only the overview and recent pictures",
      menu.indexOf("Diagrams") === menu.indexOf("All diagrams") + 1 && homeHasNoTable && recentPictures >= 1,
      `${menu.join(", ")}; ${recentPictures} recent pictures`,
    );
    await page.click("[data-home-all-diagrams]");
    await page.waitForSelector("[data-diagram-card]");
    const cards = await count(page, "[data-diagram-card]");
    const drawn = await page.$$eval("[data-diagram-card]", (els) => els.filter((e) => e.querySelector("[data-thumbnail] g rect") || e.querySelector("[data-thumbnail-empty]")).length);
    const boxesOnCards = await page.$$eval("[data-diagram-card]", (els) => els.map((e) => [e.getAttribute("data-diagram-card"), e.querySelectorAll("[data-thumbnail] > g").length, Number(e.querySelector("[data-diagram-counts]").textContent.match(/\d+/)[0])]));
    check(
      "every diagram is a card with a picture of its boxes, and the count under it matches",
      cards === live.length && drawn === cards && boxesOnCards.every(([, g, n]) => g === n),
      `${cards} cards for ${live.length} diagrams`,
    );
    await shot(page, "36-diagram-cards");
    const firstName = await page.$eval("[data-diagram-card] [data-diagram-name]", (a) => a.textContent.trim());
    await page.type("[data-diagrams-search]", firstName);
    await sleep(200);
    const found = await page.$$eval("[data-diagram-card] [data-diagram-name]", (links) => links.map((a) => a.textContent.trim()));
    await page.$eval("[data-diagrams-search]", (e) => e.select());
    await page.keyboard.type("no diagram is called this");
    await sleep(200);
    const none = (await count(page, "[data-diagram-card]")) === 0 && (await hasText(page, "No diagram matches"));
    await clickText(page, "Show all diagrams");
    await sleep(200);
    check("the search box narrows the cards by name, and says so when nothing matches", found.includes(firstName) && found.length < cards && none && (await count(page, "[data-diagram-card]")) === cards, found.join(", "));
    const areas = await page.$$eval("[data-diagram-area]", (els) => els.map((e) => e.getAttribute("data-diagram-area")));
    const area = areas.find((a) => a !== "all");
    await page.click(`[data-diagram-area="${area}"]`);
    await sleep(200);
    const inArea = await count(page, "[data-diagram-card]");
    await page.click('[data-diagram-area="all"]');
    await page.click('[data-diagrams-layout="list"]');
    await page.waitForSelector("[data-diagram-row]");
    const rows = await count(page, "[data-diagram-row]");
    await page.click('[data-diagrams-layout="grid"]');
    check("area chips narrow the cards, and the list layout shows the same diagrams as rows", inArea >= 1 && inArea < cards && rows === cards, `${area}: ${inArea}; ${rows} rows`);
    await page.click("[data-diagram-card] [data-diagram-name]");
    await page.waitForSelector(".object-node");
    await page.click("[data-crumb-diagrams]");
    await page.waitForSelector("[data-diagram-card]");
    check("a card opens its diagram, and the editor's Diagrams link comes back to the cards", page.url().endsWith("/diagrams"));
  }

  // A double-click on a box opens its relationship tree, up to five levels deep.
  {
    const model = await stored();
    const rels = Object.values(model.relationships).filter((r) => model.objects[r.sourceId] && model.objects[r.targetId] && r.sourceId !== r.targetId);
    const degree = (id) => rels.filter((r) => r.sourceId === id || r.targetId === id).length;
    const pick = Object.values(model.diagrams)
      .filter((d) => !d.archive?.archived)
      .map((d) => ({ d, id: Object.keys(d.nodes).filter((id) => model.objects[id] && model.objects[id].typeId !== "diagram").sort((a, b) => degree(b) - degree(a))[0] }))
      .filter((x) => x.id)
      .sort((a, b) => degree(b.id) - degree(a.id))[0];
    await page.goto(`${base}/diagram/${pick.d.id}`, { waitUntil: "networkidle0" });
    const node = await page.waitForSelector(`.react-flow__node[data-id="${pick.id}"]`);
    await sleep(400);
    const box = await node.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector("[data-object-tree]");
    const offered = !!(await page.$("[data-object-tree]"));
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { count: 2 });
    await page.waitForSelector(`[data-component-tree="${pick.id}"]`);
    const direct = rels.filter((r) => r.sourceId === pick.id).length + rels.filter((r) => r.targetId === pick.id && r.flow === "both").length;
    const levelOne = await count(page, '[data-tree-side="out"] [data-tree-level="1"]');
    check(
      "double-clicking a box opens its relationship tree, with each direct relationship on the first level",
      offered && page.url().includes(`/component/${pick.id}?from=${pick.d.id}`) && levelOne === direct,
      `${model.objects[pick.id].name}: ${levelOne} of ${direct}`,
    );
    const deepest = () => page.$$eval("[data-tree-level]", (els) => Math.max(0, ...els.map((e) => Number(e.getAttribute("data-tree-level")))));
    await page.click('[data-tree-levels="5"]');
    await sleep(200);
    const atFive = await deepest();
    const objectsAtFive = await page.$$eval("[data-tree-total]", (els) => els.map((e) => Number(e.textContent.match(/\d+/)[0])));
    await shot(page, "37-relationship-tree");
    await page.click('[data-tree-levels="1"]');
    await sleep(200);
    const atOne = await deepest();
    await page.click('[data-tree-levels="5"]');
    await page.click('[data-tree-scope="dependencies"]');
    await sleep(200);
    const dependencyObjects = await page.$$eval("[data-tree-total]", (els) => els.map((e) => Number(e.textContent.match(/\d+/)[0])));
    check(
      "the tree goes to the level chosen, five at most, and can follow dependencies only",
      atFive >= 2 && atFive <= 5 && atOne === 1 && dependencyObjects.every((n, i) => n <= objectsAtFive[i]) && page.url().includes("scope=dependencies"),
      `deepest ${atFive}; objects ${objectsAtFive.join("/")} then ${dependencyObjects.join("/")}`,
    );
    await page.click('[data-tree-scope="all"]');
    await page.click("[data-tree-collapse]");
    await sleep(150);
    const shownCollapsed = await count(page, "[data-tree-node]");
    await page.click("[data-tree-expand]");
    await sleep(150);
    const shownExpanded = await count(page, "[data-tree-node]");
    const other = await page.$eval('[data-tree-side="out"] [data-tree-open], [data-tree-side="in"] [data-tree-open]', (b) => b.getAttribute("data-tree-open"));
    await page.$eval(`[data-tree-open="${other}"]`, (b) => b.click());
    await page.waitForSelector(`[data-component-tree="${other}"]`);
    const rerooted = page.url().includes(`/component/${other}`) && page.url().includes(`from=${pick.d.id}`) && page.url().includes("levels=5");
    const onDiagrams = await count(page, "[data-tree-diagram]");
    await page.click("[data-tree-back]");
    await page.waitForSelector(".object-node");
    check(
      "branches fold and open, a name opens that object's own tree, and the way back leads to the diagram",
      shownCollapsed < shownExpanded && rerooted && onDiagrams >= 1 && page.url().endsWith(`/diagram/${pick.d.id}`),
      `${shownCollapsed} folded, ${shownExpanded} open, ${onDiagrams} diagrams`,
    );
  }

  // The MCP server's diagram view, opened the way an assistant's client opens it: in a frame, fed over postMessage.
  {
    const { createMcpHandler } = await import(join(root, "supabase/functions/mcp/handler.js"));
    const mcp = createMcpHandler(() => ({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "anon" }));
    const read = await (await mcp(new Request("https://example.supabase.co/functions/v1/mcp", { method: "POST", headers: { Authorization: "Bearer ark_x", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://archone/diagram.html" } }) }))).json();
    const html = read.result.contents[0].text;
    const host = await newPage(browser, errors);
    await host.setContent(`<!doctype html><body style="margin:0;background:#fff"><iframe id="view" sandbox="allow-scripts" style="width:900px;height:520px;border:0"></iframe><script>
      window.seen = [];
      const frame = document.getElementById("view");
      window.addEventListener("message", (event) => {
        const m = event.data; if (!m || m.jsonrpc !== "2.0") return;
        window.seen.push(m.method || "result");
        if (m.method === "ui/initialize") frame.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "check", version: "1" }, hostCapabilities: {}, hostContext: {} } }, "*");
        if (m.method === "ui/notifications/initialized") frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [], structuredContent: window.picture } }, "*");
        if (m.method === "ui/notifications/size-changed") window.size = m.params;
      });
    </script></body>`);
    await host.evaluate((html) => {
      window.picture = { found: true, diagram: { id: "d", name: "Checkout <img src=x onerror=window.pwned=1>", description: "", view: "custom" }, others: [],
        boxes: [{ id: "a", name: "Web shop", kind: "Web app", lifecycle: "active", x: 0, y: 0 }, { id: "b", name: "<script>window.pwned=1</script>", kind: "Service or API", lifecycle: "deprecated", x: 320, y: 0 }, { id: "c", name: "Orders database", kind: "Database", lifecycle: "active", x: 320, y: 160 }],
        arrows: [{ from: "a", to: "b", kind: "calls", label: "HTTPS" }, { from: "b", to: "c", kind: "reads writes", label: "" }] };
      document.getElementById("view").srcdoc = html;
    }, html);
    await host.waitForFunction(() => window.size && window.seen.includes("ui/notifications/size-changed") && window.seen.includes("ui/notifications/initialized"), { timeout: 8000 });
    await sleep(300);
    const frame = host.frames().find((f) => f !== host.mainFrame());
    const drawnView = await frame.evaluate(() => ({ boxes: document.querySelectorAll("g.box").length, arrows: document.querySelectorAll("g.arrow line").length, title: document.getElementById("title").textContent, images: document.querySelectorAll("img, script:not(:first-of-type)").length, pwned: !!window.pwned }));
    check(
      "the MCP diagram view shakes hands with its host, draws what it is sent, and treats names as text",
      drawnView.boxes === 3 && drawnView.arrows === 2 && drawnView.title.startsWith("Checkout <img") && drawnView.images === 0 && !drawnView.pwned && (await host.evaluate(() => window.seen[0])) === "ui/initialize" && (await host.evaluate(() => window.size.height)) > 100,
      `${drawnView.boxes} boxes, ${drawnView.arrows} arrows`,
    );
    await shot(host, "17-mcp-diagram-view");
    await host.close();
  }

  // The architecture as a Word document and as slides, written in the browser.
  await page.goto(`${base}/document`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-document-diagrams] li");
  const docDiagrams = await count(page, "[data-document-diagrams] li");
  await page.type("[data-document-title]", "Shop architecture review");
  await page.click("[data-document-word]");
  await page.waitForFunction(() => document.querySelector("[data-document-done]")?.textContent.includes(".docx"), { timeout: 90000 });
  await sleep(800);
  const docxName = (await readdir(downloads)).find((f) => f.endsWith(".docx"));
  const docx = docxName ? await JSZip.loadAsync(await readFile(join(downloads, docxName))) : null;
  const docXml = docx ? await docx.file("word/document.xml").async("string") : "";
  // Pictures placed in the text; two identical diagrams share one stored image.
  const docPictures = (docXml.match(/<pic:pic\b/g) ?? []).length;
  check(
    "the model is written up as a Word document with a picture of each diagram",
    /^shop-architecture-review-\d{4}-\d\d-\d\d\.docx$/.test(docxName ?? "") && docPictures === docDiagrams && docXml.includes("Shop architecture review") && docXml.includes("How the parts connect") && !(await hasText(page, "could not be drawn")),
    `${docPictures} pictures for ${docDiagrams} diagrams`,
  );
  if (docxName) await copyFile(join(downloads, docxName), join(shots, "export-sample.docx"));
  await page.click("[data-document-slides]");
  await page.waitForFunction(() => document.querySelector("[data-document-done]")?.textContent.includes(".pptx"), { timeout: 90000 });
  await sleep(800);
  const pptxName = (await readdir(downloads)).find((f) => f.endsWith(".pptx"));
  const pptx = pptxName ? await JSZip.loadAsync(await readFile(join(downloads, pptxName))) : null;
  const slideCount = pptx ? Object.keys(pptx.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length : 0;
  const slidePictures = pptx ? Object.keys(pptx.files).filter((f) => f.startsWith("ppt/media/")).length : 0;
  check("and as slides, one diagram to a slide", slideCount >= docDiagrams + 2 && slidePictures >= docDiagrams, `${slideCount} slides, ${slidePictures} pictures`);
  if (pptxName) await copyFile(join(downloads, pptxName), join(shots, "export-sample.pptx"));
  await shot(page, "14-document");

  // A stamped export, and the check its code leads to.
  const stampDiagram = Object.values((await stored()).diagrams).find((d) => d.name === "Inside Online store").id;
  await page.goto(`${base}/diagram/${stampDiagram}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".object-node");
  await sleep(400);
  for (const f of await readdir(downloads)) if (f.endsWith(".png")) await rm(join(downloads, f));
  await page.click("[data-export-open]");
  await page.waitForSelector("[data-export-window]");
  const stampOn = await page.$eval("[data-export-stamp]", (e) => e.checked);
  await exportAs(page, "png");
  await sleep(2500);
  const stampedPng = (await readdir(downloads)).find((f) => f.endsWith(".png"));
  const stampedHeight = stampedPng ? (await readFile(join(downloads, stampedPng))).readUInt32BE(20) : 0;
  await page.click("[data-export-stamp]");
  if (stampedPng) await rm(join(downloads, stampedPng));
  await exportAs(page, "png");
  await sleep(2500);
  const plainPng = (await readdir(downloads)).find((f) => f.endsWith(".png"));
  const plainHeight = plainPng ? (await readFile(join(downloads, plainPng))).readUInt32BE(20) : 0;
  check("a PNG is stamped with a strip under the picture unless that is switched off", stampOn && plainHeight > 0 && stampedHeight - plainHeight >= 150 && stampedHeight - plainHeight <= 400, `${stampedHeight} against ${plainHeight} pixels high`);
  await page.click("[data-export-stamp]");
  await closeExport(page);

  // The information box without a shared workspace: shown when chosen, and drawn under an exported picture.
  await page.click('button[aria-label="Diagram settings"]');
  await page.waitForSelector("[data-title-block-show]");
  await page.$eval("[data-title-block-show]", (e) => e.click());
  await page.waitForSelector("[data-title-block]");
  const localBox = await page.$eval("[data-title-block]", (e) => e.innerText.replace(/\s+/g, " "));
  const boxSaved = await page
    .waitForFunction((id) => JSON.parse(localStorage.getItem("archone.workspace.v1") ?? "{}").diagrams?.[id]?.titleBlock?.show === true, { timeout: 5000 }, stampDiagram)
    .then(() => true, () => false);
  check(
    "without a shared workspace a diagram can show its information box, with dashes where approval needs one",
    localBox.includes("Inside Online store") && localBox.includes("Approval needs a shared workspace") && (await page.$eval('[data-title-block] [data-title-block-field="ea"]', (e) => e.innerText)).includes("—") && boxSaved,
    `${boxSaved ? "kept" : "not kept"}: ${localBox.slice(-120)}`,
  );
  await shot(page, "20-information-box-local");
  for (const f of await readdir(downloads)) if (f.endsWith(".png")) await rm(join(downloads, f));
  await page.click("[data-export-open]");
  await page.waitForSelector("[data-export-box]");
  await exportAs(page, "png");
  await sleep(2500);
  const boxPng = (await readdir(downloads)).find((f) => f.endsWith(".png"));
  const boxHeight = boxPng ? (await readFile(join(downloads, boxPng))).readUInt32BE(20) : 0;
  if (boxPng) await copyFile(join(downloads, boxPng), join(shots, "export-information-box.png"));
  check("an exported PNG carries the information box and its code under the picture", boxHeight - plainHeight >= 150, `${boxHeight} against ${plainHeight} pixels high`);
  await closeExport(page);
  await page.$eval("[data-title-block-show]", (e) => e.click());
  await page.waitForFunction(() => !document.querySelector("[data-title-block]"));
  await page.click('button[aria-label="Diagram settings"]');

  await page.goto(`${base}/diagram/${stampDiagram}?asof=${encodeURIComponent(new Date().toISOString())}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-copy-check]");
  const copyNow = await page.$eval("[data-copy-check]", (e) => [e.getAttribute("data-copy-check"), e.innerText]);
  await page.goto(`${base}/diagram/${stampDiagram}?asof=2020-01-01T00%3A00%3A00.000Z`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-copy-check]");
  const copyOld = await page.$eval("[data-copy-check]", (e) => [e.getAttribute("data-copy-check"), e.innerText.replace(/\s+/g, " ")]);
  check("opening a stamped copy's link says whether the copy is still current", copyNow[0] === "current" && copyNow[1].includes("is still current") && copyOld[0] === "stale" && copyOld[1].includes("is out of date") && /objects on it changed/.test(copyOld[1]), copyOld[1].slice(0, 120));
  await shot(page, "20-copy-check");
  await page.click('[data-copy-check] button[aria-label="Close this note"]');
  await sleep(200);
  check("closing the note leaves the plain diagram address", (await count(page, "[data-copy-check]")) === 0 && !page.url().includes("asof"));

  // CALM export, the NCA pack and a draft from a meeting.
  await page.goto(`${base}/diagram/${stampDiagram}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".object-node");
  await exportAs(page, "calm");
  await closeExport(page);
  await sleep(700);
  const calmFile = (await readdir(downloads)).find((f) => f.endsWith(".calm.json"));
  const calm = calmFile ? JSON.parse(await readFile(join(downloads, calmFile), "utf8")) : null;
  const kinds = calm ? new Set(calm.relationships.map((r) => Object.keys(r["relationship-type"])[0])) : new Set();
  check("a diagram exports as FINOS CALM: nodes with the required fields and typed relationships", !!calm && calm.$schema === "https://calm.finos.org/release/1.2/meta/calm.json" && calm.nodes.length === Object.keys((await stored()).diagrams[stampDiagram].nodes).length && calm.nodes.every((n) => n["unique-id"] && n["node-type"] && n.name && n.description) && kinds.has("connects") && kinds.has("interacts") && kinds.has("deployed-in"), calm ? `${calm.nodes.length} nodes, ${[...kinds].join(", ")}` : "no file");
  await page.goto(`${base}/checks`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-findings]");
  const ncaBefore = await count(page, '[data-rule^="nca-"]');
  await page.evaluate(() => [...document.querySelectorAll("label")].find((l) => l.textContent.includes("NCA ECC")).querySelector("input").click());
  await sleep(300);
  const ncaRules = await page.$$eval('[data-rule^="nca-"]', (els) => els.map((e) => e.getAttribute("data-rule")));
  check("the NCA ECC pack is off until chosen, then reports with the subdomain it belongs to", ncaBefore === 0 && ncaRules.includes("nca-third-party") && ncaRules.includes("nca-resilience") && (await hasText(page, "ECC 4-1, Third-Party Cybersecurity")), ncaRules.join());
  await page.evaluate(() => [...document.querySelectorAll("label")].find((l) => l.textContent.includes("NCA ECC")).querySelector("input").click());
  await page.goto(`${base}/diagram/${stampDiagram}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".object-node");
  await clickText(page, "Draft with AI");
  await clickText(page, "From a meeting", "[role=tab]");
  await page.waitForSelector('textarea[aria-label="Meeting transcript"]');
  await page.type('textarea[aria-label="Meeting transcript"]', "Olivia: Thanks for joining.\nSam: The partner portal will call the order service over HTTPS.\nPriya: The order service stores returns in the returns database.");
  await clickText(page, "Create draft");
  await waitText(page, "Drafted from what was said in a meeting");
  const evidence = await page.$$eval("[data-evidence]", (els) => els.map((e) => e.textContent.trim()));
  await sleep(450);
  const meeting = Object.values((await stored()).proposals).find((p) => p.sourceKind === "transcript");
  check("a meeting transcript becomes a draft whose items quote the sentence and the speaker", evidence.some((e) => e.startsWith('Sam: "The partner portal will call the order service')) && evidence.some((e) => e.startsWith("Priya:")) && !!meeting && meeting.status === "pending" && meeting.objects.some((o) => o.name.toLowerCase() === "order service" && o.matchId), `${evidence.join(" / ")} :: ${meeting ? meeting.objects.map((o) => o.name + (o.matchId ? "*" : "")).join(", ") : "none"}`.slice(0, 500));
  await shot(page, "21-meeting-draft");

  // Flows: a use case told step by step over a diagram, written by clicking its arrows.
  await page.goto(`${base}/diagram/${landscapeId}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".object-node");
  await sleep(500);
  const flowsOfDiagram = async () => (await stored()).diagrams[landscapeId].flows ?? [];
  check("a diagram starts without flows, and without the strip that walks through them", (await flowsOfDiagram()).length === 0 && (await count(page, "[data-flow-bar]")) === 0);
  await page.click("[data-flows-button]");
  await page.waitForSelector("[data-flows-panel]");
  await clickText(page, "New flow");
  await page.waitForSelector('input[aria-label="Flow name"]');
  await page.$eval('input[aria-label="Flow name"]', (e) => e.select());
  await page.type('input[aria-label="Flow name"]', "A customer places an order");
  await page.keyboard.press("Enter");
  await sleep(300);
  // A click on an arrow adds it as the next step instead of opening the arrow's details.
  const arrowEnds = await page.$eval(".react-flow__edge", (e) => {
    e.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return e.getAttribute("data-id");
  });
  await page.waitForSelector('[data-flow-step-row="1"]');
  await sleep(350);
  const firstFlow = (await flowsOfDiagram())[0];
  const firstEdge = (await stored()).relationships[arrowEnds];
  check(
    "clicking an arrow while a flow is open adds it as a step, from the arrow's start to its end",
    firstFlow.name === "A customer places an order" && firstFlow.steps.length === 1 && (!firstEdge || (firstFlow.steps[0].fromId === firstEdge.sourceId && firstFlow.steps[0].toId === firstEdge.targetId)) && (await count(page, 'aside[aria-label="Details"]')) === 0,
    JSON.stringify({ name: firstFlow.name, steps: firstFlow.steps, edge: firstEdge && [firstEdge.sourceId, firstEdge.targetId], details: await count(page, 'aside[aria-label="Details"]') }),
  );
  await page.click('textarea[aria-label="What happens in step 1"]');
  await page.keyboard.type("The customer sends the basket");
  await page.click('[data-flow-add] button');
  await page.waitForSelector('[data-flow-step-row="2"]');
  await sleep(350);
  const twoSteps = (await flowsOfDiagram())[0].steps;
  check("a step keeps what was written about it, and a second one can be added from the two lists", twoSteps.length === 2 && twoSteps[0].text === "The customer sends the basket" && twoSteps[1].fromId in (await stored()).diagrams[landscapeId].nodes, JSON.stringify(twoSteps));
  await page.click('[data-flow-step-row="1"] button[title="Show this step on the diagram"]');
  await sleep(300);
  const lit = async (p = page) => ({
    focus: await count(p, '.object-node[data-highlight="focus"]'),
    dim: await count(p, '.object-node[data-highlight="dim"]'),
    edges: await count(p, ".react-flow__edge.flow-edge"),
    dimEdges: await count(p, ".react-flow__edge.dim-edge"),
    text: await p.$eval("[data-flow-step]", (e) => e.innerText).catch(() => ""),
    at: await p.$eval("[data-flow-count]", (e) => e.textContent.trim()).catch(() => ""),
  });
  const stepOne = await lit();
  check("a step brings its two boxes and its arrow forward and dims the rest", stepOne.focus === 2 && stepOne.dim >= 1 && stepOne.edges >= 1 && stepOne.dimEdges >= 1 && stepOne.at === "1 of 2" && stepOne.text.includes("The customer sends the basket"), JSON.stringify(stepOne));
  await shot(page, "22-flow-step");
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("ArrowRight");
  await sleep(250);
  const stepTwo = await lit();
  await page.keyboard.press("ArrowRight");
  await sleep(200);
  check("the arrow keys walk through the steps and stop at the last one", stepTwo.at === "2 of 2" && (await lit()).at === "2 of 2");
  await page.click('[data-flow-step-row="2"] button[aria-label="Move step 2 up"]');
  await sleep(350);
  check("steps can be put in another order", (await flowsOfDiagram())[0].steps[1].text === "The customer sends the basket");
  await page.click('button[aria-label="Undo (Ctrl Z)"]');
  await sleep(350);
  check("one undo takes the reordering back", (await flowsOfDiagram())[0].steps[0].text === "The customer sends the basket");
  await page.keyboard.press("Escape");
  await sleep(250);
  check("Escape stops the walk and the diagram is shown as usual", (await count(page, ".object-node[data-highlight]")) === 0 && (await count(page, ".react-flow__edge.flow-edge")) === 0);

  // The same flow for someone presenting, and for someone holding a snapshot link.
  await clickText(page, "Present");
  await page.waitForSelector("[data-present]");
  await page.waitForSelector("[data-flow-bar]");
  await page.select('select[aria-label="Flow to walk through"]', (await flowsOfDiagram())[0].id);
  await sleep(300);
  const shownBefore = await presented();
  await page.keyboard.press("ArrowRight");
  await sleep(300);
  const presentedStep = await lit();
  check("while presenting, an open flow takes the arrow keys and the diagram stays", (await presented()) === shownBefore && presentedStep.at === "2 of 2" && presentedStep.focus >= 1, JSON.stringify(presentedStep));
  await shot(page, "23-flow-present");
  await page.keyboard.press("Escape");
  await sleep(200);
  await page.keyboard.press("Escape");
  await page.waitForSelector('nav[aria-label="Main"]');
  await clickText(page, "Share");
  await waitText(page, "Create link");
  await clickText(page, "Create link");
  await page.waitForSelector('input[aria-label="Share link"]');
  const flowLink = await page.$eval('input[aria-label="Share link"]', (e) => e.value);
  await clickText(page, "Done");
  const flowViewer = await newPage(await browser.createBrowserContext(), errors);
  await flowViewer.goto(flowLink, { waitUntil: "networkidle0" });
  await flowViewer.waitForSelector("[data-flow-bar]");
  await flowViewer.select('select[aria-label="Flow to walk through"]', (await flowsOfDiagram())[0].id);
  await sleep(300);
  const sharedStep = await lit(flowViewer);
  check("a shared link carries the flows, to walk through without an account", sharedStep.at === "1 of 2" && sharedStep.focus === 2 && sharedStep.text.includes("The customer sends the basket"), JSON.stringify(sharedStep));
  await flowViewer.close();

  // Links to the real thing, on an object and on a connection.
  const linked = await objectNamed("Order service");
  await page.goto(`${base}/model?object=${linked.id}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-links]");
  await page.type('[data-links] input[aria-label="Web address of the link"]', "javascript:alert(1)");
  await page.click("[data-links] button:last-of-type");
  await sleep(250);
  const refused = (await hasText(page, "Enter a web address")) && !(await stored()).objects[linked.id].links;
  await page.$eval('[data-links] input[aria-label="Web address of the link"]', (e) => e.select());
  await page.type('[data-links] input[aria-label="Web address of the link"]', "github.com/example/order-service");
  await page.type('[data-links] input[aria-label="Name of the link"]', "Repository");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-links] a");
  await sleep(350);
  const anchor = await page.$eval("[data-links] a", (a) => ({ href: a.href, target: a.target, rel: a.rel, text: a.textContent.trim() }));
  const savedLinks = (await stored()).objects[linked.id].links;
  check(
    "an object links to where it really lives; only web addresses are taken, and they open apart from this page",
    refused && anchor.href === "https://github.com/example/order-service" && anchor.target === "_blank" && anchor.rel.includes("noopener") && anchor.rel.includes("noreferrer") && anchor.text === "Repository" && savedLinks.length === 1 && savedLinks[0].url === anchor.href,
    JSON.stringify({ refused, anchor, savedLinks }),
  );
  await shot(page, "24-links");
  await page.click('[data-links] button[aria-label="Remove the link to Repository"]');
  await sleep(350);
  check("removing the last link leaves the object as it was before it had any", !("links" in (await stored()).objects[linked.id]));
  await page.click('button[aria-label="Undo (Ctrl Z)"]');
  await sleep(350);
  const shareWithLink = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem("archone.workspace.v1")).objects));
  check("undo brings the link back", shareWithLink.includes("github.com/example/order-service"));

  // The component library: searched and placed from the editor, and browsed on its own page.
  await page.goto(`${base}/diagram/${landscapeId}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-library-panel]");
  const boxesBeforeLibrary = await count(page, ".object-node");
  await page.type('input[aria-label="Find a component in the library"]', "next-generation firewall");
  await page.waitForSelector('[data-library-panel] [data-component="security.next-generation-firewall"]');
  await page.$eval('[data-library-panel] [data-component="security.next-generation-firewall"]', (b) => b.click());
  await page.waitForFunction((n) => document.querySelectorAll(".object-node").length === n + 1, {}, boxesBeforeLibrary);
  await sleep(400);
  const firewall = Object.values((await stored()).objects).find((o) => o.componentId === "security.next-generation-firewall");
  const firewallBox = await page.$eval(`.react-flow__node[data-id="${firewall?.id}"] .object-node__meta`, (e) => e.textContent).catch(() => "");
  check(
    "a component from the library becomes an object of its kind, drawn with its own icon and name",
    firewall && firewall.typeId === "network" && firewall.name === "Next-generation firewall" && firewallBox.startsWith("Security") && (await page.$eval(`.react-flow__node[data-id="${firewall.id}"] svg.lucide`, (e) => e.getAttribute("class"))).includes("brick-wall-shield"),
    JSON.stringify({ typeId: firewall?.typeId, firewallBox }),
  );
  await shot(page, "25-library-component");
  await page.waitForSelector('aside[aria-label="Details"] [data-basic-information="security-control"]');
  const askedFor = await page.$$eval('[data-basic-information] [aria-label]', (els) => els.map((e) => e.getAttribute("aria-label")));
  check("its details ask for the basic information of a security control", ["Vendor", "Product", "Deployment", "Protects", "Licence ends"].every((l) => askedFor.includes(l)), askedFor.join(", "));
  await page.type('[data-basic-information] input[aria-label="Vendor"]', "Example Networks");
  await page.keyboard.press("Enter");
  await page.select('[data-basic-information] select[aria-label="Deployment"]', "Inline appliance");
  await sleep(350);
  const filledIn = (await stored()).objects[firewall.id].fields;
  check("what is filled in is kept with the object, under the field's name", filledIn.Vendor === "Example Networks" && filledIn.Deployment === "Inline appliance" && (await page.$eval("[data-basic-information] legend", (e) => e.innerText)).includes("2 of"), JSON.stringify(filledIn));
  await page.$eval('[data-basic-information] input[aria-label="Vendor"]', (e) => e.select());
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  await sleep(300);
  check("emptying a field removes it instead of keeping an empty value", !("Vendor" in (await stored()).objects[firewall.id].fields));
  // Changing what an existing object is.
  await page.$eval('[data-component-field] + button, [data-component-field] button', (b) => b.click());
  await page.waitForSelector('[role=dialog] [data-library-panel]');
  await page.type('[role=dialog] input[aria-label="Find a component in the library"]', "web application firewall");
  await page.waitForSelector('[role=dialog] [data-component="security.web-application-firewall"]');
  await page.$eval('[role=dialog] [data-component="security.web-application-firewall"]', (b) => b.click());
  await sleep(400);
  const changed = (await stored()).objects[firewall.id];
  check("an object can be told it is another component; its type follows and what was filled in stays", changed.componentId === "security.web-application-firewall" && changed.typeId === "gateway" && changed.fields.Deployment === "Inline appliance", JSON.stringify({ c: changed.componentId, t: changed.typeId }));
  // Dragging a cloud service from the panel onto the canvas.
  await page.$eval('input[aria-label="Find a component in the library"]', (e) => e.select());
  await page.keyboard.press("Backspace");
  await page.select('[data-library-panel] select[aria-label="Part of the library"]', "aws");
  await page.$eval('[data-library-section="aws.storage"]', (b) => b.click());
  await page.waitForSelector('[data-component="aws.simple-storage-service-s3"]');
  const before2 = await count(page, ".object-node");
  await page.evaluate(() => {
    const tile = document.querySelector('[data-component="aws.simple-storage-service-s3"]');
    const pane = document.querySelector(".react-flow");
    const data = new DataTransfer();
    tile.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }));
    const r = pane.getBoundingClientRect();
    pane.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data, clientX: r.x + r.width / 2, clientY: r.y + 80 }));
  });
  await page.waitForFunction((n) => document.querySelectorAll(".object-node").length === n + 1, {}, before2);
  await sleep(350);
  const s3 = Object.values((await stored()).objects).find((o) => o.componentId === "aws.simple-storage-service-s3" && o.provenance?.origin !== "import");
  check("a cloud service dragged onto the canvas is storage, named by its provider", s3 && s3.typeId === "storage" && s3.technology === "AWS Simple Storage Service (S3)", JSON.stringify(s3 && { t: s3.typeId, tech: s3.technology }));

  await page.goto(`${base}/library`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-library-page]");
  const headline = await page.$eval("[data-library-page] h1 + p", (e) => e.innerText);
  const generalSections = await page.$$eval("[data-library-page] aside [data-library-section]", (els) => els.map((e) => e.innerText.split("\n")[0]));
  check("the library page lists the general sections and the cloud providers", /\d,?\d{3} components/.test(headline) && ["Hardware and compute", "Data centre and facilities", "Network", "Security", "End-user computing", "Databases and data", "Applications"].every((x) => generalSections.includes(x)), `${headline} :: ${generalSections.join(" / ")}`);
  await page.select('[data-library-page] select[aria-label="Part of the library"]', "oci");
  await sleep(250);
  const ociSections = await page.$$eval("[data-library-page] aside [data-library-section]", (els) => els.length);
  await page.$eval('[data-library-section="oci.databases"]', (b) => b.click());
  await sleep(200);
  await page.$eval('[data-library-grid] [data-component="oci.autonomous-database"]', (b) => b.click());
  await page.waitForSelector('[data-library-detail="oci.autonomous-database"]');
  const ociFields = await page.$$eval("[data-library-fields] li", (els) => els.map((e) => e.innerText.split("\n")[0]));
  check("a provider's services are shown with what they become and the information they ask for", ociSections >= 8 && ociFields.includes("Engine and version") && ociFields.includes("Region"), ociFields.join(", "));
  await shot(page, "26-library-page");
  await page.type('input[aria-label="Search the library"]', "kafka");
  await sleep(250);
  const kafka = await page.$$eval("[data-library-grid] [data-component]", (els) => els.map((e) => e.getAttribute("data-component")));
  check("searching the library looks through every section and provider", kafka.length >= 5 && kafka.some((id) => id.startsWith("aws.")) && kafka.some((id) => id.startsWith("platforms.")), kafka.join(", "));
  await clickText(page, "Add to the model");
  await page.waitForFunction(() => location.pathname === "/model");
  await sleep(300);
  check("a component can be added to the model from the library page", Object.values((await stored()).objects).some((o) => o.componentId === "oci.autonomous-database" && o.typeId === "database"));

  // The workspace's own components: new, changed, copied, removed and put back, deleted.
  {
    await page.goto(`${base}/library`, { waitUntil: "networkidle0" });
    await page.click("[data-component-new]");
    await page.waitForSelector("[data-component-dialog]");
    await page.type('input[aria-label="Component name"]', "Core ledger");
    await page.select('select[aria-label="Section"]', "applications");
    await page.select('select[aria-label="Object type"]', "application");
    await page.type('input[aria-label="Other names"]', "general ledger, GL");
    await page.type('input[aria-label="Search icons"]', "landmark");
    await page.click('[data-icon="Landmark"]');
    await page.click("[data-component-save]");
    await page.waitForFunction(() => document.querySelector("[data-library-detail] h2")?.textContent === "Core ledger");
    const ownId = await page.$eval("[data-library-detail]", (e) => e.getAttribute("data-library-detail"));
    const ownTile = await page.$eval(`[data-library-grid] [data-component="${ownId}"]`, (e) => e.innerText);
    await sleep(400);
    const savedOwn = (await stored()).library?.[ownId];
    check(
      "a new component joins its section, marked as the workspace's own, and is kept with the workspace",
      ownTile.includes("Your own") && savedOwn?.component?.icon === "Landmark" && savedOwn.component.aliases === "general ledger, GL",
      `${ownId}: ${ownTile.replace(/\n/g, " ")}`,
    );
    await page.click('[data-library-section="__own"]');
    await sleep(150);
    const ownList = await page.$$eval("[data-library-grid] [data-component]", (els) => els.map((e) => e.getAttribute("data-component")));

    // A built-in one changed for this workspace only, then put back.
    await page.goto(`${base}/library?component=security.next-generation-firewall`, { waitUntil: "networkidle0" });
    await page.waitForSelector("[data-component-edit]");
    await page.click("[data-component-edit]");
    await page.waitForSelector("[data-component-dialog]");
    await page.$eval('input[aria-label="Component name"]', (e) => e.select());
    await page.keyboard.type("Perimeter firewall");
    await page.click("[data-component-save]");
    await page.waitForFunction(() => document.querySelector("[data-library-detail] h2")?.textContent === "Perimeter firewall");
    const changedTile = await page.$eval('[data-component="security.next-generation-firewall"]', (e) => e.innerText);
    await page.click("[data-component-reset]");
    await page.waitForFunction(() => document.querySelector("[data-library-detail] h2")?.textContent === "Next-generation firewall");
    await sleep(400);
    check("a built-in component can be changed for this workspace and put back", ownList.includes(ownId) && changedTile.includes("Perimeter firewall") && changedTile.includes("Changed here") && !(await stored()).library?.["security.next-generation-firewall"], changedTile.replace(/\n/g, " "));

    // Copied, then the copy deleted; a built-in removed and put back.
    await page.click("[data-component-duplicate]");
    await page.waitForFunction(() => document.querySelector("[data-library-detail] h2")?.textContent === "Next-generation firewall (copy)");
    const copyId = await page.$eval("[data-library-detail]", (e) => e.getAttribute("data-library-detail"));
    await page.click("[data-component-remove]");
    await page.click("[data-library-remove-confirm]");
    await sleep(400);
    const copyGone = !(await stored()).library?.[copyId] && !(await page.$(`[data-component="${copyId}"]`));
    await page.goto(`${base}/library?component=security.next-generation-firewall`, { waitUntil: "networkidle0" });
    await page.click("[data-component-remove]");
    await waitText(page, "You can put it back");
    await page.click("[data-library-remove-confirm]");
    await page.waitForSelector('[data-library-section="__removed"]');
    const hidden = !(await page.$('[data-library-grid] [data-component="security.next-generation-firewall"]'));
    await page.click('[data-library-section="__removed"]');
    await page.waitForSelector('[data-removed-component="security.next-generation-firewall"]');
    await shot(page, "26b-library-removed");
    await page.click('[data-component-restore="security.next-generation-firewall"]');
    await page.waitForFunction(() => !document.querySelector('[data-library-section="__removed"]'));
    await sleep(400);
    check("a copy is the workspace's own and can be deleted; a built-in one is removed and put back", copyId.startsWith("own.") && copyGone && hidden && !(await stored()).library?.["security.next-generation-firewall"], copyId);

    // Protocols: a new one, a copy, a built-in one removed and put back, and the new one deleted.
    await page.goto(`${base}/library`, { waitUntil: "networkidle0" });
    await page.click('[data-library-section="__protocols"]');
    await page.waitForSelector("[data-protocol-new]");
    await page.click("[data-protocol-new]");
    await page.waitForSelector("[data-protocol-dialog]");
    await page.type('input[aria-label="Protocol name"]', "Card switch link");
    await page.type('input[aria-label="Protocol port"]', "7001");
    await page.$eval('input[aria-label="Protocol group"]', (e) => e.select());
    await page.keyboard.type("Payments");
    await page.click("[data-protocol-secure]");
    await page.click("[data-protocol-save]");
    await page.waitForSelector('[data-protocol="Card switch link"]');
    const newRow = await page.$eval('[data-protocol="Card switch link"]', (e) => e.innerText.replace(/\s+/g, " "));
    await page.$eval('[data-protocol-duplicate="HTTPS"]', (b) => b.click());
    await page.waitForSelector('[data-protocol="HTTPS (copy)"]');
    await page.$eval('[data-protocol-remove="Telnet"]', (b) => b.click());
    await page.click("[data-library-remove-confirm]");
    await page.waitForSelector("[data-protocols-removed-open]");
    const telnetHidden = !(await page.$('[data-protocol="Telnet"]'));
    await page.click("[data-protocols-removed-open]");
    await page.click('[data-protocol-restore="Telnet"]');
    await sleep(200);
    await page.waitForSelector('[data-protocol-remove="Card switch link"]');
    await page.$eval('[data-protocol-remove="Card switch link"]', (b) => b.click());
    await page.click("[data-library-remove-confirm]");
    await sleep(400);
    const protocolsLeft = Object.values((await stored()).library ?? {}).filter((i) => i.type === "protocol").map((i) => i.protocol?.name ?? `removed ${i.id}`);
    check(
      "protocols can be added, copied, removed and put back, and deleted",
      newRow.includes("Card switch link Your own 7001 TCP Payments") && telnetHidden && !!(await page.$('[data-protocol="Telnet"]')) && !(await page.$('[data-protocol="Card switch link"]')) && protocolsLeft.join() === "HTTPS (copy)",
      `${newRow} :: ${protocolsLeft.join(", ")}`,
    );
    await shot(page, "26c-library-protocols");
  }

  // Settings and backup.
  await page.goto(`${base}/settings`, { waitUntil: "networkidle0" });
  await waitText(page, "No AI model connected");
  const beforeBackup = Object.keys((await stored()).objects).length;
  await clickText(page, "Download backup");
  await sleep(800);
  const backup = (await readdir(downloads)).find((f) => f.endsWith("-backup.json"));
  check("backup downloads as JSON", !!backup);
  if (backup) {
    const input = await page.$('input[aria-label="Backup file"]');
    await input.uploadFile(join(downloads, backup));
    await waitText(page, "Replace this workspace with the backup?");
    await clickText(page, "Replace workspace");
    await waitText(page, "Backup restored.");
    check("a backup can be restored", Object.keys((await stored()).objects).length === beforeBackup);
    await writeFile(join(downloads, "broken.json"), '{"hello": 1}');
    await (await page.$('input[aria-label="Backup file"]')).uploadFile(join(downloads, "broken.json"));
    await waitText(page, "is not a workspace backup");
    check("a wrong file is refused with an explanation", true);
  }

  /* ---------- import and export by file ---------- */
  const fixtures = join(root, "src/lib/import/fixtures");
  const importFile = async (name) => {
    await clickText(page, "Import");
    await waitText(page, "The file becomes a draft.");
    await (await page.$('input[aria-label="File to import"]')).uploadFile(join(fixtures, name));
  };
  const modelBefore = Object.keys((await stored()).objects).length;
  await page.goto(`${base}/model`, { waitUntil: "networkidle0" });
  await clickText(page, "Export Excel");
  await sleep(800);
  const workbook = (await readdir(downloads)).find((f) => f.endsWith(".xlsx"));
  check("the model exports as an Excel workbook", !!workbook && (await readFile(join(downloads, workbook))).subarray(0, 2).toString() === "PK");
  await clickText(page, "Export ArchiMate");
  await sleep(800);
  const exchange = (await readdir(downloads)).find((f) => f.endsWith("-archimate.xml"));
  const exchangeText = exchange ? await readFile(join(downloads, exchange), "utf8") : "";
  check("the model exports as an ArchiMate exchange file", exchangeText.includes("opengroup.org/xsd/archimate/3.0/") && exchangeText.includes('xsi:type="Serving"') && exchangeText.includes("<views>"));
  if (exchange) {
    await clickText(page, "Import");
    await waitText(page, "The file becomes a draft.");
    await (await page.$('input[aria-label="File to import"]')).uploadFile(join(downloads, exchange));
    await page.waitForSelector("[data-import-summary]");
    const exchangeSummary = await page.$eval("[data-import-summary]", (e) => e.innerText);
    check("an ArchiMate exchange file is read back and its objects are found in the model", /already in the model/.test(exchangeSummary), exchangeSummary.slice(0, 100));
    await clickText(page, "Cancel");
  }

  await importFile("applications.xlsx");
  await page.waitForSelector("[data-import-summary]");
  const mapped = await page.evaluate(() => {
    const value = (label) => document.querySelector(`select[aria-label="${label}"]`)?.selectedOptions[0]?.textContent;
    return [value("Column for Name in Applications"), value("Column for Owner in Applications"), value("Column for From in Integrations"), document.querySelectorAll("fieldset[data-sheet]").length].join(" | ");
  });
  check("an Excel file opens with its sheets recognised and its columns matched to fields", mapped === "A: Application Name | D: Business Owner | A: Source | 3", mapped);
  const summary = () => page.$eval("[data-import-summary]", (e) => e.innerText.replace(/\s+/g, " "));
  check("the dialog says what the draft will hold and which rows are left out", /6 objects and 3 relationships/.test(await summary()) && /Applications, row 5: No name/.test(await summary()), (await summary()).slice(0, 90));
  // Mapping is the person's call: without the owner column, nobody is given an owner.
  await page.select('select[aria-label="Column for Name in Applications"]', "");
  await waitText(page, "Choose the column for Name");
  const blocked = await page.evaluate(() => [...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim() === "Create draft to review").disabled);
  await page.select('select[aria-label="Column for Name in Applications"]', "0");
  await page.waitForSelector("[data-import-summary]");
  check("a required column that is not chosen stops the import and says which", blocked);
  await shot(page, "12-import-mapping");
  await clickText(page, "Create draft to review");
  await waitText(page, "Review the draft");
  check("the import becomes a draft to review, and the model is untouched until then", (await hasText(page, "Imported from this file")) && Object.keys((await stored()).objects).length === modelBefore);
  await clickText(page, "Accept all");
  await clickText(page, "Save accepted to the model");
  await waitText(page, "Every component and dependency, stored once.");
  await sleep(500);
  const afterSheet = await stored();
  const portal = Object.values(afterSheet.objects).find((o) => o.name === "Billing Portal");
  check(
    "accepted rows are saved with their columns and the file as their origin, without drawing a diagram",
    Object.keys(afterSheet.objects).length === modelBefore + 6 && portal?.owner === "Finance IT" && portal?.technology === "React" && portal?.provenance.origin === "import" && portal?.provenance.source === "applications.xlsx",
    `${Object.keys(afterSheet.objects).length - modelBefore} new objects`,
  );

  // The same file again changes nothing; an edited copy updates what it names.
  await writeFile(join(downloads, "owners.csv"), "Name;Owner;Status\nBilling Portal;Payments team;\nLedger DB;;retired\n");
  await clickText(page, "Import");
  await waitText(page, "The file becomes a draft.");
  await (await page.$('input[aria-label="File to import"]')).uploadFile(join(downloads, "owners.csv"));
  await page.waitForSelector("[data-import-summary]");
  check("a CSV file with semicolons is read, and its objects are found in the model", /All of them are already in the model/.test(await summary()), (await summary()).slice(0, 110));
  await clickText(page, "Create draft to review");
  await waitText(page, "Updates owner");
  check("the review shows what each row would change on an existing object", (await hasText(page, "Updates lifecycle")) && (await count(page, "tbody tr")) === 2);
  await clickText(page, "Accept all");
  await clickText(page, "Save accepted to the model");
  await waitText(page, "Every component and dependency, stored once.");
  await sleep(400);
  const updated = await stored();
  const byName = (name) => Object.values(updated.objects).find((o) => o.name === name);
  check(
    "a row updates only the fields it fills in",
    byName("Billing Portal").owner === "Payments team" && byName("Billing Portal").lifecycle === "active" && byName("Ledger DB").lifecycle === "retired" && byName("Ledger DB").owner === "Data Platform" && Object.keys(updated.objects).length === modelBefore + 6,
  );

  for (const [file, format, pageName, boxes] of [
    ["shop.drawio", "draw.io", "Shop", 5],
    ["order-flow.vsdx", "Visio", "Page-1", 4],
  ]) {
    await page.goto(base, { waitUntil: "networkidle0" });
    await importFile(file);
    await waitText(page, pageName);
    await page.waitForSelector("[data-import-summary]");
    await clickText(page, "Create draft to review");
    await waitText(page, "Review the draft");
    await clickText(page, "Accept all");
    await clickText(page, "Save accepted to the model");
    await page.waitForSelector(".object-node");
    await sleep(700);
    const drawnBoxes = await count(page, ".object-node");
    const drawnArrows = await count(page, ".react-flow__edge");
    const overlaps = await page.$$eval(".react-flow__node-object", (nodes) => {
      const rects = nodes.map((n) => n.getBoundingClientRect());
      return rects.some((a, i) => rects.some((b, j) => j > i && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
    });
    check(`a ${format} file becomes a diagram with its shapes as boxes, where they were, and its connectors as arrows`, drawnBoxes === boxes && drawnArrows >= 3 && !overlaps, `${drawnBoxes} boxes, ${drawnArrows} arrows${overlaps ? ", overlapping" : ""}`);
    await shot(page, format === "Visio" ? "14-import-visio" : "13-import-drawio");
  }
  await page.goto(`${base}/ai`, { waitUntil: "networkidle0" });
  await clickText(page, "Import a file");
  await waitText(page, "The file becomes a draft.");
  await (await page.$('input[aria-label="File to import"]')).uploadFile(join(fixtures, "apps-semicolon.csv"));
  await page.waitForSelector("[data-import-summary]");
  await clickText(page, "Choose another file");
  await (await page.$('input[aria-label="File to import"]')).uploadFile(join(root, "package.json"));
  await waitText(page, "is not a kind of file this can import");
  check("a file of another kind is refused with the kinds that work", true);
  await clickText(page, "Cancel");
  await shot(page, "10-settings");

  // Reports: built-in ones by area, the workspace's own, and eight export formats.
  {
    await page.goto(`${base}/reports`, { waitUntil: "networkidle0" });
    await page.waitForSelector("[data-report-view]");
    const rowsOf = () => page.$eval("[data-report-rows]", (e) => Number(e.getAttribute("data-report-rows")));
    check("the reports open on the application portfolio, with its chart and rows", (await rowsOf()) > 0 && !!(await page.$("[data-report-chart]")), `${await rowsOf()} rows`);
    await page.click('[data-report-link="interface-catalogue"]');
    await page.waitForFunction(() => document.querySelector("[data-report-view]")?.getAttribute("data-report-view") === "Interface catalogue");
    const allRows = await rowsOf();
    await page.type('input[aria-label="Filter the rows"]', "HTTPS");
    await sleep(200);
    const filteredRows = await rowsOf();
    check("a report's rows can be filtered on the page", filteredRows > 0 && filteredRows < allRows, `${allRows} then ${filteredRows}`);
    const made = [];
    for (const format of ["xlsx", "csv", "pdf", "docx", "pptx", "html", "md", "json"]) {
      await page.click(`[data-report-format="${format}"]`);
      let got = "";
      for (let i = 0; i < 40 && !got; i++) {
        await sleep(200);
        got = (await readdir(downloads)).find((f) => f === `interface-catalogue.${format}`) ?? "";
      }
      if (got) made.push(got);
    }
    const reportCsvText = made.includes("interface-catalogue.csv") ? await readFile(join(downloads, "interface-catalogue.csv"), "utf8") : "";
    const reportDeck = made.includes("interface-catalogue.pptx") ? await JSZip.loadAsync(await readFile(join(downloads, "interface-catalogue.pptx"))) : null;
    check(
      "a report exports as Excel, CSV, PDF, Word, PowerPoint, a web page, Markdown and JSON, with the rows shown",
      made.length === 8 && reportCsvText.trim().split("\r\n").length === filteredRows + 1 && !!reportDeck && Object.keys(reportDeck.files).some((f) => f.startsWith("ppt/slides/slide")),
      made.join(", "),
    );
    for (const f of made) await rm(join(downloads, f));
    await page.click("[data-report-new]");
    await page.waitForSelector("[data-report-builder]");
    await page.type("[data-report-name]", "Components without an owner");
    await page.click("[data-report-filter-add]");
    await page.select('[data-report-filter-field="0"]', "owner");
    await page.select('[data-report-filter-op="0"]', "is empty");
    await page.select("[data-report-group]", "type");
    await page.waitForSelector("[data-report-preview]");
    await page.click("[data-report-save]");
    await page.waitForFunction(() => document.querySelector("[data-report-view]")?.getAttribute("data-report-view") === "Components without an owner");
    await page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem("archone.workspace.v1")).reports ?? {}).length === 1, { timeout: 5000 });
    const own = await stored();
    const saved = Object.values(own.reports ?? {})[0];
    check("a report of your own is saved with the workspace and runs at once", !!saved && saved.filters[0].op === "is empty" && (await page.$eval("[data-reports-mine]", (e) => e.getAttribute("data-reports-mine"))) === "1" && !!(await page.$("[data-report-chart]")));
    await shot(page, "10e-reports");
    await page.click("[data-report-delete]");
    await page.waitForFunction(() => document.querySelector("[data-reports-mine]")?.getAttribute("data-reports-mine") === "0");
    await page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem("archone.workspace.v1")).reports ?? {}).length === 0, { timeout: 5000 });
    check("a report of your own can be deleted", true);
  }

  // The file library: upload, link to diagrams, open from a diagram, change links, delete.
  {
    const uploads = await mkdtemp(join(tmpdir(), "archone-up-"));
    await writeFile(join(uploads, "Vendor install guide.pdf"), "%PDF-1.4\n% a stand-in for a vendor guide\n");
    await writeFile(join(uploads, "Base design.drawio"), "<mxfile><diagram name='Base'/></mxfile>");
    await writeFile(join(uploads, "Meeting notes.txt"), "Agreed the failover test for next quarter.");
    const firstDiagram = Object.values((await stored()).diagrams).find((d) => !d.archive?.archived);
    await page.goto(`${base}/files`, { waitUntil: "networkidle0" });
    await page.waitForSelector("[data-file-input]");
    await (await page.$("[data-file-input]")).uploadFile(join(uploads, "Vendor install guide.pdf"), join(uploads, "Base design.drawio"));
    await page.waitForSelector("[data-file-chosen]");
    await page.select("[data-file-kind]", "vendor");
    await page.click(`[data-link-diagram="${firstDiagram.id}"]`);
    await page.click("[data-file-upload-go]");
    await page.waitForFunction(() => document.querySelector("[data-file-rows]")?.getAttribute("data-file-rows") === "2");
    check("files are uploaded to the library, with their kind and the diagram they belong to", (await page.$$eval("[data-file-links]", (els) => els.every((e) => e.getAttribute("data-file-links") === "1"))) && (await hasText(page, "Vendor document")), firstDiagram.name);
    await shot(page, "10c-file-library");
    await page.goto(`${base}/diagram/${firstDiagram.id}`, { waitUntil: "networkidle0" });
    await page.waitForSelector("[data-diagram-files-count]");
    check("a diagram shows how many files go with it", (await page.$eval("[data-diagram-files-count]", (e) => e.getAttribute("data-diagram-files-count"))) === "2");
    await page.click("[data-diagram-files-open]");
    await page.waitForSelector("[data-diagram-files] [data-file-rows]");
    await (await page.$("[data-diagram-files] [data-file-input]")).uploadFile(join(uploads, "Meeting notes.txt"));
    await page.click("[data-diagram-files] [data-file-upload-go]");
    await page.waitForFunction(() => document.querySelector("[data-diagram-files] [data-file-rows]")?.getAttribute("data-file-rows") === "3");
    check("a file uploaded from a diagram is linked to it", true);
    await shot(page, "10d-diagram-files");
    const tabs = (await browser.pages()).length;
    await page.click('[data-file-open="Meeting notes.txt"]');
    let opened = false;
    for (let i = 0; i < 20 && !opened; i++) {
      await sleep(150);
      opened = (await browser.pages()).length > tabs;
    }
    check("a file opens in a new tab from the diagram", opened);
    for (const extra of (await browser.pages()).slice(tabs)) await extra.close();
    await page.bringToFront();
    await page.goto(`${base}/files`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-file-edit="Base design.drawio"]');
    await page.click('[data-file-edit="Base design.drawio"]');
    await page.waitForSelector("[data-file-edit-dialog]");
    await page.click(`[data-file-edit-dialog] [data-link-diagram="${firstDiagram.id}"]`);
    await page.click("[data-file-save]");
    await page.waitForFunction(() => document.querySelector('[data-file-row="Base design.drawio"] [data-file-links]')?.getAttribute("data-file-links") === "0");
    check("a file's links are changed from the library", await hasText(page, "Not linked: only you see it"));
    await page.click('[data-file-delete="Meeting notes.txt"]');
    await page.click("[data-file-delete-confirm]");
    await page.waitForFunction(() => document.querySelector("[data-file-rows]")?.getAttribute("data-file-rows") === "2");
    check("a file is deleted from the library once confirmed", !(await page.$('[data-file-row="Meeting notes.txt"]')));
    await page.click('[aria-label="Download Vendor install guide.pdf"]');
    let fetched = "";
    for (let i = 0; i < 25 && !fetched; i++) {
      await sleep(200);
      fetched = (await readdir(downloads)).find((f) => f === "Vendor install guide.pdf") ?? "";
    }
    check("a file downloads under its own name", !!fetched && (await readFile(join(downloads, fetched), "utf8")).startsWith("%PDF"));
    if (fetched) await rm(join(downloads, fetched));
    await rm(uploads, { recursive: true, force: true });
  }

  // Appearance: ten themes, each person's own; branding by the workspace.
  {
    await page.goto(`${base}/settings`, { waitUntil: "networkidle0" });
    await page.waitForSelector("[data-theme-pick]");
    const themeCount = await count(page, "[data-theme-pick]");
    await page.click('[data-theme-pick="circuit"]');
    await sleep(300);
    const dark = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, ambient: document.querySelector(".ambient")?.getAttribute("data-ambient"), base: getComputedStyle(document.body).backgroundColor }));
    check("ten themes to choose from, and choosing one changes the colours and the moving background", themeCount === 10 && dark.theme === "circuit" && dark.ambient === "circuit" && dark.base === "rgb(11, 18, 32)", JSON.stringify(dark));
    await shot(page, "10f-theme-circuit");
    await page.select("[data-pref-motion]", "off");
    const still = await page.evaluate(() => getComputedStyle(document.querySelector('.ambient[data-ambient="circuit"] span')).animationName);
    check("the background can be kept still", still === "none", still);
    await page.reload({ waitUntil: "networkidle0" });
    check("the theme chosen is remembered in this browser", (await page.evaluate(() => document.documentElement.dataset.theme)) === "circuit");
    for (const t of ["aurora", "quantum", "terminal", "oasis", "glass", "synthwave", "stream", "carbon"]) {
      await page.click(`[data-theme-pick="${t}"]`);
      await sleep(120);
    }
    await page.click('[data-theme-pick="synthwave"]');
    await sleep(300);
    await shot(page, "10g-theme-synthwave");
    await page.click('[data-theme-pick="oasis"]');
    await sleep(300);
    await shot(page, "10h-theme-oasis");
    await page.click("[data-theme-follow]");
    await page.select("[data-pref-motion]", "full");
    await page.evaluate(() => document.querySelector("[data-brand-input]").scrollIntoView());
    await page.type("[data-brand-input]", "Bank EA");
    await page.click('[data-brand-accent="#0f766e"]');
    await page.select("[data-brand-theme]", "stream");
    await page.click("[data-brand-save]");
    await page.waitForFunction(() => document.querySelector("[data-brand-name]")?.textContent === "Bank EA");
    const branded = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, accent: getComputedStyle(document.documentElement).getPropertyValue("--color-blueprint").trim(), title: document.title }));
    check("the workspace's branding names the menu and the tab, sets the accent, and the theme members start with", branded.theme === "stream" && branded.accent === "#0f766e" && branded.title === "Bank EA", JSON.stringify(branded));
    await shot(page, "10i-branding");
    // Back to the defaults, so the rest of the run looks as before.
    await page.click("[data-brand-input]", { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Back to the defaults")?.click());
    await page.click("[data-brand-save]");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "blueprint");
  }

  // The bank sample: ten connected diagrams added to what is there.
  await page.goto(`${base}/settings`, { waitUntil: "networkidle0" });
  const beforeSample = Object.values((await stored()).diagrams).filter((d) => !d.archive?.archived).length;
  await page.click("[data-enterprise-sample]");
  await page.waitForFunction(() => location.pathname === "/map");
  await page.waitForSelector("[data-map-node]");
  await sleep(800);
  const sampleDiagrams = await count(page, "[data-map-node]");
  check("the bank sample adds ten connected diagrams and opens the map", sampleDiagrams === beforeSample + 10 && (await count(page, ".react-flow__edge")) >= 20, `${beforeSample} then ${sampleDiagrams} diagrams, ${await count(page, ".react-flow__edge")} links`);
  await shot(page, "10b-bank-sample-map");
  await page.goto(`${base}/settings`, { waitUntil: "networkidle0" });
  check("the bank sample is added only once", await page.$eval("[data-enterprise-sample]", (b) => b.disabled));

  // Business processes: a landscape, BPMN models edited in place, simulation, decision tables and mining.
  const processes = async () => {
    await sleep(400); // the browser copy is written a moment after a change
    return Object.values((await stored()).processes ?? {});
  };
  // A shape is clicked near its corner: a flow may run across its middle.
  const clickShape = async (id) => {
    const box = await (await page.$(`g.djs-shape[data-element-id="${id}"]`)).boundingBox();
    await page.mouse.click(box.x + 8, box.y + 8);
  };
  const processNamed = async (name) => (await processes()).find((p) => p.name === name);
  await page.goto(`${base}/processes`, { waitUntil: "networkidle0" });
  await waitText(page, "No processes yet");
  await page.click("[data-process-sample]");
  await page.waitForSelector('[data-house-band="core"] [data-process-link]');
  const house = await page.$$eval("[data-process-link]", (as) => as.map((a) => a.textContent));
  check("the sample landscape fills the process house: areas by kind, with modelled processes inside", house.includes("Order to cash") && house.includes("Incident management") && (await count(page, '[data-house-band="support"] [data-process-link]')) === 5 && (await processes()).length === 11, house.join(", "));
  await shot(page, "40-process-house");

  await clickText(page, "Loan origination", "[data-process-link]");
  await page.waitForSelector('[data-bpmn-canvas="edit"] g[data-element-id="review"]', { timeout: 20000 });
  const loanTabs = await page.$$eval('[role="tab"]', (t) => t.map((x) => x.textContent));
  check("a process opens in the BPMN modeler, in its lanes, with only a tip to act on", (await count(page, 'g.djs-shape[data-element-id^="Lane_"]')) === 3 && loanTabs.includes("Checks1") && !(await page.$("[data-model-canvas] ~ * .bg-danger-soft")), loanTabs.join());
  await clickShape("review");
  await page.waitForSelector('[data-step="review"]');
  await page.$eval("[data-step-name]", (e) => e.select());
  await page.type("[data-step-name]", "Underwriter reviews the case");
  await page.keyboard.press("Enter");
  await page.$eval('[data-step-field="mode"]', (e) => e.select());
  await page.type('[data-step-field="mode"]', "120");
  await page.keyboard.press("Enter");
  await sleep(1300);
  const loan = await processNamed("Loan origination");
  check("renaming a step changes the BPMN file, and its time is kept beside it", loan.xml.includes('name="Underwriter reviews the case"') && loan.elements.review.duration.mode === 120 && loan.elements.review.duration.max >= 120, JSON.stringify(loan.elements.review?.duration));
  await shot(page, "41-process-model");
  // A business rule step gets its decision table, which is tried here and saved as DMN.
  await clickShape("score");
  await page.waitForSelector('[data-step="score"] [data-step-decision]');
  await clickText(page, "New", '[data-step="score"] button');
  await page.waitForSelector("[data-dmn-table]");
  await page.type('[data-dmn-try="Amount"]', "25000");
  await page.waitForSelector("[data-dmn-answer]");
  const answer = await page.$eval("[data-dmn-answer]", (e) => e.innerText);
  check("a business rule step gets a decision table, and trying it shows the rule that applies", answer.includes("Manager") && answer.includes("Rule 1 applies") && !!(await processNamed("Loan origination")).elements.score.decisionId, answer);
  await page.click("[data-dmn-export]");
  await sleep(500);
  const dmnFile = (await readdir(downloads)).find((f) => f.endsWith(".dmn"));
  check("a decision table downloads as DMN 1.3", !!dmnFile && (await readFile(join(downloads, dmnFile), "utf8")).includes("https://www.omg.org/spec/DMN/20191111/MODEL/"));
  await shot(page, "42-process-decision");

  // What-if: more people in the warehouse shortens the time an order takes.
  await page.goto(`${base}/processes`, { waitUntil: "networkidle0" });
  await clickText(page, "Order to cash", "[data-process-link]");
  await page.waitForSelector('[data-bpmn-canvas="edit"] g[data-element-id="pick"]', { timeout: 20000 });
  await clickText(page, "Simulation", '[role="tab"]');
  await page.click("[data-sim-run]");
  await page.waitForSelector("[data-sim-results] tbody tr");
  await page.click("[data-sim-copy]");
  await page.$eval('[data-sim-people="Warehouse"]', (e) => e.select());
  await page.type('[data-sim-people="Warehouse"]', "3");
  await page.keyboard.press("Enter");
  await sleep(200);
  await page.click("[data-sim-run]");
  await page.waitForFunction(() => document.querySelectorAll("[data-sim-results] tbody tr").length === 2);
  const simRows = await page.$$eval("[data-sim-results] tbody tr", (rows) => rows.map((r) => r.innerText));
  check("a copied scenario with more people runs beside the first, and the waiting time drops", /-\d+%/.test(simRows[1]) && (await processNamed("Order to cash")).scenarios.length === 2, simRows.join(" | "));
  await page.click("[data-sim-show]");
  await page.waitForSelector(".bpm-overlay");
  check("the waits show on the model, the busiest in colour", (await count(page, ".bpm-overlay")) >= 5 && (await count(page, '[class*="bpm-heat-"]')) >= 3);
  await shot(page, "43-process-simulation");

  // Publish, with a note, as version 1.
  await page.click("[data-process-publish]");
  await page.type("[data-process-note]", "First agreed version");
  await page.click("[data-process-publish-confirm]");
  await sleep(300);
  const o2c = await processNamed("Order to cash");
  check("publishing keeps the model as version 1", o2c.status === "published" && o2c.version === 1 && o2c.versions[0].note === "First agreed version");

  // Mining: the sample log against Procure to pay, then a process drawn from it.
  await page.goto(`${base}/process-mining`, { waitUntil: "networkidle0" });
  await page.click("[data-log-sample]");
  await page.waitForSelector('[data-mining-map] g[data-element-id^="Activity_"]', { timeout: 20000 });
  check("a log draws the process as it runs, with how often each step was done", (await page.$eval("[data-log-summary]", (e) => e.innerText)).includes("400") && (await count(page, "[data-mining-map] .bpm-overlay")) >= 8 && (await hasText(page, "Reject purchase request")));
  await shot(page, "44-process-mining");
  const processesBefore = (await processes()).length;
  await page.click("[data-mining-create]");
  await page.waitForSelector('[data-bpmn-canvas="edit"] .djs-container', { timeout: 20000 });
  await sleep(400);
  const mined = (await processes()).find((p) => p.mining);
  check("the discovered process becomes a model to work on, with the chances and times from the log", (await processes()).length === processesBefore + 1 && !!mined && Object.values(mined.elements).some((e) => e.probability) && Object.values(mined.elements).some((e) => e.duration));
  await clickText(page, "Mining", '[role="tab"]');
  await page.click("[data-log-sample]");
  await page.waitForSelector("[data-fitness]");
  const fitness = parseInt(await page.$eval("[data-fitness]", (e) => e.textContent), 10);
  // The map leaves out the rarest paths, so a few cases take a way it does not show.
  check("the log mostly fits the model drawn from its busiest paths", fitness >= 85 && fitness < 100, `${fitness}%`);

  // Describing a process in words, with no AI model: the built-in rules draft it.
  await page.goto(`${base}/processes`, { waitUntil: "networkidle0" });
  await page.click("[data-process-new]");
  await clickText(page, "Describe or speak it", '[role="tab"]');
  await page.type("[data-process-description]", "Customer service: register the complaint\nIf it can be answered at once, answer the customer; otherwise investigate it (Specialist team)\nClose the complaint");
  await page.type("[data-process-name]", "Handle a complaint");
  await page.click("[data-process-create]");
  await page.waitForSelector("[data-process-drafted]");
  const described = await processNamed("Handle a complaint");
  check("a described process is drafted by the built-in rules into lanes, steps and a decision", described.xml.includes('name="Investigate it"') && described.xml.includes('name="It can be answered at once?"') && described.xml.includes('name="Specialist team"') && (await hasText(page, "Drafted with the built-in rules")));
  await shot(page, "45-process-drafted");

  // The BPMN library: every element with its symbol and meaning, in English and Arabic, apart from the diagram components.
  await page.goto(`${base}/bpmn-library`, { waitUntil: "networkidle0" });
  await page.waitForSelector('[data-bpmn-entry="event-based-gateway"]');
  const symbol = await page.$eval('[data-bpmn-entry="exclusive-gateway"] [data-bpmn-symbol]', (e) => ({ font: getComputedStyle(e, "::before").fontFamily, content: getComputedStyle(e, "::before").content }));
  check(
    "the BPMN library shows each element with its BPMN symbol and what it means, in English and Arabic",
    (await count(page, "[data-bpmn-entry]")) >= 50 && /bpmn/i.test(symbol.font) && symbol.content !== "none" && (await hasText(page, "بوابة حصرية")) && (await hasText(page, "exactly one way out is taken")),
    JSON.stringify(symbol),
  );
  await page.type("[data-bpmn-library-search]", "مؤقت");
  await sleep(200);
  const timers = await page.$$eval("[data-bpmn-entry]", (els) => els.map((e) => e.dataset.bpmnEntry));
  check("searching in Arabic finds the timer events", timers.includes("intermediate-catch-timer") && timers.length < 8, timers.join());
  await shot(page, "46-bpmn-library");
  await page.click("[data-training-add]");
  await page.waitForSelector('[data-training-example="loan-data"] a');
  const trainingProcesses = (await processes()).filter((p) => p.tags.includes("bpmn-training"));
  check("the ten training examples are added under one area, each with what to notice in English and Arabic", trainingProcesses.length === 11 && trainingProcesses.filter((p) => p.level === 2).every((p) => p.description.includes("ما الذي تلاحظه")), String(trainingProcesses.length));

  // Training examples open in the modeler: boundary events, other parties and messages, data and notes.
  const openExample = async (id, shape) => {
    await page.goto(`${base}/processes/${trainingProcesses.find((p) => p.tags.includes(id)).id}`, { waitUntil: "networkidle0" });
    await page.waitForSelector(`[data-bpmn-canvas="edit"] g[data-element-id="${shape}"]`, { timeout: 20000 });
  };
  await openExample("purchase-deadlines", "daily");
  const deadlines = await page.evaluate(() => ({ attached: !!document.querySelector('g[data-element-id="daily"]') && !!document.querySelector('g[data-element-id="expire"]'), errors: document.querySelectorAll('[data-model-canvas] ~ [role="alert"]').length }));
  await openExample("supplier-messages", "Partner_supplier");
  const ids = () => page.$$eval("g[data-element-id]", (els) => els.map((e) => e.dataset.elementId));
  const pools = await page.evaluate(() => ({ partner: !!document.querySelector('g[data-element-id="Partner_supplier"]') }));
  pools.messages = (await ids()).filter((id) => /^Message_\d+$/.test(id)).length;
  await openExample("loan-data", "bureau");
  const loanModel = await page.evaluate(() => ({ store: !!document.querySelector('g[data-element-id="bureau"]'), form: !!document.querySelector('g[data-element-id="form"]'), reads: document.querySelectorAll('g[data-element-id="bureau_in_1"]').length }));
  loanModel.notes = (await ids()).filter((id) => /^note_[a-z]+$/.test(id)).length;
  check("training examples open in the modeler with boundary events, another party's pool and its messages, data stores, data objects and notes", deadlines.attached && deadlines.errors === 0 && pools.partner && pools.messages === 5 && loanModel.store && loanModel.form && loanModel.notes === 2 && loanModel.reads === 1, JSON.stringify({ deadlines, pools, loanModel }));
  await shot(page, "47-training-loan");

  // A step saved as a building block, and placed again from the library beside the canvas; an element placed from the library.
  await clickShape("capture");
  await page.waitForSelector('[data-step="capture"] [data-step-about="user-task"]');
  await page.click("[data-step-save-block]");
  await sleep(300);
  const block = Object.values((await stored()).library ?? {}).find((i) => i.type === "bpmn");
  check("a step is saved to the BPMN library with its kind, role and time, and the step panel says what the element means", block?.bpmn.name === "Capture the application" && block.bpmn.element === "user-task" && block.bpmn.role === "Branch" && block.bpmn.info.duration?.mode === 20 && (await hasText(page, "مهمة مستخدم")), JSON.stringify(block?.bpmn));
  const loanId = trainingProcesses.find((p) => p.tags.includes("loan-data")).id;
  const lane = await (await page.$('g.djs-shape[data-element-id="Lane_1"]')).boundingBox();
  const dropAt = { x: lane.x + lane.width - 70, y: lane.y + lane.height / 2 };
  await clickText(page, "BPMN library", '[data-step-panel] [role="tab"]');
  await page.waitForSelector(`[data-bpmn-block="${block.id}"]`);
  await page.click(`[data-bpmn-block="${block.id}"]`);
  await page.mouse.move(dropAt.x - 40, dropAt.y, { steps: 4 });
  await page.mouse.move(dropAt.x, dropAt.y, { steps: 6 });
  await page.mouse.down();
  await page.mouse.up();
  await sleep(1300);
  const withBlock = (await stored()).processes[loanId];
  const copies = (withBlock.xml.match(/name="Capture the application"/g) ?? []).length;
  const placedInfo = Object.entries(withBlock.elements).find(([id, e]) => id !== "capture" && e.duration?.mode === 20 && e.resource === "Branch");
  check("a building block placed from the library beside the canvas brings its name, role and time into the model", copies === 2 && !!placedInfo, `${copies} copies; ${JSON.stringify(placedInfo)}`);
  await page.type('[data-bpmn-library-panel] input[aria-label="Find a BPMN element"]', "timer: wait");
  await page.waitForSelector('[data-bpmn-element="intermediate-catch-timer"]');
  const timersBefore = (withBlock.xml.match(/<bpmn:intermediateCatchEvent /g) ?? []).length;
  const lane2 = await (await page.$('g.djs-shape[data-element-id="Lane_2"]')).boundingBox();
  const timerAt = { x: lane2.x + lane2.width - 50, y: lane2.y + lane2.height / 2 };
  await page.click('[data-bpmn-element="intermediate-catch-timer"]');
  await page.mouse.move(timerAt.x - 40, timerAt.y, { steps: 4 });
  await page.mouse.move(timerAt.x, timerAt.y, { steps: 6 });
  await page.mouse.down();
  await page.mouse.up();
  await sleep(1300);
  const withTimer = (await stored()).processes[loanId].xml;
  check("an element picked in the BPMN library is placed on the canvas with a click", (withTimer.match(/<bpmn:intermediateCatchEvent /g) ?? []).length === timersBefore + 1 && withTimer.includes("timerEventDefinition"));

  // Any diagram linked to any process, from either side.
  const shownDiagrams = Object.values((await stored()).diagrams).filter((d) => Object.keys(d.nodes).length > 2).sort((a, b) => a.name.localeCompare(b.name));
  const linkedDiagram = shownDiagrams[0];
  await page.goto(`${base}/diagram/${linkedDiagram.id}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".object-node");
  await page.click("[data-processes-button]");
  await page.waitForSelector("[data-diagram-processes] [data-link-process-choice]");
  await page.select("[data-link-process-choice]", loanId);
  await page.click("[data-link-process]");
  const orderToCash = (await processNamed("Order to cash")).id;
  await page.select("[data-link-process-choice]", orderToCash);
  await page.click("[data-link-process]");
  await sleep(300);
  check("a diagram is linked to two processes from its Processes panel", (await count(page, "[data-linked-process]")) === 2 && (await stored()).processes[loanId].diagramIds.includes(linkedDiagram.id) && (await stored()).processes[orderToCash].diagramIds.includes(linkedDiagram.id));
  await page.goto(`${base}/processes/${loanId}`, { waitUntil: "networkidle0" });
  await clickText(page, "Diagrams1", '[role="tab"]');
  await page.waitForSelector(`[data-linked-diagram="${linkedDiagram.id}"]`);
  const otherDiagram = shownDiagrams[1];
  await page.select("[data-link-diagram-choice]", otherDiagram.id);
  await page.click("[data-link-diagram]");
  await sleep(300);
  check("a process is linked to several diagrams from its Diagrams tab", (await count(page, "[data-linked-diagram]")) === 2 && (await stored()).processes[loanId].diagramIds.length === 2);
  await page.click(`[data-linked-diagram="${linkedDiagram.id}"] button`);
  await sleep(300);
  check("a link is taken away from either side", !(await stored()).processes[loanId].diagramIds.includes(linkedDiagram.id) && (await stored()).processes[orderToCash].diagramIds.includes(linkedDiagram.id));

  // A process from a draw.io flowchart and from a Word document, with no AI model.
  const flowchart = `<mxfile><diagram name="Orders"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="lane" value="Sales" style="swimlane;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="800" height="200" as="geometry"/></mxCell>
    <mxCell id="a" value="Check the order" style="rounded=1;" vertex="1" parent="lane"><mxGeometry x="40" y="60" width="120" height="60" as="geometry"/></mxCell>
    <mxCell id="b" value="In stock?" style="rhombus;" vertex="1" parent="lane"><mxGeometry x="220" y="50" width="80" height="80" as="geometry"/></mxCell>
    <mxCell id="c" value="Ship the order" style="rounded=1;" vertex="1" parent="lane"><mxGeometry x="360" y="60" width="120" height="60" as="geometry"/></mxCell>
    <mxCell id="d" value="Order a refill" style="rounded=1;" vertex="1" parent="lane"><mxGeometry x="360" y="140" width="120" height="50" as="geometry"/></mxCell>
    <mxCell id="e1" edge="1" source="a" target="b" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
    <mxCell id="e2" value="Yes" edge="1" source="b" target="c" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
    <mxCell id="e3" value="No" edge="1" source="b" target="d" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  await writeFile(join(downloads, "orders.drawio"), flowchart);
  await page.goto(`${base}/processes`, { waitUntil: "networkidle0" });
  await page.click("[data-process-new]");
  await clickText(page, "From a file or picture", '[role="tab"]');
  await (await page.waitForSelector("[data-process-file]")).uploadFile(join(downloads, "orders.drawio"));
  await page.waitForSelector('[data-process-file-read="diagram"]');
  const readSays = await page.$eval('[data-process-file-read="diagram"]', (e) => e.innerText);
  await page.click("[data-process-create]");
  await page.waitForSelector("[data-process-drafted]");
  const fromChart = (await processes()).find((p) => p.name === "orders");
  check("a draw.io flowchart becomes a process: its lane, its steps, the diamond as a decision, and a start and ends added", readSays.includes("4 shapes") && !!fromChart && fromChart.xml.includes('name="In stock?"') && fromChart.xml.includes("<bpmn:exclusiveGateway") && fromChart.xml.includes('name="Sales"') && fromChart.xml.includes("<bpmn:startEvent"), readSays);
  const docZip = new JSZip();
  docZip.file("word/document.xml", '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Reception: register the visitor</w:t></w:r></w:p><w:p><w:r><w:t>Security: print the badge</w:t></w:r></w:p><w:p><w:r><w:t>Reception: hand over the badge</w:t></w:r></w:p></w:body></w:document>');
  await writeFile(join(downloads, "visitors.docx"), await docZip.generateAsync({ type: "nodebuffer" }));
  await page.goto(`${base}/processes`, { waitUntil: "networkidle0" });
  await page.click("[data-process-new]");
  await clickText(page, "From a file or picture", '[role="tab"]');
  await (await page.waitForSelector("[data-process-file]")).uploadFile(join(downloads, "visitors.docx"));
  await page.waitForSelector('[data-process-file-read="words"]');
  await page.type("[data-process-name]", "Visitors");
  await page.click("[data-process-create]");
  await page.waitForSelector("[data-process-drafted]");
  const visitors = await processNamed("Visitors");
  check("a Word document's steps are drafted into a process with its lanes, without an AI model", !!visitors && visitors.xml.includes('name="Print the badge"') && visitors.xml.includes('name="Security"'), visitors?.xml.slice(0, 80));
  await page.close();

  /* ---------- pass 2: an AI provider is configured ---------- */
  const { server: provider, seen } = await fakeProvider(4399);
  servers.push({ kill: () => provider.close() });
  const base2 = "http://127.0.0.1:4312";
  servers.push(
    await preview(4312, { AI_PROVIDER: "openai-compatible", AI_API_KEY: "test-key-not-real", AI_MODEL: "stand-in-model", AI_BASE_URL: "http://127.0.0.1:4399/v1", AI_ACCESS_CODE: "pilot", APM_FEED_URL: "http://127.0.0.1:4398" }),
  );
  const page2 = await newPage(await browser.createBrowserContext(), errors);
  page2.removeAllListeners("console"); // the 401 below is expected
  await page2.goto(`${base2}/settings`, { waitUntil: "networkidle0" });
  await waitText(page2, "Connected");
  check("settings show the connected model, not the key", await page2.evaluate(() => document.body.innerText.includes("openai-compatible:stand-in-model") && !document.documentElement.innerHTML.includes("test-key-not-real")));

  await page2.goto(`${base2}/ai`, { waitUntil: "networkidle0" });
  await clickText(page2, "Draft with AI");
  await page2.waitForSelector("textarea");
  await page2.type("textarea", "Patients use the clinic portal to book visits.");
  await clickText(page2, "Create draft");
  await waitText(page2, "asks for an AI access code");
  check("without the access code the server refuses and the provider is not called", seen.length === 0);
  await clickText(page2, "Cancel");

  await page2.goto(`${base2}/settings`, { waitUntil: "networkidle0" });
  await page2.waitForSelector('input[type="password"]');
  await page2.type('input[type="password"]', "pilot");
  await page2.keyboard.press("Enter");
  await waitText(page2, "Access code saved.");

  await page2.goto(`${base2}/ai`, { waitUntil: "networkidle0" });
  await clickText(page2, "Draft with AI");
  await page2.waitForSelector("textarea");
  await page2.type("textarea", "Patients use the clinic portal to book visits.");
  await clickText(page2, "Create draft");
  await waitText(page2, "Review the draft");
  check("with a model configured, the draft comes from the model", await page2.evaluate(() => document.body.innerText.includes("openai-compatible:stand-in-model") && !document.body.innerText.includes("Check each line")));
  check("the key travels server to provider only", seen.length === 1 && seen[0].auth === "Bearer test-key-not-real" && seen[0].url === "/v1/chat/completions");

  // Image import.
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFElEQVR4nGP8z4AfMOGVHVUwGBQAAI8sAR/FUYp2AAAAAElFTkSuQmCC".repeat(1),
    "base64",
  );
  await writeFile(join(downloads, "whiteboard.png"), Buffer.concat([pixel, Buffer.alloc(0)]));
  await page2.goto(`${base2}/ai`, { waitUntil: "networkidle0" });
  await clickText(page2, "Draft with AI");
  await clickText(page2, "Upload a picture", "[role=tab]");
  await (await page2.waitForSelector('input[type="file"]')).uploadFile(join(downloads, "whiteboard.png"));
  await sleep(200);
  await clickText(page2, "Create draft");
  await waitText(page2, "Drafted from an uploaded image");
  const sentImage = seen[1]?.body?.messages?.[1]?.content?.some?.((part) => part.type === "image_url" && part.image_url.url.startsWith("data:image/png;base64,"));
  check("an uploaded picture is sent to the model and comes back as a draft to review", !!sentImage);
  await clickText(page2, "Accept all");
  const saveClear = await page2.evaluate(() => {
    const save = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save accepted to the model").getBoundingClientRect();
    const dock = document.querySelector("[data-assistant-launcher]").getBoundingClientRect();
    return save.right <= dock.left || save.bottom <= dock.top;
  });
  check("the assistant's button leaves the draft's save button clear", saveClear);
  await clickText(page2, "Save accepted to the model");
  await page2.waitForSelector(".object-node");
  await sleep(500);
  const importedDiagramUrl = page2.url();
  check("the imported diagram is drawn with its AI badge", (await count(page2, ".object-node")) === 3 && (await page2.evaluate(() => document.body.innerText.includes("AI draft"))));
  await shot(page2, "11-image-import");

  // Applications from APM: a stand-in for APM's feeds, read through this app's own server.
  {
    const apmToken = `apmf_${"c".repeat(64)}`;
    const apmSeen = [];
    const apmFeeds = {
      applications: [{ id: "t1", number: 1, name: "CyberArk", description: "Privileged access management.", vendor: "CyberArk", version: "14.x", category: "Security" }, { id: "t2", number: 2, name: "Jenkins", description: "Build server.", vendor: "CloudBees", version: "2.x", category: "CI/CD" }],
      classifications: [{ id: "t1", name: "CyberArk", classifications: { hosting: "on_premise", license: "commercial" } }],
      lifecycle: [{ id: "t1", name: "CyberArk", lifecycle_status: "Tolerate" }, { id: "t2", name: "Jenkins", lifecycle_status: "Migrate" }],
      integrations: [{ source: "Jenkins", target: "CyberArk", type: "API", description: "Reads build secrets" }],
    };
    const apm = createServer((req, res) => {
      const dataset = /^\/api\/public\/feeds\/([a-z]+)\.json$/.exec(req.url ?? "")?.[1];
      apmSeen.push(`${dataset} ${req.headers.authorization === `Bearer ${apmToken}` ? "ok" : "bad"}`);
      if (req.headers.authorization !== `Bearer ${apmToken}`) return void res.writeHead(401).end("Invalid feed token");
      res.writeHead(dataset && apmFeeds[dataset] ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(apmFeeds[dataset] ?? null));
    });
    await new Promise((ready) => apm.listen(4398, "127.0.0.1", ready));
    servers.push({ kill: () => apm.close() });
    const apmBefore = Object.keys(JSON.parse(await page2.evaluate(() => localStorage.getItem("archone.workspace.v1"))).objects).length;
    await page2.goto(base2, { waitUntil: "networkidle0" });
    await clickText(page2, "Import");
    await page2.waitForSelector("[data-apm-import] [data-apm-token]");
    check("when the server knows where APM is, importing offers it and asks for a feed token", (await hasText(page2, "From APM & Landscape")) && (await page2.$eval("[data-apm-run]", (e) => e.disabled)));
    await page2.type("[data-apm-token]", `apmf_${"d".repeat(64)}`);
    await page2.click("[data-apm-run]");
    await waitText(page2, "APM did not accept the feed token");
    await page2.$eval("[data-apm-token]", (e) => e.select());
    await page2.keyboard.press("Backspace");
    await page2.type("[data-apm-token]", apmToken);
    await page2.click("[data-apm-run]");
    await page2.waitForFunction(() => location.pathname.startsWith("/ai/"));
    await waitText(page2, "Read from the application portfolio");
    check("the applications arrive as a draft that says where it came from, and nothing is in the model yet", (await hasText(page2, "2 applications and 1 integrations read from APM at 127.0.0.1:4398")) && apmSeen.slice(-4).join() === "applications ok,classifications ok,lifecycle ok,integrations ok" && Object.keys(JSON.parse(await page2.evaluate(() => localStorage.getItem("archone.workspace.v1"))).objects).length === apmBefore);
    await shot(page2, "19-apm-draft");
    await clickText(page2, "Accept all");
    await clickText(page2, "Save accepted to the model");
    await sleep(700);
    const apmAfter = JSON.parse(await page2.evaluate(() => localStorage.getItem("archone.workspace.v1")));
    const cyber = Object.values(apmAfter.objects).find((o) => o.name === "CyberArk");
    const jenkins = Object.values(apmAfter.objects).find((o) => o.name === "Jenkins");
    check(
      "accepted, each application is saved with its APM facts, and the integration as a relationship",
      cyber?.fields.Vendor === "CyberArk" && cyber.fields.TIME === "Tolerate" && cyber.fields.Hosting === "On premise" && cyber.fields["APM id"] === "t1" && jenkins?.lifecycle === "deprecated" && Object.values(apmAfter.relationships).some((r) => r.sourceId === jenkins.id && r.targetId === cyber.id && r.kind === "calls"),
      cyber ? Object.keys(cyber.fields).join(", ") : "not saved",
    );
  }

  // A process described in words goes to the AI model, which answers with BPMN steps.
  await page2.goto(`${base2}/processes`, { waitUntil: "networkidle0" });
  await page2.click("[data-process-new]");
  await clickText(page2, "Describe or speak it", '[role="tab"]');
  await page2.type("[data-process-description]", "A patient checks in at reception and then sees the doctor.");
  await page2.click("[data-process-create]");
  await page2.waitForSelector("[data-process-drafted]");
  await sleep(500);
  const aiProcess = Object.values(JSON.parse(await page2.evaluate(() => localStorage.getItem("archone.workspace.v1"))).processes).find((p) => p.name === "Clinic visit");
  check(
    "with an AI model, a described process is drafted by it, with its times",
    !!aiProcess && aiProcess.xml.includes('name="Examine the patient"') && aiProcess.elements.b?.duration?.mode === 20 && (await hasText(page2, "Drafted by openai-compatible:stand-in-model")) && String(seen.at(-1).body.messages[0].content).startsWith("You turn a description of a business process"),
    JSON.stringify({ found: !!aiProcess, xml: aiProcess?.xml.includes("Examine the patient"), b: aiProcess?.elements, said: await page2.$eval("[data-process-drafted]", (e) => e.innerText), sys: String(seen.at(-1)?.body.messages?.[0]?.content).slice(0, 40) }),
  );

  // A picture of a process goes to the AI model with a note, and comes back as a process to edit.
  await page2.goto(`${base2}/processes`, { waitUntil: "networkidle0" });
  await page2.click("[data-process-new]");
  await clickText(page2, "From a file or picture", '[role="tab"]');
  await (await page2.waitForSelector("[data-process-file]")).uploadFile(join(downloads, "whiteboard.png"));
  await page2.waitForSelector('[data-process-file-read="image"] img');
  await page2.type("[data-process-note]", "Two lanes: reception and doctor");
  await page2.type("[data-process-name]", "Clinic from a picture");
  await page2.click("[data-process-create]");
  await page2.waitForSelector("[data-process-drafted]");
  const sentPicture = seen.at(-1).body.messages[1].content;
  check(
    "a picture of a process is read by the AI model, with the note that came with it, and becomes a process to edit",
    Array.isArray(sentPicture) && sentPicture[1]?.image_url?.url.startsWith("data:image/png;base64,") && sentPicture[0].text.includes("Two lanes: reception and doctor") && (await hasText(page2, "Read from whiteboard.png by openai-compatible:stand-in-model")) && !!(await page2.$('[data-bpmn-canvas="edit"]')),
    JSON.stringify(Array.isArray(sentPicture) ? sentPicture[0].text.slice(0, 60) : sentPicture).slice(0, 120),
  );

  // Ask the architecture with an AI model: only with the person's say-so, and only for what the rules cannot answer.
  await page2.goto(`${base2}/ask`, { waitUntil: "networkidle0" });
  await page2.waitForSelector("[data-ask-engine] input[type=checkbox]");
  const callsBefore = seen.length;
  await page2.type('input[aria-label="Your question"]', "Which databases are there?");
  await page2.keyboard.press("Enter");
  await page2.waitForSelector('[data-answer="computed"]');
  await page2.type('input[aria-label="Your question"]', "Is patient data encrypted at rest?");
  await page2.keyboard.press("Enter");
  await page2.waitForSelector('[data-answer="search"]');
  check("the model is not sent to the AI model until the person allows it", seen.length === callsBefore && (await hasText(page2, "Tick the box above the answers")));
  await page2.click("[data-ask-engine] input[type=checkbox]");
  await page2.type('input[aria-label="Your question"]', "Is patient data encrypted at rest?");
  await page2.keyboard.press("Enter");
  await page2.waitForSelector('[data-answer="ai"]');
  const aiCard = await page2.evaluate(() => { const card = document.querySelector('[data-answer="ai"]'); return { text: card.innerText, links: [...card.querySelectorAll("[data-answer-text] [data-answer-object]")].map((a) => a.textContent) }; });
  check("once allowed, the AI model answers and its object tags become links", aiCard.links.join() === "Booking service" && aiCard.text.includes("openai-compatible:stand-in-model") && aiCard.text.includes("It can be wrong"), aiCard.links.join());
  check("a tag for an object that does not exist is not turned into a link", aiCard.text.includes("an object that is not in the model is made up") && !aiCard.text.includes("obj_invented"));
  const askCall = seen.at(-1).body;
  check("the question travels with the model as text, and one call is made", seen.length === callsBefore + 1 && String(askCall.messages[1].content).startsWith("MODEL\nWorkspace:") && String(askCall.messages[1].content).endsWith("Question: Is patient data encrypted at rest?"));
  await shot(page2, "13-ask-ai");

  // The assistant with an AI model: the diagram on screen and the whole workspace go with each message.
  await page2.goto(importedDiagramUrl, { waitUntil: "networkidle0" });
  await page2.waitForSelector(".object-node");
  const corner = await page2.evaluate(() => {
    const dock = document.querySelector("[data-assistant-launcher]").getBoundingClientRect();
    const map = document.querySelector(".react-flow__minimap")?.getBoundingClientRect();
    return { dock: Math.round(dock.right) <= innerWidth && Math.round(dock.bottom) <= innerHeight && innerWidth - dock.right < 40, clear: !map || map.right <= dock.left || map.bottom <= dock.top };
  });
  check("the assistant waits in the bottom-right corner, and the diagram's minimap moves aside for it", corner.dock && corner.clear, JSON.stringify(corner));
  await page2.click("[data-assistant-launcher]");
  await page2.waitForSelector("[data-assistant-panel] [data-assistant-suggestions] button");
  check("opened, it says which model answers and offers questions about the diagram on screen", (await page2.$eval("[data-assistant-engine]", (e) => e.textContent)).includes("openai-compatible:stand-in-model") && (await page2.evaluate(() => document.activeElement?.hasAttribute("data-assistant-input"))) && (await hasText(page2, "Summarise this diagram")));
  const chatBefore = seen.length;
  await page2.click("[data-assistant-suggestions] button");
  await page2.waitForSelector('[data-assistant-kind="ai"]');
  const firstChat = seen.at(-1).body;
  const firstSystem = String(firstChat.messages[0].content);
  const shownDiagram = importedDiagramUrl.split("/diagram/")[1];
  check(
    "a message goes to the AI model with the diagram on screen in full and the rest of the workspace",
    seen.length === chatBefore + 1 && firstChat.messages.length === 2 && firstChat.messages[1].role === "user" && firstSystem.includes(`DIAGRAM [[d:${shownDiagram}]]`) && firstSystem.includes("The person is on: the editor of the diagram") && firstSystem.includes("== OBJECTS:") && firstSystem.includes("== CHECK FINDINGS"),
    firstSystem.slice(0, 200),
  );
  const firstAnswer = await page2.$eval('[data-assistant-kind="ai"]', (e) => ({ diagram: e.querySelector("[data-assistant-diagram]")?.textContent, object: e.querySelector("[data-assistant-object]")?.textContent, bold: !!e.querySelector("strong [data-assistant-diagram]"), list: e.querySelectorAll("li li, ul li").length, text: e.innerText }));
  check("the answer's tags become links to the diagram and the object, with its bold and list kept", !!firstAnswer.diagram && firstAnswer.object === "Booking service" && firstAnswer.bold && firstAnswer.text.includes("an object that is not in this workspace is not real") && !firstAnswer.text.includes("obj_invented"), JSON.stringify(firstAnswer));
  await page2.type("[data-assistant-input]", "ما هي البروتوكولات المستخدمة؟");
  await page2.keyboard.press("Enter");
  await page2.waitForFunction(() => document.querySelectorAll('[data-assistant-kind="ai"]').length === 2);
  const second = seen.at(-1).body;
  const arabic = await page2.evaluate(() => {
    const answers = document.querySelectorAll('[data-assistant-kind="ai"]');
    const last = answers[answers.length - 1];
    const p = last.querySelector("[data-assistant-answer] p");
    return { dir: p?.getAttribute("dir"), rtl: getComputedStyle(p).direction, table: !!last.querySelector("table [data-assistant-object]"), user: [...document.querySelectorAll('[data-assistant-turn="user"] p')].at(-1).getAttribute("dir") };
  });
  check("a follow-up in Arabic carries the conversation, and the answer reads right to left with its table", second.messages.map((m) => m.role).join() === "system,user,assistant,user" && arabic.rtl === "rtl" && arabic.table && arabic.user === "auto", JSON.stringify(arabic));
  await shot(page2, "48-assistant-ai");
  await page2.click('[data-assistant-kind="ai"] [data-assistant-diagram]');
  await sleep(300);
  check("a diagram in an answer opens that diagram, and the conversation stays open beside it", page2.url().endsWith(`/diagram/${shownDiagram}`) && (await count(page2, "[data-assistant-turns] > li")) === 4);
  await page2.click("[data-assistant-ai-off]");
  const offBefore = seen.length;
  await page2.type("[data-assistant-input]", "Which databases are there?");
  await page2.keyboard.press("Enter");
  await page2.waitForSelector('[data-assistant-kind="computed"]');
  check("with AI switched off, nothing is sent and the built-in reader answers", seen.length === offBefore && (await hasText(page2, "Answer with AI?")));
  await page2.reload({ waitUntil: "networkidle0" });
  await page2.waitForSelector("[data-assistant-launcher]");
  await page2.click("[data-assistant-launcher]");
  await page2.waitForSelector("[data-assistant-turns]");
  check("the conversation is still there after a reload", (await count(page2, "[data-assistant-turns] > li")) === 6);
  await clickText(page2, "Answer with AI");
  await page2.click('[aria-label="New conversation"]');
  check("a new conversation starts empty", !(await page2.$("[data-assistant-turns]")) && !!(await page2.$("[data-assistant-suggestions]")));

  // The assistant changes the diagram on screen: at once, with Undo; removals wait for a yes; suggestions and the checks' warnings beside them.
  if (await page2.$("[data-assistant-ai-on]")) await page2.click("[data-assistant-ai-on]");
  await page2.waitForSelector("[data-assistant-edit-toggle]");
  check(
    "on a diagram the person may change, the assistant offers to change it, and says so",
    (await page2.$eval("[data-assistant-edit-toggle]", (e) => e.checked)) && (await page2.$eval("[data-assistant-engine]", (e) => e.textContent)).startsWith("Changes this diagram with") && (await hasText(page2, "Changes appear on the diagram at once")),
  );
  const nodeNames = () => page2.$$eval(".object-node", (nodes) => nodes.map((n) => n.innerText));
  const nodesBefore = await nodeNames();
  const editBefore = seen.length;
  await page2.type("[data-assistant-input]", "أضف خادم ويب واربطه بخدمة الحجز عبر HTTP");
  await page2.keyboard.press("Enter");
  await page2.waitForSelector("[data-assistant-change]");
  const editCall = seen.at(-1).body;
  check("the model is told which diagram it may change and how", seen.length === editBefore + 1 && String(editCall.messages[0].content).includes(`EDITING THE DIAGRAM\nThe person is editing the diagram [[d:${shownDiagram}]]`));
  await page2.waitForFunction((n) => document.querySelectorAll(".object-node").length === n + 1, { timeout: 5000 }, nodesBefore.length).catch(() => {});
  const afterAdd = await nodeNames();
  await sleep(700);
  const inView = await page2.evaluate(() => {
    const panel = document.querySelector("[data-assistant-panel]").getBoundingClientRect();
    const server = [...document.querySelectorAll(".react-flow__node")].find((n) => n.innerText.includes("Web server 1"));
    const r = server?.getBoundingClientRect();
    return { marked: !!server?.classList.contains("assistant-changed"), clear: !!r && r.right <= panel.left && r.left >= 0 && r.bottom <= innerHeight };
  });
  check("the view moves to what changed, clear of the assistant's panel, and marks it", inView.marked && inView.clear, JSON.stringify(inView));
  const card = await page2.$eval("[data-assistant-change]", (e) => ({
    made: [...e.querySelectorAll("[data-assistant-made] [data-assistant-lines] li")].map((li) => li.textContent),
    findings: e.querySelector("[data-assistant-findings]")?.innerText ?? "",
    waiting: e.querySelector("[data-assistant-confirm]")?.getAttribute("data-assistant-confirm"),
    suggestions: e.querySelectorAll("[data-assistant-suggestion]").length,
    block: e.closest("[data-assistant-kind]").innerText.includes("archone-changes"),
  }));
  check("the server appears on the diagram at once, connected, and the answer lists what changed without the block", afterAdd.length === nodesBefore.length + 1 && afterAdd.some((t) => t.includes("Web server 1")) && card.made.length === 2 && card.made[1].includes("HTTP 80/TCP, not encrypted") && !card.block, JSON.stringify(card.made));
  check("the checks' new findings come with the change, as a warning", /\[high\].*Web server 1/.test(card.findings) && /\[medium\].*Web server 1/.test(card.findings), card.findings.slice(0, 200));
  check("a change the model is not sure of waits for a yes, and the suggestions wait for a click", card.waiting === "waiting" && card.suggestions === 2 && afterAdd.some((t) => t.includes("Clinic portal")));
  await shot(page2, "49-assistant-edits");
  await page2.click("[data-assistant-yes]");
  await page2.waitForFunction(() => ![...document.querySelectorAll(".object-node")].some((n) => n.innerText.includes("Clinic portal")), { timeout: 5000 }).catch(() => {});
  const afterYes = await nodeNames();
  const madeUndo = await page2.$eval("[data-assistant-made] [data-assistant-undo]", (b) => b.disabled);
  check("after the yes the portal leaves the diagram, and the first change can no longer be undone from the card", !afterYes.some((t) => t.includes("Clinic portal")) && afterYes.length === nodesBefore.length && madeUndo && (await page2.$eval("[data-assistant-confirm]", (e) => e.getAttribute("data-assistant-confirm"))) === "yes");
  await page2.click("[data-assistant-confirm] [data-assistant-undo]");
  await page2.waitForFunction(() => [...document.querySelectorAll(".object-node")].some((n) => n.innerText.includes("Clinic portal")), { timeout: 5000 }).catch(() => {});
  check("Undo puts the portal back, and the change is marked undone", (await nodeNames()).some((t) => t.includes("Clinic portal")) && (await hasText(page2, "Undone.")));
  await page2.click('[data-assistant-suggestion="0"] [data-assistant-take]');
  await page2.waitForSelector('[data-assistant-suggestion="0"] li');
  const taken = await page2.$eval('[data-assistant-suggestion="0"]', (e) => e.innerText);
  check("a suggestion taken is made at once, and the warning it fixes is cleared", taken.includes("Changed the connection Web server 1 → Booking service") && taken.includes("1 finding of the checks is cleared"), taken);
  await page2.click('[data-assistant-suggestion="1"] [aria-label^="Put aside"]');
  check("a suggestion put aside is struck through and offers nothing more", !(await page2.$('[data-assistant-suggestion="1"] [data-assistant-take]')) && (await page2.$eval('[data-assistant-suggestion="1"] span', (e) => getComputedStyle(e).textDecorationLine)) === "line-through");
  // Connections in the model but not drawn: hidden, then shown again from what the app tells the model.
  const edgeCount = () => page2.$$eval(".react-flow__edge", (edges) => edges.length);
  const edgesBefore = await edgeCount();
  const turnsNow = () => page2.$$eval('[data-assistant-kind="ai"]', (t) => t.length);
  let aiTurns = await turnsNow();
  const say = async (words) => {
    await page2.type("[data-assistant-input]", words);
    await page2.keyboard.press("Enter");
    await page2.waitForFunction((n) => document.querySelectorAll('[data-assistant-kind="ai"]').length === n + 1, { timeout: 10000 }, aiTurns);
    aiTurns += 1;
    await sleep(300);
  };
  await say("أخف الاتصال بين خادم الويب وخدمة الحجز");
  const edgesHidden = await edgeCount();
  await say("أظهر الاتصال مرة أخرى");
  const showCall = seen.at(-1).body.messages[0].content;
  const edgesShown = await edgeCount();
  check(
    "the assistant hides a connection on this diagram only, and shows it again from what the app says is not drawn",
    edgesHidden === edgesBefore - 1 && edgesShown === edgesBefore && /Connections in the model that are not drawn on it[\s\S]*\| not drawn: hidden on this diagram/.test(showCall),
    JSON.stringify({ edgesBefore, edgesHidden, edgesShown }),
  );
  await say("احذف المخطط");
  const lastCard = await page2.evaluate(() => {
    const cards = [...document.querySelectorAll("[data-assistant-change]")];
    const card = cards.at(-1);
    return { waiting: card?.querySelector("[data-assistant-confirm]")?.getAttribute("data-assistant-confirm"), text: card?.innerText ?? "", made: !!card?.querySelector("[data-assistant-made]") };
  });
  check(
    "deleting the whole diagram is never done without a person's yes",
    lastCard.waiting === "waiting" && lastCard.text.includes("Delete this whole diagram") && !lastCard.made && (await page2.$$eval(".object-node", (n) => n.length)) > 0,
    JSON.stringify(lastCard),
  );
  await page2.evaluate(() => [...document.querySelectorAll("[data-assistant-no]")].at(-1).click());

  await page2.click("[data-assistant-edit-toggle]");
  check("with changes switched off the assistant only answers", (await page2.$eval("[data-assistant-engine]", (e) => e.textContent)).startsWith("Answers with"));
  await page2.type("[data-assistant-input]", "شكرا، ماذا غيرت؟");
  await page2.keyboard.press("Enter");
  await page2.waitForFunction((n) => document.querySelectorAll('[data-assistant-kind="ai"]').length === n + 1, {}, aiTurns);
  const followUp = seen.at(-1).body;
  const remembered = String(followUp.messages.find((m, i) => i > 0 && m.role === "assistant")?.content ?? "");
  check("the next message carries no permission to change, and remembers what was changed, undone and taken", !followUp.edit && remembered.includes("Changes made: Added Web server 1") && remembered.includes("the person said yes") && remembered.includes("(put aside)"), remembered.slice(-300));
  await page2.close();

  check("no errors in the browser console", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (error) {
  check("the run finished", false, error.message);
  if (errors.length) console.log(errors.slice(0, 5).join("\n"));
  const pages = await browser.pages();
  await pages.at(-1)?.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
} finally {
  await browser.close();
  for (const s of servers) s.kill();
  await rm(downloads, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
