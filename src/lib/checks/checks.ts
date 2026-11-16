import { objectType } from "../catalog";
import { toCsv } from "../exporters";
import { describeRule, runCustomCheck } from "./custom";
import { TRUTH_FIELDS, truthMatters, truthOf } from "../freshness";
import { handshakeState } from "../handshake";
import { ancestorsOf } from "../model";
import { AVAILABILITY_FIELD, declaredAvailability } from "../resilience";
import type { Diagram, ModelObject, Relationship, Workspace } from "../types";

/**
 * Diagram checks (PRD FR-45) and the data lens (FR-49).
 *
 * A check reads the model and reports findings; it changes nothing. The rule packs borrow
 * the concerns of well-known frameworks, in plain words. Passing them is not a certificate
 * of compliance: they only see what the model records.
 */

/* ---------- the data lens: three fields kept with the object's other fields ---------- */

export const DATA_FIELDS = { classification: "Data classification", personal: "Personal data", residency: "Data residency" } as const;
export const CLASSIFICATIONS = ["Public", "Internal", "Confidential", "Restricted"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
/** What an AI agent is allowed to do, said by a person. The checks fall back on the drawing when nobody has said. */
export const AGENT_FIELDS = { untrusted: "Reads untrusted content", outward: "Can send outside" } as const;
const RESERVED = new Set<string>([...Object.values(DATA_FIELDS), ...Object.values(AGENT_FIELDS), ...Object.values(TRUTH_FIELDS), AVAILABILITY_FIELD]);
export const isDataField = (key: string) => RESERVED.has(key);

export interface DataLens {
  classification: Classification | "";
  /** "" when nobody has said either way. */
  personal: "yes" | "no" | "";
  residency: string;
}
export function dataLens(o: ModelObject): DataLens {
  const classification = CLASSIFICATIONS.find((c) => c.toLowerCase() === (o.fields[DATA_FIELDS.classification] ?? "").trim().toLowerCase()) ?? "";
  const said = (o.fields[DATA_FIELDS.personal] ?? "").trim().toLowerCase();
  return { classification, personal: /^(yes|y|true|1)$/.test(said) ? "yes" : /^(no|n|false|0)$/.test(said) ? "no" : "", residency: (o.fields[DATA_FIELDS.residency] ?? "").trim() };
}
/** The object's fields with one data-lens value set, or removed when empty. */
export function withDataField(o: ModelObject, field: keyof typeof DATA_FIELDS, value: string): Record<string, string> {
  const next = { ...o.fields };
  if (value.trim()) next[DATA_FIELDS[field]] = field === "personal" ? (value === "yes" ? "Yes" : "No") : value.trim();
  else delete next[DATA_FIELDS[field]];
  return next;
}

const yesNo = (value: string | undefined): "yes" | "no" | "" => {
  const said = (value ?? "").trim().toLowerCase();
  return /^(yes|y|true|1)$/.test(said) ? "yes" : /^(no|n|false|0)$/.test(said) ? "no" : "";
};
export interface AgentLens {
  untrusted: "yes" | "no" | "";
  outward: "yes" | "no" | "";
}
export const agentLens = (o: ModelObject): AgentLens => ({ untrusted: yesNo(o.fields[AGENT_FIELDS.untrusted]), outward: yesNo(o.fields[AGENT_FIELDS.outward]) });
export function withAgentField(o: ModelObject, field: keyof typeof AGENT_FIELDS, value: string): Record<string, string> {
  const next = { ...o.fields };
  if (value === "yes" || value === "no") next[AGENT_FIELDS[field]] = value === "yes" ? "Yes" : "No";
  else delete next[AGENT_FIELDS[field]];
  return next;
}

/* ---------- checks ---------- */

export type Severity = "high" | "medium" | "low";
export const SEVERITIES: Severity[] = ["high", "medium", "low"];

export interface Finding {
  ruleId: string;
  severity: Severity;
  message: string;
  objectIds: string[];
  relationshipIds: string[];
}

export const PACKS = [
  { id: "practice", name: "Good practice", about: "Ownership, descriptions and lifecycle: the basics that keep a model usable." },
  { id: "security", name: "Security baseline", about: "Encrypted connections, exposure of data stores and classification of data." },
  { id: "privacy", name: "Privacy", about: "Where personal data is held, who owns it, where it lives and where it flows. Drawn from the concerns of GDPR-style laws." },
  { id: "pci", name: "Card data", about: "Scope and protection of anything tagged pci. Drawn from the concerns of PCI DSS." },
  {
    id: "nca",
    name: "NCA ECC (Saudi Arabia)",
    about:
      "What a diagram can show of the National Cybersecurity Authority's Essential Cybersecurity Controls, ECC-2:2024, with the subdomain each rule belongs to. Most of the controls are about policy, people and process and cannot be read from a model, so passing these rules is not compliance with the ECC.",
  },
  { id: "ai", name: "AI agents", about: "What each AI agent can read, reach and send. Looks for the combination that lets a planted instruction leak private data." },
] as const;
export type PackId = (typeof PACKS)[number]["id"];

interface Scope {
  ws: Workspace;
  objects: ModelObject[];
  relationships: Relationship[];
  /** Relationships of the whole model, for rules about what an object connects to. */
  all: Relationship[];
}
export interface Rule {
  id: string;
  title: string;
  why: string;
  severity: Severity;
  packs: PackId[];
  run: (scope: Scope) => Omit<Finding, "ruleId" | "severity">[];
}

const DATA_STORES = new Set(["database", "storage", "queue", "cache"]);
const OUTSIDE = new Set(["external-system", "actor"]);
/** Protocols that send data in the clear. A protocol written with TLS, or HTTPS, SFTP and the like, passes. */
const CLEAR_TEXT = /^(http|ftp|telnet|smtp|ldap|amqp|mqtt|redis|tcp|udp|jdbc|odbc|rsh|tftp|ws)$/i;
const name = (o: ModelObject | undefined) => o?.name ?? "A deleted object";
const isPci = (o: ModelObject) => o.tags.includes("pci");

/* ---------- AI agents ---------- */

export interface AgentReach {
  agent: ModelObject;
  /** The agent, the MCP servers and gateways it works through, and everything those touch. */
  touched: ModelObject[];
  relationshipIds: string[];
  /** Why each leg holds; empty when it does not. */
  untrusted: string;
  sensitive: string;
  outward: string;
}
const SENSITIVE = new Set<string>(["Confidential", "Restricted"]);
const PASS_THROUGH = new Set(["mcp-server", "gateway"]);
const USES = new Set<string>(["calls", "reads_writes", "depends_on", "routes_to"]);

/**
 * What an agent can reach: its own connections, and those of the MCP servers and gateways it
 * works through. The three legs are private data, untrusted content and a way out; an agent
 * with all three can be told by a planted text to send the private data away.
 */
export function agentReach(ws: Workspace, agent: ModelObject, all: Relationship[]): AgentReach {
  const via = new Set<string>([agent.id]);
  const touched = new Map<string, ModelObject>();
  const used = new Set<string>();
  const incoming: ModelObject[] = [];
  let frontier = [agent.id];
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next: string[] = [];
    for (const r of all) {
      if (!USES.has(r.kind) || !frontier.includes(r.sourceId)) continue;
      const target = ws.objects[r.targetId];
      if (!target) continue;
      used.add(r.id);
      touched.set(target.id, target);
      if (PASS_THROUGH.has(target.typeId) && !via.has(target.id)) {
        via.add(target.id);
        next.push(target.id);
      }
    }
    frontier = next;
  }
  for (const r of all) {
    const source = ws.objects[r.sourceId];
    if (r.targetId === agent.id && source && OUTSIDE.has(source.typeId) && USES.has(r.kind)) {
      incoming.push(source);
      used.add(r.id);
    }
  }
  const lens = agentLens(agent);
  const things = [...touched.values()];
  const outside = things.filter((o) => o.typeId === "external-system");
  const private_ = things.filter((o) => SENSITIVE.has(dataLens(o).classification) || dataLens(o).personal === "yes");
  const list = (objects: ModelObject[]) => objects.slice(0, 3).map((o) => o.name).join(", ") + (objects.length > 3 ? " and others" : "");
  const untrusted =
    lens.untrusted === "yes" ? "it is marked as reading untrusted content" : lens.untrusted === "no" ? "" : incoming.length ? `it takes input from ${list(incoming)}` : outside.length ? `it reads from ${list(outside)}` : "";
  const outward = lens.outward === "yes" ? "it is marked as able to send outside" : lens.outward === "no" ? "" : outside.length ? `it can reach ${list(outside)}` : "";
  const sensitive = private_.length ? `it can reach ${list(private_)}` : "";
  return { agent, touched: things, relationshipIds: [...used], untrusted, sensitive, outward };
}

export const RULES: Rule[] = [
  {
    id: "owner-missing",
    title: "Every object has an owner",
    why: "Without an owner nobody answers for a change, an incident or a review.",
    severity: "medium",
    packs: ["practice"],
    run: ({ objects }) => objects.filter((o) => !o.owner.trim() && !OUTSIDE.has(o.typeId)).map((o) => ({ message: `${o.name} has no owner.`, objectIds: [o.id], relationshipIds: [] })),
  },
  {
    id: "description-missing",
    title: "Every object says what it is for",
    why: "A name alone rarely tells a newcomer what a system does.",
    severity: "low",
    packs: ["practice"],
    run: ({ objects }) => objects.filter((o) => !o.description.trim()).map((o) => ({ message: `${o.name} has no description.`, objectIds: [o.id], relationshipIds: [] })),
  },
  {
    id: "retired-in-use",
    title: "Nothing in use depends on something retired",
    why: "A dependency on a retired system is either an error in the model or an outage waiting to happen.",
    severity: "high",
    packs: ["practice", "security"],
    run: ({ ws, relationships }) =>
      relationships
        .filter((r) => ws.objects[r.targetId]?.lifecycle === "retired" && ["active", "planned"].includes(ws.objects[r.sourceId]?.lifecycle ?? ""))
        .map((r) => ({ message: `${name(ws.objects[r.sourceId])} relies on ${name(ws.objects[r.targetId])}, which is retired.`, objectIds: [r.sourceId, r.targetId], relationshipIds: [r.id] })),
  },
  {
    id: "deprecated-in-use",
    title: "Dependencies on deprecated objects are known",
    why: "Each one is work to plan before the deprecated system goes.",
    severity: "medium",
    packs: ["practice"],
    run: ({ ws, relationships }) =>
      relationships
        .filter((r) => ws.objects[r.targetId]?.lifecycle === "deprecated" && ["active", "planned"].includes(ws.objects[r.sourceId]?.lifecycle ?? ""))
        .map((r) => ({ message: `${name(ws.objects[r.sourceId])} relies on ${name(ws.objects[r.targetId])}, which is deprecated.`, objectIds: [r.sourceId, r.targetId], relationshipIds: [r.id] })),
  },
  {
    id: "unconnected",
    title: "Every object is connected to something",
    why: "An object with no relationships is unfinished modelling or something nobody uses.",
    severity: "low",
    packs: ["practice"],
    run: ({ ws, objects, all }) => {
      const connected = new Set(all.flatMap((r) => [r.sourceId, r.targetId]));
      const parents = new Set(Object.values(ws.objects).map((o) => o.parentId));
      return objects.filter((o) => !connected.has(o.id) && !parents.has(o.id) && o.typeId !== "domain").map((o) => ({ message: `${o.name} has no relationships.`, objectIds: [o.id], relationshipIds: [] }));
    },
  },
  {
    id: "truth-stale",
    title: "What the model says has been confirmed recently",
    why: "Systems change without anyone telling the model. Facts nobody has looked at for half a year are guesses, and decisions made on them inherit the guess.",
    severity: "low",
    packs: ["practice"],
    run: ({ objects }) =>
      objects
        .filter((o) => truthMatters(o) && truthOf(o).state === "stale")
        .map((o) => {
          const truth = truthOf(o);
          return {
            message: truth.confirmed
              ? `${o.name} was last confirmed ${truth.ageDays} days ago${truth.by ? ` by ${truth.by}` : ""}. It is due every ${truth.intervalDays} days.`
              : `${o.name} was added ${truth.ageDays} days ago and nobody has confirmed it since. It is due every ${truth.intervalDays} days.`,
            objectIds: [o.id],
            relationshipIds: [],
          };
        }),
  },
  {
    id: "dependency-unconfirmed",
    title: "A dependency on another team is confirmed by that team",
    why: "The team that is depended on plans changes and outages around who relies on it. A dependency only one side knows about is the one that breaks without warning.",
    severity: "low",
    packs: ["practice"],
    run: ({ ws, relationships }) =>
      relationships
        .filter((r) => handshakeState(ws, r) === "pending")
        .map((r) => ({
          message: `${name(ws.objects[r.sourceId])} (${ws.objects[r.sourceId].owner}) depends on ${name(ws.objects[r.targetId])}, and ${ws.objects[r.targetId].owner} has not confirmed it.`,
          objectIds: [r.sourceId, r.targetId],
          relationshipIds: [r.id],
        })),
  },
  {
    id: "clear-text",
    title: "Connections are encrypted",
    why: "A protocol that sends data in the clear exposes it to anyone on the path.",
    severity: "high",
    packs: ["security", "privacy", "pci", "nca"],
    run: ({ ws, relationships }) =>
      relationships
        .filter((r) => CLEAR_TEXT.test(r.protocol.trim()))
        .map((r) => ({ message: `${name(ws.objects[r.sourceId])} to ${name(ws.objects[r.targetId])} uses ${r.protocol.trim().toUpperCase()}, which is not encrypted.`, objectIds: [r.sourceId, r.targetId], relationshipIds: [r.id] })),
  },
  {
    id: "protocol-missing",
    title: "Connections to data stores name their protocol",
    why: "Without it, nobody can tell whether the connection is encrypted.",
    severity: "low",
    packs: ["security", "nca"],
    run: ({ ws, relationships }) =>
      relationships
        .filter((r) => !r.protocol.trim() && DATA_STORES.has(ws.objects[r.targetId]?.typeId ?? ""))
        .map((r) => ({ message: `${name(ws.objects[r.sourceId])} to ${name(ws.objects[r.targetId])} does not say which protocol it uses.`, objectIds: [r.sourceId, r.targetId], relationshipIds: [r.id] })),
  },
  {
    id: "store-exposed",
    title: "Outsiders do not reach data stores directly",
    why: "A person or an outside system connected straight to a store bypasses the application's access rules.",
    severity: "high",
    packs: ["security", "pci", "nca"],
    run: ({ ws, relationships }) =>
      relationships
        .filter((r) => {
          const a = ws.objects[r.sourceId];
          const b = ws.objects[r.targetId];
          return !!a && !!b && ((OUTSIDE.has(a.typeId) && DATA_STORES.has(b.typeId)) || (OUTSIDE.has(b.typeId) && DATA_STORES.has(a.typeId)));
        })
        .map((r) => ({ message: `${name(ws.objects[r.sourceId])} connects directly to ${name(ws.objects[r.targetId])}.`, objectIds: [r.sourceId, r.targetId], relationshipIds: [r.id] })),
  },
  {
    id: "classification-missing",
    title: "Data stores are classified",
    why: "Protection follows classification; an unclassified store gets whatever it happens to have.",
    severity: "medium",
    packs: ["security", "privacy", "nca"],
    run: ({ objects }) => objects.filter((o) => DATA_STORES.has(o.typeId) && !dataLens(o).classification).map((o) => ({ message: `${o.name} has no data classification.`, objectIds: [o.id], relationshipIds: [] })),
  },
  {
    id: "sensitive-on-old",
    title: "Sensitive data is not left on systems being phased out",
    why: "Deprecated and retired systems stop getting fixes while still holding the data.",
    severity: "high",
    packs: ["security", "nca"],
    run: ({ objects }) =>
      objects
        .filter((o) => ["deprecated", "retired"].includes(o.lifecycle) && (["Confidential", "Restricted"].includes(dataLens(o).classification) || dataLens(o).personal === "yes"))
        .map((o) => ({ message: `${o.name} is ${o.lifecycle} and holds ${dataLens(o).personal === "yes" ? "personal" : dataLens(o).classification.toLowerCase()} data.`, objectIds: [o.id], relationshipIds: [] })),
  },
  {
    id: "personal-undeclared",
    title: "Data stores say whether they hold personal data",
    why: "A data map with gaps cannot answer a regulator or a person asking what is held about them.",
    severity: "medium",
    packs: ["privacy"],
    run: ({ objects }) => objects.filter((o) => DATA_STORES.has(o.typeId) && !dataLens(o).personal).map((o) => ({ message: `${o.name} does not say whether it holds personal data.`, objectIds: [o.id], relationshipIds: [] })),
  },
  {
    id: "personal-unowned",
    title: "Personal data has an owner",
    why: "Someone has to answer access and deletion requests for it.",
    severity: "high",
    packs: ["privacy"],
    run: ({ objects }) => objects.filter((o) => dataLens(o).personal === "yes" && !o.owner.trim()).map((o) => ({ message: `${o.name} holds personal data and has no owner.`, objectIds: [o.id], relationshipIds: [] })),
  },
  {
    id: "personal-residency",
    title: "Personal data says where it is kept",
    why: "Many laws limit where personal data may be stored.",
    severity: "medium",
    packs: ["privacy"],
    run: ({ objects }) => objects.filter((o) => dataLens(o).personal === "yes" && !dataLens(o).residency).map((o) => ({ message: `${o.name} holds personal data and does not say where it is kept.`, objectIds: [o.id], relationshipIds: [] })),
  },
  {
    id: "personal-crosses-border",
    title: "Personal data that changes region is known",
    why: "A transfer between regions usually needs a legal basis.",
    severity: "medium",
    packs: ["privacy"],
    run: ({ ws, relationships }) =>
      relationships
        .filter((r) => {
          const a = ws.objects[r.sourceId];
          const b = ws.objects[r.targetId];
          if (!a || !b) return false;
          const [la, lb] = [dataLens(a), dataLens(b)];
          return (la.personal === "yes" || lb.personal === "yes") && !!la.residency && !!lb.residency && la.residency.toLowerCase() !== lb.residency.toLowerCase();
        })
        .map((r) => ({
          message: `${name(ws.objects[r.sourceId])} (${dataLens(ws.objects[r.sourceId]).residency}) and ${name(ws.objects[r.targetId])} (${dataLens(ws.objects[r.targetId]).residency}) are in different regions and personal data is involved.`,
          objectIds: [r.sourceId, r.targetId],
          relationshipIds: [r.id],
        })),
  },
  {
    id: "personal-to-outside",
    title: "Personal data shared with outside systems is known",
    why: "Each outside party that receives personal data usually needs an agreement.",
    severity: "medium",
    packs: ["privacy"],
    run: ({ ws, relationships }) =>
      relationships
        .filter((r) => {
          const a = ws.objects[r.sourceId];
          const b = ws.objects[r.targetId];
          return !!a && !!b && ((dataLens(a).personal === "yes" && b.typeId === "external-system") || (dataLens(b).personal === "yes" && a.typeId === "external-system"));
        })
        .map((r) => ({ message: `${name(ws.objects[r.sourceId])} and ${name(ws.objects[r.targetId])} are connected: personal data may leave the organisation.`, objectIds: [r.sourceId, r.targetId], relationshipIds: [r.id] })),
  },
  {
    id: "nca-third-party",
    title: "Every outside party that systems connect to is known and has someone answering for it",
    why: "ECC 4-1, Third-Party Cybersecurity: outsourced and managed services have to be covered by cybersecurity requirements. That starts with knowing which outside systems are connected and who inside is accountable for each.",
    severity: "medium",
    packs: ["nca"],
    run: ({ ws, objects, all }) =>
      objects
        .filter((o) => o.typeId === "external-system" && all.some((r) => (r.sourceId === o.id || r.targetId === o.id) && ws.objects[r.sourceId] && ws.objects[r.targetId]))
        .filter((o) => !o.owner.trim() || !o.description.trim())
        .map((o) => ({
          message: `${o.name} is an outside system connected to yours, with ${!o.owner.trim() && !o.description.trim() ? "no owner and no description" : !o.owner.trim() ? "no owner inside the organisation" : "no description of what it is and who runs it"}.`,
          objectIds: [o.id],
          relationshipIds: [],
        })),
  },
  {
    id: "nca-third-party-data",
    title: "Classified data that goes to an outside party is drawn on purpose",
    why: "ECC 4-1, Third-Party Cybersecurity, with 2-7, Data and Information Protection: data handed to a third party stays the organisation's responsibility. Each such flow should be a decision someone made, with the protocol recorded.",
    severity: "high",
    packs: ["nca"],
    run: ({ ws, relationships }) =>
      relationships
        .filter((r) => {
          const source = ws.objects[r.sourceId];
          const target = ws.objects[r.targetId];
          return source && target && target.typeId === "external-system" && SENSITIVE.has(dataLens(source).classification);
        })
        .map((r) => ({
          message: `${name(ws.objects[r.sourceId])} holds ${dataLens(ws.objects[r.sourceId]).classification.toLowerCase()} data and connects to ${name(ws.objects[r.targetId])}, an outside system${r.protocol.trim() ? "" : ", with no protocol recorded"}.`,
          objectIds: [r.sourceId, r.targetId],
          relationshipIds: [r.id],
        })),
  },
  {
    id: "nca-hosting",
    title: "Where classified data is hosted is written down",
    why: "ECC 4-2, Cloud Computing and Hosting Cybersecurity: the requirements for hosting apply to wherever the data sits, so the place has to be known first. Which places are allowed is set by the data's classification and by the national data rules, not by this check.",
    severity: "medium",
    packs: ["nca"],
    run: ({ objects }) =>
      objects
        .filter((o) => DATA_STORES.has(o.typeId) && SENSITIVE.has(dataLens(o).classification) && !dataLens(o).residency.trim())
        .map((o) => ({ message: `${o.name} holds ${dataLens(o).classification.toLowerCase()} data and does not say where it is hosted.`, objectIds: [o.id], relationshipIds: [] })),
  },
  {
    id: "nca-backup",
    title: "A data store the business leans on has a copy somewhere",
    why: "ECC 2-9, Backup and Recovery Management: critical data has to be backed up and recoverable. In the model that shows as a 'replicates to' relationship from the store, or a Backup field on it.",
    severity: "medium",
    packs: ["nca"],
    run: ({ objects, all }) =>
      objects
        .filter((o) => (o.typeId === "database" || o.typeId === "storage") && (o.tags.includes("tier-1") || SENSITIVE.has(dataLens(o).classification)))
        .filter((o) => !all.some((r) => r.kind === "replicates_to" && r.sourceId === o.id) && !Object.entries(o.fields).some(([key, value]) => /backup/i.test(key) && value.trim()))
        .map((o) => ({ message: `${o.name} shows no copy: nothing it replicates to, and no Backup field.`, objectIds: [o.id], relationshipIds: [] })),
  },
  {
    id: "nca-resilience",
    title: "What is critical says how available it has to be",
    why: "ECC 3-1, Cybersecurity Resilience Aspects of Business Continuity Management: continuity is planned for what matters most. An availability figure on each tier-1 object is the smallest sign that it was thought about, and lets Health work out what the chain can deliver.",
    severity: "low",
    packs: ["nca"],
    run: ({ objects }) =>
      objects
        .filter((o) => o.tags.includes("tier-1") && o.typeId !== "actor" && declaredAvailability(o) === null)
        .map((o) => ({ message: `${o.name} is tier-1 and has no availability written down.`, objectIds: [o.id], relationshipIds: [] })),
  },
  {
    id: "agent-trifecta",
    title: "No AI agent combines private data, untrusted content and a way out",
    why: "An agent that reads text it cannot trust, can reach private data and can send to the outside can be told by a planted instruction to leak that data. Taking away any one of the three removes the risk.",
    severity: "high",
    packs: ["ai", "security"],
    run: ({ ws, objects, all }) =>
      objects
        .filter((o) => o.typeId === "ai-agent")
        .map((o) => agentReach(ws, o, all))
        .filter((reach) => reach.untrusted && reach.sensitive && reach.outward)
        .map((reach) => ({
          message: `${reach.agent.name} has all three: ${reach.untrusted}; ${reach.sensitive}; and ${reach.outward}. Remove one of the three, or put a person's approval before anything is sent.`,
          objectIds: [reach.agent.id, ...reach.touched.filter((t) => t.typeId === "external-system" || SENSITIVE.has(dataLens(t).classification) || dataLens(t).personal === "yes").map((t) => t.id)],
          relationshipIds: reach.relationshipIds,
        })),
  },
  {
    id: "agent-undeclared",
    title: "Every AI agent says what it reads and whether it can send outside",
    why: "Until someone says so, the check has to guess both from the drawing, and a guess can miss a tool the drawing does not show.",
    severity: "medium",
    packs: ["ai"],
    run: ({ objects }) =>
      objects
        .filter((o) => o.typeId === "ai-agent" && (!agentLens(o).untrusted || !agentLens(o).outward))
        .map((o) => ({ message: `${o.name} does not say ${[!agentLens(o).untrusted && "whether it reads untrusted content", !agentLens(o).outward && "whether it can send outside"].filter(Boolean).join(" or ")}.`, objectIds: [o.id], relationshipIds: [] })),
  },
  {
    id: "agent-model",
    title: "Every AI agent shows the model it uses",
    why: "Where prompts and data are sent, and under whose terms, depends on the model and who hosts it.",
    severity: "low",
    packs: ["ai"],
    run: ({ ws, objects, all }) =>
      objects
        .filter((o) => o.typeId === "ai-agent" && !all.some((r) => r.sourceId === o.id && ws.objects[r.targetId]?.typeId === "ai-model"))
        .map((o) => ({ message: `${o.name} is not connected to an AI model.`, objectIds: [o.id], relationshipIds: [] })),
  },
  {
    id: "pci-scope",
    title: "What touches card data is marked as in scope",
    why: "Anything connected to a system tagged pci is in scope for the same controls unless something separates them.",
    severity: "medium",
    packs: ["pci"],
    run: ({ ws, relationships }) =>
      relationships
        .filter((r) => {
          const a = ws.objects[r.sourceId];
          const b = ws.objects[r.targetId];
          if (!a || !b || isPci(a) === isPci(b)) return false;
          const other = isPci(a) ? b : a;
          return !["gateway", "network", "actor"].includes(other.typeId);
        })
        .map((r) => {
          const [a, b] = [ws.objects[r.sourceId], ws.objects[r.targetId]];
          const [inScope, other] = isPci(a) ? [a, b] : [b, a];
          return { message: `${other.name} is connected to ${inScope.name}, which is tagged pci, but is not tagged pci itself.`, objectIds: [other.id, inScope.id], relationshipIds: [r.id] };
        }),
  },
  {
    id: "pci-classified",
    title: "Card data is classified as restricted",
    why: "Card data is the most tightly controlled data most organisations hold.",
    severity: "medium",
    packs: ["pci"],
    run: ({ objects }) => objects.filter((o) => isPci(o) && DATA_STORES.has(o.typeId) && dataLens(o).classification !== "Restricted").map((o) => ({ message: `${o.name} is tagged pci and is not classified as restricted.`, objectIds: [o.id], relationshipIds: [] })),
  },
];

/**
 * Runs the rules of the chosen packs. With a diagram, only the objects it shows and the
 * relationships between them are checked; without one, the whole model.
 */
export function runChecks(ws: Workspace, diagram: Diagram | null, packs: PackId[]): Finding[] {
  const shown = diagram ? new Set(Object.keys(diagram.nodes).filter((id) => ws.objects[id])) : null;
  const all = Object.values(ws.relationships).filter((r) => ws.objects[r.sourceId] && ws.objects[r.targetId]);
  const scope: Scope = {
    ws,
    objects: Object.values(ws.objects).filter((o) => !shown || shown.has(o.id)),
    relationships: all.filter((r) => !shown || (shown.has(r.sourceId) && shown.has(r.targetId))),
    all,
  };
  const order = { high: 0, medium: 1, low: 2 };
  // The workspace's own rules are its policy: they run whichever packs are ticked, each with its own switch.
  const own = Object.values(ws.rules ?? {})
    .filter((rule) => rule.enabled)
    .flatMap((rule) => runCustomCheck(ws, rule.check, scope.objects, scope.relationships).map((f) => ({ ...f, ruleId: rule.id, severity: rule.severity })));
  return RULES.filter((rule) => rule.packs.some((p) => packs.includes(p)))
    .flatMap((rule) => rule.run(scope).map((f): Finding => ({ ...f, ruleId: rule.id, severity: rule.severity })))
    .concat(own)
    .sort((a, b) => order[a.severity] - order[b.severity] || a.ruleId.localeCompare(b.ruleId) || a.message.localeCompare(b.message));
}
export const rulesOf = (packs: PackId[]) => RULES.filter((rule) => rule.packs.some((p) => packs.includes(p)));
/** How many rules a run covers: the ticked packs, and the workspace's own rules that are switched on. */
export const rulesRun = (packs: PackId[], ws?: Pick<Workspace, "rules">) => rulesOf(packs).length + Object.values(ws?.rules ?? {}).filter((r) => r.enabled).length;
/** A built-in rule, or one of the workspace's own when the workspace is given. */
export function ruleById(id: string, ws?: Pick<Workspace, "objects" | "rules">): Pick<Rule, "id" | "title" | "why" | "severity"> | undefined {
  const builtIn = RULES.find((r) => r.id === id);
  if (builtIn || !ws?.rules?.[id]) return builtIn;
  const own = ws.rules[id];
  return { id, title: own.title, why: `One of this workspace's own rules. ${describeRule(ws, own.check)}`, severity: own.severity };
}

export function findingsCsv(ws: Workspace, findings: Finding[]): string {
  return toCsv([
    ["Severity", "Rule", "Finding", "Objects", "Owners"],
    ...findings.map((f) => [
      f.severity,
      ruleById(f.ruleId, ws)?.title ?? f.ruleId,
      f.message,
      f.objectIds.map((id) => ws.objects[id]?.name ?? id).join("; "),
      [...new Set(f.objectIds.map((id) => ws.objects[id]?.owner.trim()).filter(Boolean))].join("; "),
    ]),
  ]);
}

/* ---------- the data map report ---------- */

export interface DataMapRow {
  object: ModelObject;
  lens: DataLens;
  partOf: string;
}
export interface DataFlow {
  relationship: Relationship;
  from: ModelObject;
  to: ModelObject;
  /** Why this flow is worth a look. */
  notes: string[];
}
/** Every object that holds data or says something about it, and the connections personal data may travel along. */
export function dataMap(ws: Workspace): { rows: DataMapRow[]; flows: DataFlow[] } {
  const rows = Object.values(ws.objects)
    .map((object) => ({ object, lens: dataLens(object), partOf: ancestorsOf(ws, object.id).map((id) => ws.objects[id].name).reverse().join(" / ") }))
    .filter((row) => DATA_STORES.has(row.object.typeId) || row.lens.classification || row.lens.personal || row.lens.residency)
    .sort((a, b) => Number(b.lens.personal === "yes") - Number(a.lens.personal === "yes") || a.object.name.localeCompare(b.object.name));
  const flows: DataFlow[] = [];
  for (const relationship of Object.values(ws.relationships)) {
    const from = ws.objects[relationship.sourceId];
    const to = ws.objects[relationship.targetId];
    if (!from || !to) continue;
    const [a, b] = [dataLens(from), dataLens(to)];
    if (a.personal !== "yes" && b.personal !== "yes") continue;
    const notes: string[] = [];
    if (a.residency && b.residency && a.residency.toLowerCase() !== b.residency.toLowerCase()) notes.push(`${a.residency} to ${b.residency}`);
    if (from.typeId === "external-system" || to.typeId === "external-system") notes.push("outside system");
    if (CLEAR_TEXT.test(relationship.protocol.trim())) notes.push("not encrypted");
    flows.push({ relationship, from, to, notes });
  }
  flows.sort((x, y) => y.notes.length - x.notes.length || x.from.name.localeCompare(y.from.name));
  return { rows, flows };
}
export function dataMapCsv(ws: Workspace): string {
  const { rows } = dataMap(ws);
  return toCsv([["Object", "Type", "Part of", "Owner", "Classification", "Personal data", "Residency"], ...rows.map((r) => [r.object.name, objectType(r.object.typeId).label, r.partOf, r.object.owner, r.lens.classification, r.lens.personal, r.lens.residency])]);
}
