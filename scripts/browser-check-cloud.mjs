// End-to-end check of hosted mode: accounts, workspaces, roles and several people editing at once.
// Run with `npm run test:browser:cloud`. It builds the app against the in-browser demo backend
// (src/lib/cloud/demoBackend.ts), so it needs no Supabase project. What it does not cover is the
// Supabase adapter itself; the database rules are covered by src/lib/cloud/database.test.ts.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shots = join(root, "screenshots");
const vite = join(root, "node_modules/vite/bin/vite.js");
const chrome =
  process.env.CHROME_PATH ||
  ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
if (!chrome) throw new Error("Chrome was not found. Set CHROME_PATH to its location.");

const built = spawnSync(process.execPath, [vite, "build", "--outDir", "dist-demo", "--logLevel", "error"], {
  cwd: root,
  env: { ...process.env, VITE_CLOUD_BACKEND: "demo" },
  stdio: "inherit",
});
if (built.status !== 0) throw new Error("The demo build failed.");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = "http://127.0.0.1:4321";

const server = spawn(process.execPath, [vite, "preview", "--outDir", "dist-demo", "--port", "4321", "--strictPort", "--host", "127.0.0.1"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
await new Promise((ok, fail) => {
  const timer = setTimeout(() => fail(new Error("vite preview did not start")), 20000);
  server.stdout.on("data", (d) => String(d).includes("4321") && (clearTimeout(timer), ok()));
});

// A background tab does not lay out or animate, so every helper first brings its tab to the front.
const clickText = async (page, text, selector = "button, a, [role=menuitem], [role=tab]") => {
  await page.bringToFront();
  return page.evaluate(
    (text, selector) => {
      const el = [...document.querySelectorAll(selector)].find((e) => e.textContent.trim() === text && !e.disabled);
      if (!el) return false;
      el.click();
      return true;
    },
    text,
    selector,
  );
};
const until = async (page, fn, timeout, ...args) => {
  await page.bringToFront();
  return page.waitForFunction(fn, { timeout, polling: 100 }, ...args);
};
const waitText = (page, text, timeout = 8000) => until(page, (t) => document.body.innerText.includes(t), timeout, text);
const hasText = async (page, text) => {
  await page.bringToFront();
  return page.evaluate((t) => document.body.innerText.includes(t), text);
};
const count = async (page, selector) => {
  await page.bringToFront();
  return page.$$eval(selector, (els) => els.length);
};
const shot = async (page, name) => {
  await page.bringToFront();
  await sleep(250);
  return page.screenshot({ path: join(shots, `${name}.png`) });
};
const field = (page, label) =>
  page.evaluateHandle((label) => [...document.querySelectorAll("label")].find((l) => l.textContent.trim().startsWith(label))?.querySelector("input, select"), label);
const fill = async (page, label, value) => {
  await page.bringToFront();
  const input = await field(page, label);
  await input.focus();
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await input.type(value);
};
const saved = (page) => until(page, () => [...document.querySelectorAll("header [role=status]")].some((e) => e.textContent.trim() === "Saved"), 8000);
const visit = async (page, url, selector) => {
  await page.bringToFront();
  await page.goto(url, { waitUntil: "networkidle0" });
  if (selector) await page.waitForSelector(selector);
  await sleep(500);
};

await mkdir(shots, { recursive: true });
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });
const errors = [];
const dialogs = [];
// One browser profile: the tabs share the demo server, and each tab signs in as a different person.
const context = await browser.createBrowserContext();
async function open() {
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/501|404/.test(m.text()) && errors.push(`console: ${m.text()}`));
  page.on("dialog", (dialog) => {
    dialogs.push(`${dialog.type()} on ${page.url()}`);
    void dialog.accept();
  });
  await page.goto(base, { waitUntil: "networkidle0" });
  return page;
}
async function signUp(page, name, email) {
  await waitText(page, "Create account");
  await clickText(page, "Create account", "[role=tab]");
  await fill(page, "Your name", name);
  await fill(page, "Email", email);
  await fill(page, "Password", "correct-horse-9");
  await clickText(page, "Create account", "button[type=submit]");
  await waitText(page, "Your workspaces");
}

try {
  /* ---------- Ana creates an account and a workspace ---------- */
  const ana = await open();
  await waitText(ana, "Sign in");
  check("hosted mode asks for sign-in before showing anything", (await count(ana, "nav[aria-label=Main]")) === 0 && (await count(ana, "input[type=password]")) === 1);
  await shot(ana, "20-sign-in");
  await signUp(ana, "Ana Owner", "ana@example.com");
  await fill(ana, "Name", "Payments platform");
  await clickText(ana, "Create workspace");
  await waitText(ana, "Start your architecture model");
  check("a new account creates a workspace and lands in the app", await hasText(ana, "Payments platform"));
  await clickText(ana, "Load the sample model");
  await ana.waitForSelector(".object-node");
  await saved(ana);
  const boxes = await count(ana, ".object-node");
  check("work is saved to the server as it is made", boxes >= 4, `${boxes} boxes, status Saved`);
  const diagramUrl = ana.url();

  /* ---------- Ana invites two people ---------- */
  await visit(ana, `${base}/settings`);
  await waitText(ana, "Members");
  for (const [email, role] of [["ben@example.com", "editor"], ["vera@example.com", "viewer"]]) {
    await fill(ana, "Invite by email", email);
    await (await field(ana, "As")).select(role);
    await clickText(ana, "Invite");
    await waitText(ana, email);
  }
  check("an owner invites people by email with a role", (await ana.evaluate(() => document.body.innerText.split("Invited, not joined yet").length - 1)) === 2);
  await shot(ana, "21-members");

  /* ---------- Ben joins as editor ---------- */
  const ben = await open();
  await signUp(ben, "Ben Editor", "ben@example.com");
  await waitText(ben, "Ana Owner invited you as editor");
  await shot(ben, "22-invitation");
  await clickText(ben, "Join");
  await waitText(ben, "Each diagram is a view of one shared model");
  check("the invited person joins and sees the owner's diagrams", (await count(ben, "tbody tr")) === 3);
  await visit(ben, diagramUrl, ".object-node");
  await visit(ana, diagramUrl, ".object-node");
  const seen = async (page) => `${await count(page, ".object-node")} boxes, ${await count(page, ".react-flow__edge")} arrows`;
  check("the same diagram opens for both, box for box", (await seen(ana)) === (await seen(ben)) && (await count(ben, ".object-node")) === boxes, `Ana: ${await seen(ana)}; Ben: ${await seen(ben)}`);
  check(
    "each sees that the other is on this diagram",
    (await ana.evaluate(() => !!document.querySelector('[aria-label="People in this workspace now"] li[title="Ben Editor is on this diagram"]'))) &&
      (await ben.evaluate(() => !!document.querySelector('[aria-label="People in this workspace now"] li[title="Ana Owner is on this diagram"]'))),
  );

  /* ---------- live editing, both directions ---------- */
  await ben.bringToFront();
  await ben.click(".object-node");
  await ben.waitForSelector('aside[aria-label="Details"] input');
  const renamed = "Renamed live by Ben";
  await fill(ben, "Name", renamed);
  await ben.keyboard.press("Enter");
  await until(ana, (t) => [...document.querySelectorAll(".object-node__name")].some((e) => e.textContent === t), 5000, renamed);
  check("an edit by one person appears on the other's screen without a reload", true);

  await ana.bringToFront();
  await ana.evaluate(() => [...document.querySelectorAll("aside button")].find((b) => b.textContent.trim() === "Cache")?.click());
  await until(ben, (n) => document.querySelectorAll(".object-node").length === n + 1, 5000, boxes);
  check("a box added by one person appears for the other", true);

  await ben.bringToFront();
  const movedId = await ben.$eval(".react-flow__node-object", (e) => e.dataset.id);
  const transformOf = (page) => page.$eval(`.react-flow__node[data-id="${movedId}"]`, (e) => e.style.transform);
  await ana.bringToFront();
  const before = await transformOf(ana);
  await ben.bringToFront();
  const box = await (await ben.$(`.react-flow__node[data-id="${movedId}"]`)).boundingBox();
  await ben.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await ben.mouse.down();
  await ben.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 60, { steps: 8 });
  await ben.mouse.up();
  await until(ana, (id, was) => document.querySelector(`.react-flow__node[data-id="${id}"]`).style.transform !== was, 5000, movedId, before);
  check("a box moved by one person moves for the other", true);
  await saved(ben);
  await shot(ana, "23-two-people");

  /* ---------- Vera joins as viewer ---------- */
  const vera = await open();
  await signUp(vera, "Vera Viewer", "vera@example.com");
  await clickText(vera, "Join");
  await waitText(vera, "You have view access to this workspace");
  await visit(vera, diagramUrl, ".object-node");
  const veraBoxes = await count(vera, ".object-node");
  await vera.evaluate(() => [...document.querySelectorAll("aside button")].find((b) => b.textContent.trim() === "Database")?.click());
  await sleep(700);
  check("a viewer sees the model, including the others' edits", veraBoxes === boxes + 1 && (await hasText(vera, renamed)));
  check("a viewer's attempt to change it does nothing and says why", (await count(vera, ".object-node")) === veraBoxes && (await hasText(vera, "changes are not saved")) && (await count(ana, ".object-node")) === boxes + 1);
  await shot(vera, "24-viewer");
  await visit(vera, `${base}/settings`);
  await waitText(vera, "Only an owner can invite people or change roles.");
  check("a viewer can see the member list but not manage it", (await count(vera, 'select[aria-label^="Role of"]')) === 0 && !(await hasText(vera, "Invite by email")));

  /* ---------- the file library: your own files, and those of diagrams you can see ---------- */
  {
    const uploads = await mkdtemp(join(tmpdir(), "archone-cloud-up-"));
    await writeFile(join(uploads, "Ben vendor quote.txt"), "Quote for two firewalls.");
    await visit(ben, `${base}/files`, "[data-file-input]");
    await (await ben.$("[data-file-input]")).uploadFile(join(uploads, "Ben vendor quote.txt"));
    await ben.waitForSelector("[data-file-upload-go]");
    await ben.click("[data-file-upload-go]");
    await until(ben, () => document.querySelector("[data-file-rows]")?.getAttribute("data-file-rows") === "1", 6000);
    await visit(vera, `${base}/files`, "[data-files-page]");
    await waitText(vera, "No files yet");
    check("a file linked to no diagram is seen only by the person who uploaded it", !(await hasText(vera, "Ben vendor quote.txt")) && !(await vera.$("[data-file-input]")));
    await visit(ben, `${base}/files`, '[data-file-edit="Ben vendor quote.txt"]');
    await ben.click('[data-file-edit="Ben vendor quote.txt"]');
    await ben.waitForSelector("[data-file-edit-dialog] [data-link-diagram]");
    await ben.click("[data-file-edit-dialog] [data-link-diagram]");
    await ben.click("[data-file-save]");
    await until(ben, () => document.querySelector('[data-file-row="Ben vendor quote.txt"] [data-file-links]')?.getAttribute("data-file-links") === "1", 6000);
    await visit(vera, `${base}/files`, '[data-file-row="Ben vendor quote.txt"]');
    check("linked to a diagram, the file is seen by those who can see the diagram; a viewer cannot delete it", !(await vera.$('[data-file-delete="Ben vendor quote.txt"]')));
    await visit(ana, `${base}/files`, '[data-file-row="Ben vendor quote.txt"]');
    check("an owner may delete someone else's file", !!(await ana.$('[data-file-delete="Ben vendor quote.txt"]')));
    await shot(vera, "24b-viewer-files");
    await rm(uploads, { recursive: true, force: true });
  }

  /* ---------- the owner promotes the viewer; it takes effect at once ---------- */
  await visit(ana, `${base}/settings`, 'select[aria-label="Role of Vera Viewer"]');
  await ana.select('select[aria-label="Role of Vera Viewer"]', "editor");
  if (process.env.DEBUG_CLOUD) {
    await sleep(1200);
    console.log("ANA:", await ana.evaluate(() => [...document.querySelectorAll('select[aria-label^="Role of"]')].map((s) => `${s.getAttribute("aria-label")}=${s.value}`).join("; "), ), await ana.evaluate(() => document.querySelector("[role=alert]")?.textContent ?? "no alert"));
    console.log("DB:", await ana.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem("archone.demoServer")).members)));
    await vera.bringToFront();
    await sleep(1500);
    console.log("VERA banner:", await vera.evaluate(() => document.body.innerText.includes("You have view access")));
  }
  await until(vera, () => !document.body.innerText.includes("You have view access to this workspace"), 5000);
  await visit(vera, diagramUrl, ".object-node");
  await vera.evaluate(() => [...document.querySelectorAll("aside button")].find((b) => b.textContent.trim() === "Database")?.click());
  await until(vera, (n) => document.querySelectorAll(".object-node").length === n + 1, 5000, veraBoxes);
  await saved(vera);
  check("a role change reaches the other person without a reload, and they can edit", true);
  await ana.bringToFront();
  await ana.select('select[aria-label="Role of Ana Owner"]', "viewer");
  await waitText(ana, "at least one owner");
  check("the last owner cannot give up ownership", true);

  /* ---------- comments and mentions ---------- */
  const panel = 'aside[aria-label="Comments"]';
  const inPanel = (page, text) => until(page, (sel, t) => document.querySelector(sel)?.innerText.includes(t), 6000, panel, text);
  await ana.select('select[aria-label="Role of Vera Viewer"]', "commenter");
  await waitText(vera, "You have comment access to this workspace");
  await visit(ben, diagramUrl, ".object-node");
  await visit(vera, diagramUrl, ".object-node");
  await clickText(ben, "Comments");
  await inPanel(ben, "No comments on this diagram yet.");
  await ben.click(".object-node");
  await ben.waitForSelector(".react-flow__node.selected .object-node__name");
  await inPanel(ben, "About: " + (await ben.$eval(".react-flow__node.selected .object-node__name", (e) => e.textContent)));
  await ben.click('textarea[aria-label="New comment"]');
  await ben.keyboard.type("Is this still the system of record? @Ver");
  await ben.waitForSelector("[role=listbox] [role=option]");
  await ben.keyboard.press("Enter");
  const typed = await ben.$eval('textarea[aria-label="New comment"]', (e) => e.value);
  await clickText(ben, "Comment", `${panel} button`);
  await inPanel(ben, "1 open");
  check("typing @ offers the members and writes the chosen name into the comment", typed.endsWith("@Vera Viewer ") && (await ben.$eval(`${panel} li[data-thread] span.bg-blueprint-soft`, (e) => e.textContent)) === "@Vera Viewer");
  await ben.waitForSelector(".object-node__comments", { timeout: 3000 }).catch(() => undefined);
  check("a box with an open comment is marked on the canvas while comments are open", (await count(ben, ".object-node__comments")) === 1, `${await count(ben, ".object-node__comments")} marked`);
  await vera.bringToFront();
  await vera.waitForSelector('button[aria-label="Mentions, 1 new"]', { timeout: 6000 });
  check("a mention reaches the person without a reload", true);
  await vera.click('button[aria-label="Mentions, 1 new"]');
  await vera.waitForSelector('[aria-label="Comments that mention you"] li button');
  await vera.click('[aria-label="Comments that mention you"] li button');
  await inPanel(vera, "Is this still the system of record?");
  check("opening a mention shows the thread and selects what it is about", (await count(vera, ".react-flow__node.selected")) === 1 && (await count(vera, `${panel} li[data-thread].border-blueprint`)) === 1);
  await clickText(vera, "Reply", `${panel} button`);
  await vera.waitForSelector('textarea[aria-label="Reply"]');
  await vera.keyboard.type("Yes, until the migration.");
  await vera.keyboard.down("Control");
  await vera.keyboard.press("Enter");
  await vera.keyboard.up("Control");
  await inPanel(ben, "Yes, until the migration.");
  check("a commenter replies, and the reply appears for the other person as it is written", true);
  check(
    "people change only their own comments",
    (await count(ben, 'button[aria-label="Edit this comment"]')) === 1 && (await count(ben, 'button[aria-label="Edit this reply"]')) === 0 && (await count(vera, 'button[aria-label="Edit this comment"]')) === 0 && (await count(vera, 'button[aria-label="Edit this reply"]')) === 1,
  );
  await shot(ben, "27-comments");
  await clickText(ben, "Resolve", `${panel} button`);
  await inPanel(vera, "0 open");
  await inPanel(ben, "Every comment on this diagram is resolved.");
  // Vera came through the mention, so that thread stays in front of her, now marked resolved.
  check("resolving a thread clears it for everyone, and the canvas marker with it", (await count(ben, ".object-node__comments")) === 0 && (await vera.$eval(`${panel} li[data-thread]`, (e) => e.innerText.includes("Resolved"))));
  await clickText(ben, "Comments");

  /* ---------- versions: save, compare, revert ---------- */
  const beforeVersion = await count(ben, ".object-node");
  await visit(ben, `${base}/versions`);
  await waitText(ben, "No versions yet");
  await clickText(ben, "Save a version");
  await waitText(ben, "A version is a copy of the whole model");
  await sleep(200);
  await ben.keyboard.type("Before the cache");
  await clickText(ben, "Save version");
  await waitText(ben, "Version saved.");
  check("an editor saves a named version", (await count(ben, "tbody tr")) === 1 && (await hasText(ben, "Before the cache")));
  await visit(ben, diagramUrl, ".object-node");
  await ben.evaluate(() => [...document.querySelectorAll("aside button")].find((b) => b.textContent.trim() === "Cache")?.click());
  await until(ben, (n) => document.querySelectorAll(".object-node").length === n + 1, 5000, beforeVersion);
  await saved(ben);
  await visit(ben, `${base}/versions`);
  await clickText(ben, "Before the cache", "tbody a");
  await ben.waitForSelector("[data-comparison]");
  const changes = await ben.$eval("[data-comparison]", (e) => e.innerText.replace(/\s+/g, " "));
  check("a version is compared with the model now, thing by thing", /Objects 1/.test(changes) && /Added/.test(changes) && /1 box added/.test(changes), changes.slice(0, 120));
  await ben.evaluate(() => [...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.startsWith("Diagrams")).click());
  await ben.waitForSelector("[data-version-canvas] .object-node");
  await sleep(400);
  check("a version's diagrams are drawn as they were", (await count(ben, "[data-version-canvas] .object-node")) > 0 && (await count(ben, "[data-version-canvas] .react-flow__edge")) > 0);
  await shot(ben, "28-version");
  check("only an owner is offered reverting", (await count(ben, "main button")) > 0 && !(await hasText(ben, "Revert the model to this")));
  await visit(ana, `${base}/versions`);
  await ana.click('button[aria-label="Revert the model to Before the cache"]');
  await waitText(ana, "The model as it is now is saved as a version first");
  await clickText(ana, "Revert the model");
  await waitText(ana, "Model reverted.");
  await saved(ana);
  await visit(ben, diagramUrl, ".object-node");
  await visit(ana, `${base}/versions`);
  check(
    "an owner reverts the model to a version for everyone, and the state before is kept as a version",
    (await count(ben, ".object-node")) === beforeVersion && (await hasText(ana, 'Before reverting to "Before the cache"')) && (await count(ana, "tbody tr")) === 2,
    `${await count(ben, ".object-node")} boxes, expected ${beforeVersion}`,
  );

  /* ---------- review before publishing ---------- */
  const card = 'section[aria-label="Review before publishing"]';
  await visit(ana, `${base}/settings`, card);
  for (const [i, stage] of [
    { name: "Architecture", reviewer: "Ana Owner", checklist: "Every system has a named owner" },
    { name: "Security", reviewer: "Vera Viewer", checklist: "" },
  ].entries()) {
    await clickText(ana, "Add a stage", `${card} button`);
    await ana.waitForFunction((sel, n) => document.querySelectorAll(`${sel} fieldset`).length === n, {}, card, i + 1);
    const set = (await ana.$$(`${card} fieldset`))[i];
    await (await set.$("input")).type(stage.name);
    const value = await set.$eval("select", (el, who) => [...el.options].find((o) => o.textContent === who).value, stage.reviewer);
    await (await set.$("select")).select(value);
    if (stage.checklist) await (await set.$("textarea")).type(stage.checklist);
  }
  await ana.click(`${card} input[type=checkbox]`);
  await waitText(ana, "becomes the first published version");
  await clickText(ana, "Save review settings");
  await waitText(ana, "Review is on.");
  await waitText(vera, 'You are reading the published version, "Baseline"');
  check("switching review on publishes the model as it is and moves readers onto that version", true);
  await clickText(vera, "Ask", "nav a");
  await vera.waitForSelector("[data-ask-examples] button");
  await vera.click("[data-ask-examples] button");
  await vera.waitForSelector('[data-answer="computed"]');
  check("a reader asks a question and is answered from the version they are shown", (await count(vera, '[data-answer="computed"] [data-answer-object]')) >= 1);
  await visit(vera, diagramUrl, ".object-node");
  const publishedBoxes = await count(vera, ".object-node");
  await visit(ben, diagramUrl, ".object-node");
  await ben.evaluate(() => [...document.querySelectorAll("aside button")].find((b) => b.textContent.trim() === "Cache")?.click());
  await until(ben, (n) => document.querySelectorAll(".object-node").length === n + 1, 5000, publishedBoxes);
  await saved(ben);
  await sleep(600);
  check("a reader does not see changes that have not been approved", (await count(vera, ".object-node")) === publishedBoxes && publishedBoxes === beforeVersion);

  const submit = async (title) => {
    await visit(ben, `${base}/reviews`);
    await clickText(ben, "Submit for review");
    await waitText(ben, "Changes since the published version");
    await ben.waitForSelector("[role=dialog] [data-comparison]");
    await ben.click('[role=dialog] input[placeholder^="For example: Events"]');
    await ben.keyboard.type(title);
    await clickText(ben, "Submit for review", "[role=dialog] button");
    await waitText(ben, "Waiting for Ana Owner");
  };
  const openReview = async (page, title) => {
    await visit(page, `${base}/reviews`);
    await clickText(page, title, "main a");
    await waitText(page, "Stages");
  };
  await submit("Add a cache");
  check("an editor submits the model, seeing what differs from the published version", (await hasText(ben, "In review")) && /\/reviews\/.+/.test(ben.url()));
  await openReview(vera, "Add a cache");
  await waitText(vera, "You can open the submitted version when the review reaches you");
  check("a later stage's reviewer cannot open the submitted version before their turn", (await count(vera, "[data-comparison]")) === 0 && (await count(vera, 'section[aria-label="Your decision"]')) === 0);
  await visit(ana, `${base}/reviews`);
  check("the reviewer whose turn it is is told so", (await hasText(ana, "Waiting for you")) && (await ana.$eval('nav a[href="/reviews"]', (e) => e.textContent)).includes("1"));
  await openReview(ana, "Add a cache");
  const approveLocked = () => ana.evaluate(() => [...document.querySelectorAll('section[aria-label="Your decision"] button')].find((b) => b.textContent.trim() === "Approve").disabled);
  const lockedBefore = await approveLocked();
  await ana.click('section[aria-label="Your decision"] input[type=checkbox]');
  check("approving needs every checklist item ticked", lockedBefore && !(await approveLocked()));
  await ana.waitForSelector("[data-who-it-touches]");
  const touched = await ana.$eval("[data-who-it-touches]", (e) => e.innerText.replace(/\s+/g, " "));
  check("a review says when what it changes has no owner to ask", touched === "Nobody is named as owner of: New cache." && (await count(ana, "[data-stakeholder]")) === 0, touched.slice(0, 140));
  await shot(ana, "29-review");
  await clickText(ana, "Approve");
  await waitText(ana, "Waiting for Vera Viewer");
  await openReview(vera, "Add a cache");
  await vera.waitForSelector('section[aria-label="Your decision"]');
  await vera.waitForSelector("[data-comparison]");
  const rejectLocked = await vera.evaluate(() => [...document.querySelectorAll('section[aria-label="Your decision"] button')].find((b) => b.textContent.trim() === "Reject").disabled);
  await vera.click('section[aria-label="Your decision"] textarea');
  await vera.keyboard.type("The cache is reachable from the internet");
  await clickText(vera, "Reject");
  await waitText(vera, "Rejected by Vera Viewer");
  await vera.evaluate(() => {
    window.__packs = [];
    const make = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      void blob.text().then((text) => window.__packs.push(text));
      return make(blob);
    };
  });
  await clickText(vera, "Evidence pack");
  await until(vera, () => window.__packs.length > 0, 5000);
  const pack = await vera.evaluate(() => window.__packs[0]);
  check(
    "a closed review gives one evidence file: outcome, each decision with its checklist, the changes, the findings and the diagrams",
    pack.includes('data-outcome="rejected"') && pack.includes("☑ Every system has a named owner") && pack.includes("Reason: The cache is reachable from the internet") && pack.includes("Objects added (1)") && pack.includes("<svg ") && !/<script/.test(pack),
    `${pack.length} characters`,
  );
  await waitText(ben, "The cache is reachable from the internet");
  await visit(vera, diagramUrl, ".object-node");
  check("a rejection needs a reason, reaches the submitter, and leaves the published version as it was", rejectLocked && (await count(vera, ".object-node")) === publishedBoxes);

  await submit("Add a cache, internal only");
  await openReview(ana, "Add a cache, internal only");
  await ana.click('section[aria-label="Your decision"] input[type=checkbox]');
  await clickText(ana, "Approve");
  await waitText(ana, "Waiting for Vera Viewer");
  await openReview(vera, "Add a cache, internal only");
  await vera.waitForSelector('section[aria-label="Your decision"]');
  await clickText(vera, "Approve");
  await waitText(vera, "A new version was published.");
  await visit(vera, diagramUrl, ".object-node");
  check("when every stage approves, the submitted version is published and readers see it", (await count(vera, ".object-node")) === publishedBoxes + 1 && (await hasText(vera, 'published version, "Add a cache, internal only"')));
  await visit(ben, `${base}/decisions`, "[data-adr-list]");
  const written = await ben.$$eval("[data-adr-list] a", (links) => links.map((a) => a.innerText.replace(/\s+/g, " ")));
  check("every closed review left a decision record: one rejected, one accepted", written.length === 4 && written.some((w) => w.includes("Rejected") && w.endsWith("Add a cache")) && written.some((w) => w.includes("Accepted") && w.endsWith("Add a cache, internal only")), written.join(" | "));
  await ben.evaluate(() => [...document.querySelectorAll("[data-adr-list] a")].find((a) => a.textContent.includes("internal only")).click());
  await ben.waitForSelector("[data-adr]");
  const record = await ben.$eval("[data-adr]", (e) => e.innerText.replace(/\s+/g, " "));
  check("the record says who approved, what changed, and cannot be edited", record.includes("Approved in review. Architecture: Ana Owner; Security: Vera Viewer.") && /Objects: \d+ added, \d+ changed, \d+ removed\./.test(record) && record.includes("Written when a review was closed.") && (await count(ben, "[data-adr] textarea")) === 0, record.slice(0, 200));
  await shot(ben, "31-review-decision");
  await visit(ben, `${base}/versions`);
  check("the versions list shows which one is published", (await ben.$$eval("tbody tr", (rows) => rows.filter((r) => r.innerText.includes("Published")).map((r) => r.querySelector("a").textContent).join("|"))) === "Add a cache, internal only");

  // Back to open editing for the rest of the run.
  await visit(ana, `${base}/settings`, card);
  await ana.click(`${card} input[type=checkbox]`);
  await clickText(ana, "Save review settings");
  await waitText(ana, "Review settings saved.");
  await waitText(vera, "You have comment access to this workspace");
  await ana.select('select[aria-label="Role of Vera Viewer"]', "editor");
  await until(vera, () => !document.body.innerText.includes("access to this workspace"), 5000);
  await visit(vera, diagramUrl, ".object-node");
  await visit(ben, diagramUrl, ".object-node");
  check("switching review off gives readers the working model again", (await count(vera, ".object-node")) === (await count(ben, ".object-node")));

  /* ---------- live links, API keys and webhooks ---------- */
  await clickText(ben, "Share");
  await ben.waitForSelector("[data-live-links]");
  check("sharing offers a live link first, and a snapshot link as before", (await count(ben, "[role=dialog] [role=tab]")) === 2 && (await hasText(ben, "The link keeps up with later changes until you switch it off.")));
  await clickText(ben, "Create a live link");
  await ben.waitForSelector('input[aria-label="Live link"]');
  const liveUrl = await ben.$eval('input[aria-label="Live link"]', (e) => e.value);
  const benBoxes = await count(ben, ".object-node");
  // Opened by someone who is not signed in: a tab that has no session of its own.
  const visitor = await open();
  await visit(visitor, liveUrl, ".object-node");
  check(
    "a live link shows the diagram to someone who is not signed in, with no way to edit",
    /\/embed\/[a-z0-9]{12,}$/.test(liveUrl) && (await count(visitor, ".object-node")) === benBoxes && (await hasText(visitor, "Live, view only")) && (await count(visitor, "nav[aria-label=Main]")) === 0 && (await count(visitor, "input[type=password]")) === 0,
    `${await count(visitor, ".object-node")} of ${benBoxes} boxes`,
  );
  await clickText(ben, "Done");
  await ben.evaluate(() => [...document.querySelectorAll("aside button")].find((b) => b.textContent.trim() === "Cache")?.click());
  await until(ben, (n) => document.querySelectorAll(".object-node").length === n + 1, 5000, benBoxes);
  await saved(ben);
  await visit(visitor, liveUrl, ".object-node");
  check("the live link follows the diagram as it changes", (await count(visitor, ".object-node")) === benBoxes + 1);
  await shot(visitor, "30-live-link");
  await clickText(ben, "Share");
  await ben.waitForSelector('input[aria-label="Live link"]');
  await clickText(ben, "Switch off");
  await until(ben, () => !document.querySelector('input[aria-label="Live link"]'), 5000);
  await clickText(ben, "Done");
  await visit(visitor, liveUrl);
  await waitText(visitor, "This link no longer works");
  check("switching a live link off stops it for everyone who has it", (await count(visitor, ".object-node")) === 0);
  await visitor.close();

  // A live link that asks for a password and has a last day.
  await clickText(ben, "Share");
  await ben.waitForSelector("[data-live-link-new]");
  await ben.type('input[aria-label="Password for the live link"]', "short");
  const refusedShort = (await hasText(ben, "At least 8 characters.")) && (await ben.$eval("[data-live-link-new] button", (b) => b.disabled));
  await ben.$eval('input[aria-label="Password for the live link"]', (e) => e.select());
  await ben.type('input[aria-label="Password for the live link"]', "harbour-light-7");
  await ben.select('select[aria-label="When the live link stops working"]', "7");
  await clickText(ben, "Create a live link");
  await ben.waitForSelector('[data-live-link="protected"] input[aria-label="Live link"]');
  const lockedUrl = await ben.$eval('[data-live-link="protected"] input[aria-label="Live link"]', (e) => e.value);
  const dialogText = await ben.$eval("[data-live-links]", (e) => e.innerText);
  check(
    "a live link can be given a password and a last day, and the password is not shown again",
    refusedShort && dialogText.includes("Asks for a password") && dialogText.includes("Works until") && !dialogText.includes("harbour-light-7") && (await ben.$eval('input[aria-label="Password for the live link"]', (e) => e.value)) === "",
    dialogText.slice(0, 200),
  );
  await clickText(ben, "Done");
  const guest = await open();
  await visit(guest, lockedUrl, "[data-embed-locked]");
  const shutAtFirst = (await count(guest, ".object-node")) === 0 && (await hasText(guest, "This diagram is protected"));
  await guest.type("[data-embed-locked] input[type=password]", "not the password");
  await clickText(guest, "Open diagram");
  await waitText(guest, "That password does not open this link");
  const stillShut = (await count(guest, ".object-node")) === 0;
  await guest.type("[data-embed-locked] input[type=password]", "harbour-light-7");
  await clickText(guest, "Open diagram");
  await guest.waitForSelector(".object-node");
  check("a protected live link shows nothing until the right password is given", shutAtFirst && stillShut && (await count(guest, ".object-node")) > 0 && !guest.url().includes("harbour"), guest.url());
  await shot(guest, "31-protected-live-link");
  await guest.close();

  const integrations = 'section[aria-label="API and webhooks"]';
  await visit(ana, `${base}/settings`, integrations);
  await ana.type(`${integrations} input[placeholder^="For example: CMDB"]`, "CMDB sync");
  await clickText(ana, "Create key", `${integrations} button`);
  await ana.waitForSelector(`${integrations} [data-secret] input`);
  const shownKey = await ana.$eval(`${integrations} [data-secret] input`, (e) => e.value);
  await clickText(ana, "I have saved it");
  await until(ana, (sel) => !document.querySelector(`${sel} [data-secret]`), 4000, integrations);
  const keyRow = await ana.$eval(`${integrations} tbody tr`, (e) => e.innerText.replace(/\s+/g, " "));
  check("an owner creates an API key that is shown once and then only by its first characters", shownKey.startsWith("ark") && keyRow.includes("CMDB sync") && keyRow.includes(shownKey.slice(0, 12)) && !keyRow.includes(shownKey) && !(await hasText(ana, shownKey)), keyRow.slice(0, 60));
  check("a new key proposes by default: its changes wait for a person", keyRow.includes("Read and propose"), keyRow);
  await ana.type(`${integrations} input[placeholder^="For example: CMDB"]`, "Payments sync");
  await ana.select(`${integrations} form select`, "write");
  await ana.waitForSelector("[data-key-limit-choice] summary");
  await ana.click("[data-key-limit-choice] summary");
  const limitName = await ana.$eval("[data-key-limit-choice] label", (l) => l.innerText.trim());
  await ana.click("[data-key-limit-choice] input[type=checkbox]");
  await clickText(ana, "Create key", `${integrations} button`);
  await ana.waitForSelector(`${integrations} [data-secret] input`);
  await clickText(ana, "I have saved it");
  await until(ana, (sel) => !document.querySelector(`${sel} [data-secret]`), 4000, integrations);
  const limited = await ana.$$eval(`${integrations} tbody tr`, (rows) => rows.map((r) => r.innerText.replace(/\s+/g, " ")).find((r) => r.includes("Payments sync")) ?? "");
  check("a key that writes directly can be limited to chosen domains", limited.includes("Read and write") && limited.includes(`Only inside: ${limitName}`), limited);
  await ana.type(`${integrations} input[placeholder^="https://example.com"]`, "http://insecure.example.com/hook");
  await clickText(ana, "Add webhook", `${integrations} button`);
  await waitText(ana, "Give a public https address");
  await ana.focus(`${integrations} input[placeholder^="https://example.com"]`);
  await ana.keyboard.down("Control");
  await ana.keyboard.press("KeyA");
  await ana.keyboard.up("Control");
  await ana.keyboard.press("Backspace");
  await ana.keyboard.type("https://hooks.example.com/archone");
  await clickText(ana, "Add webhook", `${integrations} button`);
  await ana.waitForSelector(`${integrations} [data-secret] input`);
  check("a webhook needs a public https address and gets a signing secret, shown once", (await ana.$eval(`${integrations} [data-secret] input`, (e) => e.value)).startsWith("whsec") && (await hasText(ana, "X-ArchONE-Signature")));
  await clickText(ana, "I have saved it");
  await visit(ben, `${base}/settings`);
  check("someone who is not an owner does not see keys or webhooks", (await hasText(ben, "Workspace name")) && (await count(ben, integrations)) === 0);
  await visit(ben, diagramUrl, ".object-node");

  /* ---------- offline edits are kept and saved later ---------- */
  await ben.bringToFront();
  await ben.setOfflineMode(true);
  await ben.evaluate(() => [...document.querySelectorAll("aside button")].find((b) => b.textContent.trim() === "Cache")?.click());
  await waitText(ben, "change waiting", 6000).catch(() => waitText(ben, "changes waiting", 3000));
  const whileOffline = await count(vera, ".object-node");
  await ben.bringToFront();
  await ben.setOfflineMode(false);
  await saved(ben);
  await until(vera, (n) => document.querySelectorAll(".object-node").length === n + 1, 8000, whileOffline);
  check("edits made while offline are kept in the tab and saved when the connection returns", true);

  /* ---------- a reload shows the saved state; sign-out and sign-in ---------- */
  const total = await count(vera, ".object-node");
  await ben.bringToFront();
  await ben.reload({ waitUntil: "networkidle0" });
  await ben.waitForSelector(".object-node");
  await sleep(500);
  check("after a reload everything is still there, loaded from the server", (await count(ben, ".object-node")) === total, `${total} boxes`);
  await ben.evaluate(() => document.querySelector("header [aria-haspopup=menu]").click());
  await clickText(ben, "Sign out", "[role=menuitem]");
  await waitText(ben, "Forgot your password?");
  check("signing out returns to the sign-in screen", (await count(ben, ".object-node")) === 0);
  await fill(ben, "Email", "ben@example.com");
  await fill(ben, "Password", "wrong-password");
  await clickText(ben, "Sign in", "button[type=submit]");
  await waitText(ben, "do not match an account");
  await fill(ben, "Password", "correct-horse-9");
  await clickText(ben, "Sign in", "button[type=submit]");
  await ben.waitForSelector("nav[aria-label=Main]", { timeout: 8000 });
  check("a wrong password is refused; the right one reopens the last workspace", await hasText(ben, "Payments platform"));

  /* ---------- starting a workspace from the phase 1 browser copy ---------- */
  await ben.evaluate(() => {
    const stamp = new Date().toISOString();
    const object = { id: "obj_local1", typeId: "service", name: "Kept from before", description: "", owner: "", lifecycle: "active", tags: [], parentId: null, technology: "", fields: {}, provenance: { origin: "manual" }, createdAt: stamp, updatedAt: stamp };
    const diagram = { id: "dia_local1", name: "Old local diagram", description: "", viewType: "custom", scopeId: null, direction: "TB", nodes: { obj_local1: { x: 40, y: 40, pinned: true } }, hiddenRelationshipIds: [], edgeKinds: null, colorBy: "type", createdAt: stamp, updatedAt: stamp };
    localStorage.setItem("archone.workspace.v1", JSON.stringify({ version: 1, name: "Local", userName: "", objects: { obj_local1: object }, relationships: {}, diagrams: { dia_local1: diagram }, proposals: {}, updatedAt: stamp }));
  });
  await ben.evaluate(() => document.querySelector("header [aria-haspopup=menu]").click());
  await clickText(ben, "Switch workspace", "[role=menuitem]");
  await waitText(ben, "Start it with the model saved in this browser");
  await fill(ben, "Name", "Moved from my browser");
  await ben.evaluate(() => document.querySelector('form input[type="checkbox"]').click());
  await clickText(ben, "Create workspace");
  await waitText(ben, "Old local diagram");
  await saved(ben);
  await ben.reload({ waitUntil: "networkidle0" });
  await waitText(ben, "Old local diagram");
  check("a browser-only workspace from phase 1 can be moved into an account", (await hasText(ben, "Moved from my browser")) && (await count(ben, "tbody tr")) === 1);
  await shot(ben, "25-after-import");

  /* ---------- deleting a workspace ---------- */
  // The tabs share one browser profile, and with it the remembered last workspace, so Ben
  // moves inside the app here rather than reloading into whichever workspace was opened last.
  await clickText(ben, "Settings", "nav a");
  await waitText(ben, "Delete this workspace");
  await clickText(ben, "Delete workspace");
  await waitText(ben, "Type the workspace name to confirm");
  await sleep(200);
  const typingGoesToTheField = await ben.evaluate(() => !!document.activeElement?.matches("[role=dialog] input"));
  const deleteLocked = () => ben.evaluate(() => [...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim() === "Delete workspace").disabled);
  await ben.keyboard.type("Moved from my");
  const lockedWhileWrong = await deleteLocked();
  await ben.keyboard.type(" browser");
  check("deleting a workspace asks for its name, typed straight into the dialog", typingGoesToTheField && lockedWhileWrong && !(await deleteLocked()));
  await shot(ben, "26-delete-workspace");
  await clickText(ben, "Delete workspace", "[role=dialog] button");
  await waitText(ben, "Your workspaces");
  await waitText(ben, "Workspace deleted.");
  const listedAfter = () => ben.evaluate(() => [...document.querySelectorAll("section li")].map((li) => li.textContent).join(" | "));
  let listed = await listedAfter();
  check("an owner deletes a workspace and returns to the list, where the others remain", !listed.includes("Moved from my browser") && listed.includes("Payments platform"), listed);
  await ben.reload({ waitUntil: "networkidle0" });
  await waitText(ben, "Payments platform");
  await sleep(400);
  check("the deleted workspace stays gone after a reload", !(await hasText(ben, "Moved from my browser")));

  // Scenarios: branch the model, change the copy, compare with the model as it is.
  await visit(ana, `${base}/scenarios`);
  await waitText(ana, "New scenario");
  const mainObjects = await ana.evaluate(() => document.querySelector("form p").textContent.match(/Copies (\d+) objects/)[1]);
  await ana.type('form input[placeholder^="For example: Move payments"]', "Target 2027");
  await clickText(ana, "Create scenario");
  await waitText(ana, "Scenario: Target 2027");
  await waitText(ana, "Nothing differs yet");
  check("a scenario copies the model into its own workspace and starts out identical", (await hasText(ana, 'A copy of "Payments platform"')) && Number(mainObjects) > 5, `${mainObjects} objects copied`);
  await clickText(ana, "Model", "nav a");
  await ana.waitForSelector("tbody tr");
  await ana.click("tbody tr");
  const nameField = await ana.waitForSelector('aside input, [aria-label="Details"] input');
  await nameField.click({ clickCount: 3 });
  await nameField.type("Renamed in the scenario");
  await ana.keyboard.press("Tab");
  await saved(ana);
  await clickText(ana, "Scenarios", "nav a");
  await ana.waitForSelector("[data-scenario-comparison]");
  await waitText(ana, "Renamed in the scenario");
  check("the scenario lists what it changes compared with the main model", !(await hasText(ana, "Nothing differs yet")));
  await shot(ana, "28-scenario");
  await clickText(ana, "Back to Payments platform");
  await ana.waitForSelector("[data-scenarios]");
  await sleep(300);
  check("the main model is untouched and lists its scenario", (await hasText(ana, "Target 2027")) && !(await ana.evaluate(() => document.body.innerText.includes("Renamed in the scenario"))));
  await clickText(ana, "Model", "nav a");
  await ana.waitForSelector("tbody tr");
  check("the change made in the scenario is not in the main model", !(await hasText(ana, "Renamed in the scenario")));

  // An editor limited to a domain changes only what is inside it.
  await visit(ana, `${base}/settings`);
  await ana.waitForSelector('[data-member-limit="Ben Editor"] summary');
  await ana.click('[data-member-limit="Ben Editor"] summary');
  await ana.evaluate(() => [...document.querySelectorAll('[data-member-limit="Ben Editor"] label')].find((l) => l.textContent.includes("Only inside Digital commerce")).querySelector("input").click());
  await until(ana, () => document.querySelector('[data-member-limit="Ben Editor"] summary').textContent.includes("Limited to Digital commerce"), 5000);
  await visit(ben, `${base}/model`, "tbody tr");
  const openRow = (page, name) => page.evaluate((n) => [...document.querySelectorAll("tbody tr")].find((r) => r.querySelector("td").innerText.trim().split("\n")[0] === n).click(), name);
  const rename = async (page, to) => {
    const field = await page.waitForSelector('aside input, [aria-label="Details"] input');
    await field.click({ clickCount: 3 });
    await field.type(to);
    await page.keyboard.press("Tab");
  };
  await openRow(ben, "Payment provider");
  await rename(ben, "Outside my domain");
  await waitText(ben, "You can only change what is inside Digital commerce");
  check("an editor limited to a domain is told why a change outside it is not made", !(await ben.evaluate(() => [...document.querySelectorAll("tbody tr")].some((r) => r.innerText.includes("Outside my domain")))));
  await openRow(ben, "Catalog service");
  await rename(ben, "Catalogue service");
  await saved(ben);
  await until(ana, () => true, 100);
  await visit(ana, `${base}/model`, "tbody tr");
  check("the same editor changes what is inside the domain, and it is saved for everyone", (await hasText(ana, "Catalogue service")) && !(await hasText(ana, "Outside my domain")));
  await visit(ana, `${base}/settings`);
  await ana.waitForSelector('[data-member-limit="Ben Editor"] summary');
  await ana.click('[data-member-limit="Ben Editor"] summary');
  await ana.evaluate(() => [...document.querySelectorAll('[data-member-limit="Ben Editor"] label')].find((l) => l.textContent.includes("Only inside Digital commerce")).querySelector("input").click());
  await until(ana, () => document.querySelector('[data-member-limit="Ben Editor"] summary').textContent.includes("Changes the whole model"), 5000);
  check("an owner lifts the limit again", true);

  // Roles per category: Ben may not see Applications diagrams and only views Infrastructure.
  await visit(ana, `${base}/settings`);
  await ana.waitForSelector('[data-member-categories="Ben Editor"] summary');
  await ana.click('[data-member-categories="Ben Editor"] summary');
  const setCategory = async (category, value) => {
    await ana.select(`[data-member-categories="Ben Editor"] [data-category-role="${category}"]`, value);
    await until(ana, (c, v) => document.querySelector(`[data-member-categories="Ben Editor"] [data-category-role="${c}"]`)?.value === v && !document.querySelector(`[data-member-categories="Ben Editor"] select:disabled`), 5000, category, value);
  };
  await setCategory("applications", "none");
  await setCategory("infrastructure", "viewer");
  const categorySummary = await ana.$eval('[data-member-categories="Ben Editor"] summary', (e) => e.textContent);
  await shot(ana, "40-category-roles");
  check("an owner sets a member's role per category", categorySummary.includes("Applications: No access") && categorySummary.includes("Infrastructure: View"), categorySummary);
  await visit(ben, base, "table, [data-template-open]");
  await until(ben, () => !document.body.innerText.includes("System landscape"), 8000).catch(() => undefined);
  const benDiagrams = await ben.$$eval("tbody tr td:first-child a", (links) => links.map((a) => a.textContent.trim()));
  check("diagrams of a category with no access are not shown at all", !benDiagrams.includes("System landscape") && !benDiagrams.includes("Inside Online store") && benDiagrams.includes("Deployment"), benDiagrams.join(", "));
  await ben.evaluate(() => [...document.querySelectorAll("tbody tr td:first-child a")].find((a) => a.textContent.trim() === "Deployment").click());
  await ben.waitForSelector(".object-node");
  const viewOnly = await ben.$("[data-category-view-only=infrastructure]");
  await shot(ben, "41-category-view-only");
  check("a diagram of a category the member only views opens read-only, saying why", !!viewOnly && !(await ben.$('[aria-label="Show the panel for adding objects"]')));
  await visit(ben, base, "[data-template-open]");
  await ben.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "New diagram")?.click());
  await ben.waitForSelector('[data-view-category="business"]');
  const kindsOffered = await ben.$$eval("[data-view-category]", (tabs) => tabs.filter((t) => t.dataset.allowed === "true").map((t) => t.dataset.viewCategory));
  await ben.$eval('[data-view-category="applications"]', (b) => b.click());
  const lockedNote = await ben.$eval("[data-category-locked]", (e) => e.textContent).catch(() => "");
  check("a new diagram can be made only in the categories the member edits; the others say why", kindsOffered.join(",") === "data,business,custom" && lockedNote.includes("no access"), `${kindsOffered.join(",")} :: ${lockedNote}`);
  await ben.keyboard.press("Escape");
  await visit(ben, `${base}/model`, "tbody tr");
  const benRows = await ben.$$eval("tbody tr", (rows) => rows.map((r) => r.querySelector("td").innerText.trim().split("\n")[0]));
  const appRow = benRows.find((n) => n === "Catalogue service") ?? benRows.find((n) => /service|store|app/i.test(n));
  if (!appRow) throw new Error(`No application row among: ${benRows.join(", ")}`);
  await openRow(ben, appRow);
  await ben.waitForSelector("[data-object-view-only]");
  check("an object of a category the member does not edit shows as view-only", !!(await ben.$("fieldset[data-object-editable=false]")));
  await visit(ana, `${base}/settings`);
  await ana.waitForSelector('[data-member-categories="Ben Editor"] summary');
  await ana.click('[data-member-categories="Ben Editor"] summary');
  await setCategory("applications", "");
  await setCategory("infrastructure", "");
  await visit(ben, base, "tbody tr");
  await until(ben, () => document.body.innerText.includes("System landscape"), 8000).catch(() => undefined);
  check("lifting the roles per category brings the diagrams back", await hasText(ben, "System landscape"));

  // The audit log: owners read who changed what; nobody else is offered it.
  await visit(ana, `${base}/audit`, "[data-audit-table]");
  const auditRows = () => ana.$$eval("[data-audit-entry]", (rows) => rows.map((r) => `${r.dataset.auditEntry} | ${r.innerText.replace(/\s+/g, " ")}`));
  let audit = await auditRows();
  check(
    "the audit log lists what was changed, by whom, newest first",
    audit.length > 10 && audit.some((r) => r.startsWith("created object")) && audit.some((r) => r.startsWith("role changed member") && r.includes("Ana Owner")) && audit.some((r) => r.startsWith("sent invitation")),
    `${audit.length} entries`,
  );
  const roleRow = await ana.evaluateHandle(() => [...document.querySelectorAll('[data-audit-entry="role changed member"]')].at(0).querySelector("button"));
  await roleRow.click();
  const roleChange = await ana.$eval("[data-audit-changes]", (dl) => dl.innerText.replace(/\s+/g, " "));
  check("an entry opens to show the value before and after", /Role (viewer|editor|commenter|owner) to (viewer|editor|commenter|owner)/.test(roleChange), roleChange);
  await ana.select('select[aria-label="What changed"]', "diagram");
  await ana.waitForFunction(() => { const rows = [...document.querySelectorAll("[data-audit-entry]")]; return rows.length > 0 && rows.every((r) => r.dataset.auditEntry.endsWith(" diagram")); });
  await ana.type('input[aria-label="Search the audit log"]', "zzzz-no-such-thing");
  await waitText(ana, "No entries match");
  check("the log filters by what changed and by words, and says so when nothing matches", true);
  await clickText(ana, "Clear filters");
  await ana.waitForSelector("[data-audit-entry]");
  await clickText(ana, "Check the log");
  await ana.waitForSelector("[data-audit-result]");
  const chainText = await ana.$eval("[data-audit-result]", (e) => e.innerText.replace(/\s+/g, " "));
  const chainCode = await ana.$eval("[data-audit-code]", (e) => e.textContent.trim());
  check("an owner can check that the log's entries follow from one another, and gets a code to keep", (await ana.$eval("[data-audit-result]", (e) => e.getAttribute("data-audit-result"))) === "ok" && /All \d+ entries follow from one another/.test(chainText) && /^\d+-[0-9a-f]{64}$/.test(chainCode), chainText.slice(0, 90));
  await ana.type('[data-audit-chain] input', chainCode);
  await clickText(ana, "Check against it");
  await ana.waitForSelector('[data-audit-anchor="match"]');
  await ana.focus("[data-audit-chain] input");
  await ana.keyboard.down("Control");
  await ana.keyboard.press("a");
  await ana.keyboard.up("Control");
  await ana.keyboard.press("Backspace");
  await ana.type('[data-audit-chain] input', chainCode.slice(0, -1) + (chainCode.endsWith("0") ? "1" : "0"));
  await clickText(ana, "Check against it");
  await ana.waitForSelector('[data-audit-anchor="mismatch"]');
  check("a saved code is recognised, and a code that no longer fits is called out", (await ana.$eval("[data-audit-result]", (e) => e.getAttribute("data-audit-result"))) === "broken" && (await hasText(ana, "The log was rewritten after the code was saved")));
  await ana.focus("[data-audit-chain] input");
  await ana.keyboard.down("Control");
  await ana.keyboard.press("a");
  await ana.keyboard.up("Control");
  await ana.keyboard.press("Backspace");
  await shot(ana, "27-audit-log");
  const offered = (page) => page.evaluate(() => [...document.querySelectorAll("nav a")].some((a) => a.textContent.trim() === "Audit log"));
  await visit(vera, `${base}/audit`);
  check("someone who is not an owner is not offered the audit log, and gets no entries by its address", (await offered(ana)) && !(await offered(vera)) && (await hasText(vera, "Only owners can read the audit log")) && (await count(vera, "[data-audit-entry]")) === 0);

  // A scenario's agreed changes are brought into the main model, one tick each.
  await visit(ana, `${base}/scenarios`);
  await ana.waitForSelector("[data-scenarios]");
  await clickText(ana, "Open and compare");
  await ana.waitForSelector("[data-scenario-merge]");
  const ownWork = await ana.$$eval('[data-merge-group="scenario"] li', (rows) => rows.map((r) => r.innerText.replace(/\s+/g, " ").trim()));
  const bringLabel = await ana.$eval("[data-merge-bring]", (e) => e.textContent.trim());
  check("a scenario offers its own changes ticked, apart from what the main model changed since", ownWork.length === 1 && ownWork[0].includes("Renamed in the scenario") && bringLabel === "Bring 1 change into Payments platform", `${bringLabel}; ${ownWork.length} of its own`);
  await shot(ana, "29-scenario-merge");
  await ana.click("[data-merge-bring]");
  await waitText(ana, 'Brought 1 change into "Payments platform".');
  check("after bringing a change over, the scenario no longer lists it", (await count(ana, '[data-merge-group="scenario"]')) === 0);
  await clickText(ana, "Back to Payments platform");
  await ana.waitForSelector("[data-scenarios]");
  await clickText(ana, "Model", "nav a");
  await ana.waitForSelector("tbody tr");
  await waitText(ana, "Renamed in the scenario");
  check("the change is now in the main model", true);

  // The public trust page: set up by an owner, read by anyone with the address.
  await visit(vera, `${base}/settings`);
  await waitText(vera, "Workspace name");
  await visit(ana, `${base}/settings`, "[data-trust-card] [data-trust-title]");
  check("only an owner is offered the trust page", (await count(vera, "[data-trust-card]")) === 0 && (await ana.$eval("[data-trust-state]", (e) => e.textContent.trim())) === "Off" && (await ana.$eval("[data-trust-on]", (e) => e.disabled)));
  await ana.type("[data-trust-title]", "How we handle your data");
  const trustDiagram = await ana.$eval("[data-trust-diagram-choice]", (e) => e.options[1].value);
  await ana.select("[data-trust-diagram-choice]", trustDiagram);
  await ana.$eval("[data-trust-preview-toggle]", (e) => e.click());
  await ana.waitForSelector("[data-trust-preview] .object-node");
  check("the owner sees what the page will show before switching it on", (await hasText(ana, "Where personal data is kept")) && (await hasText(ana, "Outside parties that receive personal data")));
  await ana.$eval("[data-trust-on]", (e) => e.click());
  await ana.waitForSelector("[data-trust-link] input");
  const trustUrl = await ana.$eval("[data-trust-link] input", (e) => e.value);
  await shot(ana, "30-trust-settings");
  const reader = await open();
  await visit(reader, trustUrl, "[data-trust-page] .object-node");
  const readerText = await reader.evaluate(() => document.body.innerText);
  check(
    "the trust page opens for someone who is not signed in, with the statements and the chosen diagram",
    /\/trust\/[a-z0-9]{16,}$/.test(trustUrl) && readerText.includes("How we handle your data") && readerText.includes("Movement between regions") && (await count(reader, "nav[aria-label=Main]")) === 0 && (await count(reader, "input[type=password]")) === 0,
    trustUrl.replace(/.*\/trust\//, "/trust/"),
  );
  await shot(reader, "31-trust-page");
  await ana.bringToFront();
  await ana.$eval("[data-trust-off]", (e) => e.click());
  await until(ana, () => document.querySelector("[data-trust-state]")?.textContent.trim() === "Off", 5000);
  await reader.reload({ waitUntil: "networkidle0" });
  await waitText(reader, "This page is not available");
  check("switching the page off closes its address", (await count(reader, "[data-trust-content]")) === 0);
  await reader.close();

  // The workspace's own rules: an owner writes them, every member's checks run them.
  await visit(ana, `${base}/checks/rules`, "[data-rule-new]");
  await ana.$eval("[data-rule-new]", (e) => e.click());
  await ana.waitForSelector("[data-rule-text]");
  await ana.type("[data-rule-text]", "External systems must have an owner");
  await ana.$eval("[data-rule-read]", (e) => e.click());
  await until(ana, () => document.querySelector("[data-rule-sentence]")?.textContent.trim() === "All external systems must have an owner.", 5000);
  await ana.$eval("[data-rule-save]", (e) => e.click());
  await ana.waitForSelector("[data-rules] [data-rule-row]");
  await saved(ana);
  const ruleFindings = await ana.$eval("[data-rule-count]", (e) => e.textContent.trim());
  await visit(ben, `${base}/checks/rules`, "[data-rules-page]");
  await ben.waitForSelector("[data-rules] [data-rule-row]");
  check(
    "a rule an owner writes reaches the other members, who can read it and not change it",
    (await hasText(ben, "All external systems must have an owner.")) && (await count(ben, "[data-rule-new]")) === 0 && (await hasText(ben, "Only an owner can add or change rules.")) && (await ben.$eval("[data-rule-row] input[type=checkbox]", (e) => e.disabled)),
    ruleFindings,
  );
  await visit(ben, `${base}/checks`, "[data-own-rules]");
  check("the rule runs in that member's checks too", (await ben.$eval("[data-own-rules]", (e) => e.textContent.trim())) === "Your rules (1 on)" && (/^\d+ finding/.test(ruleFindings) ? await hasText(ben, "All external systems must have an owner.") : true));

  // The owner deletes the shared workspace while someone else has it open.
  await visit(vera, `${base}/settings`);
  check("someone who is not an owner is not offered deleting the workspace", (await hasText(vera, "Workspace name")) && !(await hasText(vera, "Delete this workspace")));
  await visit(ana, `${base}/settings`);
  await clickText(ana, "Delete workspace");
  await waitText(ana, "Type the workspace name to confirm");
  await sleep(200);
  await ana.keyboard.type("Payments platform");
  await clickText(ana, "Delete workspace", "[role=dialog] button");
  await waitText(ana, "Workspace deleted.");
  await waitText(vera, "You no longer have access to that workspace.");
  check("when an owner deletes a workspace, a member who has it open is returned to their list", (await count(vera, "nav[aria-label=Main]")) === 0);

  check("leaving a page with everything saved raises no unsaved-changes warning", dialogs.length === 0, dialogs.slice(0, 3).join(" | "));
  check("no errors in the browser console", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (error) {
  check("the run finished", false, error.message);
  const pages = await context.pages();
  for (const [i, page] of pages.entries()) {
    await page.bringToFront().catch(() => {});
    await page.screenshot({ path: join(shots, `failure-cloud-${i}.png`) }).catch(() => {});
  }
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
