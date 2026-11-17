import { componentsIn } from "./library";
import type { ModelObject, Relationship } from "./types";

/**
 * A colour for every kind of network connection in the library, so a line that runs over MPLS
 * and one that runs over the Internet look different in a diagram, and so does a box standing
 * for that network. The family sets the hue (carrier links are teal, the Internet red, encrypted
 * tunnels green, cloud connections amber, wireless pink) and each kind has its own shade.
 */

export const NETWORK_FAMILIES = [
  { id: "local", label: "Local and data centre" },
  { id: "fabric", label: "Storage and compute fabric" },
  { id: "carrier", label: "Carrier WAN" },
  { id: "internet", label: "Internet and broadband" },
  { id: "tunnel", label: "Encrypted tunnels" },
  { id: "cloud", label: "Cloud connections" },
  { id: "wireless", label: "Wireless and mobile" },
  { id: "industrial", label: "Industrial and OT" },
  { id: "voice", label: "Voice and legacy" },
] as const;
export type NetworkFamily = (typeof NETWORK_FAMILIES)[number]["id"];

export interface NetworkLink {
  /** The name of the kind, as the library has it. */
  name: string;
  color: string;
  family: NetworkFamily;
  /** Other ways people write it, compared whole. */
  also?: string[];
}

export const NETWORK_LINKS: NetworkLink[] = [
  { name: "LAN", color: "#3B82F6", family: "local", also: ["ethernet", "local network"] },
  { name: "Campus backbone", color: "#2563EB", family: "local" },
  { name: "Data centre interconnect (DCI)", color: "#4F46E5", family: "local", also: ["dci", "data center interconnect"] },
  { name: "VXLAN overlay", color: "#6366F1", family: "local", also: ["vxlan"] },
  { name: "Out-of-band management link", color: "#64748B", family: "local", also: ["oob", "out of band", "management network"] },

  { name: "Fibre Channel (SAN)", color: "#7C3AED", family: "fabric", also: ["san", "fibre channel", "fiber channel"] },
  { name: "iSCSI", color: "#A78BFA", family: "fabric" },
  { name: "InfiniBand", color: "#8B5CF6", family: "fabric" },

  { name: "WAN", color: "#0891B2", family: "carrier" },
  { name: "MPLS", color: "#0E7490", family: "carrier", also: ["mpls vpn"] },
  { name: "SD-WAN", color: "#06B6D4", family: "carrier", also: ["sdwan"] },
  { name: "Leased line", color: "#0F766E", family: "carrier", also: ["private circuit"] },
  { name: "Dark fibre", color: "#115E59", family: "carrier", also: ["dark fiber"] },
  { name: "Metro Ethernet", color: "#0D9488", family: "carrier" },
  { name: "DWDM wavelength", color: "#14B8A6", family: "carrier", also: ["dwdm"] },
  { name: "Point-to-point link", color: "#0284C7", family: "carrier", also: ["p2p", "point to point"] },
  { name: "GSN", color: "#4D7C0F", family: "carrier", also: ["government secure network"] },

  { name: "Internet", color: "#DC2626", family: "internet", also: ["public internet", "www"] },
  { name: "Internet exchange (IXP)", color: "#B91C1C", family: "internet", also: ["ixp"] },
  { name: "DSL", color: "#EA580C", family: "internet", also: ["adsl", "vdsl"] },
  { name: "Fibre broadband (FTTH)", color: "#F97316", family: "internet", also: ["ftth", "fiber broadband"] },
  { name: "Cable broadband", color: "#C2410C", family: "internet" },

  { name: "VPN (site-to-site)", color: "#16A34A", family: "tunnel", also: ["vpn", "site to site vpn", "ipsec vpn", "s2s vpn"] },
  { name: "Remote access VPN", color: "#22C55E", family: "tunnel", also: ["client vpn"] },
  { name: "SSL VPN", color: "#15803D", family: "tunnel" },
  { name: "IPsec tunnel", color: "#059669", family: "tunnel", also: ["ipsec"] },
  { name: "Cloud VPN", color: "#10B981", family: "tunnel" },
  { name: "GRE tunnel", color: "#65A30D", family: "tunnel", also: ["gre"] },

  { name: "AWS Direct Connect", color: "#F59E0B", family: "cloud", also: ["direct connect"] },
  { name: "Azure ExpressRoute", color: "#D97706", family: "cloud", also: ["expressroute", "express route"] },
  { name: "Google Cloud Interconnect", color: "#EAB308", family: "cloud", also: ["cloud interconnect"] },
  { name: "Oracle FastConnect", color: "#CA8A04", family: "cloud", also: ["fastconnect"] },
  { name: "VPC peering", color: "#B45309", family: "cloud", also: ["vnet peering"] },
  { name: "Transit gateway", color: "#A16207", family: "cloud", also: ["transit gw"] },
  { name: "Private link / private endpoint", color: "#FBBF24", family: "cloud", also: ["private link", "privatelink", "private endpoint"] },

  { name: "Wi-Fi", color: "#EC4899", family: "wireless", also: ["wifi", "wlan", "wireless"] },
  { name: "Wireless bridge", color: "#DB2777", family: "wireless" },
  { name: "Microwave link", color: "#BE185D", family: "wireless", also: ["microwave"] },
  { name: "Satellite (VSAT)", color: "#9D174D", family: "wireless", also: ["satellite", "vsat"] },
  { name: "LTE / 4G", color: "#C026D3", family: "wireless", also: ["lte", "4g"] },
  { name: "5G", color: "#A21CAF", family: "wireless" },
  { name: "Private 5G", color: "#D946EF", family: "wireless" },
  { name: "LoRaWAN", color: "#F472B6", family: "wireless", also: ["lora"] },
  { name: "NB-IoT", color: "#E879F9", family: "wireless", also: ["nbiot"] },
  { name: "Zigbee mesh", color: "#FB7185", family: "wireless", also: ["zigbee"] },
  { name: "Bluetooth", color: "#E11D48", family: "wireless", also: ["ble"] },

  { name: "Industrial Ethernet (PROFINET, EtherNet/IP)", color: "#92400E", family: "industrial", also: ["industrial ethernet", "profinet", "ethernet ip"] },
  { name: "Fieldbus (Modbus, PROFIBUS)", color: "#78350F", family: "industrial", also: ["fieldbus", "modbus", "profibus"] },
  { name: "SCADA telemetry link", color: "#9A3412", family: "industrial", also: ["scada", "telemetry"] },
  { name: "Serial link (RS-232 / RS-485)", color: "#57534E", family: "industrial", also: ["serial", "rs 232", "rs 485"] },

  { name: "PSTN telephone line", color: "#475569", family: "voice", also: ["pstn", "telephone line"] },
  { name: "SIP trunk", color: "#334155", family: "voice", also: ["sip"] },
  { name: "ISDN (legacy)", color: "#A8A29E", family: "voice", also: ["isdn"] },
  { name: "Frame relay (legacy)", color: "#78716C", family: "voice", also: ["frame relay"] },
];

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
const flat = (text: string) => words(text).join(" ");

const BY_PHRASE = new Map<string, NetworkLink>();
for (const link of NETWORK_LINKS) for (const phrase of [link.name, ...(link.also ?? [])]) BY_PHRASE.set(flat(phrase), link);

/** What each kind's name and library search words take in, for matching text that is not an exact name. */
const VOCABULARY = (() => {
  const aliases = new Map(componentsIn("connections").map((c) => [c.name, c.aliases]));
  return NETWORK_LINKS.map((link) => ({ link, words: new Set(words([link.name, aliases.get(link.name) ?? "", ...(link.also ?? [])].join(" "))) }));
})();

/**
 * The kind a network name stands for: the name itself or a known way of writing it, otherwise
 * the most specific kind whose words take in every word written ("MPLS VPN", "Internet").
 */
export function networkLink(text: string | undefined | null): NetworkLink | null {
  if (!text?.trim()) return null;
  const exact = BY_PHRASE.get(flat(text));
  if (exact) return exact;
  const written = words(text);
  let best: { link: NetworkLink; size: number } | null = null;
  for (const { link, words: vocabulary } of VOCABULARY) {
    if (!written.every((w) => vocabulary.has(w))) continue;
    if (!best || vocabulary.size < best.size) best = { link, size: vocabulary.size };
  }
  return best?.link ?? null;
}

/** The colour of the network a relationship runs over, when it says one we know. */
export const relationshipNetwork = (r: Pick<Relationship, "network"> | undefined) => networkLink(r?.network);

/** The kind of network a box stands for, when it is one of the library's network connections. */
export function objectNetwork(o: Pick<ModelObject, "componentId"> | undefined): NetworkLink | null {
  if (!o?.componentId?.startsWith("connections.")) return null;
  const component = componentsIn("connections").find((c) => c.id === o.componentId);
  return component ? BY_PHRASE.get(flat(component.name)) ?? null : null;
}

export const familyLabel = (family: NetworkFamily) => NETWORK_FAMILIES.find((f) => f.id === family)?.label ?? family;
