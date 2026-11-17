import { nowIso } from "./model";
import type { AiPolicy, Workspace } from "./types";

/**
 * Fair use of the AI. The owners set the limits here; the database applies them to every request
 * the AI server makes for a person (see supabase/migrations/*_ai_fair_use.sql). The defaults below
 * are the same as the database's, so a workspace that never set anything shows what is in force.
 */

export const DEFAULT_AI_POLICY: Omit<AiPolicy, "updatedAt"> = {
  id: "workspace",
  enabled: true,
  who: "members",
  features: { text: true, image: true, ask: true },
  perUser: { hour: 10, day: 40, tokensDay: 40000 },
  workspace: { day: 300, tokensDay: 150000 },
  overrides: {},
};

export const AI_WHO_LABEL: Record<AiPolicy["who"], string> = {
  members: "Every member",
  editors: "Owners and editors",
  owners: "Owners only",
};

export const AI_FEATURE_LABEL: Record<keyof AiPolicy["features"], string> = {
  text: "Drafts from text and voice",
  image: "Drafts from a picture",
  ask: "Answers on the Ask page",
};

/** The limits in force for a workspace: its own, or the defaults. */
export function aiPolicyOf(ws: Workspace): AiPolicy {
  const own = ws.aiPolicy?.workspace;
  return own ? { ...DEFAULT_AI_POLICY, ...own, features: { ...DEFAULT_AI_POLICY.features, ...own.features }, overrides: own.overrides ?? {} } : { ...DEFAULT_AI_POLICY, updatedAt: "" };
}

/** Saves the workspace's limits. */
export function setAiPolicy(ws: Workspace, change: (policy: AiPolicy) => AiPolicy): Workspace {
  const next = { ...change(aiPolicyOf(ws)), id: "workspace" as const, updatedAt: nowIso() };
  return { ...ws, aiPolicy: { workspace: next }, updatedAt: nowIso() };
}

/** One person's exception: another limit per day or hour, or paused. Clearing every field removes it. */
export function setAiOverride(ws: Workspace, userId: string, override: AiPolicy["overrides"][string] | null): Workspace {
  return setAiPolicy(ws, (policy) => {
    const overrides = { ...policy.overrides };
    const clean = override ? Object.fromEntries(Object.entries(override).filter(([, v]) => v !== undefined && v !== false)) : {};
    if (Object.keys(clean).length) overrides[userId] = clean;
    else delete overrides[userId];
    return { ...policy, overrides };
  });
}
