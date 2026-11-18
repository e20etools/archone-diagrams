import { Pause, Play, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { Badge, Button, CommitInput, Field, IconButton, Select, cx, formatDateTime } from "@/components/ui";
import { AI_FEATURE_LABEL, AI_WHO_LABEL, aiPolicyOf, setAiOverride, setAiPolicy } from "@/lib/aiPolicy";
import { useAiUsage } from "@/lib/cloud/aiUsage";
import type { AiUsageReport } from "@/lib/cloud/backend";
import { useSession } from "@/lib/cloud/session";
import { apply, useWorkspace } from "@/lib/store";
import type { AiPolicy } from "@/lib/types";

const n = (value: string, max: number) => Math.max(0, Math.min(max, Math.floor(Number(value) || 0)));
const fmt = (value: number) => value.toLocaleString();

/** A used-of-allowed bar, amber near the end and red at it. */
function Meter({ label, used, limit, unit = "requests", data }: { label: string; used: number; limit: number | null; unit?: string; data: string }) {
  if (limit === null) {
    return (
      <div data-ai-meter={data} data-ai-unlimited>
        <div className="flex items-baseline justify-between gap-2 text-[13px]">
          <span className="text-ink-soft">{label}</span>
          <span className="tabular-nums">
            <span className="font-medium">{fmt(used)}</span>
            <span className="text-ink-faint"> {unit}, no limit</span>
          </span>
        </div>
      </div>
    );
  }
  const share = limit > 0 ? Math.min(1, used / limit) : 1;
  return (
    <div data-ai-meter={data}>
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="text-ink-soft">{label}</span>
        <span className="tabular-nums">
          <span className="font-medium">{fmt(used)}</span>
          <span className="text-ink-faint">
            {" "}
            of {fmt(limit)} {unit}
          </span>
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line-soft" role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-label={label}>
        <div className={cx("h-full rounded-full", share >= 1 ? "bg-danger" : share >= 0.8 ? "bg-signal" : "bg-blueprint")} style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

function NumberField({ label, value, max, onSave, disabled, data }: { label: string; value: number; max: number; onSave: (v: number) => void; disabled: boolean; data: string }) {
  return (
    <Field label={label}>
      <CommitInput type="number" min={0} max={max} value={String(value)} disabled={disabled} onCommit={(v) => onSave(n(v, max))} aria-label={label} data-ai-limit={data} />
    </Field>
  );
}

/**
 * Fair use of the AI, in Settings. Owners set what is allowed and the limits; the AI server asks
 * the database before every request, so the limits hold whoever calls. Everyone sees their own use;
 * owners also see use by person and by day, and can give one person another limit or pause them.
 */
export function AiFairUseCard() {
  const ws = useWorkspace();
  const role = useSession((s) => s.role);
  const owner = role === "owner";
  const policy = aiPolicyOf(ws);
  const { report, loading, error, refresh } = useAiUsage();
  const inScenario = !!report?.scenario;
  const canSet = owner && !inScenario;
  const save = (change: (p: AiPolicy) => AiPolicy) => apply((w) => setAiPolicy(w, change));
  // Read the use again once a change of the limits has had time to reach the database.
  useEffect(() => {
    const timer = setTimeout(refresh, 1500);
    return () => clearTimeout(timer);
  }, [ws.aiPolicy, refresh]);

  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4" data-ai-fair-use>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Fair use and limits</h2>
          <p className="text-ink-soft mt-0.5 max-w-2xl">
            The server checks these before every AI request and counts it, so nobody can use more than their share. Limits run over the last hour and the last 24 hours; a request the AI model fails does not count.
          </p>
        </div>
        <IconButton label="Refresh the use" onClick={refresh} data-ai-refresh>
          <RefreshCw size={15} className={loading ? "animate-spin" : undefined} />
        </IconButton>
      </div>
      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}

      {report && <MyUse report={report} />}

      <div className="mt-5 border-t border-line-soft pt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">What is allowed</h3>
          {!owner && <span className="text-xs text-ink-faint">Owners set these.</span>}
          {owner && inScenario && <span className="text-xs text-ink-faint">A scenario follows the limits of the workspace it was made from; set them there.</span>}
        </div>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={policy.enabled} disabled={!canSet} onChange={(e) => save((p) => ({ ...p, enabled: e.target.checked }))} data-ai-enabled />
              AI is on for this workspace
            </label>
            <Field label="Who may use AI">
              <Select value={policy.who} disabled={!canSet} onChange={(e) => save((p) => ({ ...p, who: e.target.value as AiPolicy["who"] }))} aria-label="Who may use AI" data-ai-who>
                {(Object.keys(AI_WHO_LABEL) as AiPolicy["who"][]).map((w) => (
                  <option key={w} value={w}>
                    {AI_WHO_LABEL[w]}
                  </option>
                ))}
              </Select>
            </Field>
            <fieldset>
              <legend className="mb-1 text-[13px] font-medium text-ink-soft">What AI may do</legend>
              {(Object.keys(AI_FEATURE_LABEL) as (keyof AiPolicy["features"])[]).map((f) => (
                <label key={f} className="flex items-center gap-2 py-0.5 text-[13px]">
                  <input type="checkbox" checked={policy.features[f]} disabled={!canSet} onChange={(e) => save((p) => ({ ...p, features: { ...p.features, [f]: e.target.checked } }))} data-ai-feature={f} />
                  {AI_FEATURE_LABEL[f]}
                </label>
              ))}
            </fieldset>
          </div>
          <div className="space-y-3">
            <p className="text-[13px] font-medium text-ink-soft">Each person</p>
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="Requests an hour" value={policy.perUser.hour} max={1000} disabled={!canSet} data="hour" onSave={(v) => save((p) => ({ ...p, perUser: { ...p.perUser, hour: v } }))} />
              <NumberField label="Requests in 24 hours" value={policy.perUser.day} max={10000} disabled={!canSet} data="day" onSave={(v) => save((p) => ({ ...p, perUser: { ...p.perUser, day: v } }))} />
              <NumberField label="Tokens in 24 hours" value={policy.perUser.tokensDay} max={10_000_000} disabled={!canSet} data="tokensDay" onSave={(v) => save((p) => ({ ...p, perUser: { ...p.perUser, tokensDay: v } }))} />
            </div>
            <p className="text-[13px] font-medium text-ink-soft">The whole workspace, scenarios included</p>
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="Requests in 24 hours" value={policy.workspace.day} max={100000} disabled={!canSet} data="workspace-day" onSave={(v) => save((p) => ({ ...p, workspace: { ...p.workspace, day: v } }))} />
              <NumberField label="Tokens in 24 hours" value={policy.workspace.tokensDay} max={100_000_000} disabled={!canSet} data="workspace-tokensDay" onSave={(v) => save((p) => ({ ...p, workspace: { ...p.workspace, tokensDay: v } }))} />
            </div>
            <p className="text-xs text-ink-faint">A person's own use counts in every workspace they work in, so a scenario or another workspace does not start them afresh.</p>
            <label className="flex items-start gap-2 text-[13px]">
              <input type="checkbox" className="mt-0.5" checked={policy.ownersUnlimited} disabled={!canSet} onChange={(e) => save((p) => ({ ...p, ownersUnlimited: e.target.checked }))} data-ai-owners-unlimited />
              <span>
                No limits for owners
                <span className="block text-xs text-ink-faint">Owners are not stopped by the limits per person or the workspace's. Their use still counts, and the AI service's own daily allowance still applies.</span>
              </span>
            </label>
          </div>
        </div>
      </div>

      {owner && report?.people && <UseByPerson report={report} policy={policy} canSet={canSet} />}
      {!report && !loading && !error && <p className="mt-4 text-[13px] text-ink-soft">This database does not count AI use yet, so these limits are not applied.</p>}
    </section>
  );
}

function MyUse({ report }: { report: AiUsageReport }) {
  const { me, workspace } = report;
  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2" data-ai-my-use>
      <div className="space-y-2.5">
        <h3 className="text-sm font-semibold">
          Your use {me.limits.paused && <Badge tone="red">Paused by an owner</Badge>}
        </h3>
        {me.limits.unlimited && <p className="text-xs text-ink-faint">You are an owner, and owners have no limits here. Your use still counts.</p>}
        <Meter label="This hour" used={me.hour} limit={me.limits.unlimited ? null : me.limits.hour} data="me-hour" />
        <Meter label="Last 24 hours" used={me.day} limit={me.limits.unlimited ? null : me.limits.day} data="me-day" />
        <Meter label="Tokens, last 24 hours" used={me.tokensDay} limit={me.limits.unlimited ? null : me.limits.tokensDay} unit="tokens" data="me-tokens" />
      </div>
      <div className="space-y-2.5">
        <h3 className="text-sm font-semibold">The workspace</h3>
        <Meter label="Last 24 hours" used={workspace.day} limit={workspace.limits.day} data="ws-day" />
        <Meter label="Tokens, last 24 hours" used={workspace.tokensDay} limit={workspace.limits.tokensDay} unit="tokens" data="ws-tokens" />
      </div>
    </div>
  );
}

function UseByPerson({ report, policy, canSet }: { report: AiUsageReport; policy: AiPolicy; canSet: boolean }) {
  const people = report.people ?? [];
  const days = report.days ?? [];
  const peak = Math.max(1, ...days.map((d) => d.requests));
  return (
    <div className="mt-5 border-t border-line-soft pt-4" data-ai-by-person>
      <h3 className="text-sm font-semibold">Use by person</h3>
      <p className="text-xs text-ink-faint">Requests in the last 24 hours, 7 days and 30 days. Give one person another daily limit, or pause AI for them.</p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead className="border-b border-line text-xs text-ink-soft">
            <tr>
              <th className="py-1.5 font-medium">Person</th>
              <th className="py-1.5 text-right font-medium">24 hours</th>
              <th className="py-1.5 text-right font-medium">7 days</th>
              <th className="py-1.5 text-right font-medium">30 days</th>
              <th className="py-1.5 text-right font-medium">Tokens, 24 hours</th>
              <th className="py-1.5 pl-3 font-medium">Last used</th>
              <th className="py-1.5 pl-3 font-medium">Daily limit</th>
              <th className="py-1.5">
                <span className="sr-only">Pause</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const own = policy.overrides[p.userId] ?? {};
              // The limits as set here, so a change shows at once rather than after the next reading.
              const paused = own.blocked === true;
              const near = !(policy.ownersUnlimited && p.role === "owner") && p.day >= (own.day ?? policy.perUser.day) * 0.8;
              return (
                <tr key={p.userId} className="border-b border-line-soft last:border-b-0" data-ai-person={p.name}>
                  <td className="py-1.5">
                    <span className="font-medium">{p.name || "Unnamed"}</span> <span className="text-xs text-ink-faint">{p.role}</span>
                    {paused && (
                      <span className="ml-1.5">
                        <Badge tone="red">Paused</Badge>
                      </span>
                    )}
                  </td>
                  <td className={cx("py-1.5 text-right tabular-nums", near && "font-medium text-signal")}>{fmt(p.day)}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmt(p.week)}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmt(p.month)}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmt(p.tokensDay)}</td>
                  <td className="py-1.5 pl-3 text-ink-soft whitespace-nowrap">{p.lastUsed ? formatDateTime(p.lastUsed) : "Never"}</td>
                  <td className="py-1 pl-3">
                    {policy.ownersUnlimited && p.role === "owner" ? (
                      <span className="text-[13px] text-ink-faint" data-ai-person-unlimited={p.name}>
                        No limit
                      </span>
                    ) : (
                    <CommitInput
                      type="number"
                      min={0}
                      max={10000}
                      className="!h-7 !w-24"
                      disabled={!canSet}
                      placeholder={String(policy.perUser.day)}
                      value={own.day === undefined ? "" : String(own.day)}
                      aria-label={`Daily limit for ${p.name}`}
                      data-ai-person-limit={p.name}
                      onCommit={(v) => apply((w) => setAiOverride(w, p.userId, { ...own, day: v.trim() === "" ? undefined : n(v, 10000) }))}
                    />
                    )}
                  </td>
                  <td className="py-1 text-right">
                    {canSet && (
                      <IconButton
                        label={paused ? `Let ${p.name} use AI again` : `Pause AI for ${p.name}`}
                        data-ai-pause={p.name}
                        onClick={() => apply((w) => setAiOverride(w, p.userId, { ...own, blocked: !paused }))}
                      >
                        {paused ? <Play size={14} /> : <Pause size={14} />}
                      </IconButton>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {days.length > 0 && (
        <div className="mt-4" data-ai-days>
          <h3 className="text-sm font-semibold">The last 14 days</h3>
          <div className="mt-2 flex h-24 items-end gap-1" role="img" aria-label={`Requests by day: ${days.map((d) => `${d.day} ${d.requests}`).join(", ")}`}>
            {days.map((d) => (
              <div key={d.day} className="flex flex-1 flex-col items-center gap-1" title={`${d.day}: ${fmt(d.requests)} requests, ${fmt(d.tokens)} tokens`}>
                <div className="w-full rounded-t bg-blueprint/70" style={{ height: `${Math.max(d.requests ? 4 : 1, (d.requests / peak) * 80)}px` }} />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-ink-faint">
            <span>{days[0].day}</span>
            <span>{days[days.length - 1].day}</span>
          </div>
        </div>
      )}
      {!canSet && <p className="mt-2 text-xs text-ink-faint">Open the workspace this scenario was made from to change limits.</p>}
      <div className="mt-3">
        <Button size="sm" variant="ghost" onClick={() => apply((w) => setAiPolicy(w, (p) => ({ ...p, overrides: {} })))} disabled={!canSet || !Object.keys(policy.overrides).length} data-ai-clear-overrides>
          Clear every exception
        </Button>
      </div>
    </div>
  );
}
