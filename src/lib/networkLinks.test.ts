import { describe, expect, it } from "vitest";
import { componentsIn } from "./library";
import { NETWORK_FAMILIES, NETWORK_LINKS, networkLink, objectNetwork } from "./networkLinks";

describe("colours for network connections", () => {
  it("gives every kind in the library its own colour, in a known family", () => {
    const library = componentsIn("connections").map((c) => c.name).sort();
    expect(NETWORK_LINKS.map((l) => l.name).sort()).toEqual(library);
    const colours = NETWORK_LINKS.map((l) => l.color.toLowerCase());
    expect(new Set(colours).size).toBe(colours.length);
    const families = new Set<string>(NETWORK_FAMILIES.map((f) => f.id));
    expect(NETWORK_LINKS.every((l) => families.has(l.family) && /^#[0-9a-f]{6}$/i.test(l.color))).toBe(true);
  });

  it("reads the names people write", () => {
    const name = (text: string | undefined) => networkLink(text)?.name ?? null;
    expect(name("MPLS")).toBe("MPLS");
    expect(name("mpls vpn")).toBe("MPLS");
    expect(name("Internet")).toBe("Internet");
    expect(name("public internet")).toBe("Internet");
    expect(name("VPN")).toBe("VPN (site-to-site)");
    expect(name("Site-to-site VPN")).toBe("VPN (site-to-site)");
    expect(name("4G")).toBe("LTE / 4G");
    expect(name("Dark fiber")).toBe("Dark fibre");
    expect(name("ExpressRoute")).toBe("Azure ExpressRoute");
    expect(name("wifi")).toBe("Wi-Fi");
    expect(name("SWIFTNet")).toBeNull();
    expect(name("")).toBeNull();
    expect(name(undefined)).toBeNull();
  });

  it("knows a box that stands for a network", () => {
    const mpls = componentsIn("connections").find((c) => c.name === "MPLS")!;
    expect(objectNetwork({ componentId: mpls.id })?.color).toBe(networkLink("MPLS")!.color);
    expect(objectNetwork({ componentId: "network.core-switch" })).toBeNull();
    expect(objectNetwork({ componentId: undefined })).toBeNull();
  });
});
