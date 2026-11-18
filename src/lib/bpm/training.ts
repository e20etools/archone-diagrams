import type { DecisionTable, ProcessElementInfo, Workspace } from "../types";
import { buildBpmn, type ProcessSpec, type SpecStep } from "./bpmn";
import { createProcess } from "./processes";

/**
 * Small processes for learning BPMN, one part of the notation at a time: a decision, work at the
 * same time, one or more ways, deadlines, failures, other parties and their messages, waiting for
 * whichever comes first, data and rules, sub-processes, and loops. Each has typical times and
 * chances, so it can be simulated, and says what to notice in English and in Arabic.
 */

export interface TrainingExample {
  id: string;
  name: string;
  /** The part of BPMN it teaches, in a few words. */
  topic: string;
  description: string;
  /** What to look at in the model. */
  lesson: string;
  lessonAr: string;
  /** The BPMN library's elements it shows (ids of BPMN_ELEMENTS). */
  teaches: string[];
  spec: ProcessSpec;
  minutes: Record<string, [number, number, number]>;
  /** Percent per flow, by its place in spec.flows (0-based). */
  chances: Record<number, number>;
  decisions?: Record<string, DecisionTable>;
  /** Steps that apply a decision table: step id to table id. */
  rules?: Record<string, string>;
}

const s = (id: string, name: string, type: SpecStep["type"], lane?: string, trigger?: string): SpecStep => ({ id, name, type, lane, trigger });
const on = (id: string, name: string, attachedTo: string, trigger: string, interrupting = true): SpecStep => ({ id, name, type: "boundaryEvent", attachedTo, trigger, interrupting });
const f = (from: string, to: string, name?: string) => ({ from, to, name });

export const TRAINING_AREA = "BPMN training";
export const TRAINING_TAG = "bpmn-training";

export const TRAINING_EXAMPLES: TrainingExample[] = [
  {
    id: "leave-request",
    name: "1. Leave request",
    topic: "A decision: the exclusive gateway",
    description: "An employee asks for leave, the manager decides, and HR records it.",
    lesson:
      "The diamond with an X is an exclusive gateway: exactly one way out is taken. It is named as a question and each flow out of it with its answer. Each lane is a role, and every step sits in the lane of whoever does it. The process starts with one start event and can end in two places, each named by the state it ends in.",
    lessonAr:
      "المعيّن الذي بداخله علامة X هو بوابة حصرية (Exclusive Gateway): يُسلك منها طريق واحد فقط. تُسمّى البوابة بسؤال، ويُسمّى كل مسار خارج منها بالجواب. كل مسار سباحة (Lane) يمثل دوراً، وكل خطوة توضع في مسار من يقوم بها. للعملية حدث بداية واحد، ويمكن أن تنتهي في مكانين، كلٌّ منهما يُسمّى بالحالة التي تنتهي إليها.",
    teaches: ["start-none", "user-task", "service-task", "send-task", "exclusive-gateway", "end-none", "lane", "sequence-flow"],
    spec: {
      name: "Leave request",
      lanes: ["Employee", "Manager", "HR"],
      steps: [
        s("start", "Leave needed", "startEvent", "Employee"),
        s("submit", "Submit the leave request", "userTask", "Employee"),
        s("review", "Review the request", "userTask", "Manager"),
        s("ok", "Approved?", "exclusiveGateway", "Manager"),
        s("record", "Record the leave", "serviceTask", "HR"),
        s("tell", "Tell the employee", "sendTask", "HR"),
        s("approved", "Leave approved", "endEvent", "HR"),
        s("explain", "Explain the refusal", "sendTask", "Manager"),
        s("refused", "Leave refused", "endEvent", "Manager"),
      ],
      flows: [f("start", "submit"), f("submit", "review"), f("review", "ok"), f("ok", "record", "Yes"), f("ok", "explain", "No"), f("record", "tell"), f("tell", "approved"), f("explain", "refused")],
    },
    minutes: { submit: [3, 5, 10], review: [10, 30, 120], record: [1, 2, 5], tell: [1, 1, 2], explain: [5, 10, 20] },
    chances: { 3: 85, 4: 15 },
  },
  {
    id: "onboarding-parallel",
    name: "2. Getting a new employee ready",
    topic: "Work at the same time: the parallel gateway",
    description: "Accounts, a laptop and a desk are prepared at the same time before the first day.",
    lesson:
      "The diamond with a plus is a parallel gateway. The first one starts all the ways out at once; the second waits until every one of them has arrived before the work goes on. Splitting with one parallel gateway and joining with another keeps the model honest: the welcome cannot start until all three things are done.",
    lessonAr:
      "المعيّن الذي بداخله علامة + هو بوابة متوازية (Parallel Gateway). الأولى تبدأ كل المسارات الخارجة منها في الوقت نفسه، والثانية تنتظر وصول جميع المسارات قبل أن يستمر العمل. التفريع ببوابة متوازية والدمج بأخرى يجعل النموذج دقيقاً: لا يبدأ الترحيب حتى تكتمل الأعمال الثلاثة كلها.",
    teaches: ["parallel-gateway", "manual-task", "service-task", "user-task", "lane"],
    spec: {
      name: "Getting a new employee ready",
      lanes: ["HR", "IT", "Facilities", "Manager"],
      steps: [
        s("start", "Contract signed", "startEvent", "HR"),
        s("prepare", "Plan the first day", "userTask", "HR"),
        s("split", "", "parallelGateway", "HR"),
        s("accounts", "Create the accounts", "serviceTask", "IT"),
        s("laptop", "Set up the laptop", "manualTask", "IT"),
        s("desk", "Prepare the desk and badge", "manualTask", "Facilities"),
        s("join", "", "parallelGateway", "HR"),
        s("welcome", "Welcome the new employee", "userTask", "Manager"),
        s("end", "Employee started", "endEvent", "Manager"),
      ],
      flows: [f("start", "prepare"), f("prepare", "split"), f("split", "accounts"), f("split", "laptop"), f("split", "desk"), f("accounts", "join"), f("laptop", "join"), f("desk", "join"), f("join", "welcome"), f("welcome", "end")],
    },
    minutes: { prepare: [15, 30, 60], accounts: [5, 15, 60], laptop: [30, 60, 180], desk: [20, 45, 120], welcome: [30, 60, 90] },
    chances: {},
  },
  {
    id: "claim-inclusive",
    name: "3. Insurance claim",
    topic: "One or more ways: the inclusive gateway",
    description: "A claim may cover a car, injuries and property, in any combination, and each is assessed.",
    lesson:
      "The diamond with a circle is an inclusive gateway: one or more ways out are taken, as many as apply. A claim for a car and an injury takes two. The inclusive gateway that joins waits only for the ways that were taken. Use it when the choices are not exclusive; use an exclusive gateway when only one can be true.",
    lessonAr:
      "المعيّن الذي بداخله دائرة هو بوابة شاملة (Inclusive Gateway): يُسلك منها طريق واحد أو أكثر بحسب ما ينطبق. مطالبة تخص سيارة وإصابة تسلك طريقين. البوابة الشاملة التي تدمج تنتظر فقط الطرق التي سُلكت. استخدمها حين لا تكون الخيارات متعارضة، واستخدم البوابة الحصرية حين لا يصح إلا خيار واحد.",
    teaches: ["inclusive-gateway", "start-message", "user-task", "service-task"],
    spec: {
      name: "Insurance claim",
      lanes: ["Claims", "Assessors", "Finance"],
      steps: [
        s("start", "Claim received", "startEvent", "Claims", "message"),
        s("register", "Register the claim", "userTask", "Claims"),
        s("what", "What was damaged?", "inclusiveGateway", "Claims"),
        s("car", "Assess the car", "userTask", "Assessors"),
        s("injury", "Assess the injuries", "userTask", "Assessors"),
        s("property", "Assess the property", "userTask", "Assessors"),
        s("merge", "", "inclusiveGateway", "Claims"),
        s("pay", "Pay the claim", "serviceTask", "Finance"),
        s("end", "Claim settled", "endEvent", "Finance"),
      ],
      flows: [f("start", "register"), f("register", "what"), f("what", "car", "Car"), f("what", "injury", "Injuries"), f("what", "property", "Property"), f("car", "merge"), f("injury", "merge"), f("property", "merge"), f("merge", "pay"), f("pay", "end")],
    },
    minutes: { register: [5, 10, 20], car: [60, 120, 480], injury: [60, 180, 600], property: [60, 120, 360], pay: [2, 5, 15] },
    chances: { 2: 70, 3: 30, 4: 40 },
  },
  {
    id: "purchase-deadlines",
    name: "4. Purchase approval with deadlines",
    topic: "Time: timer events on the edge of a task and in the flow",
    description: "A purchase waits for approval, with a daily reminder and a last day, then for its delivery date.",
    lesson:
      "A clock on the edge of a task is a timer boundary event. The dashed one does not interrupt: every working day it sends a reminder while the approval goes on. The solid one interrupts: after five days the approval stops and the request expires. The clock in the flow after the order is an intermediate timer event: the process waits there until the delivery date.",
    lessonAr:
      "الساعة على حافة المهمة هي حدث مؤقت حدّي (Timer Boundary Event). المتقطعة لا تقاطع المهمة: كل يوم عمل ترسل تذكيراً بينما تستمر الموافقة. والمتصلة تقاطعها: بعد خمسة أيام تتوقف الموافقة وينتهي الطلب. والساعة داخل المسار بعد الطلب هي حدث مؤقت وسيط: تنتظر العملية عنده حتى موعد التسليم.",
    teaches: ["boundary-timer", "boundary-timer-non-interrupting", "intermediate-catch-timer", "exclusive-gateway", "send-task"],
    spec: {
      name: "Purchase approval with deadlines",
      lanes: ["Requester", "Approver", "Purchasing"],
      steps: [
        s("start", "Purchase needed", "startEvent", "Requester"),
        s("request", "Fill in the purchase request", "userTask", "Requester"),
        s("approve", "Approve the purchase", "userTask", "Approver"),
        on("daily", "Every working day", "approve", "timer", false),
        on("expire", "5 days passed", "approve", "timer"),
        s("ok", "Approved?", "exclusiveGateway", "Approver"),
        s("order", "Place the order", "serviceTask", "Purchasing"),
        s("due", "Delivery date reached", "intermediateCatchEvent", "Purchasing", "timer"),
        s("check", "Check the delivery", "userTask", "Purchasing"),
        s("received", "Goods received", "endEvent", "Purchasing"),
        s("refused", "Request refused", "endEvent", "Approver"),
        s("nudge", "Remind the approver", "sendTask", "Approver"),
        s("nudged", "Reminder sent", "endEvent", "Approver"),
        s("cancel", "Tell the requester it expired", "sendTask", "Requester"),
        s("expired", "Request expired", "endEvent", "Requester"),
      ],
      flows: [f("start", "request"), f("request", "approve"), f("approve", "ok"), f("ok", "order", "Yes"), f("ok", "refused", "No"), f("order", "due"), f("due", "check"), f("check", "received"), f("daily", "nudge"), f("nudge", "nudged"), f("expire", "cancel"), f("cancel", "expired")],
    },
    minutes: { request: [5, 10, 20], approve: [30, 240, 2880], order: [2, 5, 10], check: [10, 20, 40], nudge: [1, 1, 1], cancel: [1, 2, 5] },
    chances: { 3: 90, 4: 10 },
  },
  {
    id: "payment-errors",
    name: "5. Online payment that can fail",
    topic: "Failures: the error boundary event",
    description: "A card payment is refused, the customer is asked for another card, and may try again.",
    lesson:
      "The lightning on the edge of Charge the card is an error boundary event: when the payment service reports an error, the task stops and the process takes the error path instead of the normal one. The flow back from Try again? to Charge the card is a loop. A loop back is drawn underneath so that it does not cross the main path.",
    lessonAr:
      "علامة البرق على حافة مهمة «Charge the card» هي حدث خطأ حدّي (Error Boundary Event): عندما تُبلغ خدمة الدفع عن خطأ تتوقف المهمة وتسلك العملية مسار الخطأ بدل المسار العادي. والمسار الراجع من «Try again?» إلى «Charge the card» حلقة تكرار، وتُرسم من الأسفل حتى لا تتقاطع مع المسار الرئيسي.",
    teaches: ["boundary-error", "service-task", "send-task", "exclusive-gateway", "start-message"],
    spec: {
      name: "Online payment that can fail",
      lanes: ["Web shop", "Payment service", "Customer service"],
      steps: [
        s("start", "Customer pays", "startEvent", "Web shop", "message"),
        s("charge", "Charge the card", "serviceTask", "Payment service"),
        on("refused", "Payment refused", "charge", "error"),
        s("confirm", "Confirm the order", "sendTask", "Web shop"),
        s("paid", "Order paid", "endEvent", "Web shop"),
        s("ask", "Ask for another card", "sendTask", "Customer service"),
        s("again", "Try again?", "exclusiveGateway", "Customer service"),
        s("cancelled", "Order cancelled", "endEvent", "Customer service"),
      ],
      flows: [f("start", "charge"), f("charge", "confirm"), f("confirm", "paid"), f("refused", "ask"), f("ask", "again"), f("again", "charge", "Yes"), f("again", "cancelled", "No")],
    },
    minutes: { charge: [0.1, 0.2, 1], confirm: [0.1, 0.1, 0.2], ask: [1, 5, 30] },
    chances: { 5: 60, 6: 40 },
  },
  {
    id: "supplier-messages",
    name: "6. Ordering from a supplier",
    topic: "Other parties: pools and message flows",
    description: "The buyer and the supplier exchange an order, a confirmation, the goods, an invoice and the payment.",
    lesson:
      "The supplier is another party, so it gets its own pool, drawn closed because we do not model its work. Dashed arrows with a small circle are message flows: they only ever go between pools. Sequence flows, the solid arrows, stay inside one pool. A send task sends a message; an envelope event or a receive task waits for one.",
    lessonAr:
      "المورّد طرف آخر، لذلك له حوض (Pool) خاص به، ويُرسم مغلقاً لأننا لا نمذج عمله. الأسهم المتقطعة ذات الدائرة الصغيرة هي تدفقات رسائل (Message Flows)، ولا تكون إلا بين الأحواض. أما تدفقات التسلسل (الأسهم المتصلة) فتبقى داخل حوض واحد. مهمة الإرسال ترسل رسالة، وحدث الظرف أو مهمة الاستلام ينتظر رسالة.",
    teaches: ["pool", "message-flow", "send-task", "receive-task", "intermediate-catch-message", "start-conditional"],
    spec: {
      name: "Ordering from a supplier",
      lanes: ["Buyer", "Accounts payable"],
      partners: [{ id: "supplier", name: "Supplier" }],
      steps: [
        s("start", "Stock is low", "startEvent", "Buyer", "conditional"),
        s("write", "Write the purchase order", "userTask", "Buyer"),
        s("send", "Send the order", "sendTask", "Buyer"),
        s("confirmed", "Confirmation received", "intermediateCatchEvent", "Buyer", "message"),
        s("goods", "Receive the goods", "receiveTask", "Buyer"),
        s("invoice", "Invoice received", "intermediateCatchEvent", "Accounts payable", "message"),
        s("pay", "Pay the invoice", "sendTask", "Accounts payable"),
        s("end", "Order paid", "endEvent", "Accounts payable"),
      ],
      flows: [f("start", "write"), f("write", "send"), f("send", "confirmed"), f("confirmed", "goods"), f("goods", "invoice"), f("invoice", "pay"), f("pay", "end")],
      messages: [f("send", "supplier", "Purchase order"), f("supplier", "confirmed", "Confirmation"), f("supplier", "goods", "Delivery"), f("supplier", "invoice", "Invoice"), f("pay", "supplier", "Payment")],
    },
    minutes: { write: [10, 20, 40], send: [1, 1, 2], goods: [15, 30, 60], pay: [5, 10, 20] },
    chances: {},
  },
  {
    id: "quote-event-gateway",
    name: "7. Following up a quote",
    topic: "Whichever comes first: the event-based gateway",
    description: "After a quote is sent, the customer accepts, declines, or says nothing for ten days.",
    lesson:
      "The diamond with a pentagon is an event-based gateway: the process waits at it for the first of the events that follow, and that one decides the way. Here the customer's acceptance or refusal arrives as a message, or ten days pass. Unlike an exclusive gateway, nothing is checked: what happens first wins.",
    lessonAr:
      "المعيّن الذي بداخله شكل خماسي هو بوابة قائمة على الأحداث (Event-based Gateway): تنتظر العملية عندها أول حدث يقع من الأحداث التي تليها، وهو الذي يحدد الطريق. هنا تصل موافقة العميل أو رفضه كرسالة، أو تمر عشرة أيام. وعلى خلاف البوابة الحصرية لا يُفحص أي شرط: ما يحدث أولاً هو الذي يفوز.",
    teaches: ["event-based-gateway", "intermediate-catch-message", "intermediate-catch-timer", "pool", "message-flow"],
    spec: {
      name: "Following up a quote",
      lanes: ["Sales", "Order desk"],
      partners: [{ id: "customer", name: "Customer" }],
      steps: [
        s("start", "Quote requested", "startEvent", "Sales", "message"),
        s("prepare", "Prepare the quote", "userTask", "Sales"),
        s("send", "Send the quote", "sendTask", "Sales"),
        s("wait", "", "eventBasedGateway", "Sales"),
        s("yes", "Customer accepts", "intermediateCatchEvent", "Sales", "message"),
        s("no", "Customer declines", "intermediateCatchEvent", "Sales", "message"),
        s("silent", "10 days without an answer", "intermediateCatchEvent", "Sales", "timer"),
        s("book", "Book the order", "serviceTask", "Order desk"),
        s("won", "Order won", "endEvent", "Order desk"),
        s("lost", "Quote lost", "endEvent", "Sales"),
        s("call", "Call the customer", "userTask", "Sales"),
        s("followed", "Quote followed up", "endEvent", "Sales"),
      ],
      flows: [f("start", "prepare"), f("prepare", "send"), f("send", "wait"), f("wait", "yes"), f("wait", "no"), f("wait", "silent"), f("yes", "book"), f("book", "won"), f("no", "lost"), f("silent", "call"), f("call", "followed")],
      messages: [f("customer", "start", "Request"), f("send", "customer", "Quote"), f("customer", "yes", "Acceptance"), f("customer", "no", "Refusal")],
    },
    minutes: { prepare: [30, 60, 240], send: [1, 2, 5], book: [5, 10, 20], call: [5, 10, 20] },
    chances: { 3: 55, 4: 25, 5: 20 },
  },
  {
    id: "loan-data",
    name: "8. Loan application",
    topic: "Data, rules and notes",
    description: "An application is captured, scored by a decision table against the credit bureau, and offered or declined.",
    lesson:
      "The page with a folded corner is a data object: the application form of this one case. The cylinders are data stores, kept beyond the case: the credit bureau and the loan contracts. Dotted arrows show which step reads or writes them. Score the applicant is a business rule task: it applies the decision table Credit score, in the Decisions tab. The brackets on the left of a note are text annotations: they explain without changing the flow.",
    lessonAr:
      "الورقة ذات الزاوية المطوية هي كائن بيانات (Data Object): نموذج الطلب لهذه الحالة وحدها. والأسطوانات هي مخازن بيانات (Data Store) تبقى بعد انتهاء الحالة: مكتب الائتمان وعقود القروض. وتبيّن الأسهم المنقطة أي خطوة تقرأ منها أو تكتب فيها. ومهمة «Score the applicant» مهمة قاعدة أعمال (Business Rule Task): تطبّق جدول القرار «Credit score» الموجود في تبويب Decisions. والأقواس بجانب الملاحظات هي تعليقات نصية (Text Annotation): تشرح دون أن تغيّر المسار.",
    teaches: ["data-object", "data-store", "data-association", "business-rule-task", "text-annotation", "association"],
    spec: {
      name: "Loan application",
      lanes: ["Branch", "Credit"],
      steps: [
        s("start", "Application received", "startEvent", "Branch", "message"),
        s("capture", "Capture the application", "userTask", "Branch"),
        s("score", "Score the applicant", "businessRuleTask", "Credit"),
        s("enough", "Score high enough?", "exclusiveGateway", "Credit"),
        s("offer", "Prepare the offer", "userTask", "Branch"),
        s("offered", "Offer sent", "endEvent", "Branch", "message"),
        s("decline", "Write the refusal letter", "userTask", "Credit"),
        s("declined", "Application declined", "endEvent", "Credit"),
      ],
      flows: [f("start", "capture"), f("capture", "score"), f("score", "enough"), f("enough", "offer", "Yes"), f("enough", "decline", "No"), f("offer", "offered"), f("decline", "declined")],
      data: [
        { id: "form", name: "Loan application", kind: "object", writes: ["capture"], reads: ["score"] },
        { id: "bureau", name: "Credit bureau", kind: "store", reads: ["score"] },
        { id: "contracts", name: "Loan contracts", kind: "store", writes: ["offer"] },
      ],
      notes: [
        { id: "note_score", on: "score", text: "Applies the decision table Credit score: under 600 is declined." },
        { id: "note_capture", on: "capture", text: "The applicant's identity is checked first." },
      ],
    },
    minutes: { capture: [10, 20, 40], score: [0.5, 1, 2], offer: [20, 40, 90], decline: [5, 10, 20] },
    chances: { 3: 70, 4: 30 },
    decisions: {
      dmn_credit: {
        id: "dmn_credit",
        name: "Credit score",
        hitPolicy: "UNIQUE",
        inputs: [{ id: "in_score", label: "Score", type: "number" }],
        outputs: [{ id: "out_outcome", label: "Outcome", type: "string" }],
        rules: [
          { id: "r1", inputs: [">= 600"], outputs: ['"offer"'], note: "Good enough for an offer" },
          { id: "r2", inputs: ["< 600"], outputs: ['"decline"'], note: "Too low" },
        ],
      },
    },
    rules: { score: "dmn_credit" },
  },
  {
    id: "incident-subprocess",
    name: "9. IT incident",
    topic: "Sub-processes, calling another process, and signals",
    description: "An incident is logged, a major one is announced to everyone, fixed by the team, or passed to the vendor.",
    lesson:
      "Diagnose and fix is a collapsed sub-process (the small plus): its own steps are modelled inside it, so this level stays readable. Vendor support has a thick border: it is a call activity, which runs a separate process kept on its own and reused by others. The triangle event is a signal: it is broadcast to everyone listening, unlike a message, which goes to one party.",
    lessonAr:
      "«Diagnose and fix» عملية فرعية مطوية (Collapsed Sub-process)، وتدل عليها علامة + الصغيرة: خطواتها مُنمذجة داخلها حتى يبقى هذا المستوى سهل القراءة. أما «Vendor support» فحدّها سميك: إنها نشاط استدعاء (Call Activity) يشغّل عملية مستقلة محفوظة وحدها وتستخدمها عمليات أخرى. والحدث ذو المثلث إشارة (Signal) تُبث لكل من يستمع، بخلاف الرسالة التي تذهب إلى طرف واحد.",
    teaches: ["sub-process", "call-activity", "intermediate-throw-signal", "exclusive-gateway", "text-annotation"],
    spec: {
      name: "IT incident",
      lanes: ["Service desk", "Support team"],
      steps: [
        s("start", "Incident reported", "startEvent", "Service desk", "message"),
        s("log", "Log and classify", "userTask", "Service desk"),
        s("major", "Major incident?", "exclusiveGateway", "Service desk"),
        s("alert", "Major incident announced", "intermediateThrowEvent", "Service desk", "signal"),
        s("diagnose", "Diagnose and fix", "subProcess", "Support team"),
        s("fixed", "Fixed by the team?", "exclusiveGateway", "Support team"),
        s("vendor", "Vendor support", "callActivity", "Support team"),
        s("confirm", "Confirm with the user", "userTask", "Service desk"),
        s("closed", "Incident closed", "endEvent", "Service desk"),
      ],
      flows: [f("start", "log"), f("log", "major"), f("major", "alert", "Yes"), f("major", "diagnose", "No"), f("alert", "diagnose"), f("diagnose", "fixed"), f("fixed", "confirm", "Yes"), f("fixed", "vendor", "No"), f("vendor", "confirm"), f("confirm", "closed")],
      notes: [{ id: "note_vendor", on: "vendor", text: "Runs the process Vendor escalation, kept and changed on its own." }],
    },
    minutes: { log: [3, 5, 10], diagnose: [30, 90, 480], vendor: [240, 960, 2880], confirm: [5, 10, 30] },
    chances: { 2: 10, 3: 90, 6: 85, 7: 15 },
  },
  {
    id: "document-loop",
    name: "10. Document review",
    topic: "Loops and the terminate end event",
    description: "A document goes back to its author until it is approved, or the review is stopped for good.",
    lesson:
      "Changes needed sends the work back to the author: a loop, drawn underneath. The thick circle with a filled dot is a terminate end event: reaching it stops the whole process at once, even work still running in another branch. A plain end event only ends its own path.",
    lessonAr:
      "مسار «Changes needed» يعيد العمل إلى المؤلف: حلقة تكرار تُرسم من الأسفل. والدائرة السميكة ذات النقطة الممتلئة هي حدث نهاية إنهائي (Terminate End Event): الوصول إليه يوقف العملية كلها فوراً، حتى العمل الجاري في فرع آخر. أما حدث النهاية العادي فينهي مساره فقط.",
    teaches: ["end-terminate", "exclusive-gateway", "sequence-flow", "user-task"],
    spec: {
      name: "Document review",
      lanes: ["Author", "Reviewer"],
      steps: [
        s("start", "Draft ready", "startEvent", "Author"),
        s("submit", "Submit for review", "userTask", "Author"),
        s("review", "Review the document", "userTask", "Reviewer"),
        s("verdict", "Outcome?", "exclusiveGateway", "Reviewer"),
        s("publish", "Publish the document", "serviceTask", "Reviewer"),
        s("published", "Document published", "endEvent", "Reviewer"),
        s("stop", "Review stopped", "endEvent", "Reviewer", "terminate"),
        s("revise", "Revise the document", "userTask", "Author"),
      ],
      flows: [f("start", "submit"), f("submit", "review"), f("review", "verdict"), f("verdict", "publish", "Approved"), f("verdict", "revise", "Changes needed"), f("verdict", "stop", "Rejected"), f("publish", "published"), f("revise", "submit")],
      notes: [{ id: "note_stop", on: "stop", text: "Stops the whole process at once." }],
    },
    minutes: { submit: [1, 2, 5], review: [30, 60, 240], publish: [1, 2, 5], revise: [30, 90, 240] },
    chances: { 3: 50, 4: 40, 5: 10 },
  },
];

/** An example's BPMN file and what the app keeps about its steps: times, chances and the decision tables they apply. */
export function fromExample(t: TrainingExample): { xml: string; elements: Record<string, ProcessElementInfo>; decisions: Record<string, DecisionTable> } {
  const elements: Record<string, ProcessElementInfo> = {};
  for (const [id, [min, mode, max]] of Object.entries(t.minutes)) elements[id] = { objectIds: [], raci: {}, duration: { min, mode, max } };
  for (const [index, probability] of Object.entries(t.chances)) elements[`Flow_${Number(index) + 1}`] = { objectIds: [], raci: {}, probability };
  for (const [step, decisionId] of Object.entries(t.rules ?? {})) elements[step] = { ...(elements[step] ?? { objectIds: [], raci: {} }), decisionId };
  return { xml: buildBpmn(t.spec), elements, decisions: t.decisions ?? {} };
}

/** What a learner reads in the process's description: what it is, and what to notice, in English and Arabic. */
export const exampleDescription = (t: TrainingExample) => `${t.description}\n\nWhat to notice (${t.topic}): ${t.lesson}\n\nما الذي تلاحظه: ${t.lessonAr}`;

/**
 * Adds the training examples under one process area, "BPMN training". Examples already there (by
 * name) are left as they are, so adding them again only brings back the ones that were removed.
 */
export function addTrainingExamples(ws: Workspace, only?: string[]): { ws: Workspace; areaId: string; added: string[] } {
  let next = ws;
  let area = Object.values(ws.processes).find((p) => p.level === 0 && p.tags.includes(TRAINING_TAG));
  if (!area) {
    const made = createProcess(next, {
      name: TRAINING_AREA,
      level: 0,
      category: "support",
      tags: [TRAINING_TAG],
      description: "Ten small processes for learning BPMN, one part of the notation each. Open one, read what to notice in its details, then change it and see what the checks and the simulation say.\n\nعشر عمليات صغيرة لتعلّم BPMN، كل واحدة تشرح جزءاً من الترميز. افتح إحداها واقرأ ما الذي تلاحظه في تفاصيلها، ثم عدّلها وانظر ما تقوله الفحوصات والمحاكاة.",
    });
    next = made.ws;
    area = made.process;
  }
  const have = new Set(Object.values(next.processes).filter((p) => p.parentId === area!.id).map((p) => p.name));
  const added: string[] = [];
  for (const t of TRAINING_EXAMPLES) {
    if ((only && !only.includes(t.id)) || have.has(t.name)) continue;
    const made = createProcess(next, { name: t.name, level: 2, parentId: area.id, category: "support", tags: [TRAINING_TAG, t.id], description: exampleDescription(t), owner: "Training", ...fromExample(t) });
    next = made.ws;
    added.push(made.process.id);
  }
  return { ws: next, areaId: area.id, added };
}
