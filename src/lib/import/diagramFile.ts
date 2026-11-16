import { decodeEntities } from "./xml";

/** What the Visio and draw.io readers produce: labelled shapes with positions, and the connectors between them. */

export interface ImportedShape {
  id: string;
  text: string;
  /** Top-left corner and size in pixels, y growing downwards. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The shape this one sits inside, when the file says so. */
  parentId: string | null;
  /** The stencil name or style, used to guess what kind of thing the shape is. */
  hint: string;
}
export interface ImportedConnector {
  id: string;
  sourceId: string;
  targetId: string;
  text: string;
}
export interface ImportedPage {
  name: string;
  shapes: ImportedShape[];
  connectors: ImportedConnector[];
  /** Things on the page that were left out, in words, for the person to read before importing. */
  skipped: { unlabelled: number; loose: number; notes: number };
}

export class DiagramFileError extends Error {}

/** A label as plain text: HTML removed, line breaks and runs of spaces collapsed. */
export function plainLabel(value: string): string {
  let text = value;
  if (/<[a-z!/][^>]*>/i.test(text)) {
    text = text
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "");
  }
  return decodeEntities(text.replace(/&nbsp;/gi, " "))
    .replace(/[ ​]/g, " ")
    .replace(/[ \t]*\n[ \t\n]*/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Shapes that fully enclose other shapes become their parents when the file did not say so itself. */
export function nestByGeometry(shapes: ImportedShape[]): ImportedShape[] {
  const area = (s: ImportedShape) => s.width * s.height;
  const holds = (outer: ImportedShape, inner: ImportedShape) =>
    outer !== inner && area(outer) > area(inner) * 1.5 && inner.x >= outer.x - 2 && inner.y >= outer.y - 2 && inner.x + inner.width <= outer.x + outer.width + 2 && inner.y + inner.height <= outer.y + outer.height + 2;
  return shapes.map((shape) => {
    if (shape.parentId) return shape;
    // The smallest shape that encloses it is its direct parent.
    const parent = shapes.filter((other) => holds(other, shape)).sort((a, b) => area(a) - area(b))[0];
    return parent ? { ...shape, parentId: parent.id } : shape;
  });
}

/**
 * The shape a loose end of a connector points at: the smallest shape whose outline, widened a
 * little, holds the point. Connectors drawn up to a shape without being glued to it are common.
 */
export function shapeAt(shapes: ImportedShape[], x: number, y: number, slack: number): ImportedShape | null {
  const hits = shapes.filter((s) => x >= s.x - slack && x <= s.x + s.width + slack && y >= s.y - slack && y <= s.y + s.height + slack);
  return hits.sort((a, b) => a.width * a.height - b.width * b.height)[0] ?? null;
}

const TYPE_RULES: [string, RegExp][] = [
  ["actor", /\b(actor|user|users|person|people|customer|customers|staff|employee|operator|team|umlactor)\b/],
  ["database", /\b(database|databases|db|sql|postgres\w*|mysql|mariadb|oracle|mongo\w*|dynamo\w*|rds|cosmos|datastore|data store|data warehouse|warehouse|cylinder\w*|datastore)\b/],
  ["queue", /\b(queue|queues|kafka|topic|stream|streams|event bus|service bus|bus|sqs|sns|rabbit\w*|event hub|pubsub|pub\/sub|broker)\b/],
  ["cache", /\b(cache|redis|memcache\w*)\b/],
  ["storage", /\b(storage|bucket|s3|blob|file share|file store|data lake|sftp|ftp)\b/],
  ["gateway", /\b(gateway|load balancer|lb|alb|nlb|elb|cdn|proxy|ingress|waf|api management|apim|front door)\b/],
  ["cluster", /\b(cluster|kubernetes|k8s|eks|aks|gke|openshift|container platform)\b/],
  ["network", /\b(firewall|vpn|router|switch|subnet|vnet|vpc|dmz)\b/],
  ["server", /\b(server|servers|vm|virtual machine|ec2|host|instance|mainframe)\b/],
  ["mobile-app", /\b(mobile|ios|android|phone|tablet)\b/],
  ["web-app", /\b(web app|webapp|web application|website|web site|portal|front end|frontend|front-end|spa|browser)\b/],
  ["external-system", /\b(external|third party|third-party|3rd party|vendor|partner|saas|cloud)\b/],
  ["service", /\b(service|services|api|apis|microservice|backend|back end|worker|function|lambda|job)\b/],
  ["system", /\b(system|platform|erp|crm|suite)\b/],
  ["application", /\b(application|app)\b/],
];

/** A best guess at the object type from a shape's stencil or style and its text. The person can change it in the review. */
export function guessType(hint: string, text: string): string | null {
  const from = (value: string) => {
    const words = value
      .toLowerCase()
      .replace(/[_=;.]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2");
    return TYPE_RULES.find(([, pattern]) => pattern.test(words))?.[0] ?? null;
  };
  // The stencil is what the author chose deliberately; the words in the label come second.
  return from(hint) ?? from(text);
}

export function guessKind(label: string, sourceType: string, targetType: string): "calls" | "depends_on" | "reads_writes" | "hosted_on" | "routes_to" | "replicates_to" {
  const text = label.toLowerCase();
  if (/\b(replicat\w*|mirror\w*|sync\w*|backup|backs up)\b/.test(text)) return "replicates_to";
  if (/\b(hosted|hosts|runs on|deployed|installed)\b/.test(text)) return "hosted_on";
  if (/\b(route\w*|forward\w*|proxies|balances)\b/.test(text)) return "routes_to";
  if (/\b(read\w*|write\w*|quer\w*|store\w*|persist\w*|save\w*|load\w*|publish\w*|consum\w*)\b/.test(text)) return "reads_writes";
  if (/\b(depend\w*|uses|needs|requires)\b/.test(text)) return "depends_on";
  if (["database", "cache", "storage", "queue"].includes(targetType)) return "reads_writes";
  if (sourceType === "gateway") return "routes_to";
  if (["server", "cluster"].includes(targetType) && !["server", "cluster", "gateway", "network", "actor"].includes(sourceType)) return "hosted_on";
  return "calls";
}
