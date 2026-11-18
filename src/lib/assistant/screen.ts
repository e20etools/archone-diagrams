import type { ExportFormat } from "./edits";

/**
 * What the assistant asks of the screen the person is on: the diagram editor exports with its own
 * Export window, presents, and opens its panels and windows. The editor answers each request;
 * without an editor on screen nobody answers, and the request fails after a while.
 */
export const SCREEN_REQUEST = "archone:assistant-screen";

export type ScreenAsk = { kind: "export"; format: ExportFormat } | { kind: "present" } | { kind: "open"; what: "share" | "export" | "approval" | "comments" | "files" | "settings" | "flows" | "processes" };

export interface ScreenRequest {
  diagramId: string;
  ask: ScreenAsk;
  /** The editor says what it did, or throws what went wrong. */
  answer: (result: { ok: true; text: string } | { ok: false; text: string }) => void;
}

export function askScreen(diagramId: string, ask: ScreenAsk, timeoutMs = 120_000): Promise<string> {
  return new Promise((done, failed) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      failed(new Error("Open the diagram to do this, then ask again."));
    }, timeoutMs);
    const answer: ScreenRequest["answer"] = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result.ok) done(result.text);
      else failed(new Error(result.text));
    };
    window.dispatchEvent(new CustomEvent<ScreenRequest>(SCREEN_REQUEST, { detail: { diagramId, ask, answer } }));
  });
}

/** Files were linked or unlinked: whatever lists them reads them again. */
export const FILES_CHANGED = "archone:files-changed";
