import type { ModelLink } from "./types";

/**
 * Links from the model to the real thing: a repository, a runbook, a dashboard, a ticket.
 * Only web addresses are kept. Anything else a browser would run or open locally
 * (javascript:, data:, file:) is refused, because a link is clicked by whoever reads the model.
 */

export const MAX_LINKS = 20;
const MAX_LABEL = 80;
const MAX_URL = 2000;

/** The address as it will be stored, or null when it is not a web address. A bare "github.com/x" gets https. */
export function safeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > MAX_URL || /\s/.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname || !(url.hostname.includes(".") || url.hostname === "localhost")) return null;
    // An address with a password in it would put that password in front of every reader.
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Where a link goes, short enough to show when it has no label. */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export const linkLabel = (link: ModelLink) => link.label.trim() || linkHost(link.url);

/** Drops what is not a web address, trims labels, removes repeats and keeps at most MAX_LINKS. */
export function cleanLinks(links: ModelLink[]): ModelLink[] {
  const seen = new Set<string>();
  const kept: ModelLink[] = [];
  for (const link of links) {
    const url = safeUrl(link.url ?? "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    kept.push({ label: (link.label ?? "").trim().slice(0, MAX_LABEL), url });
    if (kept.length === MAX_LINKS) break;
  }
  return kept;
}
