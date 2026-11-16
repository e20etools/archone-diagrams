import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIBRARY_ICONS } from "../../components/libraryIcons";
import { isKnownType } from "../catalog";
import { createObject, emptyWorkspace } from "../model";
import { workspaceSchema } from "../types";
import { LIBRARY, LIBRARY_COUNTS, componentSubtitle, LIBRARY_SECTIONS, PROVIDERS, componentById, componentLabel, componentsIn, normalizeComponentName, objectFromComponent, profileOf, searchLibrary } from "./index";
import { PROFILES, hasProfile } from "./profiles";

describe("the component library", () => {
  it("is large, and covers the sections asked for and seven cloud providers", () => {
    expect(LIBRARY_COUNTS.general).toBeGreaterThan(400);
    expect(LIBRARY_COUNTS.cloud).toBeGreaterThan(1200);
    const general = LIBRARY_SECTIONS.filter((s) => !s.provider).map((s) => s.id);
    for (const id of ["business", "applications", "data", "compute", "storage", "datacenter", "network", "security", "identity", "end-user", "iot", "ai", "cloud", "external"]) expect(general).toContain(id);
    for (const p of PROVIDERS) expect(LIBRARY.filter((c) => c.provider === p.id).length, p.id).toBeGreaterThan(70);
  });

  it("has no component twice in one section, and no id twice anywhere", () => {
    for (const section of LIBRARY_SECTIONS) {
      const names = componentsIn(section.id).map((c) => normalizeComponentName(c.name));
      const repeated = names.filter((n, i) => names.indexOf(n) !== i);
      expect(repeated, section.id).toEqual([]);
      expect(names.length, `${section.id} is empty`).toBeGreaterThan(0);
    }
    const ids = LIBRARY.map((c) => c.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    // Within one provider a service is listed once, in the first section it belongs to.
    for (const p of PROVIDERS) {
      const names = LIBRARY.filter((c) => c.provider === p.id).map((c) => normalizeComponentName(c.name));
      expect(names.filter((n, i) => names.indexOf(n) !== i), p.id).toEqual([]);
    }
  });

  it("gives every component a real icon, a known kind and a basic-information screen", () => {
    for (const c of LIBRARY) {
      expect(LIBRARY_ICONS[c.icon], `${c.id} icon ${c.icon}`).toBeDefined();
      expect(isKnownType(c.kind), `${c.id} kind ${c.kind}`).toBe(true);
      expect(hasProfile(c.profile), `${c.id} profile ${c.profile}`).toBe(true);
    }
    for (const s of LIBRARY_SECTIONS) expect(LIBRARY_ICONS[s.icon], s.id).toBeDefined();
    // An icon says what the thing does: a firewall is not drawn like a database.
    const iconOf = (id: string) => componentById(id)!.icon;
    expect(iconOf("security.firewall")).not.toBe(iconOf("data.relational-database"));
    expect(new Set(LIBRARY.filter((c) => !c.provider).map((c) => c.icon)).size).toBeGreaterThan(200);
  });

  it("asks each kind of component for what matters about it", () => {
    for (const p of PROFILES) {
      const labels = p.fields.map((f) => f.label);
      expect(labels.filter((l, i) => labels.indexOf(l) !== i), p.id).toEqual([]);
      for (const f of p.fields) if (f.kind === "select") expect(f.options?.length, `${p.id} ${f.label}`).toBeGreaterThan(1);
      // The data lens and availability have their own controls; a profile must not ask again.
      expect(labels.some((l) => /^(Data classification|Personal data|Data residency|Availability)/.test(l)), p.id).toBe(false);
    }
    const labels = (id: string) => profileOf({ componentId: id, typeId: "application" }).fields.map((f) => f.label);
    expect(labels("compute.physical-server")).toEqual(expect.arrayContaining(["Host name", "Serial number", "Memory", "Operating system", "Warranty ends"]));
    expect(labels("data.relational-database")).toEqual(expect.arrayContaining(["Engine", "Recovery point", "Recovery time"]));
    expect(labels("network.router")).toEqual(expect.arrayContaining(["Management IP", "Firmware or OS version"]));
    expect(labels("security.firewall")).toEqual(expect.arrayContaining(["Protects", "Licence ends"]));
    expect(labels("end-user.laptop")).toEqual(expect.arrayContaining(["Assigned to", "Asset tag", "Disk encrypted"]));
    expect(labels("datacenter.data-centre")).toEqual(expect.arrayContaining(["Tier", "Power capacity"]));
    expect(labels("aws.simple-storage-service-s3")).toEqual(expect.arrayContaining(["Region", "Account or subscription", "Public access"]));
    // An object made before the library, or not from it, still gets a screen for its type.
    expect(profileOf({ typeId: "database" }).id).toBe("database");
    expect(profileOf({ typeId: "server", componentId: "gone.away" }).id).toBe("server");
  });

  it("files cloud services by what they do, whatever section the provider used", () => {
    const look = (id: string) => {
      const c = componentById(id);
      return c && `${c.kind}/${c.icon}`;
    };
    expect(look("aws.simple-storage-service-s3")).toBe("storage/HardDrive");
    expect(look("aws.dynamodb")).toBe("database/Database");
    expect(look("aws.redshift")).toBe("database/Warehouse");
    expect(look("aws.simple-queue-service")).toBe("queue/RadioTower");
    expect(look("aws.lambda")).toBe("service/SquareFunction");
    expect(look("aws.ec2")).toBe("server/Server");
    expect(look("aws.elastic-kubernetes-service")).toBe("cluster/Container");
    expect(look("aws.waf")).toBe("gateway/ShieldHalf");
    expect(look("aws.cloudfront")).toBe("gateway/Globe");
    expect(look("aws.bedrock")).toBe("ai-model/BrainCircuit");
    expect(look("gcp.bigquery")).toBe("database/Warehouse");
    expect(look("gcp.pub-sub")).toBe("queue/RadioTower");
    expect(look("gcp.cloud-run")).toBe("service/SquareFunction");
    expect(look("oci.autonomous-database")).toBe("database/Database");
    expect(look("huawei.object-storage-service-obs")).toBe("storage/HardDrive");
    expect(look("alibaba.apsaramq-for-kafka")).toBe("queue/RadioTower");
    expect(look("ibm.databases-for-postgresql")).toBe("database/Database");
  });

  it("is found by name, by another name and by provider", () => {
    expect(searchLibrary("firewall")[0].name).toBe("Firewall");
    expect(searchLibrary("NGFW").map((c) => c.name)).toContain("Next-generation firewall");
    expect(searchLibrary("s3", { provider: "aws" })[0].name).toBe("Simple Storage Service (S3)");
    expect(searchLibrary("kafka").length).toBeGreaterThan(4);
    expect(searchLibrary("database", { provider: null }).every((c) => !c.provider)).toBe(true);
    expect(searchLibrary("", { sectionId: "network" })).toEqual(componentsIn("network"));
    expect(searchLibrary("nafath")[0].sectionId).toBe("gulf");
  });

  it("makes an ordinary object of its kind that remembers the component", () => {
    const s3 = componentById("aws.simple-storage-service-s3")!;
    expect(componentLabel(s3)).toBe("AWS Simple Storage Service (S3)");
    const made = createObject(emptyWorkspace(), objectFromComponent(s3));
    expect(made.object).toMatchObject({ typeId: "storage", name: "Simple Storage Service (S3)", componentId: s3.id, technology: "AWS Simple Storage Service (S3)" });
    expect(workspaceSchema.safeParse(made.ws).success).toBe(true);
    const fw = createObject(emptyWorkspace(), objectFromComponent(componentById("security.firewall")!)).object;
    expect(fw).toMatchObject({ typeId: "network", componentId: "security.firewall", technology: "" });
  });

  it("does not say a box's name twice", () => {
    expect(componentSubtitle({ componentId: "security.firewall", name: "Firewall" })).toBe("Security");
    expect(componentSubtitle({ componentId: "security.firewall", name: "Edge firewall FW-01" })).toBe("Firewall");
    expect(componentSubtitle({ componentId: "aws.lambda", name: "Lambda" })).toBe("AWS");
    expect(componentSubtitle({ componentId: undefined, name: "x" })).toBeNull();
  });

  it("credits where the cloud names came from", () => {
    const header = readFileSync(new URL("./cloudNames.ts", import.meta.url), "utf8").slice(0, 900);
    expect(header).toMatch(/draw\.io/);
    expect(header).toMatch(/Apache License 2\.0/);
  });
});
