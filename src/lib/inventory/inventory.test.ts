import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyProposal, saveProposal, setAllDecisions } from "../ai/proposals";
import { emptyWorkspace } from "../model";
import { inventoryToProposal, readInventory, type Inventory } from "./index";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
const read = (name: string, hint: "bmc" | "device42" | null = null) => readInventory(name, fixture(name), hint)!;

/** "name [type component] in zone" for each item, and "a -kind-> b" for each link: easy to compare. */
function shape(inv: Inventory) {
  const name = (id: string) => inv.items.find((i) => i.id === id)?.name ?? id;
  return {
    items: inv.items.map((i) => `${i.name} [${i.typeId}${i.componentId ? ` ${i.componentId}` : ""}]${i.parentId ? ` in ${name(i.parentId)}` : ""}`),
    links: inv.links.map((l) => `${name(l.sourceId)} -${l.kind}-> ${name(l.targetId)}`),
  };
}

describe("infrastructure as code", () => {
  it("reads a Terraform configuration: resources, references, networks as zones, and the glue left out", () => {
    const inv = read("main.tf");
    expect(inv.format).toBe("A Terraform configuration");
    const s = shape(inv);
    expect(s.items).toEqual([
      "shop-vpc [zone aws.vpc]",
      "app-subnet [zone zones.cloud-vpc-subnet]",
      "shop-alb [gateway aws.elastic-load-balancing] in app-subnet",
      "web-1 [server aws.ec2] in app-subnet",
      "orders-db [database aws.rds] in shop-vpc",
      "shop-assets [storage aws.simple-storage-service-s3]",
      "monitoring [system]",
    ]);
    // The listener, target group and attachment join the load balancer to the instance; a shared security group joins nothing.
    expect(s.links).toContain("shop-alb -routes_to-> web-1");
    expect(s.links.some((l) => l.includes("orders-db") && !l.includes("monitoring"))).toBe(false);
    expect(inv.skipped.join(" ")).toMatch(/1 data source/);
    expect(inv.items.find((i) => i.name === "web-1")?.fields).toMatchObject({ address: "aws_instance.web", instance_type: "t3.small" });
  });

  it("reads a Terraform plan with its references, and a Pulumi stack", () => {
    expect(shape(read("plan.json"))).toEqual({
      items: ["shop-net [zone gcp.virtual-private-cloud]", "apps [zone zones.cloud-vpc-subnet]", "shop-gke [cluster gcp.google-kubernetes-engine-gke] in apps", "orders-sql [database gcp.cloud-sql]"],
      links: ["orders-sql -hosted_on-> shop-gke"],
    });
    expect(shape(read("pulumi.json")).links).toEqual(["orders -reads_writes-> orders-table"]);
  });

  it("reads a SAM template, with !Ref, !GetAtt and ${} references and the role left out", () => {
    const inv = read("cfn.yaml");
    expect(inv.format).toBe("An AWS SAM template");
    expect(shape(inv)).toEqual({
      items: ["OrdersApi [gateway aws.api-gateway]", "orders-handler [service aws.lambda]", "orders [database aws.dynamodb]", "orders-events [queue aws.simple-queue-service]"],
      links: ["orders-handler -reads_writes-> orders", "orders-handler -reads_writes-> orders-events", "orders-handler -calls-> OrdersApi"],
    });
  });

  it("reads ARM templates, with parameters, nested resources and resourceId(), and Bicep files", () => {
    expect(shape(read("arm.json")).links).toEqual(["shop-web -calls-> shop-plan", "orders -reads_writes-> shop-sql"]);
    expect(shape(read("arm.json")).items[1]).toBe("shop-web [server azure.app-services]");
    const bicep = shape(read("main.bicep"));
    expect(bicep.items).toContain("shop-aks [cluster azure.kubernetes-services] in shop-vnet");
    expect(bicep.items).toContain("shopacr [storage azure.container-registries]");
  });

  it("reads Kubernetes manifests: services to the workloads they select, ingress to services, namespaces as zones", () => {
    const s = shape(read("k8s.yaml"));
    expect(s.items).toContain("postgres [database containers.statefulset] in data");
    expect(s.items).toContain("web-config [component containers.config-map] in shop");
    expect(s.links).toEqual(expect.arrayContaining(["web -routes_to-> web", "shop -routes_to-> web", "web -calls-> orders", "web -depends_on-> web-config", "orders -depends_on-> db-credentials"]));
    expect(s.items.some((i) => i.startsWith("readers"))).toBe(false);
  });

  it("reads a Docker Compose file: images say what a service is, and depends_on and addresses say what it uses", () => {
    expect(shape(read("compose.yaml"))).toEqual({
      items: ["web [component containers.container]", "api [service]", "db [database]", "cache [cache]"],
      links: ["web -calls-> api", "api -reads_writes-> db", "api -reads_writes-> cache"],
    });
  });
});

describe("cloud inventories and discovery tools", () => {
  it("reads AWS Config results with what each resource is contained in", () => {
    expect(shape(read("aws-config.json")).items).toEqual(["core [zone aws.vpc]", "subnet-1 [zone zones.cloud-vpc-subnet] in core", "app-1 [server aws.ec2] in subnet-1", "orders [database aws.rds] in subnet-1"]);
  });

  it("reads Azure Resource Graph results, with subnets from their networks and through network interfaces", () => {
    const s = shape(read("azure.json"));
    expect(s.items).toContain("vm1 [server azure.virtual-machine] in app");
    expect(s.links).toEqual(["orders -reads_writes-> sql1"]);
  });

  it("reads Google Cloud Asset Inventory results, matching self links to asset names", () => {
    expect(shape(read("gcp.json")).items).toContain("vm-a [server gcp.compute-engine] in apps");
  });

  it("reads a ServiceNow CMDB export with its relationship types", () => {
    expect(shape(read("servicenow.json"))).toEqual({
      items: ["Online Banking [system]", "obk-app-01 [application]", "lnx-web-01 [server]", "ORDERSDB [database]"],
      links: ["Online Banking -depends_on-> obk-app-01", "obk-app-01 -hosted_on-> lnx-web-01", "obk-app-01 -calls-> ORDERSDB"],
    });
  });

  it("reads BMC Helix Discovery search results and Device42 devices with their communications", () => {
    const bmc = shape(read("bmc.json", "bmc"));
    expect(bmc.links).toEqual(expect.arrayContaining(["Apache Tomcat on lnx-app-01 -hosted_on-> lnx-app-01", "Apache Tomcat on lnx-app-01 -calls-> Oracle Database ORCL", "Oracle Database ORCL -depends_on-> Payments"]));
    const d42 = read("device42.json", "device42");
    expect(d42.format).toBe("A Device42 export");
    expect(shape(d42).links).toEqual(["app-vm-01 -hosted_on-> esx-01", "app-vm-01 -calls-> db-vm-01", "db-vm-01 -hosted_on-> esx-01"]);
    expect(d42.links.find((l) => l.kind === "calls")?.port).toBe("1433");
  });

  it("answers null for a file that is none of these", () => {
    expect(readInventory("notes.json", '{"hello": "world"}')).toBeNull();
    expect(readInventory("list.yaml", "- one\n- two\n")).toBeNull();
    expect(readInventory("package.json", JSON.stringify({ name: "shop", type: "module", version: "1.0.0" }))).toBeNull();
  });
});

describe("an inventory as a draft", () => {
  it("keeps components, fields and zones, and the draft puts resources inside their networks when accepted", () => {
    const ws = emptyWorkspace("Sara");
    const proposal = inventoryToProposal(ws, read("main.tf"), "iac", "main.tf");
    expect(proposal.importKind).toBe("iac");
    const web = proposal.objects.find((o) => o.name === "web-1")!;
    const subnet = proposal.objects.find((o) => o.name === "app-subnet")!;
    expect(web).toMatchObject({ componentId: "aws.ec2", parentKey: subnet.key, fields: expect.objectContaining({ type: "aws_instance" }) });
    expect(proposal.notes).toMatch(/A Terraform configuration .* 7 resources and 2 relationships/);
    const saved = setAllDecisions(saveProposal(ws, proposal), proposal.id, "accepted");
    const applied = applyProposal(saved, proposal.id, "Sara");
    const objects = Object.values(applied.ws.objects);
    const webObject = objects.find((o) => o.name === "web-1")!;
    expect(objects.find((o) => o.id === webObject.parentId)?.name).toBe("app-subnet");
    expect(webObject.componentId).toBe("aws.ec2");
  });
});
