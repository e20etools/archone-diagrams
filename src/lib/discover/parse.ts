import { readAws, readAzure, readDiscoveryRows, readGcp, readServiceNow } from "../inventory/discovery";
import type { Inventory } from "../inventory/model";
import { NO_COMMUNICATIONS, type RawDiscovery } from "./fetchers";

/** Reads what a source answered into an inventory, with the source's notes added to what was left out. */
export function parseDiscovery(raw: RawDiscovery): Inventory {
  const inventory =
    raw.source === "aws"
      ? readAws(raw.data, raw.label)
      : raw.source === "azure"
        ? readAzure(raw.data, raw.label)
        : raw.source === "gcp"
          ? readGcp(raw.data, raw.label)
          : raw.source === "servicenow"
            ? readServiceNow(raw.data, raw.label)
            : readDiscoveryRows(raw.data, raw.label, raw.source === "bmc" ? "BMC Helix Discovery" : "Device42");
  // Without communications, the reader's own advice to add them would repeat the note.
  const skipped = raw.notes.includes(NO_COMMUNICATIONS) ? inventory.skipped.filter((s) => !s.startsWith("No connection rows")) : inventory.skipped;
  return { ...inventory, skipped: [...skipped, ...raw.notes] };
}
