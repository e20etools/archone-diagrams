import { useEffect } from "react";
import { create } from "zustand";
import { cloudEnabled } from "../cloud/config";
import { getBackend, useSession } from "../cloud/session";
import { integrationOf, type IntegrationId, type IntegrationInfo, type IntegrationUse } from "./catalog";

/** The workspace's integrations, loaded once and shared by every page that offers one. */
interface IntegrationsState {
  workspaceId: string | null;
  list: IntegrationInfo[];
  loaded: boolean;
}
const useStore = create<IntegrationsState>(() => ({ workspaceId: null, list: [], loaded: false }));

export async function refreshIntegrations(): Promise<IntegrationInfo[]> {
  const workspaceId = useSession.getState().workspaceId;
  if (!cloudEnabled || !workspaceId) {
    useStore.setState({ workspaceId: null, list: [], loaded: true });
    return [];
  }
  try {
    const list = await (await getBackend()).listIntegrations(workspaceId);
    if (useSession.getState().workspaceId === workspaceId) useStore.setState({ workspaceId, list, loaded: true });
    return list;
  } catch {
    useStore.setState({ workspaceId, list: [], loaded: true });
    return [];
  }
}

/** The integrations of the open workspace; loads them the first time they are asked for. */
export function useIntegrations(): { list: IntegrationInfo[]; loaded: boolean } {
  const workspaceId = useSession((s) => s.workspaceId);
  const state = useStore();
  useEffect(() => {
    if (state.workspaceId !== workspaceId || !state.loaded) void refreshIntegrations();
  }, [workspaceId, state.workspaceId, state.loaded]);
  return state.workspaceId === workspaceId ? { list: state.list, loaded: state.loaded } : { list: [], loaded: false };
}

/** Whether an integration is on and has what it needs to connect. */
export const isConnected = (info: IntegrationInfo | undefined): info is IntegrationInfo => {
  if (!info?.enabled) return false;
  const def = integrationOf(info.provider);
  return !!def && def.fields.filter((f) => f.secret && f.required).every((f) => info.secretFields.includes(f.key));
};

/** The connected integrations used for one thing, in the catalog's order. */
export function useConnected(use: IntegrationUse): IntegrationInfo[] {
  const { list } = useIntegrations();
  return list.filter((i) => isConnected(i) && integrationOf(i.provider)?.use === use);
}

export async function callIntegration<T = Record<string, unknown>>(provider: IntegrationId | null, action: string, args: Record<string, unknown> = {}): Promise<T> {
  const workspaceId = useSession.getState().workspaceId;
  if (!workspaceId) throw new Error("Open a workspace kept in the cloud to use integrations.");
  try {
    return await (await getBackend()).useIntegration<T>(workspaceId, provider, action, args);
  } finally {
    // A test or a use records how it went; show it.
    if (action !== "notify" && action !== "models") void refreshIntegrations();
  }
}

/**
 * Tells the connected channels (Teams, Slack, email) about something that happened. It never
 * holds up the work it reports, and a channel that fails says so in Settings → Integrations.
 */
export function notifyChannels(event: "review.submitted" | "review.decided" | "diagram.shared", args: Record<string, unknown>): void {
  void (async () => {
    const state = useStore.getState();
    const list = state.loaded && state.workspaceId === useSession.getState().workspaceId ? state.list : await refreshIntegrations();
    if (!list.some((i) => isConnected(i) && integrationOf(i.provider)?.use === "notify")) return;
    await callIntegration(null, "notify", { event, appUrl: window.location.origin, ...args });
  })().catch(() => undefined);
}
