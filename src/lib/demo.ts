import { createAdr, decideAdr } from "./adr";
import { createObject, createRelationship, emptyWorkspace, type ObjectInput } from "./model";
import type { Provenance, RelationKind, Workspace } from "./types";
import { createView } from "./views";

/** A small, realistic model so a new user can try every feature without typing one first. */
export function demoWorkspace(userName = ""): Workspace {
  let ws = { ...emptyWorkspace("Online store (demo)"), userName };
  const provenance: Provenance = { origin: "demo" };
  const ids: Record<string, string> = {};

  const add = (key: string, input: Omit<ObjectInput, "parentId" | "provenance"> & { parent?: string }) => {
    const { parent, ...rest } = input;
    const made = createObject(ws, { ...rest, parentId: parent ? ids[parent] : null, provenance });
    ws = made.ws;
    ids[key] = made.object.id;
  };
  const link = (source: string, target: string, kind: RelationKind, label = "", protocol = "", port = "") => {
    ws = createRelationship(ws, { sourceId: ids[source], targetId: ids[target], kind, label, protocol, port, provenance }).ws;
  };

  add("commerce", { typeId: "domain", name: "Digital commerce", owner: "Digital team", description: "Everything customers use to browse and buy." });
  add("customer", { typeId: "actor", name: "Customer", description: "Buys products on the web and on the phone." });
  add("support", { typeId: "actor", name: "Support agent", description: "Handles order questions and refunds." });

  add("store", { typeId: "system", name: "Online store", parent: "commerce", owner: "Digital team", tags: ["customer-facing", "tier-1"], description: "The shop: catalogue, basket, checkout and order tracking." });
  add("web", { typeId: "web-app", name: "Web storefront", parent: "store", owner: "Digital team", technology: "React", tags: ["customer-facing"] });
  add("mobile", { typeId: "mobile-app", name: "Mobile app", parent: "store", owner: "Digital team", technology: "Flutter", lifecycle: "planned", tags: ["customer-facing"] });
  add("gateway", { typeId: "gateway", name: "API gateway", parent: "store", owner: "Platform team", technology: "Kong", tags: ["tier-1"] });
  add("orders", { typeId: "service", name: "Order service", parent: "store", owner: "Digital team", technology: "Node.js", tags: ["tier-1"] });
  add("catalog", { typeId: "service", name: "Catalog service", parent: "store", owner: "Digital team", technology: "Node.js" });
  add("payments", { typeId: "service", name: "Payment service", parent: "store", owner: "Payments team", technology: "Java", tags: ["pci", "tier-1"] });
  add("ordersDb", { typeId: "database", name: "Orders database", parent: "store", owner: "Digital team", technology: "PostgreSQL", tags: ["tier-1"] });
  add("search", { typeId: "database", name: "Catalog search index", parent: "store", owner: "Digital team", technology: "Elasticsearch" });
  add("cache", { typeId: "cache", name: "Session cache", parent: "store", owner: "Platform team", technology: "Memcached", lifecycle: "deprecated", description: "Being replaced by Redis." });
  add("bus", { typeId: "queue", name: "Event bus", parent: "store", owner: "Platform team", technology: "Kafka" });

  add("office", { typeId: "system", name: "Back office", parent: "commerce", owner: "Data team", description: "Tools for staff: order administration and reporting." });
  add("admin", { typeId: "web-app", name: "Admin portal", parent: "office", owner: "Digital team", technology: "Angular" });
  add("reporting", { typeId: "service", name: "Reporting service", parent: "office", owner: "Data team", technology: "Python" });
  add("warehouse", { typeId: "database", name: "Data warehouse", parent: "office", owner: "Data team", technology: "Snowflake" });

  add("psp", { typeId: "external-system", name: "Payment provider", description: "Card processing, run by a third party.", tags: ["pci"] });
  add("sms", { typeId: "external-system", name: "SMS gateway", description: "Sends order updates to customers." });
  add("idp", { typeId: "external-system", name: "Identity provider", description: "Sign-in for customers and staff." });
  add("k8s", { typeId: "cluster", name: "Production cluster", owner: "Platform team", technology: "Kubernetes", tags: ["tier-1"] });

  link("customer", "web", "calls", "shops on");
  link("customer", "mobile", "calls", "shops on");
  link("support", "admin", "calls", "manages orders in");
  link("web", "gateway", "calls", "", "HTTPS", "443");
  link("mobile", "gateway", "calls", "", "HTTPS", "443");
  link("web", "idp", "calls", "signs in with", "OIDC", "443");
  link("gateway", "orders", "routes_to");
  link("gateway", "catalog", "routes_to");
  link("gateway", "payments", "routes_to");
  link("orders", "ordersDb", "reads_writes", "", "TCP", "5432");
  link("orders", "payments", "calls", "takes payment through");
  link("orders", "bus", "calls", "publishes order events to");
  link("orders", "sms", "calls", "sends order updates through");
  link("catalog", "search", "reads_writes");
  link("catalog", "cache", "reads_writes");
  link("payments", "psp", "calls", "charges cards through", "HTTPS", "443");
  link("admin", "reporting", "calls");
  link("admin", "orders", "calls", "looks up orders in");
  link("reporting", "bus", "calls", "consumes order events from");
  link("reporting", "warehouse", "reads_writes");
  for (const key of ["orders", "catalog", "payments", "gateway", "reporting"]) link(key, "k8s", "hosted_on");

  ws = createView(ws, { name: "System landscape", viewType: "landscape", description: "Who uses which system." }).ws;
  ws = createView(ws, { name: "Inside Online store", viewType: "container", scopeId: ids.store, description: "The applications and data stores of the shop." }).ws;
  ws = createView(ws, { name: "Deployment", viewType: "deployment", direction: "LR", description: "What runs on the production cluster." }).ws;

  // Two decisions, so the log shows what a record looks like: one decided, one still open.
  const decided = createAdr(ws, {
    title: "Publish order events on one event bus",
    context: "Reporting and order updates each polled the orders database. Every new consumer meant another query against the busiest table.",
    decision: "We will publish order events to the event bus, and every consumer will read from there. Nothing but the order service reads the orders database.",
    consequences: "Consumers no longer load the orders database. The event bus becomes tier-1: an outage delays reports and order updates. Events need a schema that is versioned.",
    objectIds: [ids.orders, ids.bus, ids.reporting, ids.ordersDb],
    author: "Demo",
  });
  ws = decideAdr(decided.ws, decided.adr.id, "accepted");
  ws = createAdr(ws, {
    title: "Replace the session cache with Redis",
    context: "Memcached is deprecated here and loses every session when a node restarts.",
    decision: "We will move sessions to Redis with persistence, and retire the session cache once the catalog service has switched.",
    objectIds: [ids.cache, ids.catalog],
    author: "Demo",
  }).ws;
  return ws;
}
