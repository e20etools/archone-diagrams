import { authToken } from "../ai/client";
import { APM_DATASETS, type ApmData } from "./http";

/** The browser's side of the APM import: asks this app's own server, which asks APM. */

export interface ApmStatus {
  /** The server has an APM address. */
  configured: boolean;
  host: string | null;
  /** The server keeps a feed token, so none has to be pasted. */
  hasToken: boolean;
}
const NONE: ApmStatus = { configured: false, host: null, hasToken: false };

export async function apmStatus(): Promise<ApmStatus> {
  try {
    const response = await fetch("/api/apm");
    // A host without the function serves the page itself or a 404; both mean "no APM here".
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("json")) return NONE;
    const data = (await response.json()) as Partial<ApmStatus>;
    return { configured: data.configured === true, host: typeof data.host === "string" ? data.host : null, hasToken: data.hasToken === true };
  } catch {
    return NONE;
  }
}

export async function fetchApm(token: string): Promise<ApmData> {
  const session = await authToken();
  let response: Response;
  try {
    response = await fetch("/api/apm", { method: "POST", headers: { "content-type": "application/json", ...(session ? { authorization: `Bearer ${session}` } : {}) }, body: JSON.stringify(token.trim() ? { token: token.trim() } : {}) });
  } catch {
    throw new Error("The server could not be reached. Check your connection and try again.");
  }
  const data = (await response.json().catch(() => null)) as (Partial<ApmData> & { message?: string }) | null;
  if (!response.ok || !data) throw new Error(typeof data?.message === "string" ? data.message : `The import failed with status ${response.status}.`);
  if (typeof data.host !== "string" || !APM_DATASETS.every((d) => Array.isArray(data[d]))) throw new Error("The server's answer could not be read.");
  return data as ApmData;
}
