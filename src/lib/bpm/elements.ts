import { newId, nowIso } from "../model";
import { bpmnBlockSchema, type BpmnBlock, type LibraryItem, type ProcessElementInfo, type Workspace } from "../types";

/**
 * The BPMN library: every element of BPMN 2.0 a process model is drawn with, what it means and
 * when to use it, in English and Arabic, and how to put it on the canvas. It is separate from the
 * component library of diagrams. A workspace adds its own building blocks to it: steps it uses
 * again and again ("Approve in the ERP"), each with its kind, the role that does it, its time and
 * the systems it uses.
 */

export type BpmnGroup = "events" | "activities" | "gateways" | "data" | "swimlanes" | "artifacts" | "connections";

export const BPMN_GROUPS: { id: BpmnGroup; name: string; nameAr: string; about: string }[] = [
  { id: "events", name: "Events", nameAr: "الأحداث", about: "Something that happens: a start, a wait, a deadline, an end. Drawn as circles: thin at the start, double in between, thick at the end." },
  { id: "activities", name: "Activities", nameAr: "الأنشطة", about: "Work that is done: a task, a sub-process, or another process called. Drawn as rounded boxes; the icon says who or what does it." },
  { id: "gateways", name: "Gateways", nameAr: "البوابات", about: "Where the flow splits or joins. Drawn as diamonds; the sign inside says how many ways are taken." },
  { id: "data", name: "Data", nameAr: "البيانات", about: "What the work reads and writes: a document of one case, or a store kept beyond it." },
  { id: "swimlanes", name: "Pools and lanes", nameAr: "الأحواض والمسارات", about: "Who does the work: a pool for each party, a lane for each role inside it." },
  { id: "artifacts", name: "Notes and groups", nameAr: "الملاحظات والمجموعات", about: "Explanations that do not change the flow." },
  { id: "connections", name: "Connections", nameAr: "الروابط", about: "What follows what, the messages between parties, and which data a step uses. Drawn by dragging from one shape to another." },
];

export interface BpmnCreate {
  /** The BPMN type as bpmn-js names it: bpmn:UserTask. */
  type: string;
  eventDefinition?: string;
  isExpanded?: boolean;
  triggeredByEvent?: boolean;
  /** For a boundary event: false when it does not interrupt the activity. */
  cancelActivity?: boolean;
  /** A pool: made with the modeler's own participant shape. */
  participant?: boolean;
}

export interface BpmnElement {
  id: string;
  group: BpmnGroup;
  /** For events: start, intermediate, boundary or end. */
  family?: "start" | "intermediate" | "boundary" | "end";
  name: string;
  nameAr: string;
  /** The bpmn-font icon that draws its symbol. */
  icon: string;
  meaning: string;
  meaningAr: string;
  use: string;
  /** How to put it on the canvas, when it is a shape of its own. */
  create?: BpmnCreate;
  /** How to make it when it is not placed on its own (a flow, a lane). */
  how?: string;
}

const ev = (type: string, definition?: string, extra: Partial<BpmnCreate> = {}): BpmnCreate => ({ type, ...(definition ? { eventDefinition: `bpmn:${definition}EventDefinition` } : {}), ...extra });

export const BPMN_ELEMENTS: BpmnElement[] = [
  /* ---------- events: start ---------- */
  { id: "start-none", group: "events", family: "start", name: "Start event", nameAr: "حدث بداية", icon: "bpmn-icon-start-event-none", meaning: "Where the process begins, when nothing in particular sets it off.", meaningAr: "النقطة التي تبدأ منها العملية حين لا يطلقها شيء محدد.", use: "Name it with what made the work necessary: \"Leave needed\".", create: ev("bpmn:StartEvent") },
  { id: "start-message", group: "events", family: "start", name: "Message start event", nameAr: "حدث بداية برسالة", icon: "bpmn-icon-start-event-message", meaning: "The process begins when a message arrives: an order, a request, an e-mail.", meaningAr: "تبدأ العملية عند وصول رسالة: طلب أو بريد أو استمارة.", use: "Use it when someone outside sends something that starts the work.", create: ev("bpmn:StartEvent", "Message") },
  { id: "start-timer", group: "events", family: "start", name: "Timer start event", nameAr: "حدث بداية زمني", icon: "bpmn-icon-start-event-timer", meaning: "The process begins at a time or on a schedule: every month, on 1 January.", meaningAr: "تبدأ العملية في وقت محدد أو بشكل دوري: كل شهر أو في أول يناير.", use: "Use it for work done on a calendar, such as a month-end close.", create: ev("bpmn:StartEvent", "Timer") },
  { id: "start-signal", group: "events", family: "start", name: "Signal start event", nameAr: "حدث بداية بإشارة", icon: "bpmn-icon-start-event-signal", meaning: "The process begins when a signal is broadcast, wherever it came from.", meaningAr: "تبدأ العملية عند بث إشارة، أياً كان مصدرها.", use: "Use it when one event starts several processes at once.", create: ev("bpmn:StartEvent", "Signal") },
  { id: "start-conditional", group: "events", family: "start", name: "Conditional start event", nameAr: "حدث بداية شرطي", icon: "bpmn-icon-start-event-condition", meaning: "The process begins when a condition becomes true: stock below the minimum.", meaningAr: "تبدأ العملية عندما يصبح شرط ما صحيحاً: مثل انخفاض المخزون عن الحد الأدنى.", use: "Use it when a state, not a message or a time, starts the work.", create: ev("bpmn:StartEvent", "Conditional") },
  /* ---------- events: intermediate ---------- */
  { id: "intermediate-none", group: "events", family: "intermediate", name: "Intermediate event", nameAr: "حدث وسيط", icon: "bpmn-icon-intermediate-event-none", meaning: "A milestone reached in the middle of the process.", meaningAr: "علامة إنجاز تتحقق في منتصف العملية.", use: "Use it to mark a state worth reporting: \"Order checked\".", create: ev("bpmn:IntermediateThrowEvent") },
  { id: "intermediate-catch-message", group: "events", family: "intermediate", name: "Message received", nameAr: "استلام رسالة", icon: "bpmn-icon-intermediate-event-catch-message", meaning: "The process waits here until a message arrives.", meaningAr: "تنتظر العملية هنا حتى تصل رسالة.", use: "Use it for waiting on an answer, a confirmation or an invoice.", create: ev("bpmn:IntermediateCatchEvent", "Message") },
  { id: "intermediate-throw-message", group: "events", family: "intermediate", name: "Message sent", nameAr: "إرسال رسالة", icon: "bpmn-icon-intermediate-event-throw-message", meaning: "The process sends a message here and goes on at once.", meaningAr: "ترسل العملية رسالة هنا وتكمل فوراً.", use: "A send task does the same when sending takes work of its own.", create: ev("bpmn:IntermediateThrowEvent", "Message") },
  { id: "intermediate-catch-timer", group: "events", family: "intermediate", name: "Timer: wait", nameAr: "مؤقت: انتظار", icon: "bpmn-icon-intermediate-event-catch-timer", meaning: "The process waits for a time or a period: until the delivery date, for two days.", meaningAr: "تنتظر العملية وقتاً أو مدة: حتى موعد التسليم، أو لمدة يومين.", use: "Use it for planned waits, not for work that takes time.", create: ev("bpmn:IntermediateCatchEvent", "Timer") },
  { id: "intermediate-catch-signal", group: "events", family: "intermediate", name: "Signal received", nameAr: "استقبال إشارة", icon: "bpmn-icon-intermediate-event-catch-signal", meaning: "The process waits for a signal broadcast elsewhere.", meaningAr: "تنتظر العملية إشارة تُبث من مكان آخر.", use: "Use it when many processes react to one announcement.", create: ev("bpmn:IntermediateCatchEvent", "Signal") },
  { id: "intermediate-throw-signal", group: "events", family: "intermediate", name: "Signal sent", nameAr: "بث إشارة", icon: "bpmn-icon-intermediate-event-throw-signal", meaning: "The process broadcasts a signal to everyone listening.", meaningAr: "تبث العملية إشارة إلى كل من يستمع.", use: "A message goes to one party; a signal to all.", create: ev("bpmn:IntermediateThrowEvent", "Signal") },
  { id: "intermediate-throw-escalation", group: "events", family: "intermediate", name: "Escalation", nameAr: "تصعيد", icon: "bpmn-icon-intermediate-event-throw-escalation", meaning: "Raises the matter to a higher level, without stopping the work.", meaningAr: "يرفع الأمر إلى مستوى أعلى دون إيقاف العمل.", use: "Use it inside a sub-process, caught on its edge.", create: ev("bpmn:IntermediateThrowEvent", "Escalation") },
  { id: "intermediate-catch-conditional", group: "events", family: "intermediate", name: "Condition: wait", nameAr: "شرط: انتظار", icon: "bpmn-icon-intermediate-event-catch-condition", meaning: "The process waits until a condition becomes true.", meaningAr: "تنتظر العملية حتى يصبح شرط ما صحيحاً.", use: "Use it for waiting on a state: \"Stock available\".", create: ev("bpmn:IntermediateCatchEvent", "Conditional") },
  { id: "intermediate-link", group: "events", family: "intermediate", name: "Link", nameAr: "رابط", icon: "bpmn-icon-intermediate-event-throw-link", meaning: "Jumps from one place of a large diagram to another, like a page connector.", meaningAr: "ينقل من مكان في مخطط كبير إلى مكان آخر، مثل موصل الصفحات.", use: "Use a pair with the same name: one that throws, one that catches.", create: ev("bpmn:IntermediateThrowEvent", "Link") },
  /* ---------- events: boundary ---------- */
  { id: "boundary-timer", group: "events", family: "boundary", name: "Deadline (interrupting)", nameAr: "مهلة (مقاطِعة)", icon: "bpmn-icon-intermediate-event-catch-timer", meaning: "On the edge of a task: when the time is up, the task stops and the process goes another way.", meaningAr: "على حافة المهمة: عند انتهاء الوقت تتوقف المهمة وتسلك العملية طريقاً آخر.", use: "Drop it on the edge of a task. Use it for a last day.", create: ev("bpmn:BoundaryEvent", "Timer") },
  { id: "boundary-timer-non-interrupting", group: "events", family: "boundary", name: "Reminder (non-interrupting)", nameAr: "تذكير (غير مقاطِع)", icon: "bpmn-icon-intermediate-event-catch-non-interrupting-timer", meaning: "On the edge of a task, dashed: when the time comes something else starts, and the task goes on.", meaningAr: "على حافة المهمة بخط متقطع: عند حلول الوقت يبدأ شيء آخر وتستمر المهمة.", use: "Drop it on the edge of a task. Use it for reminders.", create: ev("bpmn:BoundaryEvent", "Timer", { cancelActivity: false }) },
  { id: "boundary-error", group: "events", family: "boundary", name: "Error", nameAr: "خطأ", icon: "bpmn-icon-intermediate-event-catch-error", meaning: "On the edge of an activity: when it fails, it stops and the error path is taken.", meaningAr: "على حافة النشاط: عند فشله يتوقف ويُسلك مسار الخطأ.", use: "Drop it on the edge of a task that can fail, such as a payment.", create: ev("bpmn:BoundaryEvent", "Error") },
  { id: "boundary-message", group: "events", family: "boundary", name: "Message (interrupting)", nameAr: "رسالة (مقاطِعة)", icon: "bpmn-icon-intermediate-event-catch-message", meaning: "On the edge of an activity: a message that arrives stops it, such as a cancellation.", meaningAr: "على حافة النشاط: رسالة تصل فتوقفه، مثل طلب إلغاء.", use: "Drop it on the edge of the work the message cancels.", create: ev("bpmn:BoundaryEvent", "Message") },
  { id: "boundary-message-non-interrupting", group: "events", family: "boundary", name: "Message (non-interrupting)", nameAr: "رسالة (غير مقاطِعة)", icon: "bpmn-icon-intermediate-event-catch-non-interrupting-message", meaning: "On the edge of an activity, dashed: a message starts extra work while the activity goes on.", meaningAr: "على حافة النشاط بخط متقطع: رسالة تبدأ عملاً إضافياً بينما يستمر النشاط.", use: "Use it for a question from the customer during the work.", create: ev("bpmn:BoundaryEvent", "Message", { cancelActivity: false }) },
  { id: "boundary-escalation", group: "events", family: "boundary", name: "Escalation (non-interrupting)", nameAr: "تصعيد (غير مقاطِع)", icon: "bpmn-icon-intermediate-event-catch-non-interrupting-escalation", meaning: "On the edge of a sub-process: catches an escalation raised inside it.", meaningAr: "على حافة العملية الفرعية: يلتقط تصعيداً يُرفع من داخلها.", use: "Drop it on the edge of a sub-process.", create: ev("bpmn:BoundaryEvent", "Escalation", { cancelActivity: false }) },
  /* ---------- events: end ---------- */
  { id: "end-none", group: "events", family: "end", name: "End event", nameAr: "حدث نهاية", icon: "bpmn-icon-end-event-none", meaning: "Where a path of the process ends.", meaningAr: "النقطة التي ينتهي عندها مسار من مسارات العملية.", use: "Name it with the state reached: \"Invoice paid\". A process can have several.", create: ev("bpmn:EndEvent") },
  { id: "end-message", group: "events", family: "end", name: "Message end event", nameAr: "حدث نهاية برسالة", icon: "bpmn-icon-end-event-message", meaning: "The path ends by sending a message.", meaningAr: "ينتهي المسار بإرسال رسالة.", use: "Use it when the last thing done is telling someone.", create: ev("bpmn:EndEvent", "Message") },
  { id: "end-error", group: "events", family: "end", name: "Error end event", nameAr: "حدث نهاية بخطأ", icon: "bpmn-icon-end-event-error", meaning: "The path ends with an error, caught on the edge of the sub-process around it.", meaningAr: "ينتهي المسار بخطأ يُلتقط على حافة العملية الفرعية المحيطة به.", use: "Use it inside a sub-process to report a failure to its caller.", create: ev("bpmn:EndEvent", "Error") },
  { id: "end-terminate", group: "events", family: "end", name: "Terminate end event", nameAr: "حدث نهاية إنهائي", icon: "bpmn-icon-end-event-terminate", meaning: "Stops the whole process at once, even work still running in other branches.", meaningAr: "يوقف العملية كلها فوراً، حتى العمل الجاري في فروع أخرى.", use: "Use it sparingly: for \"stop everything\".", create: ev("bpmn:EndEvent", "Terminate") },
  { id: "end-signal", group: "events", family: "end", name: "Signal end event", nameAr: "حدث نهاية بإشارة", icon: "bpmn-icon-end-event-signal", meaning: "The path ends by broadcasting a signal.", meaningAr: "ينتهي المسار ببث إشارة.", use: "Use it to start other processes when this one finishes.", create: ev("bpmn:EndEvent", "Signal") },
  { id: "end-escalation", group: "events", family: "end", name: "Escalation end event", nameAr: "حدث نهاية بتصعيد", icon: "bpmn-icon-end-event-escalation", meaning: "The path ends by raising an escalation to the level above.", meaningAr: "ينتهي المسار برفع تصعيد إلى المستوى الأعلى.", use: "Use it inside a sub-process.", create: ev("bpmn:EndEvent", "Escalation") },
  /* ---------- activities ---------- */
  { id: "task", group: "activities", name: "Task", nameAr: "مهمة", icon: "bpmn-icon-task", meaning: "A piece of work, when it does not matter who or what does it.", meaningAr: "عمل يُنجز، حين لا يهم من يقوم به أو ما الذي يقوم به.", use: "Name it with a verb and an object: \"Check the order\".", create: { type: "bpmn:Task" } },
  { id: "user-task", group: "activities", name: "User task", nameAr: "مهمة مستخدم", icon: "bpmn-icon-user-task", meaning: "A person does it with the help of a system: approve, review, fill in.", meaningAr: "يقوم بها شخص باستخدام نظام: موافقة أو مراجعة أو تعبئة نموذج.", use: "The most common task in office work.", create: { type: "bpmn:UserTask" } },
  { id: "service-task", group: "activities", name: "Service task", nameAr: "مهمة خدمة", icon: "bpmn-icon-service-task", meaning: "Software does it on its own: a call to a system, a calculation.", meaningAr: "يقوم بها برنامج بمفرده: استدعاء نظام أو عملية حسابية.", use: "Link it to the system that does it, in its step details.", create: { type: "bpmn:ServiceTask" } },
  { id: "manual-task", group: "activities", name: "Manual task", nameAr: "مهمة يدوية", icon: "bpmn-icon-manual-task", meaning: "Physical work with no system: pack a box, install a cable.", meaningAr: "عمل بدني لا يستخدم نظاماً: تغليف صندوق أو تركيب كابل.", use: "Use it when no software is involved at all.", create: { type: "bpmn:ManualTask" } },
  { id: "script-task", group: "activities", name: "Script task", nameAr: "مهمة برمجية", icon: "bpmn-icon-script-task", meaning: "A short script runs inside the process engine.", meaningAr: "تُنفَّذ شيفرة قصيرة داخل محرك العمليات.", use: "Mostly for automated processes; a service task is usually clearer.", create: { type: "bpmn:ScriptTask" } },
  { id: "business-rule-task", group: "activities", name: "Business rule task", nameAr: "مهمة قاعدة أعمال", icon: "bpmn-icon-business-rule-task", meaning: "Applies business rules, such as a decision table, to decide something.", meaningAr: "تطبّق قواعد الأعمال، مثل جدول قرار، لاتخاذ قرار ما.", use: "Link a decision table to it in its step details (DMN).", create: { type: "bpmn:BusinessRuleTask" } },
  { id: "send-task", group: "activities", name: "Send task", nameAr: "مهمة إرسال", icon: "bpmn-icon-send-task", meaning: "Sends a message to another party.", meaningAr: "ترسل رسالة إلى طرف آخر.", use: "Draw a message flow from it to the party's pool.", create: { type: "bpmn:SendTask" } },
  { id: "receive-task", group: "activities", name: "Receive task", nameAr: "مهمة استلام", icon: "bpmn-icon-receive-task", meaning: "Waits for a message from another party, and receives it.", meaningAr: "تنتظر رسالة من طرف آخر وتستلمها.", use: "A message event does the same when receiving is not work of its own.", create: { type: "bpmn:ReceiveTask" } },
  { id: "sub-process", group: "activities", name: "Sub-process (collapsed)", nameAr: "عملية فرعية (مطوية)", icon: "bpmn-icon-subprocess-collapsed", meaning: "A group of steps shown as one box with a plus; its inside is modelled on its own level.", meaningAr: "مجموعة خطوات تظهر كمربع واحد بعلامة +؛ ويُنمذج داخلها في مستواه الخاص.", use: "Use it to keep a level readable. Open it with the plus.", create: { type: "bpmn:SubProcess", isExpanded: false } },
  { id: "sub-process-expanded", group: "activities", name: "Sub-process (expanded)", nameAr: "عملية فرعية (موسّعة)", icon: "bpmn-icon-subprocess-expanded", meaning: "A group of steps drawn inside one large box, with its own start and end.", meaningAr: "مجموعة خطوات تُرسم داخل مربع كبير واحد، ولها بدايتها ونهايتها.", use: "Use it when the inside should be seen on the same page, or to catch events around a group.", create: { type: "bpmn:SubProcess", isExpanded: true } },
  { id: "event-sub-process", group: "activities", name: "Event sub-process", nameAr: "عملية فرعية للأحداث", icon: "bpmn-icon-event-subprocess-expanded", meaning: "Dotted box that starts when an event happens anywhere in its process, such as a cancellation.", meaningAr: "مربع منقط يبدأ عند وقوع حدث في أي مكان من عمليته، مثل طلب إلغاء.", use: "Put a start event inside it with what triggers it.", create: { type: "bpmn:SubProcess", isExpanded: true, triggeredByEvent: true } },
  { id: "call-activity", group: "activities", name: "Call activity", nameAr: "نشاط استدعاء", icon: "bpmn-icon-call-activity", meaning: "Runs another process, kept on its own and reused by others. Drawn with a thick border.", meaningAr: "يشغّل عملية أخرى محفوظة وحدها وتستخدمها عمليات أخرى. يُرسم بحدّ سميك.", use: "Choose the process it runs in its step details.", create: { type: "bpmn:CallActivity" } },
  { id: "transaction", group: "activities", name: "Transaction", nameAr: "معاملة", icon: "bpmn-icon-transaction", meaning: "A sub-process whose steps all succeed or are all undone, drawn with a double border.", meaningAr: "عملية فرعية إما أن تنجح كل خطواتها أو تُلغى جميعها، وتُرسم بحد مزدوج.", use: "Use it for bookings that must be cancelled together.", create: { type: "bpmn:Transaction", isExpanded: true } },
  /* ---------- gateways ---------- */
  { id: "exclusive-gateway", group: "gateways", name: "Exclusive gateway (XOR)", nameAr: "بوابة حصرية (XOR)", icon: "bpmn-icon-gateway-xor", meaning: "A decision: exactly one way out is taken. Joining, it lets each arrival through.", meaningAr: "قرار: يُسلك طريق واحد فقط من الطرق الخارجة. وعند الدمج يمرّر كل ما يصل إليه.", use: "Name it as a question; name each flow out with its answer.", create: { type: "bpmn:ExclusiveGateway" } },
  { id: "parallel-gateway", group: "gateways", name: "Parallel gateway (AND)", nameAr: "بوابة متوازية (AND)", icon: "bpmn-icon-gateway-parallel", meaning: "All ways out are taken at once; joining, it waits for every way in.", meaningAr: "تُسلك كل الطرق الخارجة في الوقت نفسه، وعند الدمج تنتظر وصول كل الطرق الداخلة.", use: "Split with one and join with another.", create: { type: "bpmn:ParallelGateway" } },
  { id: "inclusive-gateway", group: "gateways", name: "Inclusive gateway (OR)", nameAr: "بوابة شاملة (OR)", icon: "bpmn-icon-gateway-or", meaning: "One or more ways out are taken, as many as apply; joining, it waits for those taken.", meaningAr: "يُسلك طريق واحد أو أكثر بحسب ما ينطبق، وعند الدمج تنتظر الطرق التي سُلكت فقط.", use: "Use it when the choices can be true together.", create: { type: "bpmn:InclusiveGateway" } },
  { id: "event-based-gateway", group: "gateways", name: "Event-based gateway", nameAr: "بوابة قائمة على الأحداث", icon: "bpmn-icon-gateway-eventbased", meaning: "Waits for the first of the events after it; that one decides the way.", meaningAr: "تنتظر أول حدث يقع من الأحداث التي تليها، وهو الذي يحدد الطريق.", use: "Follow it with message and timer events: \"answer or timeout\".", create: { type: "bpmn:EventBasedGateway" } },
  { id: "complex-gateway", group: "gateways", name: "Complex gateway", nameAr: "بوابة مركّبة", icon: "bpmn-icon-gateway-complex", meaning: "A rule of its own decides the ways, such as \"go on when 3 of 5 have answered\".", meaningAr: "قاعدة خاصة تحدد الطرق، مثل «تابع عندما يرد 3 من 5».", use: "Rarely needed; write the rule in a note.", create: { type: "bpmn:ComplexGateway" } },
  /* ---------- data ---------- */
  { id: "data-object", group: "data", name: "Data object", nameAr: "كائن بيانات", icon: "bpmn-icon-data-object", meaning: "A document or record of this one case: the application form, the order.", meaningAr: "مستند أو سجل خاص بهذه الحالة وحدها: نموذج الطلب أو أمر الشراء.", use: "Connect it to the steps that write and read it.", create: { type: "bpmn:DataObjectReference" } },
  { id: "data-store", group: "data", name: "Data store", nameAr: "مخزن بيانات", icon: "bpmn-icon-data-store", meaning: "Where data is kept beyond the case: a database, a register, an archive.", meaningAr: "المكان الذي تُحفظ فيه البيانات بعد انتهاء الحالة: قاعدة بيانات أو سجل أو أرشيف.", use: "Name it after the system or register it stands for.", create: { type: "bpmn:DataStoreReference" } },
  /* ---------- pools and lanes ---------- */
  { id: "pool", group: "swimlanes", name: "Pool", nameAr: "حوض", icon: "bpmn-icon-participant", meaning: "One party: your organisation, a customer, a supplier. Messages travel between pools.", meaningAr: "طرف واحد: مؤسستك أو عميل أو مورّد. وتنتقل الرسائل بين الأحواض.", use: "Draw another party as a closed pool when its work is not yours to model.", create: { type: "bpmn:Participant", participant: true } },
  { id: "lane", group: "swimlanes", name: "Lane", nameAr: "مسار سباحة", icon: "bpmn-icon-lane", meaning: "A role or department inside a pool; each step sits in the lane of whoever does it.", meaningAr: "دور أو قسم داخل الحوض؛ وكل خطوة توضع في مسار من يقوم بها.", use: "Name lanes after roles, not people.", how: "Select a pool, then use its tool to add a lane above or below." },
  /* ---------- notes and groups ---------- */
  { id: "text-annotation", group: "artifacts", name: "Text annotation", nameAr: "تعليق نصي", icon: "bpmn-icon-text-annotation", meaning: "A note that explains a step, without changing the flow.", meaningAr: "ملاحظة تشرح خطوة دون أن تغيّر المسار.", use: "Connect it to what it explains with an association.", create: { type: "bpmn:TextAnnotation" } },
  { id: "group", group: "artifacts", name: "Group", nameAr: "مجموعة", icon: "bpmn-icon-group", meaning: "A dashed box around steps that belong together, for reading only.", meaningAr: "مربع متقطع حول خطوات مترابطة، للقراءة فقط.", use: "It has no effect on the flow.", create: { type: "bpmn:Group" } },
  /* ---------- connections ---------- */
  { id: "sequence-flow", group: "connections", name: "Sequence flow", nameAr: "تدفق تسلسلي", icon: "bpmn-icon-connection", meaning: "A solid arrow: what follows what, inside one pool.", meaningAr: "سهم متصل: يبيّن ما يلي ماذا، داخل حوض واحد.", use: "Out of a decision, name it with the answer.", how: "Drag from a shape's arrow tool to the next shape." },
  { id: "default-flow", group: "connections", name: "Default flow", nameAr: "التدفق الافتراضي", icon: "bpmn-icon-default-flow", meaning: "The way out of a decision taken when no other applies, marked with a slash.", meaningAr: "الطريق الخارج من القرار الذي يُسلك حين لا ينطبق غيره، ويُعلَّم بخط مائل.", use: "One per gateway.", how: "Select a flow out of a gateway and change it to a default flow with the wrench." },
  { id: "conditional-flow", group: "connections", name: "Conditional flow", nameAr: "تدفق شرطي", icon: "bpmn-icon-conditional-flow", meaning: "A flow out of a task that is taken only when its condition holds, marked with a small diamond.", meaningAr: "تدفق خارج من مهمة لا يُسلك إلا إذا تحقق شرطه، ويُعلَّم بمعين صغير.", use: "Most models use a gateway instead.", how: "Select a flow out of a task and change it to a conditional flow with the wrench." },
  { id: "message-flow", group: "connections", name: "Message flow", nameAr: "تدفق رسالة", icon: "bpmn-icon-connection-multi", meaning: "A dashed arrow with a small circle: a message between two pools.", meaningAr: "سهم متقطع بدائرة صغيرة: رسالة بين حوضين.", use: "Never inside one pool; there, use a sequence flow.", how: "Drag from a step to another pool, or from that pool to a step." },
  { id: "association", group: "connections", name: "Association", nameAr: "ارتباط", icon: "bpmn-icon-connection", meaning: "A dotted line that ties a note to what it explains.", meaningAr: "خط منقط يربط الملاحظة بما تشرحه.", use: "It carries nothing.", how: "Drag from a note to a step." },
  { id: "data-association", group: "connections", name: "Data association", nameAr: "ارتباط البيانات", icon: "bpmn-icon-connection", meaning: "A dotted arrow: a step writes into data, or reads from it.", meaningAr: "سهم منقط: خطوة تكتب في البيانات أو تقرأ منها.", use: "The arrow points the way the data goes.", how: "Drag from a step to a data object or store, or back." },
];

export const elementById = (id: string) => BPMN_ELEMENTS.find((e) => e.id === id);

/** The library element that a BPMN element of a model is: from its type, trigger and whether it interrupts. */
export function elementOf(type: string, trigger?: string, interrupting = true): BpmnElement | undefined {
  const t = type.charAt(0).toUpperCase() + type.slice(1);
  const definition = trigger ? `bpmn:${trigger.charAt(0).toUpperCase()}${trigger.slice(1)}EventDefinition` : undefined;
  return (
    BPMN_ELEMENTS.find((e) => e.create && e.create.type === `bpmn:${t}` && e.create.eventDefinition === definition && (e.create.cancelActivity ?? true) === interrupting) ??
    BPMN_ELEMENTS.find((e) => e.create && e.create.type === `bpmn:${t}` && !e.create.eventDefinition)
  );
}

/* ---------- the workspace's own building blocks ---------- */

export { bpmnBlockSchema, type BpmnBlock };

/** The workspace's own building blocks, newest first. */
export function ownBlocks(ws: Pick<Workspace, "library">): (LibraryItem & { bpmn: BpmnBlock })[] {
  return Object.values(ws.library ?? {})
    .filter((i): i is LibraryItem & { bpmn: BpmnBlock } => i.type === "bpmn" && !!i.bpmn && !i.removed)
    .sort((a, b) => a.bpmn.name.localeCompare(b.bpmn.name));
}

/** What a building block puts into a process's step details when it is placed. */
export function blockInfo(block: BpmnBlock): ProcessElementInfo {
  const info: ProcessElementInfo = { objectIds: [...block.info.objectIds], raci: block.role ? { [block.role]: "R" } : {} };
  if (block.info.duration) info.duration = block.info.duration;
  if (block.info.cost !== undefined) info.cost = block.info.cost;
  if (block.info.automation) info.automation = block.info.automation;
  if (block.info.notes) info.notes = block.info.notes;
  if (block.role) info.resource = block.role;
  return info;
}

/** A building block made from a step of a model, keeping its kind, name, role and details. */
export function blockFromStep(step: { type: string; name: string; trigger?: string }, role: string, info: ProcessElementInfo | undefined): BpmnBlock {
  const element = elementOf(step.type, step.trigger)?.id ?? "task";
  return bpmnBlockSchema.parse({
    name: step.name.trim() || elementById(element)?.name || "Step",
    element,
    role,
    info: { objectIds: info?.objectIds ?? [], duration: info?.duration, cost: info?.cost, automation: info?.automation, notes: info?.notes },
  });
}

/** Saves a building block in the workspace's BPMN library: a new one, or one already there by id. */
export function saveBlock(ws: Workspace, block: BpmnBlock, id?: string): { ws: Workspace; id: string } {
  const key = id && ws.library?.[id]?.type === "bpmn" ? id : newId("bpmn");
  const at = nowIso();
  const known = ws.library?.[key];
  const item: LibraryItem = { id: key, type: "bpmn", bpmn: bpmnBlockSchema.parse(block), createdAt: known?.createdAt ?? at, updatedAt: at };
  return { ws: { ...ws, library: { ...(ws.library ?? {}), [key]: item }, updatedAt: at }, id: key };
}

export function removeBlock(ws: Workspace, id: string): Workspace {
  if (ws.library?.[id]?.type !== "bpmn") return ws;
  const { [id]: _gone, ...rest } = ws.library;
  return { ...ws, library: rest, updatedAt: nowIso() };
}
