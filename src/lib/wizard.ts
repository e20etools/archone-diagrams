import { viewCategory } from "./categories";
import { LIBRARY, componentById, exactComponent, type LibraryComponent } from "./library";
import { USUAL_COMPONENT, type Perspective, type Template, type TemplateObject } from "./templates";
import type { RelationKind, ViewType } from "./types";

/**
 * The guided way to build a diagram: a few questions for the kind of diagram chosen, each
 * answered with a list of names. Every answer becomes a library component, so the result holds
 * only library components, and the questions say how the answers connect. The result is a
 * template made on the spot, put into the model the way any template is.
 */

export interface WizardItem {
  name: string;
  /** The library component chosen for it; when left empty, the name or the step decides. */
  componentId?: string;
}

export interface WizardStep {
  id: string;
  title: string;
  question: string;
  /** The kinds of component offered for this step's items. */
  kinds: string[];
  /** The component an item becomes when nothing more exact is chosen. */
  usual: string;
  /** Whether the step takes one item or a list. */
  single?: boolean;
  required?: boolean;
  placeholder: string;
}

/** A line between the items of two steps. */
interface Link {
  from: string;
  to: string;
  kind: RelationKind;
  label: string;
  /** "each": every item of one step to every item of the other. "spread": each item of "from" to one item of "to" in turn. "chain": the items of one step one after another. */
  how?: "each" | "spread";
}

interface Plan {
  steps: WizardStep[];
  links: Link[];
  /** For a C4 Level 2 diagram, the steps whose items sit inside the system. */
  inside?: { step: string; of: string };
  /** A process: its steps run one after another, between a start and an end. */
  chain?: string;
  notation?: "bpmn";
  direction?: "TB" | "LR";
}

const PEOPLE: WizardStep = { id: "people", title: "People", question: "Who uses it?", kinds: ["actor"], usual: USUAL_COMPONENT.actor, placeholder: "Customer" };
const EXTERNAL: WizardStep = { id: "external", title: "Other systems", question: "Which systems run by others does it rely on?", kinds: ["external-system", "system"], usual: USUAL_COMPONENT["external-system"], placeholder: "Payment provider" };
const SYSTEM: WizardStep = { id: "system", title: "The system", question: "Which system is this diagram about?", kinds: ["system"], usual: USUAL_COMPONENT.system, single: true, required: true, placeholder: "Online store" };
const STORES: WizardStep = { id: "stores", title: "Data stores", question: "Where is the data kept?", kinds: ["database", "cache", "storage"], usual: USUAL_COMPONENT.database, placeholder: "Orders database" };

const PLANS: Record<ViewType, Plan> = {
  landscape: {
    steps: [
      { id: "systems", title: "Systems", question: "Which systems does the organisation run?", kinds: ["system"], usual: USUAL_COMPONENT.system, required: true, placeholder: "Online store" },
      PEOPLE,
      EXTERNAL,
    ],
    links: [
      { from: "people", to: "systems", kind: "calls", label: "Uses" },
      { from: "systems", to: "external", kind: "calls", label: "" },
    ],
  },
  context: {
    steps: [SYSTEM, PEOPLE, EXTERNAL],
    links: [
      { from: "people", to: "system", kind: "calls", label: "Uses" },
      { from: "system", to: "external", kind: "calls", label: "" },
    ],
  },
  container: {
    steps: [
      SYSTEM,
      PEOPLE,
      { id: "front", title: "Front ends", question: "What do people open: web or mobile apps?", kinds: ["web-app", "mobile-app"], usual: USUAL_COMPONENT["web-app"], placeholder: "Store website" },
      { id: "services", title: "Services", question: "Which services and applications do the work?", kinds: ["service", "application", "ai-agent", "gateway"], usual: USUAL_COMPONENT.service, placeholder: "Order service" },
      { ...STORES, kinds: ["database", "cache", "storage", "queue"] },
      EXTERNAL,
    ],
    links: [
      { from: "people", to: "front", kind: "calls", label: "Uses" },
      { from: "front", to: "services", kind: "calls", label: "" },
      { from: "services", to: "stores", kind: "reads_writes", label: "" },
      { from: "services", to: "external", kind: "calls", label: "" },
    ],
    inside: { step: "front,services,stores", of: "system" },
  },
  dataflow: {
    steps: [
      { id: "apps", title: "Applications", question: "Which applications use the data?", kinds: ["application", "service", "web-app", "system"], usual: USUAL_COMPONENT.application, required: true, placeholder: "Billing service" },
      { ...STORES, required: true },
      { id: "streams", title: "Queues and streams", question: "Which queues or event streams carry it?", kinds: ["queue"], usual: USUAL_COMPONENT.queue, placeholder: "Order events" },
      { id: "copies", title: "Copies", question: "Where is it copied to, such as a warehouse or a backup?", kinds: ["database", "storage"], usual: "data.data-warehouse", placeholder: "Data warehouse" },
    ],
    links: [
      { from: "apps", to: "stores", kind: "reads_writes", label: "", how: "spread" },
      { from: "apps", to: "streams", kind: "reads_writes", label: "Publishes" },
      { from: "stores", to: "copies", kind: "replicates_to", label: "", how: "spread" },
    ],
  },
  deployment: {
    steps: [
      { id: "entry", title: "Entry points", question: "How does traffic come in: firewalls, load balancers, gateways?", kinds: ["gateway", "network"], usual: "network.load-balancer", placeholder: "Load balancer" },
      { id: "platforms", title: "Platforms", question: "What does it run on: clusters, servers, cloud services?", kinds: ["cluster", "server"], usual: USUAL_COMPONENT.cluster, required: true, placeholder: "Production cluster" },
      { id: "workloads", title: "What runs there", question: "Which applications and databases are hosted on them?", kinds: ["application", "service", "web-app", "database", "cache", "queue"], usual: USUAL_COMPONENT.service, placeholder: "Order service" },
    ],
    links: [
      { from: "entry", to: "platforms", kind: "routes_to", label: "" },
      { from: "workloads", to: "platforms", kind: "hosted_on", label: "", how: "spread" },
    ],
    direction: "LR",
  },
  business: {
    steps: [
      { id: "domain", title: "Domain", question: "Which business area does it belong to?", kinds: ["domain"], usual: USUAL_COMPONENT.domain, single: true, placeholder: "Sales" },
      { id: "process", title: "The process", question: "What is the process called?", kinds: ["process"], usual: USUAL_COMPONENT.process, single: true, required: true, placeholder: "Order to cash" },
      PEOPLE,
      { id: "steps", title: "Steps", question: "What are its steps, in order?", kinds: ["task"], usual: USUAL_COMPONENT.task, required: true, placeholder: "Check the order" },
    ],
    links: [
      { from: "people", to: "steps", kind: "calls", label: "Performs", how: "spread" },
    ],
    chain: "steps",
    notation: "bpmn",
    direction: "LR",
  },
  custom: {
    steps: [{ id: "parts", title: "Components", question: "Which components should it show? List them in the order they connect.", kinds: [], usual: USUAL_COMPONENT.application, required: true, placeholder: "Web portal" }],
    links: [],
    chain: "parts",
  },
};

export const wizardSteps = (viewType: ViewType): WizardStep[] => PLANS[viewType].steps;

/** The components offered for a step: general ones first, then cloud ones. */
export function stepComponents(step: WizardStep): LibraryComponent[] {
  const pool = step.kinds.length ? LIBRARY.filter((c) => step.kinds.includes(c.kind)) : LIBRARY;
  return [...pool.filter((c) => !c.provider), ...pool.filter((c) => c.provider)];
}

/** The library component an answer becomes: the one chosen, the one its name is exactly, or the step's usual one. */
export function componentFor(step: WizardStep, item: WizardItem): LibraryComponent {
  const chosen = componentById(item.componentId);
  if (chosen) return chosen;
  const named = exactComponent(item.name);
  if (named && (!step.kinds.length || step.kinds.includes(named.kind))) return named;
  return componentById(step.usual) ?? componentById(USUAL_COMPONENT.application)!;
}

export type WizardAnswers = Record<string, WizardItem[]>;

const clean = (items: WizardItem[] | undefined) => (items ?? []).map((i) => ({ ...i, name: i.name.trim() })).filter((i) => i.name);

/** What is still missing before the diagram can be built, or null. */
export function wizardProblem(viewType: ViewType, answers: WizardAnswers): string | null {
  for (const step of PLANS[viewType].steps) if (step.required && !clean(answers[step.id]).length) return `Answer "${step.question}" first.`;
  return null;
}

const PERSPECTIVE: Record<string, Perspective> = { applications: "applications", data: "data", infrastructure: "infrastructure", business: "business", custom: "applications" };

/** The answers as a template: one box per answer, each a library component, joined as the questions say. */
export function wizardTemplate(viewType: ViewType, name: string, answers: WizardAnswers): Template {
  const plan = PLANS[viewType];
  const objects: TemplateObject[] = [];
  const keysOf: Record<string, string[]> = {};
  const byName = new Map<string, string>();
  for (const step of plan.steps) {
    keysOf[step.id] = [];
    for (const item of clean(answers[step.id]).slice(0, step.single ? 1 : 40)) {
      // The same name given twice is one box.
      const seen = byName.get(item.name.toLowerCase());
      if (seen) {
        keysOf[step.id].push(seen);
        continue;
      }
      const c = componentFor(step, item);
      const key = `w${objects.length + 1}`;
      objects.push({ key, name: item.name, typeId: c.kind, componentId: c.id, technology: c.provider ? c.name : "" });
      byName.set(item.name.toLowerCase(), key);
      keysOf[step.id].push(key);
    }
  }
  const relationships: Template["relationships"] = [];
  const add = (from: string, to: string, kind: RelationKind, label: string) => {
    if (from !== to && !relationships.some(([f, t]) => f === from && t === to)) relationships.push([from, to, kind, label]);
  };
  for (const link of plan.links) {
    const from = keysOf[link.from] ?? [];
    const to = keysOf[link.to] ?? [];
    if (!from.length || !to.length) continue;
    if (link.how === "spread") from.forEach((f, i) => add(f, to[i % to.length], link.kind, link.label));
    else for (const f of from) for (const t of to) add(f, t, link.kind, link.label);
  }
  if (plan.chain) {
    const chain = keysOf[plan.chain] ?? [];
    if (plan.notation === "bpmn" && chain.length) {
      const start: TemplateObject = { key: "start", name: "Start", typeId: "event", componentId: USUAL_COMPONENT.event };
      const end: TemplateObject = { key: "end", name: "Done", typeId: "event", componentId: USUAL_COMPONENT.event };
      objects.push(start, end);
      [start.key, ...chain, end.key].forEach((k, i, all) => i > 0 && add(all[i - 1], k, "flows_to", ""));
    } else chain.forEach((k, i) => i > 0 && add(chain[i - 1], k, "calls", ""));
  }
  if (plan.inside) {
    const holder = keysOf[plan.inside.of]?.[0];
    if (holder) for (const step of plan.inside.step.split(",")) for (const k of keysOf[step] ?? []) {
      const o = objects.find((x) => x.key === k);
      if (o && !o.inside) o.inside = holder;
    }
  }
  // A process belongs to its domain; its steps to the process.
  if (viewType === "business") {
    const domain = keysOf.domain?.[0];
    const process = keysOf.process?.[0];
    for (const o of objects) {
      if (o.key === process && domain) o.inside = domain;
      else if (process && (keysOf.steps ?? []).includes(o.key)) o.inside = process;
    }
  }
  return {
    id: "wizard",
    name: name.trim() || "New diagram",
    perspective: PERSPECTIVE[viewCategory(viewType)],
    about: "Built step by step with the wizard.",
    direction: plan.direction ?? "TB",
    ...(plan.notation ? { notation: plan.notation } : {}),
    objects,
    relationships,
  };
}
