import { DiscoverError, type Remote } from "../discover/remote";
import { aiBaseUrl, aiProviderOf } from "./catalog";

/**
 * Calls to the services a workspace connects to in Settings → Integrations, made by the
 * integrations Edge Function with what the integration keeps. Each takes the integration's
 * settings (s) and secrets (k), and a Remote that limits time and refuses redirects.
 */

type Kept = Record<string, string>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const b64 = (text: string) => {
  let binary = "";
  for (const b of new TextEncoder().encode(text)) binary += String.fromCharCode(b);
  return btoa(binary);
};
const basic = (user: string, password: string) => `Basic ${b64(`${user}:${password}`)}`;
const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const bad = (message: string) => new DiscoverError(400, "bad_settings", message);

/** A plain https address from a setting, without a trailing slash, or an error naming the field. */
function httpsBase(raw: string, field: string): string {
  try {
    const url = new URL(raw.trim());
    const local = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if ((url.protocol !== "https:" && !local) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw bad(`${field} is not a plain https address.`);
  }
}

/* ---------- AI provider ---------- */

export function aiTarget(s: Kept, k: Kept): { base: string; key: string; model: string; visionModel: string; label: string } {
  const provider = aiProviderOf(s.provider);
  if (!provider) throw bad("Choose an AI provider.");
  const base = aiBaseUrl(s);
  if (!base) throw bad("Give the Cloudflare account ID: 32 letters and digits, from the Workers AI page of the dashboard.");
  if (!str(k.apiKey)) throw bad("Give the provider's API key.");
  return { base, key: str(k.apiKey), model: str(s.model) || provider.model, visionModel: str(s.visionModel) || provider.visionModel || "", label: provider.label };
}

export async function aiModels(s: Kept, k: Kept, remote: Remote): Promise<string[]> {
  const t = aiTarget(s, k);
  const answer = (await remote.json(`${t.base}/models`, { headers: { authorization: `Bearer ${t.key}` } })) as { data?: { id?: unknown }[]; models?: { id?: unknown; name?: unknown }[] } | unknown[];
  const list = Array.isArray(answer) ? answer : (answer?.data ?? answer?.models ?? []);
  return [...new Set((list as Record<string, unknown>[]).map((m) => str(m.id) || str(m.name).replace(/^models\//, "")).filter(Boolean))].sort().slice(0, 500);
}

export async function aiTest(s: Kept, k: Kept, remote: Remote): Promise<string> {
  const t = aiTarget(s, k);
  const answer = (await remote.json(`${t.base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${t.key}` },
    body: JSON.stringify({ model: t.model, messages: [{ role: "user", content: "Reply with the single word OK." }], max_tokens: 16 }),
  })) as { choices?: unknown[] };
  if (!Array.isArray(answer?.choices)) throw new DiscoverError(502, "source_failed", `${t.label} answered, but not with a chat reply. Check the model name.`);
  return `Connected to ${t.label}: ${t.model} answered.`;
}

/* ---------- GitHub: infrastructure as code from a repository ---------- */

const IAC_FILE = /\.(tf|tf\.json|tfstate|hcl|bicep|ya?ml|json)$/i;
const MAX_FILES = 150;
const MAX_REPO_BYTES = 4_000_000;

function githubApi(s: Kept): string {
  return s.url ? httpsBase(s.url, "The GitHub Enterprise address") : "https://api.github.com";
}
const githubHeaders = (k: Kept) => ({ authorization: `Bearer ${str(k.token)}`, "x-github-api-version": "2022-11-28", "user-agent": "ArchONE-Diagrams" });

export async function githubTest(s: Kept, k: Kept, remote: Remote): Promise<string> {
  const api = githubApi(s);
  const repo = str(s.repository);
  if (repo) {
    const info = (await remote.json(`${api}/repos/${repo}`, { headers: githubHeaders(k) })) as { full_name?: string; default_branch?: string };
    return `Connected: ${info.full_name ?? repo} can be read (default branch ${info.default_branch ?? "unknown"}).`;
  }
  const me = (await remote.json(`${api}/user`, { headers: githubHeaders(k) })) as { login?: string };
  return `Connected as ${me.login ?? "the token's user"}.`;
}

/** The infrastructure files under a folder of a repository: at most 150 files and 4 MB. */
export async function githubFiles(s: Kept, k: Kept, remote: Remote, args: { repository?: unknown; path?: unknown; ref?: unknown }) {
  const api = githubApi(s);
  const repo = str(args.repository) || str(s.repository);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw bad("Give the repository as owner/name.");
  const folder = str(args.path).replace(/^\/+|\/+$/g, "");
  if (folder.includes("..")) throw bad("The folder cannot contain '..'.");
  let ref = str(args.ref);
  if (!ref) ref = ((await remote.json(`${api}/repos/${repo}`, { headers: githubHeaders(k) })) as { default_branch?: string }).default_branch ?? "main";
  if (!/^[\w./-]{1,200}$/.test(ref)) throw bad("The branch or tag name is not valid.");
  const tree = (await remote.json(`${api}/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers: githubHeaders(k) })) as { tree?: { path?: string; type?: string; size?: number }[]; truncated?: boolean };
  const wanted = (tree.tree ?? []).filter((e) => e.type === "blob" && typeof e.path === "string" && (!folder || e.path === folder || e.path.startsWith(`${folder}/`)) && IAC_FILE.test(e.path) && !/(^|\/)(node_modules|\.terraform|\.github)\//.test(e.path) && !/package(-lock)?\.json$|tsconfig.*\.json$/.test(e.path));
  const files: { path: string; text: string }[] = [];
  let bytes = 0;
  const notes: string[] = [];
  for (const entry of wanted) {
    if (files.length >= MAX_FILES || bytes + (entry.size ?? 0) > MAX_REPO_BYTES || !remote.hasTime) {
      notes.push(`Stopped after ${files.length} files: choose a smaller folder to read the rest`);
      break;
    }
    const text = await remote.send(`${api}/repos/${repo}/contents/${entry.path!.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`, { headers: { ...githubHeaders(k), accept: "application/vnd.github.raw" } });
    bytes += text.length;
    files.push({ path: entry.path!, text });
  }
  if (tree.truncated) notes.push("GitHub listed only part of the repository; choose a folder");
  return { repository: repo, ref, path: folder, files, notes };
}

/* ---------- Directories: Microsoft Entra ID and Okta ---------- */

export interface DirectoryPerson {
  id: string;
  name: string;
  email: string;
  title: string;
  department: string;
}
export interface DirectoryGroup {
  id: string;
  name: string;
  description: string;
  members: string[];
}
const MAX_PEOPLE = 5000;
const MAX_GROUPS = 200;

async function entraToken(s: Kept, k: Kept, remote: Remote): Promise<string> {
  if (!/^[A-Za-z0-9.-]{3,100}$/.test(str(s.tenantId))) throw bad("The tenant ID is not valid.");
  const form = new URLSearchParams({ grant_type: "client_credentials", client_id: str(s.clientId), client_secret: str(k.clientSecret), scope: "https://graph.microsoft.com/.default" });
  const token = (await remote.json(`https://login.microsoftonline.com/${encodeURIComponent(str(s.tenantId))}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() })) as { access_token?: string };
  if (!token?.access_token) throw new DiscoverError(502, "credentials_refused", "Microsoft gave no access token. Check the client ID and secret.");
  return token.access_token;
}

async function graphAll(url: string, token: string, remote: Remote, cap: number): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let next: string | undefined = url;
  while (next && out.length < cap && remote.hasTime) {
    const page = (await remote.json(next, { headers: { authorization: `Bearer ${token}`, ConsistencyLevel: "eventual" } })) as { value?: Record<string, unknown>[]; "@odata.nextLink"?: string };
    out.push(...(page.value ?? []));
    next = page["@odata.nextLink"]?.startsWith("https://graph.microsoft.com/") ? page["@odata.nextLink"] : undefined;
  }
  return out.slice(0, cap);
}

export async function entraDirectory(s: Kept, k: Kept, remote: Remote, peopleOnly = false) {
  const token = await entraToken(s, k, remote);
  const users = await graphAll("https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName,jobTitle,department,accountEnabled&$top=999", token, remote, peopleOnly ? 1 : MAX_PEOPLE);
  const people: DirectoryPerson[] = users
    .filter((u) => u.accountEnabled !== false)
    .map((u) => ({ id: str(u.id), name: str(u.displayName), email: str(u.mail) || str(u.userPrincipalName), title: str(u.jobTitle), department: str(u.department) }))
    .filter((p) => p.name);
  if (peopleOnly) return { people, groups: [] as DirectoryGroup[] };
  const prefix = str(s.groupFilter).replace(/'/g, "''");
  const groupRows = await graphAll(`https://graph.microsoft.com/v1.0/groups?$select=id,displayName,description&$top=999${prefix ? `&$filter=${encodeURIComponent(`startswith(displayName,'${prefix}')`)}` : ""}`, token, remote, MAX_GROUPS);
  const groups: DirectoryGroup[] = [];
  for (const g of groupRows) {
    if (!remote.hasTime) break;
    const members = await graphAll(`https://graph.microsoft.com/v1.0/groups/${str(g.id)}/members?$select=id&$top=999`, token, remote, 1000);
    groups.push({ id: str(g.id), name: str(g.displayName), description: str(g.description), members: members.map((m) => str(m.id)).filter(Boolean) });
  }
  return { people, groups };
}

async function oktaAll(url: string, token: string, remote: Remote, cap: number, base: string): Promise<Record<string, unknown>[]> {
  // Okta pages with a Link header, which this helper cannot see, so pages are asked for by the last id.
  const out: Record<string, unknown>[] = [];
  let after = "";
  while (out.length < cap && remote.hasTime) {
    const page = (await remote.json(`${url}${url.includes("?") ? "&" : "?"}limit=200${after ? `&after=${encodeURIComponent(after)}` : ""}`, { headers: { authorization: `SSWS ${token}` } })) as Record<string, unknown>[];
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
    if (page.length < 200) break;
    after = str(page[page.length - 1].id);
  }
  void base;
  return out.slice(0, cap);
}

export async function oktaDirectory(s: Kept, k: Kept, remote: Remote, peopleOnly = false) {
  const base = httpsBase(s.url, "The Okta address");
  const token = str(k.token);
  const users = await oktaAll(`${base}/api/v1/users?filter=${encodeURIComponent('status eq "ACTIVE"')}`, token, remote, peopleOnly ? 1 : MAX_PEOPLE, base);
  const profile = (u: Record<string, unknown>) => (u.profile && typeof u.profile === "object" ? (u.profile as Record<string, unknown>) : {});
  const people: DirectoryPerson[] = users
    .map((u) => ({ id: str(u.id), name: [str(profile(u).firstName), str(profile(u).lastName)].filter(Boolean).join(" ") || str(profile(u).login), email: str(profile(u).email), title: str(profile(u).title), department: str(profile(u).department) }))
    .filter((p) => p.name);
  if (peopleOnly) return { people, groups: [] as DirectoryGroup[] };
  const prefix = str(s.groupFilter);
  const groupRows = await oktaAll(`${base}/api/v1/groups${prefix ? `?q=${encodeURIComponent(prefix)}` : ""}`, token, remote, MAX_GROUPS, base);
  const groups: DirectoryGroup[] = [];
  for (const g of groupRows) {
    if (!remote.hasTime) break;
    const members = await oktaAll(`${base}/api/v1/groups/${str(g.id)}/users`, token, remote, 1000, base);
    groups.push({ id: str(g.id), name: str(profile(g).name), description: str(profile(g).description), members: members.map((m) => str(m.id)).filter(Boolean) });
  }
  return { people, groups };
}

/* ---------- Notifications: Teams, Slack, email ---------- */

export interface Notice {
  title: string;
  text: string;
  link?: string;
  linkText?: string;
}

export async function sendTeams(k: Kept, notice: Notice, remote: Remote): Promise<void> {
  const url = httpsBase(k.webhookUrl ?? "", "The workflow webhook address");
  const card = {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      { type: "TextBlock", text: notice.title, weight: "Bolder", size: "Medium", wrap: true },
      { type: "TextBlock", text: notice.text, wrap: true },
    ],
    ...(notice.link ? { actions: [{ type: "Action.OpenUrl", title: notice.linkText ?? "Open", url: notice.link }] } : {}),
  };
  await remote.send(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }] }) });
}

export async function sendSlack(k: Kept, notice: Notice, remote: Remote): Promise<void> {
  const url = httpsBase(k.webhookUrl ?? "", "The incoming webhook address");
  const text = `*${notice.title}*\n${notice.text}${notice.link ? `\n<${notice.link}|${notice.linkText ?? "Open"}>` : ""}`;
  await remote.send(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
}

const EMAIL = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;

export async function sendEmail(s: Kept, k: Kept, notice: Notice, remote: Remote): Promise<void> {
  const to = str(s.to).split(/[\s,;]+/).filter(Boolean);
  if (!to.length || to.length > 20 || !to.every((a) => EMAIL.test(a))) throw bad("Recipients must be 1 to 20 email addresses, separated by commas.");
  const from = str(s.from);
  const fromAddress = from.match(/<([^>]+)>/)?.[1] ?? from;
  if (!EMAIL.test(fromAddress)) throw bad("The sender is not an email address.");
  const key = str(k.apiKey);
  const text = `${notice.text}${notice.link ? `\n\n${notice.linkText ?? "Open"}: ${notice.link}` : ""}`;
  const html = `<p><strong>${escapeHtml(notice.title)}</strong></p><p>${escapeHtml(notice.text).replace(/\n/g, "<br>")}</p>${notice.link ? `<p><a href="${escapeHtml(notice.link)}">${escapeHtml(notice.linkText ?? "Open")}</a></p>` : ""}`;
  const subject = notice.title.slice(0, 200);
  switch (s.service) {
    case "resend":
      await remote.json("https://api.resend.com/emails", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ from, to, subject, text, html }) });
      return;
    case "sendgrid": {
      const name = from.match(/^(.*?)\s*</)?.[1]?.trim();
      await remote.send("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ personalizations: [{ to: to.map((email) => ({ email })) }], from: { email: fromAddress, ...(name ? { name } : {}) }, subject, content: [{ type: "text/plain", value: text }, { type: "text/html", value: html }] }),
      });
      return;
    }
    case "mailgun": {
      const domain = str(s.domain);
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) throw bad("Give the Mailgun sending domain.");
      const form = new URLSearchParams({ from, to: to.join(","), subject, text, html });
      await remote.json(`https://api${s.region === "eu" ? ".eu" : ""}.mailgun.net/v3/${domain}/messages`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic("api", key) }, body: form.toString() });
      return;
    }
    case "postmark":
      await remote.json("https://api.postmarkapp.com/email", { method: "POST", headers: { "content-type": "application/json", "x-postmark-server-token": key }, body: JSON.stringify({ From: from, To: to.join(","), Subject: subject, TextBody: text, HtmlBody: html, MessageStream: "outbound" }) });
      return;
    default:
      throw bad("Choose the email service.");
  }
}

/* ---------- Work tracking: Jira and Azure DevOps ---------- */

export interface IssueInput {
  title: string;
  description: string;
  link?: string;
}

export async function jiraTest(s: Kept, k: Kept, remote: Remote): Promise<string> {
  const base = httpsBase(s.url, "The Jira address");
  const auth = { authorization: basic(str(s.email), str(k.token)) };
  const project = (await remote.json(`${base}/rest/api/3/project/${encodeURIComponent(str(s.project))}`, { headers: auth })) as { name?: string; key?: string };
  return `Connected: issues will be created in ${project.name ?? s.project} (${project.key ?? s.project}).`;
}

export async function jiraIssue(s: Kept, k: Kept, input: IssueInput, remote: Remote): Promise<{ key: string; url: string }> {
  const base = httpsBase(s.url, "The Jira address");
  const paragraph = (text: string) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
  const content = input.description.split(/\n{2,}/).slice(0, 50).map((p) => paragraph(p.slice(0, 3000)));
  if (input.link) content.push({ type: "paragraph", content: [{ type: "text", text: "Open in ArchONE", marks: [{ type: "link", attrs: { href: input.link } }] } as never] });
  const created = (await remote.json(`${base}/rest/api/3/issue`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: basic(str(s.email), str(k.token)) },
    body: JSON.stringify({ fields: { project: { key: str(s.project) }, summary: input.title.slice(0, 250), issuetype: { name: str(s.issueType) || "Task" }, description: { type: "doc", version: 1, content } } }),
  })) as { key?: string };
  if (!created.key) throw new DiscoverError(502, "source_failed", "Jira did not say which issue it created.");
  return { key: created.key, url: `${base}/browse/${created.key}` };
}

const adoBase = (s: Kept) => {
  if (!/^[\w.-]{1,100}$/.test(str(s.organization))) throw bad("The organization name is not valid.");
  return `https://dev.azure.com/${encodeURIComponent(str(s.organization))}`;
};

export async function adoTest(s: Kept, k: Kept, remote: Remote): Promise<string> {
  const project = (await remote.json(`${adoBase(s)}/_apis/projects/${encodeURIComponent(str(s.project))}?api-version=7.1`, { headers: { authorization: basic("", str(k.token)) } })) as { name?: string };
  return `Connected: work items will be created in ${project.name ?? s.project}.`;
}

export async function adoWorkItem(s: Kept, k: Kept, input: IssueInput, remote: Remote): Promise<{ key: string; url: string }> {
  const type = str(s.workItemType) || "Task";
  const html = `${input.description.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("")}${input.link ? `<p><a href="${escapeHtml(input.link)}">Open in ArchONE</a></p>` : ""}`;
  const created = (await remote.json(`${adoBase(s)}/${encodeURIComponent(str(s.project))}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=7.1`, {
    method: "POST",
    headers: { "content-type": "application/json-patch+json", authorization: basic("", str(k.token)) },
    body: JSON.stringify([
      { op: "add", path: "/fields/System.Title", value: input.title.slice(0, 250) },
      { op: "add", path: "/fields/System.Description", value: html },
    ]),
  })) as { id?: number; _links?: { html?: { href?: string } } };
  if (!created.id) throw new DiscoverError(502, "source_failed", "Azure DevOps did not say which work item it created.");
  return { key: `#${created.id}`, url: created._links?.html?.href ?? `${adoBase(s)}/${encodeURIComponent(str(s.project))}/_workitems/edit/${created.id}` };
}

/* ---------- Documentation: Confluence ---------- */

const confluenceAuth = (s: Kept, k: Kept) => ({ authorization: basic(str(s.email), str(k.token)) });

export async function confluenceTest(s: Kept, k: Kept, remote: Remote): Promise<string> {
  const base = httpsBase(s.url, "The Confluence address");
  const space = (await remote.json(`${base}/rest/api/space/${encodeURIComponent(str(s.space))}`, { headers: confluenceAuth(s, k) })) as { name?: string };
  return `Connected: pages will be added to the space ${space.name ?? s.space}.`;
}

/** A page with the diagram's picture and the table of what is on it. */
export async function confluencePublish(s: Kept, k: Kept, input: { title: string; summary: string; rows: string[][]; png?: string; link?: string }, remote: Remote): Promise<{ url: string }> {
  const base = httpsBase(s.url, "The Confluence address");
  const table = input.rows.length
    ? `<table><tbody><tr>${input.rows[0].map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>${input.rows
        .slice(1, 1000)
        .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`
    : "";
  const body = `<p>${escapeHtml(input.summary)}</p>${input.png ? '<p><ac:image ac:width="1200"><ri:attachment ri:filename="diagram.png" /></ac:image></p>' : ""}${table}${input.link ? `<p><a href="${escapeHtml(input.link)}">Open in ArchONE</a></p>` : ""}`;
  const page = (await remote.json(`${base}/rest/api/content`, {
    method: "POST",
    headers: { "content-type": "application/json", ...confluenceAuth(s, k) },
    body: JSON.stringify({ type: "page", title: input.title.slice(0, 250), space: { key: str(s.space) }, ...(str(s.parentId) ? { ancestors: [{ id: str(s.parentId) }] } : {}), body: { storage: { value: body, representation: "storage" } } }),
  })) as { id?: string; _links?: { base?: string; webui?: string } };
  if (!page.id) throw new DiscoverError(502, "source_failed", "Confluence did not say which page it created.");
  if (input.png) {
    const bytes = Uint8Array.from(atob(input.png), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "image/png" }), "diagram.png");
    await remote.json(`${base}/rest/api/content/${page.id}/child/attachment`, { method: "POST", headers: { "x-atlassian-token": "no-check", ...confluenceAuth(s, k) }, body: form });
  }
  return { url: page._links?.webui ? `${page._links.base ?? base}${page._links.webui}` : `${base}/pages/viewpage.action?pageId=${page.id}` };
}
