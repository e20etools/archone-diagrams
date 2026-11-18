import { clearTextOf, type Finding } from "./checks/checks";
import { protocolByName } from "./library/protocols";
import { protocolsOf } from "./model";
import type { ModelObject, Relationship } from "./types";

/**
 * What the Security view of a diagram reads from the model: whether each connection is protected
 * on the way, how far each zone is trusted, what the checks find on each box and how its data is
 * classified. Only what the model records: a connection whose protocol is not recorded cannot be
 * called encrypted or not.
 */

export type Protection = "encrypted" | "plain" | "unknown";

/** Protocols that are encrypted whatever the catalogue says, by their usual short names. */
const SECURE_NAME = /^(https|tls|ssl|ssh|sftp|ftps|scp|wss|ldaps|imaps|pop3s|smtps|ipsec|ikev2|wireguard|openvpn|grpcs|mtls|oidc|saml|kerberos|rdp over tls|amqps|mqtts|rediss)$/i;

export function protectionOf(r: Relationship): Protection {
  if (r.encrypted === "no") return "plain";
  if (r.encrypted === "yes") return "encrypted";
  if (clearTextOf(r).length) return "plain";
  const protocols = protocolsOf(r);
  if (!protocols.length) return "unknown";
  const secure = protocols.every((p) => protocolByName(p.name)?.secure === true || SECURE_NAME.test(p.name.trim()));
  return secure ? "encrypted" : "unknown";
}

export const PROTECTION_INFO: Record<Protection, { label: string; hint: string; color: string; dash?: string; width: number }> = {
  encrypted: { label: "Encrypted", hint: "Its protocol encrypts, or it is recorded as encrypted", color: "#3e63dd", width: 2.25 },
  plain: { label: "Not encrypted", hint: "Its protocol sends in the clear, or it is recorded as not encrypted", color: "#ea580c", dash: "7 5", width: 2.75 },
  unknown: { label: "Not recorded", hint: "No protocol or encryption is recorded, so it cannot be checked", color: "#94a3b8", dash: "2 5", width: 2 },
};

export type Trust = "untrusted" | "perimeter" | "internal" | "restricted";

/** How far a zone is trusted, from what it is called. Null when the name does not say. */
export function trustOfZone(name: string): Trust | null {
  const n = name.toLowerCase();
  if (/\b(internet|public|untrusted|external|guest|wan)\b/.test(n)) return "untrusted";
  if (/\b(dmz|perimeter|edge|demilitari[sz]ed)\b/.test(n)) return "perimeter";
  if (/\b(restricted|pci|cde|secret|confidential|sensitive|vault|data zone|database|db)\b/.test(n)) return "restricted";
  if (/\b(internal|private|corporate|intranet|lan|trusted|management|office|core)\b/.test(n)) return "internal";
  return null;
}

export const TRUST_INFO: Record<Trust, { label: string; color: string }> = {
  untrusted: { label: "Untrusted", color: "#ea580c" },
  perimeter: { label: "Perimeter", color: "#b7791f" },
  internal: { label: "Internal", color: "#3e63dd" },
  restricted: { label: "Restricted", color: "#1a36ab" },
};

export interface BoxFindings {
  high: number;
  medium: number;
  low: number;
}

/** The checks' findings counted for each box they name. */
export function findingsByObject(findings: Finding[]): Record<string, BoxFindings> {
  const out: Record<string, BoxFindings> = {};
  for (const f of findings) {
    for (const id of new Set(f.objectIds)) {
      const box = (out[id] ??= { high: 0, medium: 0, low: 0 });
      box[f.severity]++;
    }
  }
  return out;
}

/** How a box's data is classified, when it says so: its classification, or that it holds personal data. */
export function classificationOf(o: ModelObject): string | null {
  const fields = Object.fromEntries(Object.entries(o.fields ?? {}).map(([k, v]) => [k.trim().toLowerCase(), String(v).trim()]));
  const level = fields["data classification"] ?? fields["classification"] ?? "";
  if (/^(confidential|restricted|secret|top secret|sensitive)$/i.test(level)) return level.replace(/^./, (c) => c.toUpperCase());
  if (/^(yes|true)$/i.test(fields["personal data"] ?? "")) return "Personal data";
  if (o.tags.includes("pci")) return "Card data";
  return null;
}
