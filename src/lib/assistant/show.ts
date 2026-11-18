/** The assistant asks the canvas to bring the boxes it changed into view, clear of its panel, and to mark them for a moment. */
export const SHOW_CHANGES = "archone:assistant-changed";

export interface ShowChanges {
  diagramId: string;
  ids: string[];
}

export function showChanges(diagramId: string, ids: string[]) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ShowChanges>(SHOW_CHANGES, { detail: { diagramId, ids } }));
}
