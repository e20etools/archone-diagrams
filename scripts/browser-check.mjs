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
        const text = sent.messages[1].content[0].text;
        const id = /^(\S+) \| Booking service \|/m.exec(text)?.[1] ?? "missing";
        res.end(JSON.stringify({ choices: [{ message: { content: `Nothing in the model says so.\n- [[${id}]] holds the bookings.\n- [[obj_invented]] is made up.` } }] }));
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { content: "```json\n" + JSON.stringify(draft) + "\n```" } }] }));
    });
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, seen })));
}

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
  for (const label of ["Mermaid", "PlantUML", "Objects (CSV)", "Relationships (CSV)", "Diagram (JSON)", "PNG image", "SVG image", "PDF document"]) {
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Export"))?.click());
    await page.waitForSelector("[role=menu]");
    await clickText(page, label, "[role=menuitem]");
    await sleep(label.includes("PDF") ? 2500 : 1200);
  }
  const files = await readdir(downloads);
  const has = (ext) => files.some((f) => f.endsWith(ext));
  check(
    "all eight export formats download as files",
    has(".mmd") && has(".puml") && has("-objects.csv") && has("-relationships.csv") && has(".json") && has(".png") && has(".svg") && has(".pdf"),
    files.join(", "),
  );
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
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Export"))?.click());
  await page.waitForSelector("[role=menu]");
  await clickText(page, "BPMN 2.0 (.bpmn)", "[role=menuitem]");
  await sleep(1000);
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
  await waitText(page, "What it shows");
  await sleep(200);
  // Typed with no click first: the dialog itself has to put the keyboard in the name field.
  check("a dialog opens with the keyboard in its first field", await page.evaluate(() => !!document.activeElement?.matches('[role=dialog] input[placeholder^="For example: Payments"]')));
  await page.keyboard.type("Landscape check");
  await clickText(page, "Create diagram");
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
    await clickText(large, "Export");
    await clickText(large, "PNG image", "[role=menuitem]");
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
  await page.click('[data-template="ai-agent"]');
  await page.waitForFunction(() => location.pathname.startsWith("/diagram/"));
  await page.waitForSelector(".object-node");
  await sleep(500);
  const templated = await stored();
  check(
    "a template adds its objects to the model and opens a diagram of them",
    templatesOffered >= 5 && Object.keys(templated.objects).length === templateBase + 7 && (await count(page, ".object-node")) === 6 && Object.values(templated.diagrams).some((d) => d.name === "AI agent with tools"),
    `${templatesOffered} templates, ${Object.keys(templated.objects).length - templateBase} objects added, ${await count(page, ".object-node")} boxes`,
  );
  await page.click(".object-node");
  await page.waitForSelector("#technology-options option");
  check("the technology field offers cloud service names", (await page.$$eval("#technology-options option", (o) => o.map((x) => x.value))).includes("Amazon S3"));
  await shot(page, "18-template");

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
  const docPictures = docx ? Object.keys(docx.files).filter((f) => f.startsWith("word/media/")).length : 0;
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
  await clickText(page, "Export");
  const stampOn = await page.$eval("[data-export-stamp]", (e) => e.checked);
  await clickText(page, "PNG image", "[role=menuitem]");
  await sleep(2500);
  const stampedPng = (await readdir(downloads)).find((f) => f.endsWith(".png"));
  const stampedHeight = stampedPng ? (await readFile(join(downloads, stampedPng))).readUInt32BE(20) : 0;
  await clickText(page, "Export");
  await page.click("[data-export-stamp]");
  if (stampedPng) await rm(join(downloads, stampedPng));
  await clickText(page, "PNG image", "[role=menuitem]");
  await sleep(2500);
  const plainPng = (await readdir(downloads)).find((f) => f.endsWith(".png"));
  const plainHeight = plainPng ? (await readFile(join(downloads, plainPng))).readUInt32BE(20) : 0;
  check("a PNG is stamped with a strip under the picture unless that is switched off", stampOn && plainHeight > 0 && stampedHeight - plainHeight >= 150 && stampedHeight - plainHeight <= 400, `${stampedHeight} against ${plainHeight} pixels high`);
  await clickText(page, "Export");
  await page.click("[data-export-stamp]");
  await page.keyboard.press("Escape");
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
  await clickText(page, "Export");
  await clickText(page, "FINOS CALM (JSON)", "[role=menuitem]");
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
  await clickText(page2, "Save accepted to the model");
  await page2.waitForSelector(".object-node");
  await sleep(500);
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
  check("the question travels with the model as text, and one call is made", seen.length === callsBefore + 1 && askCall.messages[1].content[0].text.startsWith("MODEL\nWorkspace:") && askCall.messages[1].content[0].text.endsWith("Question: Is patient data encrypted at rest?"));
  await shot(page2, "13-ask-ai");
  await page2.close();

  check("no errors in the browser console", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (error) {
  check("the run finished", false, error.message);
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
