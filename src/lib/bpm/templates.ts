import type { ProcessElementInfo, Workspace } from "../types";
import { createProcess } from "./processes";
import { buildBpmn, type ProcessSpec, type SpecStep } from "./bpmn";

/**
 * Starting points for common processes, written for this app: each with its lanes, its steps,
 * a typical time for each step and the chance of each way out of a decision, so it can be
 * simulated at once and then changed to fit.
 */

export interface ProcessTemplate {
  id: string;
  name: string;
  area: string;
  category: "management" | "core" | "support";
  description: string;
  spec: ProcessSpec;
  /** Minutes per step id: least, most likely, most. */
  minutes: Record<string, [number, number, number]>;
  /** Percent per flow, by its place in spec.flows (0-based). */
  chances: Record<number, number>;
}

const s = (id: string, name: string, type: SpecStep["type"], lane?: string, trigger?: string): SpecStep => ({ id, name, type, lane, trigger });

export const PROCESS_TEMPLATES: ProcessTemplate[] = [
  {
    id: "order-to-cash",
    name: "Order to cash",
    area: "Sales",
    category: "core",
    description: "From a customer's order to the money in the bank: check, fulfil, invoice, collect.",
    spec: {
      name: "Order to cash",
      lanes: ["Sales", "Warehouse", "Finance"],
      steps: [
        s("start", "Order received", "startEvent", "Sales", "message"),
        s("check", "Check the order and credit", "userTask", "Sales"),
        s("ok", "Credit approved?", "exclusiveGateway", "Sales"),
        s("reject", "Tell the customer", "sendTask", "Sales"),
        s("rejected", "Order rejected", "endEvent", "Sales"),
        s("pick", "Pick and pack", "manualTask", "Warehouse"),
        s("ship", "Ship the goods", "userTask", "Warehouse"),
        s("invoice", "Send the invoice", "serviceTask", "Finance"),
        s("paid", "Payment received", "intermediateCatchEvent", "Finance", "message"),
        s("close", "Close the order", "serviceTask", "Finance"),
        s("end", "Order paid", "endEvent", "Finance"),
      ],
      flows: [
        { from: "start", to: "check" },
        { from: "check", to: "ok" },
        { from: "ok", to: "pick", name: "Yes" },
        { from: "ok", to: "reject", name: "No" },
        { from: "reject", to: "rejected" },
        { from: "pick", to: "ship" },
        { from: "ship", to: "invoice" },
        { from: "invoice", to: "paid" },
        { from: "paid", to: "close" },
        { from: "close", to: "end" },
      ],
    },
    minutes: { check: [5, 15, 40], pick: [20, 45, 120], ship: [10, 20, 60], invoice: [1, 2, 5], paid: [1440, 4320, 14400], close: [1, 2, 4] },
    chances: { 2: 90, 3: 10 },
  },
  {
    id: "procure-to-pay",
    name: "Procure to pay",
    area: "Finance",
    category: "support",
    description: "From a request to buy something to paying the supplier, with approval and a three-way match.",
    spec: {
      name: "Procure to pay",
      lanes: ["Requester", "Procurement", "Accounts payable"],
      steps: [
        s("start", "Need to buy", "startEvent", "Requester"),
        s("request", "Raise a purchase request", "userTask", "Requester"),
        s("approve", "Approve the request", "userTask", "Procurement"),
        s("approved", "Approved?", "exclusiveGateway", "Procurement"),
        s("declined", "Request declined", "endEvent", "Requester"),
        s("order", "Send the purchase order", "sendTask", "Procurement"),
        s("receive", "Receive the goods", "userTask", "Requester"),
        s("match", "Match order, receipt and invoice", "businessRuleTask", "Accounts payable"),
        s("matches", "Do they match?", "exclusiveGateway", "Accounts payable"),
        s("resolve", "Resolve the difference", "userTask", "Accounts payable"),
        s("pay", "Pay the supplier", "serviceTask", "Accounts payable"),
        s("end", "Supplier paid", "endEvent", "Accounts payable"),
      ],
      flows: [
        { from: "start", to: "request" },
        { from: "request", to: "approve" },
        { from: "approve", to: "approved" },
        { from: "approved", to: "order", name: "Yes" },
        { from: "approved", to: "declined", name: "No" },
        { from: "order", to: "receive" },
        { from: "receive", to: "match" },
        { from: "match", to: "matches" },
        { from: "matches", to: "pay", name: "Yes" },
        { from: "matches", to: "resolve", name: "No" },
        { from: "resolve", to: "match" },
        { from: "pay", to: "end" },
      ],
    },
    minutes: { request: [5, 10, 30], approve: [10, 60, 480], order: [1, 2, 5], receive: [1440, 4320, 10080], match: [1, 2, 5], resolve: [30, 120, 480], pay: [1, 2, 5] },
    chances: { 3: 85, 4: 15, 8: 80, 9: 20 },
  },
  {
    id: "incident",
    name: "Incident management",
    area: "IT service management",
    category: "support",
    description: "An IT incident from the first report to its resolution, with escalation to the second line (in the style of ITIL).",
    spec: {
      name: "Incident management",
      lanes: ["Service desk", "Second line"],
      steps: [
        s("start", "Incident reported", "startEvent", "Service desk", "message"),
        s("log", "Log and classify", "userTask", "Service desk"),
        s("known", "Known fix?", "exclusiveGateway", "Service desk"),
        s("fix1", "Apply the known fix", "userTask", "Service desk"),
        s("diagnose", "Investigate and diagnose", "userTask", "Second line"),
        s("fix2", "Resolve the incident", "userTask", "Second line"),
        s("join", "", "exclusiveGateway", "Service desk"),
        s("confirm", "Confirm with the user and close", "userTask", "Service desk"),
        s("end", "Incident closed", "endEvent", "Service desk"),
      ],
      flows: [
        { from: "start", to: "log" },
        { from: "log", to: "known" },
        { from: "known", to: "fix1", name: "Yes" },
        { from: "known", to: "diagnose", name: "No" },
        { from: "diagnose", to: "fix2" },
        { from: "fix1", to: "join" },
        { from: "fix2", to: "join" },
        { from: "join", to: "confirm" },
        { from: "confirm", to: "end" },
      ],
    },
    minutes: { log: [2, 5, 15], fix1: [5, 15, 45], diagnose: [30, 90, 480], fix2: [20, 60, 240], confirm: [2, 5, 20] },
    chances: { 2: 65, 3: 35 },
  },
  {
    id: "onboarding",
    name: "Employee onboarding",
    area: "Human resources",
    category: "support",
    description: "From a signed offer to a new joiner ready on day one: contract, accounts and equipment in parallel.",
    spec: {
      name: "Employee onboarding",
      lanes: ["HR", "IT", "Manager"],
      steps: [
        s("start", "Offer accepted", "startEvent", "HR"),
        s("contract", "Prepare the contract", "userTask", "HR"),
        s("fork", "", "parallelGateway", "HR"),
        s("accounts", "Create the accounts", "serviceTask", "IT"),
        s("laptop", "Prepare the laptop", "manualTask", "IT"),
        s("plan", "Plan the first weeks", "userTask", "Manager"),
        s("joinAll", "", "parallelGateway", "HR"),
        s("welcome", "Welcome on day one", "userTask", "Manager"),
        s("end", "Joiner ready", "endEvent", "Manager"),
      ],
      flows: [
        { from: "start", to: "contract" },
        { from: "contract", to: "fork" },
        { from: "fork", to: "accounts" },
        { from: "fork", to: "laptop" },
        { from: "fork", to: "plan" },
        { from: "accounts", to: "joinAll" },
        { from: "laptop", to: "joinAll" },
        { from: "plan", to: "joinAll" },
        { from: "joinAll", to: "welcome" },
        { from: "welcome", to: "end" },
      ],
    },
    minutes: { contract: [30, 60, 180], accounts: [1, 5, 30], laptop: [60, 120, 480], plan: [30, 60, 120], welcome: [60, 120, 240] },
    chances: {},
  },
  {
    id: "loan-origination",
    name: "Loan origination",
    area: "Lending",
    category: "core",
    description: "From a loan application to the money paid out: checks, a credit decision by rules, and an underwriter for the cases in between.",
    spec: {
      name: "Loan origination",
      lanes: ["Customer channel", "Credit", "Operations"],
      steps: [
        s("start", "Application received", "startEvent", "Customer channel", "message"),
        s("kyc", "Check identity (KYC)", "serviceTask", "Customer channel"),
        s("score", "Score the application", "businessRuleTask", "Credit"),
        s("decision", "Decision?", "exclusiveGateway", "Credit"),
        s("review", "Underwriter review", "userTask", "Credit"),
        s("reviewed", "Approved by the underwriter?", "exclusiveGateway", "Credit"),
        s("decline", "Send the decline letter", "sendTask", "Customer channel"),
        s("declined", "Application declined", "endEvent", "Customer channel"),
        s("offer", "Send the offer", "sendTask", "Customer channel"),
        s("signed", "Offer signed", "intermediateCatchEvent", "Customer channel", "message"),
        s("payout", "Pay out the loan", "serviceTask", "Operations"),
        s("end", "Loan paid out", "endEvent", "Operations"),
      ],
      flows: [
        { from: "start", to: "kyc" },
        { from: "kyc", to: "score" },
        { from: "score", to: "decision" },
        { from: "decision", to: "offer", name: "Approve" },
        { from: "decision", to: "review", name: "Refer" },
        { from: "decision", to: "decline", name: "Decline" },
        { from: "review", to: "reviewed" },
        { from: "reviewed", to: "offer", name: "Yes" },
        { from: "reviewed", to: "decline", name: "No" },
        { from: "decline", to: "declined" },
        { from: "offer", to: "signed" },
        { from: "signed", to: "payout" },
        { from: "payout", to: "end" },
      ],
    },
    minutes: { kyc: [1, 2, 10], score: [0.1, 0.2, 1], review: [30, 90, 480], decline: [1, 1, 2], offer: [1, 1, 2], signed: [60, 1440, 7200], payout: [1, 5, 30] },
    chances: { 3: 60, 4: 25, 5: 15, 7: 70, 8: 30 },
  },
  {
    id: "complaint",
    name: "Customer complaint handling",
    area: "Customer service",
    category: "core",
    description: "A complaint from the first contact to an answer the customer accepts, with a time limit to reply.",
    spec: {
      name: "Customer complaint handling",
      lanes: ["Customer service", "Specialist team"],
      steps: [
        s("start", "Complaint received", "startEvent", "Customer service", "message"),
        s("register", "Register and acknowledge", "userTask", "Customer service"),
        s("simple", "Can it be answered now?", "exclusiveGateway", "Customer service"),
        s("answer", "Answer the customer", "userTask", "Customer service"),
        s("investigate", "Investigate the complaint", "userTask", "Specialist team"),
        s("propose", "Propose a remedy", "userTask", "Specialist team"),
        s("join", "", "exclusiveGateway", "Customer service"),
        s("accepted", "Customer satisfied?", "exclusiveGateway", "Customer service"),
        s("close", "Close the complaint", "userTask", "Customer service"),
        s("end", "Complaint closed", "endEvent", "Customer service"),
      ],
      flows: [
        { from: "start", to: "register" },
        { from: "register", to: "simple" },
        { from: "simple", to: "answer", name: "Yes" },
        { from: "simple", to: "investigate", name: "No" },
        { from: "investigate", to: "propose" },
        { from: "answer", to: "join" },
        { from: "propose", to: "join" },
        { from: "join", to: "accepted" },
        { from: "accepted", to: "close", name: "Yes" },
        { from: "accepted", to: "investigate", name: "No" },
        { from: "close", to: "end" },
      ],
    },
    minutes: { register: [3, 5, 15], answer: [5, 15, 30], investigate: [60, 240, 1440], propose: [15, 30, 90], close: [2, 5, 10] },
    chances: { 2: 55, 3: 45, 8: 85, 9: 15 },
  },
];

/** A template's BPMN file and what the app keeps about its steps (times and chances). */
export function fromTemplate(t: ProcessTemplate): { xml: string; elements: Record<string, ProcessElementInfo> } {
  const elements: Record<string, ProcessElementInfo> = {};
  for (const [id, [min, mode, max]] of Object.entries(t.minutes)) elements[id] = { objectIds: [], raci: {}, duration: { min, mode, max } };
  for (const [index, probability] of Object.entries(t.chances)) elements[`Flow_${Number(index) + 1}`] = { objectIds: [], raci: {}, probability };
  return { xml: buildBpmn(t.spec), elements };
}

/**
 * A first landscape to look around in: areas for the three kinds of process, each holding the
 * templates that belong there, ready to open, simulate and change.
 */
export function sampleLandscape(ws: Workspace): Workspace {
  const areas: { name: string; owner: string; category: ProcessTemplate["category"]; description: string; templates: [string, string][] }[] = [
    { name: "Strategy and governance", owner: "Chief Executive", category: "management", description: "Setting direction, planning, and keeping the organisation compliant.", templates: [] },
    { name: "Sell and serve", owner: "Chief Commercial Officer", category: "core", description: "Everything from a customer's first order to keeping them happy.", templates: [["order-to-cash", "Head of Sales"], ["complaint", "Head of Customer Service"]] },
    { name: "Lend", owner: "Chief Risk Officer", category: "core", description: "Credit products, from application to payout.", templates: [["loan-origination", "Head of Lending"]] },
    { name: "Finance", owner: "Chief Financial Officer", category: "support", description: "Buying, paying and accounting.", templates: [["procure-to-pay", "Head of Procurement"]] },
    { name: "People and IT", owner: "Chief Operating Officer", category: "support", description: "The people who do the work and the tools they use.", templates: [["onboarding", "HR Director"], ["incident", "IT Service Manager"]] },
  ];
  let next = ws;
  for (const area of areas) {
    const a = createProcess(next, { name: area.name, level: 0, category: area.category, description: area.description, owner: area.owner });
    next = a.ws;
    for (const [id, owner] of area.templates) {
      const t = PROCESS_TEMPLATES.find((x) => x.id === id)!;
      next = createProcess(next, { name: t.name, level: 2, parentId: a.process.id, category: area.category, description: t.description, owner, ...fromTemplate(t) }).ws;
    }
  }
  return next;
}
