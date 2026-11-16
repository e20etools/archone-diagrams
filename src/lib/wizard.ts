import { viewCategory } from "./categories";
import { LIBRARY, componentById, exactComponent, type LibraryComponent } from "./library";
import { nowIso } from "./model";
import { USUAL_COMPONENT, type Perspective, type Template, type TemplateObject } from "./templates";
import { VIEW_TYPES, type RelationKind, type ViewType, type WizardConfig, type WizardStepConfig, type Workspace } from "./types";

/**
 * The guided way to build a diagram: a few questions for the kind of diagram chosen, each
 * answered with a list of names. Every answer becomes a library component, so the result holds
 * only library components, and each question says how its answers connect to the others. The
 * questions are the workspace's own when an owner has set them in Settings, otherwise the
 * built-in ones below. The result is a template made on the spot.
 */

export type WizardStep = WizardStepConfig;

export interface WizardItem {
  name: string;
  /** The library component chosen for it; when left empty, the name or the step decides. */
  componentId?: string;
}

const link = (to: string, kind: RelationKind, label = "", how: "each" | "spread" = "each") => ({ to, kind, label, how });

const PEOPLE: WizardStep = { id: "people", title: "People", question: "Who uses it?", kinds: ["actor"], usual: USUAL_COMPONENT.actor, placeholder: "Customer", links: [] };
const EXTERNAL: WizardStep = { id: "external", title: "Other systems", question: "Which systems run by others does it rely on?", kinds: ["external-system", "system"], usual: USUAL_COMPONENT["external-system"], placeholder: "Payment provider", links: [] };
const SYSTEM: WizardStep = { id: "system", title: "The system", question: "Which system is this diagram about?", kinds: ["system"], usual: USUAL_COMPONENT.system, single: true, required: true, placeholder: "Online store", links: [] };

/** The questions the app comes with, for each kind of diagram. */
export const BUILT_IN_STEPS: Record<ViewType, WizardStep[]> = {
  landscape: [
    { id: "systems", title: "Systems", question: "Which systems does the organisation run?", kinds: ["system"], usual: USUAL_COMPONENT.system, required: true, placeholder: "Online store", links: [link("external", "calls")] },
    { ...PEOPLE, links: [link("systems", "calls", "Uses")] },
    EXTERNAL,
  ],
  context: [{ ...SYSTEM, links: [link("external", "calls")] }, { ...PEOPLE, links: [link("system", "calls", "Uses")] }, EXTERNAL],
  container: [
    SYSTEM,
    { ...PEOPLE, links: [link("front", "calls", "Uses")] },
    { id: "front", title: "Front ends", question: "What do people open: web or mobile apps?", kinds: ["web-app", "mobile-app"], usual: USUAL_COMPONENT["web-app"], placeholder: "Store website", inside: "system", links: [link("services", "calls")] },
    {
      id: "services",
      title: "Services",
      question: "Which services and applications do the work?",
      kinds: ["service", "application", "ai-agent", "gateway"],
      usual: USUAL_COMPONENT.service,
      placeholder: "Order service",
      inside: "system",
      links: [link("stores", "reads_writes"), link("external", "calls")],
    },
    { id: "stores", title: "Data stores", question: "Where is the data kept?", kinds: ["database", "cache", "storage", "queue"], usual: USUAL_COMPONENT.database, placeholder: "Orders database", inside: "system", links: [] },
    EXTERNAL,
  ],
  dataflow: [
    {
      id: "apps",
      title: "Applications",
      question: "Which applications use the data?",
      kinds: ["application", "service", "web-app", "system"],
      usual: USUAL_COMPONENT.application,
      required: true,
      placeholder: "Billing service",
      links: [link("stores", "reads_writes", "", "spread"), link("streams", "reads_writes", "Publishes")],
    },
    { id: "stores", title: "Data stores", question: "Where is the data kept?", kinds: ["database", "cache", "storage"], usual: USUAL_COMPONENT.database, required: true, placeholder: "Orders database", links: [link("copies", "replicates_to", "", "spread")] },
    { id: "streams", title: "Queues and streams", question: "Which queues or event streams carry it?", kinds: ["queue"], usual: USUAL_COMPONENT.queue, placeholder: "Order events", links: [] },
    { id: "copies", title: "Copies", question: "Where is it copied to, such as a warehouse or a backup?", kinds: ["database", "storage"], usual: "data.data-warehouse", placeholder: "Data warehouse", links: [] },
  ],
  deployment: [
    { id: "entry", title: "Entry points", question: "How does traffic come in: firewalls, load balancers, gateways?", kinds: ["gateway", "network"], usual: "network.load-balancer", placeholder: "Load balancer", links: [link("platforms", "routes_to")] },
    { id: "platforms", title: "Platforms", question: "What does it run on: clusters, servers, cloud services?", kinds: ["cluster", "server"], usual: USUAL_COMPONENT.cluster, required: true, placeholder: "Production cluster", links: [] },
    {
      id: "workloads",
      title: "What runs there",
      question: "Which applications and databases are hosted on them?",
      kinds: ["application", "service", "web-app", "database", "cache", "queue"],
      usual: USUAL_COMPONENT.service,
      placeholder: "Order service",
      links: [link("platforms", "hosted_on", "", "spread")],
    },
  ],
  business: [
    { id: "domain", title: "Domain", question: "Which business area does it belong to?", kinds: ["domain"], usual: USUAL_COMPONENT.domain, single: true, placeholder: "Sales", links: [] },
    { id: "process", title: "The process", question: "What is the process called?", kinds: ["process"], usual: USUAL_COMPONENT.process, single: true, required: true, placeholder: "Order to cash", inside: "domain", links: [] },
    { ...PEOPLE, question: "Who takes part?", links: [link("steps", "calls", "Performs", "spread")] },
    { id: "steps", title: "Steps", question: "What are its steps, in order?", kinds: ["task"], usual: USUAL_COMPONENT.task, required: true, placeholder: "Check the order", inside: "process", chain: true, links: [] },
  ],
  custom: [{ id: "parts", title: "Components", question: "Which components should it show? List them in the order they connect.", kinds: [], usual: USUAL_COMPONENT.application, required: true, placeholder: "Web portal", chain: true, links: [] }],
};

/** How each kind of diagram is drawn; not something the questions change. */
const DRAWN: Partial<Record<ViewType, { notation?: "bpmn"; direction: "TB" | "LR" }>> = { business: { notation: "bpmn", direction: "LR" }, deployment: { direction: "LR" } };

/** The questions for a kind of diagram: the workspace's own when it has set them. */
export function wizardSteps(viewType: ViewType, ws?: Pick<Workspace, "wizards">): WizardStep[] {
  return ws?.wizards?.[viewType]?.steps ?? BUILT_IN_STEPS[viewType];
}

export const hasOwnWizard = (viewType: ViewType, ws?: Pick<Workspace, "wizards">) => !!ws?.wizards?.[viewType];

/** The components offered for a step: general ones first, then cloud ones. */
export function stepComponents(step: Pick<WizardStep, "kinds">): LibraryComponent[] {
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
export function wizardProblem(viewType: ViewType, answers: WizardAnswers, ws?: Pick<Workspace, "wizards">): string | null {
  for (const step of wizardSteps(viewType, ws)) if (step.required && !clean(answers[step.id]).length) return `Answer "${step.question || step.title}" first.`;
  return null;
}

const PERSPECTIVE: Record<string, Perspective> = { applications: "applications", data: "data", infrastructure: "infrastructure", business: "business", custom: "applications" };

/** The answers as a template: one box per answer, each a library component, joined as the questions say. */
export function wizardTemplate(viewType: ViewType, name: string, answers: WizardAnswers, ws?: Pick<Workspace, "wizards">): Template {
  const steps = wizardSteps(viewType, ws);
  const drawn = DRAWN[viewType];
  const objects: TemplateObject[] = [];
  const keysOf: Record<string, string[]> = {};
  const byName = new Map<string, string>();
  for (const step of steps) {
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
  for (const step of steps) {
    const from = keysOf[step.id] ?? [];
    for (const l of step.links ?? []) {
      const to = keysOf[l.to] ?? [];
      if (!from.length || !to.length) continue;
      if (l.how === "spread") from.forEach((f, i) => add(f, to[i % to.length], l.kind, l.label));
      else for (const f of from) for (const t of to) add(f, t, l.kind, l.label);
    }
    if (step.chain) {
      const chain = from;
      if (drawn?.notation === "bpmn" && chain.length) {
        const start: TemplateObject = { key: `${step.id}-start`, name: "Start", typeId: "event", componentId: USUAL_COMPONENT.event };
        const end: TemplateObject = { key: `${step.id}-end`, name: "Done", typeId: "event", componentId: USUAL_COMPONENT.event };
        objects.push(start, end);
        [start.key, ...chain, end.key].forEach((k, i, all) => i > 0 && add(all[i - 1], k, "flows_to", ""));
      } else chain.forEach((k, i) => i > 0 && add(chain[i - 1], k, "calls", ""));
    }
  }
  // Answers that sit inside another step's answer: the containers inside a system, the steps inside a process.
  for (const step of steps) {
    const holder = step.inside ? keysOf[step.inside]?.[0] : undefined;
    if (!holder) continue;
    for (const k of keysOf[step.id] ?? []) {
      const o = objects.find((x) => x.key === k);
      if (o && !o.inside && o.key !== holder) o.inside = holder;
    }
  }
  return {
    id: "wizard",
    name: name.trim() || "New diagram",
    perspective: PERSPECTIVE[viewCategory(viewType)],
    about: "Built step by step with the wizard.",
    direction: drawn?.direction ?? "TB",
    ...(drawn?.notation ? { notation: drawn.notation } : {}),
    objects,
    relationships,
  };
}

/* ---------- editing the questions (Settings) ---------- */

/** What is wrong with a set of questions, in words; empty when they can be saved. */
export function wizardStepsProblems(steps: WizardStep[]): string[] {
  const problems: string[] = [];
  if (!steps.length) problems.push("Keep at least one step.");
  if (steps.length > 20) problems.push("A wizard can have up to 20 steps.");
  const ids = new Set<string>();
  for (const step of steps) {
    const label = step.title.trim() || "A step";
    if (!step.title.trim()) problems.push("Every step needs a title.");
    if (ids.has(step.id)) problems.push(`Two steps share the id ${step.id}.`);
    ids.add(step.id);
    const usual = componentById(step.usual);
    if (!usual) problems.push(`${label}: choose the component its answers usually become.`);
    else if (step.kinds.length && !step.kinds.includes(usual.kind)) problems.push(`${label}: its usual component is not one of the kinds it offers.`);
  }
  for (const step of steps) {
    const label = step.title.trim() || "A step";
    if (step.inside && (!ids.has(step.inside) || step.inside === step.id)) problems.push(`${label}: the step its answers sit inside no longer exists.`);
    for (const l of step.links ?? []) if (!ids.has(l.to) || l.to === step.id) problems.push(`${label}: a connection points to a step that no longer exists.`);
  }
  return [...new Set(problems)];
}

/** A step id that is not used yet. */
export function newStepId(steps: WizardStep[]): string {
  let n = steps.length + 1;
  while (steps.some((s) => s.id === `step${n}`)) n++;
  return `step${n}`;
}

/** Keeps the workspace's own questions for a kind of diagram. */
export function saveWizard(ws: Workspace, viewType: ViewType, steps: WizardStep[], author: string): Workspace {
  const config: WizardConfig = { id: viewType, steps, author: author.trim() || "Someone", updatedAt: nowIso() };
  return { ...ws, wizards: { ...(ws.wizards ?? {}), [viewType]: config }, updatedAt: nowIso() };
}

/** Goes back to the built-in questions for a kind of diagram. */
export function resetWizard(ws: Workspace, viewType: ViewType): Workspace {
  if (!ws.wizards?.[viewType]) return ws;
  const { [viewType]: _gone, ...rest } = ws.wizards;
  return { ...ws, wizards: rest, updatedAt: nowIso() };
}

export const WIZARD_KINDS = VIEW_TYPES;
