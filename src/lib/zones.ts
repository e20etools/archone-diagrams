import type { Diagram, Workspace } from "./types";

/**
 * Network zones on a diagram. A zone that holds boxes on the diagram is drawn around them, in
 * a colour of its own, instead of as a box; a zone with nothing inside it stays a box.
 */

const ZONE_COLORS: Record<string, string> = {
  "zones.dmz": "#E08A1E",
  "zones.internal-lan": "#0EA5B7",
  "zones.public-internet": "#7C83F2",
  "zones.management": "#2F9E5F",
  "zones.database-zone": "#E06A6A",
  "zones.cloud-vpc-subnet": "#2D9CDB",
  "zones.restricted-pci": "#E0457B",
  "zones.dr-zone": "#A99A1E",
  "zones.production-zone": "#C2410C",
  "zones.payment-zone": "#BE185D",
  "zones.ot-industrial-zone": "#8B5CF6",
  "zones.untrusted-zone": "#DC2626",
  "zones.trusted-zone": "#16A34A",
  "zones.guest-network": "#64748B",
  "zones.quarantine-zone": "#B91C1C",
  "zones.isolated-recovery-vault": "#0F766E",
  "zones.air-gapped-network": "#334155",
};

export const zoneColor = (componentId?: string) => (componentId && ZONE_COLORS[componentId]) || "#64748B";

export interface ZoneBox {
  id: string;
  name: string;
  color: string;
  /** The boxes drawn inside it: everything on the diagram that sits in the zone, at any depth. */
  members: string[];
  /** How many zones it sits in, so outer zones are drawn behind inner ones. */
  depth: number;
}

/** The zones of a diagram that have something inside them on the diagram. */
export function zonesOf(ws: Workspace, diagram: Pick<Diagram, "nodes">): ZoneBox[] {
  const on = Object.keys(diagram.nodes).filter((id) => ws.objects[id]);
  const out: ZoneBox[] = [];
  for (const id of on) {
    const zone = ws.objects[id];
    if (zone.typeId !== "zone") continue;
    const members = on.filter((other) => {
      if (other === id) return false;
      for (let cur = ws.objects[other]?.parentId, n = 0; cur && n < 12; cur = ws.objects[cur]?.parentId, n++) if (cur === id) return true;
      return false;
    });
    if (!members.length) continue;
    let depth = 0;
    for (let cur = zone.parentId, n = 0; cur && n < 12; cur = ws.objects[cur]?.parentId, n++) if (ws.objects[cur]?.typeId === "zone") depth++;
    out.push({ id, name: zone.name, color: zoneColor(zone.componentId), members, depth });
  }
  return out.sort((a, b) => a.depth - b.depth);
}
