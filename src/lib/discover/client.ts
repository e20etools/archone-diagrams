import { authToken } from "../ai/client";
import type { Inventory } from "../inventory/model";
import type { DiscoverStatus } from "./http";

/** The browser's side of live discovery: asks this app's own server, which asks the source. */

const NONE: DiscoverStatus = { sources: [], signIn: true };

export async function discoveryStatus(): Promise<DiscoverStatus> {
  try {
    const response = await fetch("/api/discover");
    // A host without the function serves the page itself or a 404; both mean "no discovery here".
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("json")) return NONE;
    const data = (await response.json()) as Partial<DiscoverStatus>;
    return { sources: Array.isArray(data.sources) ? data.sources : [], signIn: data.signIn !== false };
  } catch {
    return NONE;
  }
}

export async function discover(source: string, workspaceId: string): Promise<{ inventory: Inventory; label: string }> {
  const session = await authToken();
  let response: Response;
  try {
    response = await fetch("/api/discover", {
      method: "POST",
      headers: { "content-type": "application/json", ...(session ? { authorization: `Bearer ${session}` } : {}) },
      body: JSON.stringify({ source, workspaceId }),
    });
  } catch {
    throw new Error("The server could not be reached. Check your connection and try again.");
  }
  const data = (await response.json().catch(() => null)) as { inventory?: Inventory; label?: string; message?: string } | null;
  if (!response.ok || !data) throw new Error(typeof data?.message === "string" ? data.message : `Discovery failed with status ${response.status}.`);
  const inventory = data.inventory;
  if (!inventory || !Array.isArray(inventory.items) || !Array.isArray(inventory.links)) throw new Error("The server's answer could not be read.");
  return { inventory: { ...inventory, skipped: Array.isArray(inventory.skipped) ? inventory.skipped : [] }, label: typeof data.label === "string" ? data.label : source };
}
