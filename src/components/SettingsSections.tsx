import { Activity, Check, Database, HardDrive, ImageUp, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { DEFAULT_APP_NAME, FONTS, FONT_IDS, THEMES, setPrefs, usePrefs, type Branding, type FontId, type Theme } from "@/lib/appearance";
import { auditAction, type AuditEntry } from "@/lib/cloud/audit";
import { cloudEnabled } from "@/lib/cloud/config";
import { listAudit, useSession } from "@/lib/cloud/session";
import { PACKS, runChecks } from "@/lib/checks/checks";
import { formatSize, useFileLibrary } from "@/lib/files";
import { nowIso } from "@/lib/model";
import { apply, useWorkspace } from "@/lib/store";
import { Badge, Button, Input, Select, cx } from "./ui";

/* ---------- appearance: each person's own ---------- */

/** A small picture of a theme: its menu, a card, and its accent. */
function ThemeSwatch({ theme }: { theme: Theme }) {
  const [base, surface, accent, second, nav] = theme.swatch;
  return (
    <svg viewBox="0 0 120 72" className="block w-full rounded-md" aria-hidden>
      <rect width="120" height="72" fill={base} />
      <rect width="26" height="72" fill={nav} />
      <rect x="6" y="10" width="14" height="3" rx="1.5" fill={accent} opacity="0.9" />
      <rect x="6" y="18" width="12" height="2" rx="1" fill="#ffffff" opacity="0.35" />
      <rect x="6" y="24" width="12" height="2" rx="1" fill="#ffffff" opacity="0.35" />
      <rect x="34" y="10" width="78" height="22" rx="4" fill={surface} />
      <rect x="40" y="16" width="30" height="3" rx="1.5" fill={theme.dark ? "#ffffff" : "#16233a"} opacity="0.7" />
      <rect x="40" y="23" width="44" height="2" rx="1" fill={theme.dark ? "#ffffff" : "#16233a"} opacity="0.3" />
      <rect x="34" y="38" width="36" height="24" rx="4" fill={surface} />
      <rect x="76" y="38" width="36" height="24" rx="4" fill={surface} />
      <path d="M52 50 L94 50" stroke={accent} strokeWidth="2" strokeDasharray="4 3" />
      <rect x="86" y="14" width="20" height="8" rx="3" fill={accent} />
      <circle cx="44" cy="50" r="3" fill={second} />
    </svg>
  );
}

export function AppearanceSection({ branding }: { branding: Branding | undefined }) {
  const prefs = usePrefs();
  const workspaceTheme = branding?.theme ?? "blueprint";
  const current = prefs.theme ?? workspaceTheme;
  return (
    <div className="space-y-5" data-settings-appearance>
      <div>
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-semibold">Theme</h3>
          <span className="text-xs text-ink-soft">
            Yours alone, kept in this browser.{" "}
            {prefs.theme ? (
              <button type="button" className="text-blueprint hover:underline" onClick={() => setPrefs({ theme: null })} data-theme-follow>
                Use the workspace's theme ({THEMES.find((t) => t.id === workspaceTheme)?.name ?? "Blueprint"})
              </button>
            ) : (
              "You follow the workspace's theme."
            )}
          </span>
        </div>
        <ul className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-5" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                role="radio"
                aria-checked={current === t.id}
                data-theme-pick={t.id}
                onClick={() => setPrefs({ theme: t.id })}
                className={cx("theme-card group block w-full rounded-lg border p-2 text-left transition", current === t.id ? "border-blueprint ring-2 ring-blueprint/30" : "border-line hover:border-ink-faint")}
              >
                <ThemeSwatch theme={t} />
                <span className="mt-2 flex items-center gap-1.5 text-[13px] font-medium">
                  {t.name}
                  {current === t.id && <Check size={13} className="text-blueprint" />}
                  {t.dark && <span className="ml-auto text-[11px] font-normal text-ink-faint">Dark</span>}
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-ink-soft">{t.idea}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="mb-1 block text-xs text-ink-soft">Font</span>
          <Select value={prefs.font ?? ""} onChange={(e) => setPrefs({ font: e.target.value || null })} aria-label="Font" data-pref-font>
            <option value="">The theme's font</option>
            {FONT_IDS.map((f) => (
              <option key={f} value={f}>
                {FONTS[f].name}
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-soft">Density</span>
          <Select value={prefs.density} onChange={(e) => setPrefs({ density: e.target.value as "comfortable" | "compact" })} aria-label="Density" data-pref-density>
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact: more on the screen</option>
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-soft">Corners</span>
          <Select value={prefs.radius} onChange={(e) => setPrefs({ radius: e.target.value as "sharp" | "soft" | "round" })} aria-label="Corners" data-pref-radius>
            <option value="sharp">Sharp</option>
            <option value="soft">Soft</option>
            <option value="round">Round</option>
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-soft">Movement</span>
          <Select value={prefs.motion} onChange={(e) => setPrefs({ motion: e.target.value as "full" | "calm" | "off" })} aria-label="Movement" data-pref-motion>
            <option value="full">Full: the background moves</option>
            <option value="calm">Calm: slower</option>
            <option value="off">Still</option>
          </Select>
        </label>
      </div>
      <p className="text-xs text-ink-faint">If your computer asks for less motion, the background stays still whatever is chosen here.</p>
    </div>
  );
}

/* ---------- branding: the workspace's, set by an owner ---------- */

const ACCENTS = ["#2447d6", "#0f766e", "#7c3aed", "#db2777", "#ea580c", "#16a34a", "#0891b2", "#b91c1c"];
const LOGO_LIMIT = 200 * 1024;

export function BrandingSection({ canChange }: { canChange: boolean }) {
  const ws = useWorkspace();
  const current = ws.branding?.workspace;
  const [appName, setAppName] = useState(current?.appName ?? "");
  const [accent, setAccent] = useState(current?.accent ?? "");
  const [theme, setTheme] = useState(current?.theme ?? "blueprint");
  const [font, setFont] = useState(current?.font ?? "");
  const [logo, setLogo] = useState(current?.logo ?? "");
  const [problem, setProblem] = useState("");
  const [saved, setSaved] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setAppName(current?.appName ?? "");
    setAccent(current?.accent ?? "");
    setTheme(current?.theme ?? "blueprint");
    setFont(current?.font ?? "");
    setLogo(current?.logo ?? "");
  }, [current?.updatedAt]);
  const readLogo = (f: File | undefined) => {
    setProblem("");
    if (!f) return;
    if (!/^image\/(png|jpeg|webp|svg\+xml|gif)$/.test(f.type)) return setProblem("Choose a PNG, JPEG, WebP, SVG or GIF image.");
    if (f.size > LOGO_LIMIT) return setProblem(`The logo can be up to ${formatSize(LOGO_LIMIT)}. A small square image works best.`);
    const reader = new FileReader();
    reader.onload = () => setLogo(String(reader.result));
    reader.readAsDataURL(f);
  };
  const save = () => {
    const branding: Branding = { id: "workspace", appName: appName.trim().slice(0, 40), logo, accent, theme, font, updatedAt: nowIso() };
    apply((w) => ({ ...w, branding: { workspace: branding }, updatedAt: nowIso() }));
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };
  return (
    <div className="space-y-4" data-settings-branding>
      {!canChange && <p className="text-[13px] text-ink-soft">Only an owner can change the workspace's branding.</p>}
      <fieldset disabled={!canChange} className="grid gap-4 lg:grid-cols-[1fr_260px]">
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-ink-soft">Name in the menu and the browser tab</span>
            <Input value={appName} onChange={(e) => setAppName(e.target.value)} maxLength={40} placeholder={DEFAULT_APP_NAME} aria-label="App name" data-brand-input />
          </label>
          <div>
            <span className="mb-1 block text-xs text-ink-soft">Logo</span>
            <div className="flex items-center gap-2">
              <span className="grid size-12 place-items-center rounded-md border border-line bg-paper">{logo ? <img src={logo} alt="The logo" className="size-10 object-contain" /> : <ImageUp size={18} className="text-ink-faint" />}</span>
              <Button size="sm" icon={<ImageUp size={13} />} onClick={() => file.current?.click()}>
                {logo ? "Change" : "Upload a logo"}
              </Button>
              {logo && (
                <Button size="sm" icon={<Trash2 size={13} />} onClick={() => setLogo("")}>
                  Remove
                </Button>
              )}
              <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" className="sr-only" aria-label="Logo image" data-brand-logo-input onChange={(e) => readLogo(e.target.files?.[0])} />
            </div>
          </div>
          <div>
            <span className="mb-1 block text-xs text-ink-soft">Accent colour: buttons, links and what is selected</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <button type="button" onClick={() => setAccent("")} aria-pressed={accent === ""} className={cx("h-7 rounded-full border px-2.5 text-xs", accent === "" ? "border-blueprint text-blueprint" : "border-line")}>
                The theme's
              </button>
              {ACCENTS.map((c) => (
                <button key={c} type="button" aria-label={`Accent ${c}`} aria-pressed={accent === c} onClick={() => setAccent(c)} className={cx("size-7 rounded-full border-2", accent === c ? "border-ink" : "border-transparent")} style={{ background: c }} data-brand-accent={c} />
              ))}
              <input type="color" value={accent || "#2447d6"} onChange={(e) => setAccent(e.target.value)} aria-label="Any colour" className="h-7 w-10 cursor-pointer rounded border border-line bg-transparent" />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">Theme for members who have not chosen one</span>
              <Select value={theme} onChange={(e) => setTheme(e.target.value)} aria-label="Workspace theme" data-brand-theme>
                {THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">Font</span>
              <Select value={font} onChange={(e) => setFont(e.target.value as FontId | "")} aria-label="Workspace font">
                <option value="">The theme's font</option>
                {FONT_IDS.map((f) => (
                  <option key={f} value={f}>
                    {FONTS[f].name}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        </div>
        <div>
          <span className="mb-1 block text-xs text-ink-soft">How the menu will look</span>
          <div className="rounded-lg bg-nav p-3 text-nav-ink">
            <div className="flex items-center gap-2">
              {logo ? <img src={logo} alt="" className="size-7 rounded object-contain" /> : <span className="grid size-7 place-items-center rounded bg-nav-ink/10 text-xs">A</span>}
              <span className="min-w-0">
                <span className="block truncate font-semibold">{appName.trim() || DEFAULT_APP_NAME}</span>
                <span className="block text-xs opacity-60">Diagrams</span>
              </span>
            </div>
            <span className="mt-3 block h-8 rounded-md px-2.5 text-sm leading-8" style={{ background: accent || "var(--color-blueprint)", color: "#fff" }}>
              Selected
            </span>
          </div>
        </div>
      </fieldset>
      {problem && (
        <p role="alert" className="text-[13px] text-danger">
          {problem}
        </p>
      )}
      {canChange && (
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={save} data-brand-save>
            Save the branding
          </Button>
          <Button
            icon={<RotateCcw size={13} />}
            onClick={() => {
              setAppName("");
              setAccent("");
              setTheme("blueprint");
              setFont("");
              setLogo("");
            }}
          >
            Back to the defaults
          </Button>
          {saved && (
            <span role="status" className="text-[13px] text-ok">
              Saved{cloudEnabled ? " for every member" : ""}.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- what each role may do ---------- */

const CAPABILITIES: { what: string; owner: boolean | string; editor: boolean | string; commenter: boolean | string; viewer: boolean | string }[] = [
  { what: "See the model, diagrams, reports and the files of diagrams they can see", owner: true, editor: true, commenter: true, viewer: true },
  { what: "Comment on diagrams and objects", owner: true, editor: true, commenter: true, viewer: false },
  { what: "Change the model and diagrams", owner: true, editor: "Within the kinds of diagram and domains given", commenter: false, viewer: false },
  { what: "Upload files and link them to diagrams", owner: true, editor: "To diagrams they can edit", commenter: false, viewer: false },
  { what: "Make reports and templates", owner: true, editor: true, commenter: false, viewer: false },
  { what: "Accept AI drafts into the model", owner: true, editor: true, commenter: false, viewer: false },
  { what: "Save versions and submit for review", owner: true, editor: true, commenter: false, viewer: false },
  { what: "Approve a review", owner: "When named as reviewer", editor: "When named as reviewer", commenter: "When named as reviewer", viewer: "When named as reviewer" },
  { what: "Invite people, change roles and limits per kind of diagram", owner: true, editor: false, commenter: false, viewer: false },
  { what: "Set the rules, the wizard's questions and the branding", owner: true, editor: false, commenter: false, viewer: false },
  { what: "API keys, webhooks, live links and the trust page", owner: true, editor: "Live links", commenter: false, viewer: false },
  { what: "Read and verify the audit log", owner: true, editor: false, commenter: false, viewer: false },
  { what: "Delete the workspace", owner: true, editor: false, commenter: false, viewer: false },
];

export function PermissionsMatrix() {
  const mark = (v: boolean | string) => (v === true ? <Check size={15} className="mx-auto text-ok" aria-label="Yes" /> : v === false ? <span className="block text-center text-ink-faint" aria-label="No">–</span> : <span className="block text-center text-xs text-ink-soft">{v}</span>);
  return (
    <div className="overflow-x-auto" data-permissions-matrix>
      <table className="w-full text-[13px]">
        <thead className="text-left text-ink-soft">
          <tr className="border-b border-line">
            <th className="py-2 pr-3 font-medium">What</th>
            {["Owner", "Editor", "Commenter", "Viewer"].map((r) => (
              <th key={r} className="w-28 py-2 text-center font-medium">
                {r}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CAPABILITIES.map((c) => (
            <tr key={c.what} className="border-b border-line-soft">
              <td className="py-1.5 pr-3">{c.what}</td>
              <td>{mark(c.owner)}</td>
              <td>{mark(c.editor)}</td>
              <td>{mark(c.commenter)}</td>
              <td>{mark(c.viewer)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-ink-faint">
        Under each member, an owner can lower their role for each kind of diagram (Applications, Data, Infrastructure, Business, Custom) down to No access, and limit an editor to some domains. The database enforces every rule here, not only the screen.
      </p>
    </div>
  );
}

/* ---------- monitoring ---------- */

export function MonitoringSection() {
  const ws = useWorkspace();
  const sync = useSession((s) => s.sync);
  const live = useSession((s) => s.live);
  const peers = useSession((s) => s.peers);
  const role = useSession((s) => s.role);
  const library = useFileLibrary();
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [activity, setActivity] = useState<AuditEntry[] | null>(null);
  const findings = useMemo(
    () =>
      runChecks(
        ws,
        null,
        PACKS.map((p) => p.id),
      ),
    [ws],
  );
  useEffect(() => {
    void navigator.storage?.estimate?.().then((e) => setStorage({ usage: e.usage ?? 0, quota: e.quota ?? 0 }));
    if (cloudEnabled && role === "owner") void listAudit({ limit: 8 }).then((p) => setActivity(p.entries), () => setActivity([]));
  }, [role]);
  const files = library.files ?? [];
  const stats: { label: string; value: string | number }[] = [
    { label: "Objects", value: Object.keys(ws.objects).length },
    { label: "Relationships", value: Object.keys(ws.relationships).length },
    { label: "Diagrams", value: Object.keys(ws.diagrams).length },
    { label: "Files", value: `${files.length} · ${formatSize(files.reduce((n, f) => n + f.size, 0))}` },
    { label: "Reports of your own", value: Object.keys(ws.reports ?? {}).length },
    { label: "Decisions", value: Object.keys(ws.adrs).length },
    { label: "AI drafts waiting", value: Object.values(ws.proposals).filter((p) => p.status === "pending").length },
    { label: "Rules of your own", value: Object.keys(ws.rules).length },
  ];
  const bySeverity = (s: string) => findings.filter((f) => f.severity === s).length;
  return (
    <div className="space-y-4" data-settings-monitoring>
      <div className="grid gap-2 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-md border border-line px-3 py-2">
            <div className="text-lg font-semibold tabular-nums">{s.value}</div>
            <div className="text-xs text-ink-soft">{s.label}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-md border border-line px-3 py-2.5">
          <h4 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Activity size={14} className="text-blueprint" /> Saving and connection
          </h4>
          <p className="mt-1 text-[13px]" data-monitor-sync>
            {cloudEnabled ? (
              <>
                <Badge tone={sync.kind === "saved" ? "green" : sync.kind === "error" || sync.kind === "offline" ? "red" : "amber"}>{sync.kind === "saved" ? "All saved" : sync.kind}</Badge> <span className="ml-1 text-ink-soft">{live ? `Live, ${peers.length} other ${peers.length === 1 ? "tab" : "tabs"} here now` : "Not live"}</span>
              </>
            ) : (
              <>
                <Badge tone="green">In this browser</Badge> <span className="ml-1 text-ink-soft">Saved as you work.</span>
              </>
            )}
          </p>
        </div>
        <div className="rounded-md border border-line px-3 py-2.5">
          <h4 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <ShieldCheck size={14} className="text-blueprint" /> Findings of the checks
          </h4>
          <p className="mt-1 flex gap-1.5 text-[13px]" data-monitor-findings={findings.length}>
            <Badge tone="red">{bySeverity("high")} high</Badge>
            <Badge tone="amber">{bySeverity("medium")} medium</Badge>
            <Badge tone="neutral">{bySeverity("low")} low</Badge>
            <Link to="/checks" className="ml-auto text-xs text-blueprint hover:underline">
              Open the checks
            </Link>
          </p>
        </div>
        <div className="rounded-md border border-line px-3 py-2.5">
          <h4 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <HardDrive size={14} className="text-blueprint" /> Storage in this browser
          </h4>
          <p className="mt-1 text-[13px] text-ink-soft">{storage ? `${formatSize(storage.usage)} of ${formatSize(storage.quota)} used` : "Not reported by this browser."}</p>
        </div>
      </div>
      {cloudEnabled && (
        <div className="rounded-md border border-line px-3 py-2.5">
          <h4 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Database size={14} className="text-blueprint" /> Latest activity
            {role === "owner" && (
              <Link to="/audit" className="ml-auto text-xs font-normal text-blueprint hover:underline">
                The full audit log
              </Link>
            )}
          </h4>
          {role !== "owner" ? (
            <p className="mt-1 text-[13px] text-ink-soft">Owners see who changed what, and can verify that the log has not been altered.</p>
          ) : activity === null ? (
            <p className="mt-1 text-[13px] text-ink-soft">Reading the log…</p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-[13px]" data-monitor-activity={activity.length}>
              {activity.map((e) => (
                <li key={e.id} className="flex gap-2">
                  <span className="w-36 shrink-0 text-xs text-ink-faint">{new Date(e.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{e.actorName}</span> {auditAction(e)} <span className="text-ink-soft">{e.entityName}</span>
                  </span>
                </li>
              ))}
              {!activity.length && <li className="text-ink-soft">Nothing recorded yet.</li>}
            </ul>
          )}
        </div>
      )}
      <p className="text-xs text-ink-faint">Version built {__BUILD_TIME__}.</p>
    </div>
  );
}
