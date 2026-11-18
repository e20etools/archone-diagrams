# ArchONE Diagrams

A tool for building IT architecture diagrams from one shared model. Components and
dependencies are stored once; every diagram is a view of them. AI can draft a model from
a description or a picture, and a person reviews every suggestion before it is saved.

This repository holds **phase 1** of the PRD "IT Architecture Diagram Application" and the
first part of **phase 2**: accounts, shared workspaces with roles, a hosted database on
Supabase and real-time editing. Without a Supabase project configured it runs exactly as
phase 1 did, in the browser with no sign-in.

## What phase 1 does

| PRD item | What you get |
| --- | --- |
| FR-01, FR-02 | Objects (type, name, description, owner, lifecycle, tags, technology, custom fields) and relationships (kind, direction, label, protocol, port) stored once and reused by every diagram |
| FR-04 | Four nesting levels (domain, system, application or resource, component). "Open inside" zooms into an object and creates its inside view on first use |
| FR-05 | Tags, and search across objects and diagrams, with `tag:`, `type:`, `owner:` and `lifecycle:` filters |
| FR-07 | Drag-and-drop canvas. Dropping a type creates a model object; dropping an existing object links it |
| FR-08 | Six views of one model: landscape, context, inside a system, deployment, data flow, free-form |
| FR-09 | Automatic layout that leaves hand-placed boxes where they are |
| FR-15, FR-16 | Dependency view (what an object needs, what needs it) and impact report (affected objects, owners, diagrams, broken relationships) with CSV export |
| FR-31 | Read-only share links, optionally password-protected (AES-GCM). No account needed to view |
| FR-32 | Export to PNG, SVG, PDF, CSV, JSON, Mermaid and PlantUML |
| AI-01, AI-02 | Draft from a description or from an uploaded picture |
| AI-06, AI-07 | Every suggestion is accepted, edited or rejected before it is saved; each saved item records its prompt or file, the engine and the approver |

### What phase 1 does not do

- **No accounts and no shared database** unless hosted mode is set up (see below). The
  workspace is then kept in the browser (`localStorage`) on one device. Use
  Settings > Download backup to move or protect it.
- **Share links are snapshots** unless hosted mode is set up, which adds live links that can
  be switched off. In a snapshot link the diagram travels inside the link, so it cannot be
  switched off or updated after it is sent. FR-31 also names SSO protection; that comes
  with phase 3.
- **AI needs a key you provide.** Without one, text drafts are read by built-in rules that
  only catch plainly stated components and connections, and drafting from a picture is
  off. The AI path was tested here against a stand-in provider, not against a paid model.
- The interface is English only.

## What phase 2 adds (hosted mode)

Hosted mode switches on when the build has `VITE_SUPABASE_URL` and a Supabase key.

| PRD item | What you get |
| --- | --- |
| Accounts | Sign-up, sign-in and password reset with Supabase Auth |
| NFR-02 (first step) | Workspaces with four roles: owner, editor, commenter, viewer. Owners invite by email, change roles, remove members, and rename or delete the workspace. Enforced in the database with row-level security, not only in the screens |
| FR-27 | Real-time editing: each person's changes are saved as they work and appear on everyone else's screen. People see who else is in the workspace and on the same diagram |
| FR-28 | Comments on a diagram, a box or an arrow, with replies, resolving, and @mentions of members. Mentions show in the header; nothing is emailed |
| FR-29 | Versions: a named copy of the whole model, taken by the database. Compare a version with the model now or with another version, look at its diagrams, and (owners) revert to it |
| FR-30 | Review before publishing: an owner names up to five stages, each with a reviewer and a checklist. Editors submit the model; each reviewer approves, rejects with a reason, or hands the stage to someone else. Viewers and commenters see only the last approved version |
| FR-20 | Import and export by spreadsheet. Import an Excel workbook (.xlsx) or a CSV file and choose which column is which; export the whole model as a workbook that imports back. Works without hosted mode too |
| FR-21 | Import a Visio drawing (.vsdx) or a draw.io file (.drawio): each labelled shape becomes an object, each connector a relationship, and the diagram is redrawn with the boxes where they were. Works without hosted mode too |
| FR-24 | REST API with keys an owner creates (read, or read and write): objects, relationships and diagrams, with an OpenAPI description. Webhooks: a signed note to your address after every saved change |
| FR-25, FR-31 | Live links: a link that shows one diagram, read-only and up to date, to anyone who has it, until it is switched off. With an embed code for wiki pages |
| AI-05 | Ask the architecture: a question in plain words, answered from the model, with a link to every object the answer rests on. Works without hosted mode too |
| Hosted storage | One database row per object, relationship, diagram, placed box and AI draft |
| AI endpoint | With accounts on, `/api/ai` drafts only for signed-in people |

How it behaves, so nobody is surprised:

- **Two people, same thing:** the last save wins, per row. Moving different boxes on one
  diagram never conflicts; changing the same field of the same object does, and the later
  save stays.
- **Undo** only takes back your own edits.
- **Offline:** edits are kept in the open tab and saved when the connection returns. Closing
  the tab before then loses them; the browser warns first.
- **Invitations** send no email. The invited person signs up with that address and sees the
  invitation.
- **Commenter** reads like a viewer and can write, resolve and reply to comments.
- **Comments** stay with the box or arrow they are about, on every diagram that shows it. Only
  the author changes a comment's text; the author or an owner deletes it.
- **A version** holds objects, relationships and diagrams. AI drafts and comments are not part
  of it. Reverting saves the model as it is first, so a revert can be taken back.
- **With review on,** the model owners and editors work on is a draft. Viewers and commenters
  are shown the published version, and the database refuses them the draft rows, so this does
  not depend on the screens. One review is open at a time; work can continue during it, and
  later changes wait for the next submission. Switching review on publishes the model as it
  is, so readers keep seeing what they saw. A person may review their own submission if an
  owner names them as reviewer; the history shows who did what.
- **Not in this step:** review scoped to one diagram (a review covers the whole model), email
  for mentions and review requests, and the PRD's guest review link and evidence pack.
- **Deleting a workspace** (Settings, owners only) removes its model, diagrams, drafts,
  members and invitations for everyone, and cannot be undone. Members who have it open are
  returned to their list of workspaces.

### Ask the architecture

The **Ask** page answers a question about the model and links every object it mentions to
that object in the model and to its dependencies.

- **Read from the model, in the browser.** Questions of these kinds are worked out by
  following the model, with nothing sent anywhere and nothing guessed: what depends on an
  object, what it depends on, what a failure or a retirement touches and whose owners to
  tell, who owns it, what is inside it, which diagrams show it, how one object reaches
  another, and lists or counts by type, lifecycle, owner, tag, technology, or missing owner
  or description. Objects are found by their names as written in the model. These questions
  are understood in English only.
- **Other questions go to the AI model, if you allow it.** When a model is configured (see
  AI providers) the page shows a tick box, off until someone ticks it. With it on, a
  question the built-in reader cannot work out is sent to the provider together with the
  model as text: names, types, owners, lifecycle, technology, tags, descriptions,
  relationships and which diagram shows what. The server keeps none of it. The answer is
  marked as written by an AI model and can be wrong; the links are there to check it.
  A model too large to send whole (about 200,000 characters) is cut, and the answer says so.
- **Otherwise no answer is invented.** The page lists the objects whose words match the
  question and says why there is no answer.
- A person who is shown the published version (review on) is answered from that version.
- Answers are kept until the page is reloaded; they are not saved or shared.

## What phase 3 adds so far (hosted mode)

### Audit log (NFR-03)

Owners get an **Audit log** page: who changed what, and when, newest first, with the value
before and after for each changed field. It can be searched, filtered by what changed and
by date, and downloaded as CSV (up to 5,000 entries at a time).

- **The database writes the entries**, with triggers, so they do not depend on the app and
  cover changes made through the REST API as well. Those are recorded under the name of
  the API key that made them.
- **Recorded:** objects, relationships and diagrams (created, changed, deleted, restored),
  objects put on or taken off a diagram, members and their roles, invitations, the
  workspace's name and review settings, versions, each step of a review, API keys,
  webhooks and live links. Keys, link tokens and webhook secrets are never copied in.
- **Not recorded:** moving a box on a diagram (layout, not the model), comments, AI drafts
  that were never saved to the model, and who read what.
- **Nobody can change or remove an entry**, the database owner included, short of switching
  the trigger off by hand in SQL. An entry keeps the person's name as it was, also after
  their account is removed.
- **Only owners read it.** Editors, commenters and viewers get nothing, by the database's
  rule and not only in the screens.
- **Limits:** recording starts when this migration is applied; earlier changes are not in
  it. There is no retention period yet: entries are kept until the workspace is deleted,
  and deleting the workspace removes them with it. The log is not offered through the REST
  API. Browser-only mode has no audit log.

### Checks and the data map (FR-45, FR-49)

The **Checks** page runs rules against the whole model or one diagram (the diagram's
**Check** button opens it for that diagram) and lists findings by rule, with the reason for
the rule and links to the objects. Findings download as CSV. Works without hosted mode.

- **Rule packs:** Good practice (owners, descriptions, lifecycle, unconnected objects),
  Security baseline (unencrypted protocols, data stores reached from outside, missing
  classification, sensitive data on systems being phased out), Privacy (personal data
  without an owner or a region, crossing regions, going to outside systems) and Card data
  (what connects to anything tagged `pci`). AI agents (phase 4): an agent that reads
  untrusted content, reaches sensitive data and can send outside, all three at once; an
  agent whose reach nobody has declared; an agent with no model. Phase 4 also adds two
  to Good practice: facts nobody has confirmed for too long, and a dependency on another
  team that the team has not confirmed; and a pack for the Saudi NCA ECC (below). 27 rules
  in all, in
  `src/lib/checks/checks.ts`.
- **They are not a certificate.** The packs borrow the concerns of GDPR-style laws and
  PCI DSS in plain words. They see only what the model records.
- **Data fields:** every object has **Data it holds**: classification (public, internal,
  confidential, restricted), personal data (yes or no) and where it is kept. They are
  stored among the object's own fields, so they import, export and travel through the API
  like any other field.
- **Data map:** the second tab lists every data store and every object with a data field,
  and the relationships personal data may travel along, marked when they cross regions,
  reach an outside system or are not encrypted. A relationship has no data fields of its
  own yet; a flow is read from its two ends.
- Findings are worked out when the page is opened. They are not stored, and a check does
  not block saving or publishing.

### Scenarios (FR-17, hosted mode)

**Scenarios** copies the model into a workspace of its own, tied to the one it came from.
People change the copy to show a target state; its Scenarios page lists what it changes
compared with the main model as it is now.

- Owners and editors of the main workspace become members of the scenario. Viewers and
  commenters do not, so a scenario never shows them more than the published version does.
- Comments, versions and drafts are not copied. Later changes to members are not carried
  over either.
- Agreed changes are brought into the main model from the scenario's page, one tick each
  (see "Bringing a scenario into the main model" below). Deleting the main workspace
  deletes its scenarios; an owner deletes one scenario under Settings.
- A workspace can have 20 scenarios. A scenario cannot be branched again.

### Editors limited to domains (NFR-02, hosted mode)

Under Settings > Members an owner can limit an editor to one or more domains. That editor
then changes only objects inside those domains, at any depth, and relationships that start
or end there. They still read the whole model and may arrange diagrams. The database
enforces it; the app applies the same rule first, so a change outside the limit is not
made on screen and the person is told why. The limit goes when the role changes.

### MCP server for assistants (AI-09, hosted mode)

An AI assistant that speaks the Model Context Protocol connects to
`https://<project>.supabase.co/functions/v1/mcp` with an API key from Settings, sent as
`Authorization: Bearer <key>`. A read key gives it seven tools to read the model and
`list_proposals`; a propose key adds `propose_changes`; a write key adds seven more to
create, change and delete objects and relationships and to create diagrams. Any key can
ask `may_connect` and `show_diagram`. For business processes, any key can use `list_processes`
(with `uses` for the processes a system takes part in), `get_process` (the steps in order, who does
them, how long they take, the systems they use, the decisions and the checks) and `simulate_process`
(what if: more people in a role, a faster step, other shares at a decision, side by side; nothing is
saved); a write key adds `create_process` (from a list of steps, laid out as BPMN), `update_process`
(including review and publishing) and `delete_process`. 24 tools.

- It is the REST API under another protocol: the same database function answers, so the
  key's rights, the 300-a-minute limit, webhooks and the audit log apply unchanged. An
  assistant's changes are recorded under its key's name.
- Access is the key's, not a person's. Since phase 4 the default key **proposes**: what
  the assistant sends waits under AI → Proposals until a person accepts it, item by item,
  and nothing reaches the model before that. A write key still saves at once, but an owner
  can limit it to domains, exactly like an editor. Give an assistant a propose key unless
  it truly has to write.
- Streamable HTTP, one JSON reply per request, no sessions and no server-sent stream.
  Requests from a browser page are refused unless its origin is listed in the function's
  `MCP_ALLOWED_ORIGINS`.
- Deploy: `supabase functions deploy mcp --no-verify-jwt`. No secrets are needed.

### ArchiMate exchange (part of FR-10)

**Model > Export ArchiMate** writes an ArchiMate 3 Model Exchange File, the format Archi,
Bizzdesign, Sparx and others open, with the diagrams as views. **Import** reads such a
file into a draft, like a spreadsheet. Works without hosted mode.

- The two notations do not match one to one. Each object type goes out as one ArchiMate
  element (a database as system software, a domain as a grouping, and so on) and "A calls
  B" goes out as "B serves A". The exact type and kind travel as properties, so a file
  written here comes back as it left.
- From another tool, elements this app has no type for (goals, processes, and others)
  arrive as the nearest type or as an application, for a person to correct in the review.
  Elements with the same name become one object. Views are not imported.
- The export has been checked for structure and by reading it back, not by opening it in
  Archi or another tool.

### Notations: ArchiMate and BPMN (FR-10)

Diagram settings has **Notation**: boxes and lines, ArchiMate or BPMN. It changes how one
diagram is drawn for everyone; the model behind it stays the same, so one object can sit
on a plain diagram and an ArchiMate one. Works without hosted mode.

- **ArchiMate:** each box takes the colour of its layer (business, application,
  technology; a domain is a dashed grouping) and names its element. "A calls B" is drawn
  the ArchiMate way, as "B serves A" with the arrowhead at A; copies and routing are dashed
  flows. Elements keep the box shape with their name written on them; the small ArchiMate
  corner icons are not drawn.
- **BPMN:** four object types are added for it, **Process**, **Task**, **Event** and
  **Decision** (a gateway), and one relationship, **Then** (a sequence flow, which impact
  analysis does not follow). A task is a rounded box, an event a circle, a decision a
  diamond, a data store keeps a store shape; anything else stays a box. Sequence flows are
  solid arrows, everything else dotted.
- **Export > BPMN 2.0** on a diagram drawn in BPMN writes a `.bpmn` file with the layout,
  for Camunda Modeler, bpmn.io and the like. An event nothing leads to becomes the start
  event, one nothing follows the end event. One file holds one process without pools or
  lanes; people and systems on the diagram are left out of the file.
- **Limits:** one kind of gateway (exclusive) and plain tasks and events only: no message
  or timer events, no sub-process expansion. BPMN files are not imported. The REST API and
  the MCP server accept the new object types but not yet the "Then" relationship. The
  `.bpmn` file has been checked for structure, not opened in a BPMN tool.

### Evidence pack (FR-56, hosted mode)

A review that is closed (approved, rejected or withdrawn) has an **Evidence pack** button.
It downloads one HTML file an auditor can open without an account, and print to PDF:

- the outcome, who submitted and when, and the version that was reviewed;
- every stage with its reviewer and each decision in order: who, when, the reason, a
  hand-over, and the checklist as it was ticked;
- what the review changed compared with what was published before;
- the findings of all four rule packs on the reviewed version;
- every diagram of that version, redrawn in a plain style from the stored positions.

The file is a copy made at that moment: it is not signed, and the review and the audit
log in the workspace remain the record. It holds no scripts and loads nothing from
outside. The audit-log entries themselves are not copied in; owners download those from
the Audit log page.

### The API, webhooks and live links

**API.** An owner creates keys under Settings > API and webhooks. A key belongs to one
workspace, is shown once, and is stored only as a hash. The API is served by the Supabase
Edge Function in `supabase/functions/api`:

```
https://<your-project>.supabase.co/functions/v1/api/v1
```

```bash
curl -H "Authorization: Bearer ark_..." https://<your-project>.supabase.co/functions/v1/api/v1/objects
curl -X POST -H "Authorization: Bearer ark_..." -H "Content-Type: application/json" \
  -d '{"name":"Billing API","typeId":"service","owner":"Finance IT"}' \
  https://<your-project>.supabase.co/functions/v1/api/v1/objects
```

`/objects`, `/relationships`, `/diagrams` and `/processes` each take GET (list, with filters and a
cursor), POST, and GET, PATCH and DELETE on `/{id}`. `/model` returns everything in one reply
(processes without their BPMN files), and `/openapi.json` describes the API for tools (no key
needed). Things to know:

- Every rule of the API is in the database function `api_request()`; the Edge Function only
  passes requests to it. It uses the public key, never the `service_role` key.
- The API keeps the application's rules: the same object types and nesting levels, one
  relationship per source, target and kind, and deleting an object removes its arrows and
  boxes and moves what was inside it up a level.
- A key may make 300 requests a minute. A workspace has at most 20 active keys.
- The API reads and writes the working model. With review switched on, that is the draft:
  changes made through the API reach readers only after the next approved review.
- What was created through the API says so in the application, with the key's name.
- Deploy the function once: `supabase functions deploy api --no-verify-jwt`. It needs no
  secrets. JWT verification is off because the API checks its own keys.
- Run against a live project so far: the deployed function answering over the internet
  (its description, and a refusal for a missing or wrong key), and the database side of
  every kind of call. A full call with a real key over the internet, and a webhook actually
  arriving at an address, have not been run yet.

**Webhooks.** An owner adds up to 5 addresses per workspace. After a statement that changes
objects, relationships or diagrams is saved, by a person, an import or the API, each address
receives one POST:

```json
{ "event": "model.changed", "workspaceId": "...", "resource": "objects",
  "changed": ["obj_1"], "deleted": [], "at": "2026-11-16T09:00:00Z" }
```

- The body lists ids, not contents; fetch what you need through the API. A box moved on a
  diagram is reported as a change to that diagram, and a changed process has `"resource": "processes"`.
- `X-ArchONE-Signature` is `sha256=` followed by the HMAC-SHA256 of the exact body, keyed
  with the secret shown once when the webhook was added. Check it before trusting a delivery.
- Deliveries are sent by Supabase's `pg_net` extension, once, with a 5 second timeout. There
  are no retries and no delivery log in this step, so treat a webhook as a prompt to look,
  and use `updatedSince` on the API to catch up after downtime.
- Only public `https://` addresses with a host name are accepted.

**Live links.** In a diagram, Share > Live link (owners and editors). The link opens without
signing in, shows that diagram read-only, and refreshes itself about every 30 seconds while
the page is visible. Switching it off stops it for everyone who has it; deleting the diagram
does the same. The embed code is an iframe for wikis such as Confluence or SharePoint.

- With review switched on, a live link shows the published version, and nothing until the
  diagram has been approved once.
- A link shows the boxes on the diagram with their details, and the arrows between them.
  Objects that are not on the diagram are not sent, except as bare ids where the picture
  needs them to draw an arrow between two boxes.
- Anyone who has the link can see the diagram, so treat it like a password. The earlier
  snapshot links (the diagram packed into the link, optionally with a password) are still
  there under Share > Snapshot.
- Embedding needs a host that lets `/embed/...` be framed. `vercel.json` sets this.

### Importing files

Every import becomes a draft under **Drafts**, like an AI draft: you review it, correct what
was guessed, and accept what should be saved. Each saved item records the file it came from
and who approved it. Files are read in the browser and are not uploaded anywhere.

- **Spreadsheets.** One object or one relationship per row, with a first row of headings.
  The columns are matched to fields by their headings and you can change every match. A row
  that names an object already in the model updates it, only in the columns that have a
  value: an empty cell never wipes a field. Objects named only as a parent or in a
  relationship are added so nothing dangles. Limits: 25 MB, 20,000 rows a sheet, 3,000
  objects a file. The older .xls format has to be saved as .xlsx first.
- **Diagram files.** One page at a time. Object types and relationship kinds are guessed
  from the stencil, the shape style and the words in the labels, so check them in the
  review. A shape that encloses others becomes their parent instead of a box. Two shapes
  with the same name on a page become one object. Left out, and counted for you before you
  import: shapes without a label, connectors not attached to a labelled shape at both ends,
  and free text notes. Colours, icons, line routes and rotation are not carried over. The
  older binary .vsd format has to be saved as .vsdx in Visio first.
- **What it was tried on.** The readers were run over 620 public draw.io files and 20 public
  Visio test files without a failure, apart from four files that are stencil libraries
  rather than diagrams. In those draw.io files, mostly flowcharts and templates with many
  unlabelled shapes, about four connectors in ten had no labelled shape at one end and were
  left out. No file made in Microsoft Visio itself by a customer has been tried; the
  automated tests use a hand-built .vsdx in Visio's format.

### Set up Supabase

1. Create a project at supabase.com.
2. Open **SQL Editor** and run the files in `supabase/migrations/` one at a time, in the
   order of their names: `20261115142540_phase2_foundation.sql`,
   `20261115200541_phase2_collaboration.sql`, `20261115205851_phase2_api.sql`,
   `20261115211347_phase2_api_pg_net_schema.sql`, `20261115214525_phase3_audit_log.sql`,
   `20261115224032_phase3_scenarios.sql`, `20261115230126_phase3_notations.sql`,
   `20261115230130_phase3_sequence_flow.sql`, `20261115230314_phase3_notation_optional.sql`,
   `20261115231548_phase3_domain_roles.sql`, `20261116090000_phase4_api_proposals.sql`,
   `20261116120000_phase4_decisions.sql`, then `20261116140000_phase4_chain_handshake.sql`.
   The app now needs the last one: it saves a column that migration adds. (With the Supabase CLI: `supabase db push`.)
   They only create and touch their own tables and functions.
3. Under **Authentication > URL Configuration**, set the Site URL to the address of the app
   and add it to the redirect URLs. Confirmation and password-reset links return there.
4. Keep **Confirm email** switched on. Invitations are matched on the confirmed address.
   Until you set up your own email sending under **Authentication > SMTP**, Supabase's
   built-in email service delivers only to the addresses of your Supabase organization's
   team members and is limited to a few messages an hour. Anyone else who tries to sign up
   gets "Email address not authorized". Set up custom SMTP before you invite other people.
5. Give the build these two values (Project Settings > API), then build or redeploy:
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (newer projects call the second one the
   publishable key; `VITE_SUPABASE_PUBLISHABLE_KEY` works too). Both are safe to expose.

Never put the `service_role` key in this app or its hosting settings. It is not needed.

### What has and has not been run

- The migration and every access rule run in `npm test` on a real Postgres engine (PGlite),
  as different signed-in people, with a small stand-in for Supabase's auth schema
  (`supabase/tests/supabase-shim.sql`).
- The sync engine is tested with simulated people, and the screens are tested end to end
  with several signed-in tabs (`npm run test:browser:cloud`) against a stand-in backend
  that lives in the browser (`src/lib/cloud/demoBackend.ts`).
- Both migrations have also been applied to a live Supabase project, where the resulting
  schema was compared with the one the tests use (identical: functions, policies, columns,
  grants, constraints, realtime tables). On the first, 28 access-rule checks were run there
  as different signed-in people; on the second, saving a version, commenting, switching
  review on, submitting and approving were run as a signed-in owner; on the third, creating
  keys, calling the API with a write key and a read key, and opening and switching off a
  live link were run as an owner and as a visitor who is not signed in. All passed and were
  rolled back.
- The app itself has been run against that live project through
  `src/lib/cloud/supabaseBackend.ts`, in two tabs signed in as one person: sign-up with
  email confirmation, reopening the session, creating a workspace, saving the sample model
  (every row checked in the database), loading it in a second tab, seeing who else is there,
  a rename and a delete arriving in the other tab without a reload (the deleted object, its
  relationships and its boxes marked `deleted` in the database), inviting and cancelling an
  invitation, and an AI draft saved to the model with the signed-in check on `/api/ai`.
  The API refused every request made without a sign-in.
- Comments, versions and review were run the same way, as one signed-in owner: a comment
  with a mention, a reply and resolving; saving a version, comparing it with the model
  (identical, as it should be) and drawing its diagrams; switching review on, submitting a
  change, approving it with the checklist, and seeing it become the published version.
  Deleting a workspace from Settings was run there too, and removed all of its rows.
- The audit log migration has been applied to the live project too, and its schema compared
  with the tests' (identical). There, as the signed-in owner and then through the API with
  a key, creating, changing and deleting were each recorded with the right name; changing,
  deleting and inserting entries were refused for the owner, for a visitor and for the
  database owner. All of it was rolled back. The Audit log page itself has been run against
  the stand-in backend only, not yet against the live project.
- The scenarios, notations, sequence-flow and domain-limit migrations are applied to the
  live project and its schema matches the tests' (functions, triggers, policies, columns,
  grants, constraints). The MCP function is deployed there but has not been called.
  Checks, scenarios, the domain limit, ArchiMate, the notations and the evidence pack have
  been run in the tests and against the stand-in backend only, not yet through the app on
  the live project.
- The phase 4 migration (proposals through the API, propose keys, domain-limited write
  keys, the AI object types) is applied to the live project and its function bodies match
  the file. There, with a temporary propose key, a direct write was refused
  (`propose_only`), a proposal was filed and listed, the audit log recorded it and the
  model was unchanged; all of it was rolled back. The `api` and `mcp` functions are
  redeployed; the API's `/openapi.json` was read from the live address, the MCP tools were
  not called there. Reviewing an API proposal in the app, and a limited write key, have
  been run in the tests and against the stand-in backend only.
- The decisions migration is applied to the live project and its function bodies, triggers,
  policies and grants match the file. There, a review was closed by hand in the database:
  the trigger wrote the record with the right counts and links, the audit log recorded it,
  and changing the text of that decided record was refused; all of it was rolled back.
  The Decisions page, the list of who a review touches, the text imports, arranging and
  presenting have been run in the tests and in the browser checks (browser-only mode and
  the stand-in backend), not yet through the app on the live project.
- The chain and handshake migration is applied to the live project and its functions match
  the file. There, the existing entries were chained and the chain verified; new entries
  extended it and a saved code still matched; a changed entry was found at its number; and
  a confirmation on a relationship was cleared when the relationship changed. All of it was
  rolled back. The tamper check panel, Health, stamped exports and the copy check have been
  run in the tests and the browser checks, not yet through the app on the live project.
- The MCP function with `may_connect` is deployed to the live project. It was typed in by
  hand from the built file and answers requests; the tool itself has not been called there.
- Ask the architecture has not been run against a paid AI model or on the live project; it
  is covered by the unit tests and by browser checks with a stand-in provider.
- **Not yet run against a live project:** anything that needs a second account (a person
  accepting an invitation, role changes reaching them, a viewer being refused through the
  app, a reader being held on the published version, a mention or a comment reaching another
  person), password-reset email, going offline and back, and reverting to a version. Those paths are covered by the database tests and by the stand-in backend, not
  yet by the real one.

To look at the hosted screens without Supabase: `VITE_CLOUD_BACKEND=demo npm run dev`.

## What phase 4 adds so far

### Proposals through the API and MCP

- **Three kinds of key:** read, propose (the default) and write. A propose key reads the
  model and files proposals with `POST /proposals` (or the MCP tool `propose_changes`);
  every other change is refused with `403 propose_only`.
- **A proposal changes nothing.** It appears under AI → Proposals as "Proposed through the
  API or an AI assistant", with the key's name and the sender's note. A person accepts or
  rejects each object and relationship. An object named by `id`, or with the name of an
  existing object, is matched to it and only the fields that were sent are changed.
- **Limits:** 200 objects and 400 relationships per proposal, 50 waiting API proposals per
  workspace. `GET /proposals` shows the sender what became of each.
- **Audit log:** filing a proposal and its outcome (applied or dismissed) are recorded.
- **Write keys limited to domains:** chosen when the key is created; a write outside the
  limit is refused with `403 outside_limit`.

### AI agents in the model

Three object types: AI agent, AI model and MCP server. An agent has two declared answers,
"Reads untrusted content" and "Can send outside"; when they are left empty the checks
derive them from the model (what the agent reaches directly and through MCP servers and
gateways, four steps deep). The rule pack "AI agents" is described under Checks above.

### The decision log (ADR)

- **Decisions** in the navigation holds one record per decision: context, decision,
  consequences, and the objects it is about. Records are numbered (ADR-1, ADR-2, ...).
- **A decided record keeps its text.** While a record is proposed it can be edited or
  discarded; once accepted or rejected only its links to objects can be corrected. To
  change an accepted decision, supersede it: a new proposed record is started and the old
  one is marked superseded. In hosted mode the database enforces this, not only the screen.
- **Every object shows the decisions about it**, with "Record a decision" to start one
  that is already linked.
- **Closing a review writes a record by itself** (hosted mode): on approval or rejection, a
  trigger records the title, the submitter's note, who approved each stage or the reason
  for rejecting, how many objects and relationships were added, changed and removed, and
  links the objects that were added or changed. A withdrawn review leaves none.
- Decisions are not part of a version: reverting the model keeps the log.
- One record or the whole log downloads as Markdown in the usual ADR layout.

### Who a review touches (hosted mode)

A review, and the dialog that submits one, list the owners of what the change adds, changes
or removes, then the owners of what depends on that (up to three steps), and say for each
whether they are a reviewer, a member who is not a reviewer, or not a member. Owners are
matched to members by name, email, or the part of the email before the @. It is advice:
the stages still name the reviewers, and a reviewer can hand a stage over.

### Diagrams written as text

Import also reads a Mermaid flowchart or C4 diagram (`.mmd`, or the first one in a
Markdown file) and a Structurizr DSL workspace (`.dsl`, its model block). Boxes, groups and
arrows become a draft like any other import: nothing reaches the model until it is
accepted, and an object with the same name is reused. These files do not say where a box
sits, so the new diagram is laid out afresh. Not read: other Mermaid diagram kinds,
Structurizr views and styles, and files pulled in with `!include`.

### Arranging and presenting

- **Shift-click** boxes to pick several. A bar offers to line them up on an edge or on
  their centres, and to space three or more evenly; a picked group also drags together.
- **Present** shows a diagram alone and read-only. The arrow keys walk through the
  diagrams, a double click on a box opens its inside view when one exists, F switches
  full screen and Esc leaves.

### A log that shows tampering (hosted mode)

Every audit entry carries a hash of itself and of the entry before it. On the Audit log
page an owner can check the chain: a changed or removed entry is found, with its number.
The check also gives a code, the newest entry's number and hash. Kept somewhere outside
this system, it pins the log down as it was: a later check against it shows whether the log
was rewritten or its end cut off. What this does not do: it does not stop someone with full
access to the database from changing the log, it makes the change visible; and without a
saved code, a log rewritten from start to end with new hashes would pass.

### Stamped exports

A PNG or PDF export carries a strip with the diagram's name, when it was exported, and a QR
code (it can be switched off in the Export menu; SVG is not stamped). The code opens the
diagram with that date, and a note says whether the copy is still current or what changed
since: objects on it, relationships drawn on it, or the diagram itself. The reader needs
access to the workspace; the code holds an address and a date, nothing of the model.
Objects deleted since the export are not counted.

### Health

A page with four views of how far the model can be leaned on.

- **What if it stops.** Switch off one or more objects and see everything that stops with
  them, nearest first, with the chain that leads there, the tier-1 objects hit, the people
  left without it and the owners to tell. It starts from a ranking of the objects whose
  failure takes the most with it.
- **Availability.** Write the availability an object promises (for example 99.9) on the
  object. The page multiplies it with that of everything the object depends on and shows
  what it can really deliver, the expected downtime and the weakest link. It assumes every
  dependency is needed and failures are independent; standby copies and fallbacks are not
  modelled, and an object with no number counts as always up.
- **Confirmations.** A dependency between objects of two different owners waits until the
  owner of the object that is depended on confirms it. Changing the relationship takes the
  confirmation back (the database does this for changes through the API too). In hosted
  mode the screens let the target's owner, matched by name or email, or a workspace owner
  confirm; the database itself does not check who confirms.
- **Freshness.** Every object shows when its facts were last confirmed. It is due every 180
  days, or every 90 when tagged `tier-1`; past that it is stale and the checks say so.
  Planned and retired objects are not asked about.

### NCA ECC pack (Saudi Arabia)

A rule pack, off until chosen on the Checks page, for what a diagram can show of the
National Cybersecurity Authority's Essential Cybersecurity Controls, ECC-2:2024. Five rules
of its own, each naming its subdomain: outside parties nobody answers for and classified
data that leaves to one (4-1), classified data with no hosting place written (4-2), a
critical data store with no copy (2-9), and tier-1 objects with no availability (3-1). Five
existing rules also count in it (encryption, exposure of data stores, classification).

It is not compliance. ECC-2:2024 has 108 main controls and most are about policy, people
and process, which a model does not record. The pack names subdomains, not control numbers,
and it does not judge where data may be hosted: that is set by classification and by the
national data rules. The subdomain names were checked against the NCA's published guide to
the ECC; the rules themselves are this project's reading, not the NCA's.

### For coding agents: "may this connect to that?" and FINOS CALM

- **`may_connect`** (MCP tool, any key). An agent asks before it writes a call from one
  system to another and gets yes, no or unknown with the reason: yes when the relationship
  is in the model; no for a retired or deprecated target, a data store reached from
  outside, an unencrypted protocol, or sensitive data going to an outside system; unknown
  when the model does not have it, with the advice to propose it. It reads the working
  model and applies those few rules only, not the whole of the checks.
- **FINOS CALM export.** Export → FINOS CALM (JSON) writes a diagram as a CALM 1.2
  architecture: nodes, and `connects`, `interacts`, `deployed-in` and `composed-of`
  relationships. It is meant for tools that check a pull request against the architecture.
  The file was built to the published schema but has not been run through the CALM
  validator, and there is no pull-request gate in this project.

### From a meeting to a draft

Draft with AI → From a meeting takes a transcript or notes, one speaker per line, and
turns each sentence that says how things connect into suggestions. Every suggestion shows
the sentence and who said it, and nothing is saved until it is accepted. It is read by the
built-in rules in the browser, with no AI model: it finds what was named and how it was
said to connect, and does not understand a decision, a doubt or a "no". Audio is not read.

### Bringing a scenario into the main model (hosted mode)

A scenario's Scenarios page lists every difference from the main model with a tick beside
it, and **Bring changes into** the main model writes the ticked ones there. The differences
come in three groups:

- **Changed in this scenario**: the scenario's own work, ticked to begin with.
- **Changed on both sides**: the main model changed the same thing since the scenario was
  created. Unticked; bringing one over replaces the main model's version.
- **Changed only in the main model**: the main model moved on. Unticked; bringing one over
  would undo that change.

What you should know:

- No copy of the starting point is kept. The groups are worked out from when each object,
  relationship and diagram was last changed, compared with when the scenario was created.
  Moving a box does not stamp its diagram, so a layout-only difference is offered as the
  scenario's unless the main diagram's own settings changed since.
- A ticked relationship or diagram brings the objects it needs with it, and a ticked
  removal takes the main model's arrows and boxes for that object too. The page says so
  before anything is written.
- The changes are saved as the edits of the person who brings them, so the main model's
  roles, domain limits, review and audit log apply as for any edit. Only its owners and
  editors are offered the button.
- A ticked diagram is made to look as it does in the scenario; it is not merged box by box.
  The scenario itself is left as it is. Decisions and drafts are not brought over.

### Public trust page (hosted mode)

Settings → **Public trust page** lets an owner publish one page, open to anyone who has
its address, that says where personal data is kept, which outside parties receive it and
between which regions it moves, with one chosen diagram. It is worked out from the data
fields ("Personal data", "Data residency") and from which external systems are connected
to something that holds personal data. An external system's "Public purpose" field is
shown as what that party does for you.

- **What leaves the workspace:** the names of those external systems with their region and
  public purpose; for systems that hold personal data and their neighbours, only the
  region and the fact, without a name; and the chosen diagram's box names, kinds and arrow
  labels. Descriptions, owners, tags, technology, protocols, classifications and all other
  fields are not sent. The Preview in Settings shows exactly what the page will show.
- The database makes this cut itself (`trust_view()`), so the rest never reaches the
  visitor's browser. A test checks that the database and the app make the same cut.
- With review switched on, the page shows the approved version.
- Switching the page off closes its address; switching it on again reopens the same
  address. Changes to the settings are written to the audit log.
- The page states what the model records. It is not a legal notice, and a system with no
  data fields filled in is simply not counted.

### The architecture as a document or slides

**Document** writes the model up as a Word file (.docx) or as PowerPoint slides (.pptx),
in the browser, with nothing sent anywhere. You choose the title, which diagrams and in
what order, and which sections follow them.

- Word: a title page, the counts, one chapter per diagram (picture, description, a table
  of what it shows and a table of how the parts connect), then the inventory, the
  decisions, findings from the chosen rule packs and the personal-data summary. Headings
  are real headings, so Word can add a table of contents (References → Table of Contents).
- Slides: title, counts, one diagram to a slide with its description in the speaker notes,
  then decisions, findings and the personal-data tables. The inventory is Word only.
- Each diagram is drawn off-screen and photographed, which takes a moment per diagram. One
  that cannot be drawn within six seconds goes in without its picture, and the page says so.
- The pictures are images, not editable shapes. Both files have been opened with
  LibreOffice here; they have not been opened in Microsoft Word or PowerPoint.

### Your own rules and journey tests

Checks → **Your rules** holds rules the workspace writes for itself. They run with the
built-in checks wherever those run: on the whole model, on one diagram, in a scenario, in
the Document export and in a review's evidence pack. Each rule has its own switch.

A rule is one of three things:

- **Something every chosen object must have**: an owner, a description, a technology, a
  data classification, a region, a tag (or not a tag), a field, or one of some lifecycles.
- **How two sets of objects may connect**: never, the first set only to the second, or
  only over certain protocols.
- **A journey test**: on every way from one set of objects to another, following the
  arrows from source to target, a third set is never passed through, or always is. For
  example: "Traffic from customers to databases must pass through a gateway".

A set of objects is chosen by kind, tag, part of the name, lifecycle, what it sits inside,
whether it holds personal data, and its classification.

**Writing a rule as a sentence.** Type the rule in English or Arabic and press Read it. The
form below is filled in from the sentence, "Read as" says the rule back in fixed words, and
the page lists what the rule would find in the model as it is now, before it is kept.

What you should know:

- The sentence is read by recognising words, with no AI model: kinds of object, tags,
  lifecycles, names of objects in the model, and ways of saying must, never, only and
  through. It does not understand the sentence. Words it did not use are listed, and a
  sentence it cannot read at all leaves the form for you to fill in. The Arabic reading
  covers fewer phrasings than the English one.
- A journey follows relationships in their direction and ignores nesting: a relationship
  drawn on a parent is not followed for its children.
- A rule that goes wrong all over the model reports its first 60 findings.
- In hosted mode only owners write rules, and the database enforces that; every member's
  checks run them. A scenario starts with the rules of the model it was copied from.
  Versions do not hold rules: an evidence pack runs today's rules against the reviewed
  version, and says so.
- A workspace can have 200 rules of its own.

### Showing a diagram inside an assistant, and a skill for coding agents

The MCP server has an 18th tool, `show_diagram`. It returns one diagram as its boxes and
arrows, and declares a view for clients that support MCP Apps: the client opens the view in
a sandboxed frame and the diagram is drawn in the conversation. A client without MCP Apps
gets the same content as text.

- The view is one self-contained page served by the server as `ui://archone/diagram.html`.
  It makes no request of its own and writes names from the model as text, never as markup.
- The picture is simpler than the app's canvas: straight arrows, no nesting boxes, and only
  relationships whose two ends are both on the diagram.
- `skills/archone-architecture/SKILL.md` is a skill for coding agents: ask `may_connect`
  before writing a connection, file changes with `propose_changes`, show diagrams with
  `show_diagram`. Copy the folder into the agent's skills folder.
- Tested: the tool and the resource calls against the database rules, and the view inside a
  frame with a stand-in host that speaks the handshake. Not tested: inside a real assistant
  client. The view follows the MCP Apps messages as documented on 16 November 2026.

### A gate for pull requests

`gate/archone-gate.mjs` is a single-file check for a repository's CI. The repository
declares in `archone.json` which system it is and what it connects to; the gate asks the
model about each connection with the rules of `may_connect`, fails the check on one a rule
forbids, and can file the ones the model does not know as a proposal that names the pull
request. `gate/README.md` has the file format, the options and a GitHub Actions workflow.
It checks the declaration, not the code.

### Exporting a diagram

Export opens one window with every format, grouped:

- **Pictures and slides**: PNG, SVG and PDF as on the screen (PNG and PDF can carry the date
  and a check code), and PowerPoint: the picture, the same diagram as shapes and lines that can
  be edited in PowerPoint, and tables of its objects and relationships.
- **Moving and interactive**: an interactive HTML page (pan, zoom, search, every box's details
  on a click, flows to play; one file that works offline), an animated GIF and a video (MP4 where
  the browser can record it, otherwise WebM). The animation plays the diagram's flows step by
  step; a diagram without flows shows traffic moving along its lines. These are drawn from the
  model, not from the screen, so they look the same wherever they open.
- **Data**: JSON, Excel (objects and relationships sheets, which import back), and CSV.
- **For other tools**: Mermaid, PlantUML, draw.io, Structurizr DSL (a C4 Level 2 diagram becomes
  a container view of its system), ArchiMate exchange file, FINOS CALM, and BPMN 2.0 for diagrams
  drawn in BPMN.

### Kinds of diagram and roles per category

Every diagram belongs to one of five categories, chosen when it is made:

| Category | Kinds | Filled with |
|---|---|---|
| Applications | C4 System landscape, C4 Level 1: System context, C4 Level 2: Containers | systems and people; one system and its neighbours; what is inside one system |
| Data | Data | data stores and the applications that read, write or replicate them |
| Infrastructure | Infrastructure | servers, clusters, gateways, networks and what is hosted on them |
| Business | Business | domains, processes, their steps and the people who take part |
| Custom | Custom | nothing; you choose |

An owner can give a member a role in each category (Edit, Comment, View or No access) under
Settings, Members, By category. A category narrows the workspace role and never widens it; a
category left alone keeps the workspace role; owners always have everything. The role governs
the category's diagrams and the objects that belong to it: Data covers databases, queues,
caches and storage; Infrastructure servers, clusters, gateways and network devices; Business
processes and their steps; Applications systems, applications, services, AI and external
systems. People and domains belong to both Applications and Business. A relationship can be
changed by whoever edits either of its ends. No access hides the category's diagrams, their
boxes, comments and saved templates, also in versions (read through `version_snapshot`); the
objects stay readable because other diagrams draw them. The database enforces all of it with
restrictive row-level policies (migration `phase4_category_roles`); the app refuses such an edit
before sending it, opens those diagrams read-only and offers only the kinds the member may
create. Scenarios keep the roles of the workspace they were made from; changes are written to
the audit log. API keys keep their own access and domain limits.

### Starting a new diagram

New diagram asks first what the diagram shows (its kind, by category) and its name, then how to
build it:

1. **Create manually**: the diagram opens, filled with what the model already has for that kind.
2. **Wizard steps**: a few questions for that kind (for a C4 Level 2 diagram: the system, its
   people, front ends, services, data stores and other systems; for Business: the domain, the
   process, who takes part and its steps in order). Each answer becomes a library component,
   chosen or recognised by name, and the answers are joined as the questions say. A review shows
   the picture before anything is created.
3. **From an existing diagram**: a copy, with the same objects or with objects of its own
   (named with a label such as "target") so it can change freely. The original stays as it is.
4. **From a template**: the template picker, opened on the category's perspective.
5. **Text to architecture** and 6. **Voice to architecture**: a draft from a description, typed
   or dictated (Arabic or English; the browser's dictation, started only on request), reviewed
   before it is saved. Component names are asked for in English.
7. **Import architecture**: draw.io, Visio, Excel, CSV, Mermaid, Structurizr or ArchiMate, with no
   AI; in a draw.io or Visio diagram a shape whose label or stencil is exactly a library component
   (also "Amazon S3", "AWS Lambda", "Azure Functions") becomes that component, and the draft lists
   the shapes that matched nothing. A picture goes through the AI draft instead.
8. **Archived diagrams**: a diagram can be archived from its row or its settings, with a reason;
   it leaves the lists and search, nothing is deleted, and it can be restored with a reason. Both
   reasons are kept with the diagram (column `archive`), and scenarios keep it archived.

Every draft, imported or AI-made, becomes a diagram of the kind and name chosen, and each new
object is linked to the library component its name or technology names exactly.

### Connections: direction, protocols and ports

Each connection says which way it goes: outbound (from the first box to the second, the usual),
inbound, or both ways. The canvas draws the arrowheads that way and moves dashes along the line
in the direction of the traffic (still for people who ask their system for less motion). A
connection carries one or more protocols and ports, picked from the catalogue of 150 under
Library, Protocols and ports (web, remote access, file transfer, email, identity, name and
time, databases, messaging, monitoring, tunnels, storage, containers, industrial, finance and
health) or typed; the network it runs over (from the Network connections section, such as MPLS
or GSN); and whether it is encrypted. The line's label shows the first protocols, and its tooltip
everything. In a diagram's library panel, a protocol is added to the connection picked. The
clear-text check reads the protocols (HTTP, FTP, Telnet, LDAP and the like) and stays quiet when
the connection is marked encrypted. Exports carry the direction and protocols.

### Impact and dependencies

The Impact page (menu: Impact) answers two questions for anything in the model: a component, a
whole diagram, or a library component (every object linked to it, or named as it is when not
linked). It is also opened from a component's panel, a diagram's settings, and a component's
details in the Library.

- Dependencies and impact: what it depends on and what depends on it, level by level up to the
  fifth, with the path to each, the kind of relationship and the protocols on it. A box that
  stands for another diagram depends on everything that diagram shows, so the analysis crosses
  from one diagram into the next. It lists the diagrams reached and how much of each, draws the
  nearest sixty on a map, and downloads as CSV or JSON.
- What if it stops: pick one or more components or whole diagrams. It lists everything that
  stops with them, each rated Critical, High, Medium or Low (by distance, tier-1 or business
  criticality, people who cannot work, and how many depend on it in turn); the diagrams affected;
  the owners to tell; an impact level from 1 (negligible) to 5 (severe), worked out and
  changeable; the likelihood from 1 (rare) to 5 (almost certain); and the risk on the usual five by
  five grid (Low up to 4, Medium up to 9, High up to 16, Critical above). It suggests what to do
  first: a second instance with failover for a single point of failure, replicas and tested
  restores with an RPO and RTO for data, a fallback and agreed availability for an external
  system, a second path or carrier for a network, high availability for a shared integration, a
  recovery runbook for a whole diagram, owners where there are none. Scenarios are kept in the
  browser and download as a Markdown report or CSV.

### All diagrams on one map

The All diagrams page draws every diagram as one box and the links between them. A diagram
depends on another when one of its components needs (calls, depends on, reads or writes, is
hosted on) a component shown only on the other, or when it shows the other as a diagram box; the
arrow points to what is needed and moves along the line. Two diagrams that show the same
component are joined by a dotted line that says how many they share. Labels carry how many links
and the protocols on them.

- Click a diagram to see what it impacts and what it depends on, level by level up to the fifth,
  with the rest dimmed; the panel lists the direct links and the components behind each, and
  opens the diagram, its impact analysis or a what-if scenario.
- Shift-click to pick several: the panel lists the links between them and, for those not linked
  directly, the shortest way through others; "Only the ones picked" leaves just them on the map.
- A diagram's box opens to list the components that link it to the others.
- Hide kinds of diagram (Applications, Data, Infrastructure, Business, Custom), dependencies or
  shared components; find a diagram by name; drag boxes (kept in this browser); Reset layout;
  Full screen.
- Export what the map shows as PNG, SVG, PDF, an animated GIF, draw.io, Mermaid, CSV (every link
  with the components behind it) or JSON.

### Home, menu, themes and settings

The home page greets you with the workspace's name and the four things to look at first, each a
link to where it is acted on: the component most depended on (to its impact analysis), the
components without an owner and the connections in clear text (to their reports), and the AI
drafts waiting. Below them, the diagrams changed last, each with a small picture, and shortcuts
to the Diagrams page, the map, impact, reports, files and library.

The menu is grouped in the order work happens: Home; Build (Model, Library, Files, Drafts);
Analyse (All diagrams, Diagrams, Impact, Dependencies, Health, Checks); Govern (Decisions, Reports,
Document, Ask); Work together (Versions, Reviews, Scenarios, Audit log, when signed in); and
Settings.

### The Diagrams page

`/diagrams` shows every diagram as a card with a small picture of what it holds: its boxes in
their places, coloured by category, with the lines, zones and boundary between them; names are
written in when they are large enough to read. Under the picture: the name, the kind of diagram,
how many boxes and lines, when it last changed, and buttons to save it as a template, archive,
duplicate or delete it. A card opens its diagram for editing. Search by name, kind or system;
narrow by area; sort by last change, name or size; or switch to a list. The build buttons
(Import, Template, Draft with AI, New diagram) and a New diagram card start a new one, and
archived diagrams are a click away. The editor's "Diagrams" link comes back here.

### The relationship tree of a component

Double-click a box in a diagram (or "Relationship tree" in its panel) to open
`/component/<id>`: the component and everything related to it as two trees, what it relies on
(following its arrows) and what relies on it (against them), one to five levels deep. Each
row shows its level, the relationship and its protocols, and the diagrams that object is on; an
object reached by more than one way is listed once at its nearest level, and the other ways are
kept as "listed above" references, so every relationship within reach appears and the tree
stays finite. Follow every kind of relationship or dependencies only; fold and open branches; a
name opens that object's own tree. Below the trees, the diagrams these objects are on, nearest
first; pointing at one lights its objects in the trees. A double-click on a diagram box still
opens that diagram, and "Open inside" still opens the inside view.

Ten themes, each with its own colours, font and a background that moves behind the work:
Blueprint (a drifting drafting grid), Midnight circuit (signals running along board traces),
Aurora (veils of teal and violet), Quantum field (particles at two depths), Command line (green on
black with scan lines), Digital oasis (sand and teal under a turning eight-pointed star pattern),
Glass (frosted panels over drifting colour), Neon grid (a horizon of lines rolling towards you),
Data stream (data flowing across white) and Carbon (graphite and signal orange). Each person
picks their theme, font (IBM Plex Sans, Inter, Sora, Space Grotesk, JetBrains Mono, IBM Plex Sans
Arabic, Cairo, Tajawal), density, corners and how much moves (full, calm or still; a computer set
to reduce motion keeps it still). That choice is kept in the browser and changes nothing for
others.

Settings is one page with an index: You and this workspace; Appearance; Branding (owners: the
name in the menu and the browser tab, a logo, an accent colour, and the theme and font members
start with, kept with the workspace in `workspace_branding` and recorded in the audit log);
People and permissions (members, roles per kind of diagram, domains, and a table of what each
role may do); Review and approval; Integrations (API, webhooks, MCP, trust page); AI; Diagram
wizard; Monitoring and logs (the size of the workspace, files, saving and live connection,
findings of the checks, storage in the browser, and for owners the latest audit entries); and
Data, backup and reset.

### Reports

Reports (menu: Reports) lists twenty-one built-in reports by area, each a table worked out from
the model as it is now, most with a chart:

- Inventory: application portfolio, components by type, technology stack, library components in
  use, external systems and vendors, shared components (on more than one diagram), network zones.
- Connections and interfaces: interface catalogue (from, to, kind, protocols, ports, network,
  direction, encryption), protocols and ports in use, connections in clear text, dependencies
  between diagrams.
- Risk and resilience: single points of failure, impact ranking (what depends on each component
  within five levels and how many diagrams that reaches), critical components and what they rest
  on.
- Governance and quality: components without an owner, lifecycle and end of life, components
  without a description, findings of every check pack, architecture decisions.
- Data: data stores with classification, personal data, residency and who reads or writes them.
- Diagrams: the catalogue of diagrams, with their size and the diagrams they depend on and
  impact.

Filter the rows and sort by any column on the page. Export any report as Excel (with a summary
sheet), CSV, PDF, Word, PowerPoint (a chart and the table over as many slides as it takes), a web
page with a filter box, Markdown or JSON; exports carry the rows shown.

New report makes a report of your own: what it lists (components, connections or diagrams), the
columns in the order ticked (owner, lifecycle, technology, criticality, tags, diagrams, what
depends on it within five levels, protocols, ports, network, clear-text protocols and more),
conditions (is, is not, contains, is empty, at least, at most…), a column to count by for the
chart, and the sort, with a live preview. Owners and editors make, edit, duplicate and delete
them; they are kept with the workspace (`custom_reports`) for every member, and recorded in the
audit log.

### File library

Files (menu: Files) keeps the documents that go with diagrams: vendor documents (datasheets,
guides, contracts), supporting files, designs and anything else, up to 50 MB each. Upload several
at once by dropping them or choosing them, say what they are, add a note, and link them to one or
more diagrams. A diagram's toolbar has a Files button with the count: it lists the diagram's files
to open or download, uploads more linked to that diagram, and links a file already in the
library. In the library, filter by name, kind, diagram or "Uploaded by me"; edit a file's name,
kind, note and links; delete it once confirmed.

Who sees what: each person sees the files they uploaded and the files linked to a diagram they
can see (their role for that kind of diagram is above No access); nobody else's, owners
included. Owners and editors upload. A file's uploader, or an owner, renames, links and deletes
it; an editor of a diagram can take a file off that diagram. A file is linked only to diagrams the
person can edit. The rules are in the database (`diagram_files`, `diagram_file_links`, row-level
security) and on the private storage bucket `diagram-files`, where each file sits under its
workspace and its own id; uploads, changes, links and deletions are written to the audit log.
Without an account, files are kept in the browser.

### The bank sample: ten connected diagrams

Settings, Sample model, "Add the bank sample (10 diagrams)" adds a bank's estate to what is in
the workspace, without removing anything, to try impact and dependency analysis on something the
size of a real one: Enterprise landscape, Customer portal, Core banking, Payments hub, Identity
and access, Data platform, Data centre network (zones: Internet, DMZ, internal LAN, database,
PCI, management, DR site), Security operations, Backup and disaster recovery, and Employee
onboarding as a process. Shared services (Active Directory, DNS, NTP, Exchange, the integration
bus, the log collectors, the core switch) appear on several diagrams, connections carry
protocols and ports (LDAPS 636, Kerberos 88, Oracle 1521, Kafka over TLS 9093, ISO 20022, ISO
8583, Syslog over TLS 6514 and more) and the networks they run over (MPLS, GSN, Internet), and
boxes stand for the network, identity and backup diagrams. Every object is tagged
enterprise-sample. An empty workspace offers it on the Diagrams page too.

### Colours for network connections

Every kind of network connection in the library (54 of them, from LAN and MPLS to LoRaWAN and SIP
trunks) has its own colour. The family sets the hue so the picture reads at a glance: local and
data centre links are blue, storage and compute fabrics violet, carrier WAN links teal, the
Internet and broadband red and orange, encrypted tunnels green, cloud connections amber,
wireless and mobile pink, industrial links brown, and voice and legacy links grey. Each kind
has its own shade within its family.

- A line whose relationship says what it "Runs over" is drawn in that network's colour, a
  little thicker, and its label carries the colour too. The name is matched the way people
  write it: "MPLS VPN" is MPLS, "VPN" a site-to-site VPN, "4G" LTE / 4G. A name the library does
  not know keeps the usual grey, and the connection panel says so.
- A box that stands for a network (dragged from Network connections) takes the same colour.
- The canvas shows a "Network links" legend for the networks the diagram draws.
- The library shows each kind's icon in its colour; the Diagrams cards, SVG and draw.io exports
  use the colours too.

### Network zones, connections, integrations and diagram boxes

Four more sections in the library:

- **Network zones** (57, such as DMZ, Internal / LAN, Public / Internet, Management, Database
  zone, Cloud VPC / Subnet, Restricted / PCI, DR zone, OT, SWIFT secure zone). A zone is its own
  kind of object; put servers, applications or databases inside it (Part of) and the diagram
  draws the zone around them in its colour, nested zones inside outer ones. A zone with nothing
  inside it on the diagram stays a box. Zones belong to the Infrastructure category.
- **Network connections** (54, such as LAN, WAN, Internet, MPLS, GSN, site-to-site and remote
  access VPN, SD-WAN, leased line, 4G/5G, satellite, Direct Connect, ExpressRoute).
- **Integrations** (120 shared services almost every diagram connects to: Active Directory,
  Entra ID, DNS, DHCP, NTP, email, SMTP relay, backup, SIEM, EDR, PAM, PKI, monitoring, ITSM,
  CMDB, file transfer, ESB, ERP, CRM and more), with their own basic information.
- **Diagrams**: in a diagram's library panel this lists the workspace's other diagrams. Placing
  one adds a box that stands for that diagram (one box per diagram, reused everywhere), so
  components can connect to it; the box's button, or a double click, opens the diagram.

### Templates

115 templates for the most common diagrams, under Start from a template on the Diagrams
page: 30 for applications, 20 for data, 40 for infrastructure and 25 for business. Each is a
small first draft (five to eleven boxes) of a common situation.

**Every box of every template is a component of the library.** Its type, icon and basic
information are the component's; a template cannot bring in anything the library does not
have. A template naming a component the library lacks stops the app from starting, and a
test checks every box of every template, before and after it is put into a model.

- **Applications:** single-page app, mobile back end, microservices, saga, CQRS, event
  sourcing, serverless, strangler migration, multi-tenant SaaS, online shop, card payments,
  digital banking, government e-service, ZATCA e-invoicing, ERP integration, contact centre,
  ITSM, hospital systems and more.
- **Data:** modern data stack, lakehouse, enterprise warehouse, streaming analytics, change
  data capture, MDM, data mesh, BI, ML platform, retrieval-augmented generation, governance,
  database high availability, migration, partner sharing, IoT data and 3-2-1 backup.
- **Infrastructure:** data centre network, leaf-spine, DMZ, SD-WAN, campus, remote access,
  virtualisation, SAN, power and cooling, active-standby and active-active recovery, hybrid
  cloud, landing zone, Kubernetes, CI/CD, observability, end-user computing, VDI, security
  operations, zero trust, PKI, privileged access, hybrid identity, OT network, retail store,
  mainframe, segmentation and internet edge protection.
- **Business:** capability map, capabilities to applications, value stream, customer
  journey, BPMN processes (order to cash, procure to pay, hire to retire, incident, change,
  KYC onboarding, insurance claim, loan origination, patient visit, permit application),
  organisation, stakeholders, system context, application landscape, current and target
  state, roadmap, business services, partners, sites, policies and controls, product lines.

The picker shows each template as a small picture of its boxes and lines, with its name
above it. Search by any word (DMZ, KYC, ZATCA) or by perspective; a click shows what it
holds, Use (or a double click) puts it in the model and opens its diagram. Process templates
open in BPMN, left to right. Objects whose names the model already has are reused. No
template starts with a high-severity security finding; a test holds this.

**Your own templates.** Any diagram can become a template of the workspace: Save as template
in its settings, or the bookmark button on its row in the Diagrams list. You give it a name,
choose the perspective it belongs under (Applications, Data, Infrastructure or Business; the
window suggests one from what the boxes are), a line on what it is for and words to find it
by. It keeps each box's name, library component and technology, the lines between the boxes,
and where everything stands; owners, descriptions, basic information, links and comments stay
with the real objects. A box that is not a library component is saved as the usual component
for its type, and the window lists those first, so a template still holds only library
components. Saved templates appear first in the picker, marked Saved here, with a filter of
their own; using one draws its boxes where they stood. Owners and editors save and delete
them, every member can use them, and the audit log records each. They are stored in the
`diagram_templates` table (300 per workspace) and are not part of versions or scenarios.

The technology field still offers common cloud service names, so the same service is
spelled the same way across the model.

### ArchiMate 4

ArchiMate 4 removes seven concepts and merges the processes of the three layers into one.
The export here still writes the ArchiMate 3 exchange format, which is what current tools
read. The import now also reads the removed concepts and ArchiMate 4's single Process, Role
and Collaboration, and when a file uses something ArchiMate 4 removes or merges, the import
dialog lists it with the documented way to model it instead. Not checked: the relationship
types of ArchiMate 4 (the export writes Composition, Serving, Flow, Triggering and
Association), and an ArchiMate 4 exchange file from a real tool.

### Applications from APM & Landscape

Import → **From APM & Landscape** reads the application portfolio that APM publishes and
makes a draft of it, reviewed like any other import. APM stays the record of which
applications exist, who sells them and what is planned for them; this model is the record
of how they connect.

- **What it reads:** four of APM's read-only feeds (applications, classifications,
  lifecycle, integrations) at `<APM>/api/public/feeds/<dataset>.json`, with a feed token.
- **What it writes, once accepted:** each application as an object of kind Application with
  its description and the fields `APM id`, `APM number`, `Vendor`, `Version`, `Category`,
  `TIME`, `Hosting`, `Business capability` and `License`; each integration as a
  relationship (API as calls, Database as reads or writes, Event and File as flows to, SSO
  as depends on). TIME becomes the lifecycle: Invest and Tolerate are active, Migrate and
  Eliminate are deprecated.
- **A second import updates instead of duplicating.** An object is tied to its application
  by `APM id`, so a rename on either side does not break the tie; the first time, it is
  matched by name. A matched object keeps its kind, owner, tags and place, and its other
  fields. Applications APM no longer lists are named in the draft's note and left alone.
  Nothing is ever deleted by an import.
- **Setting it up:** set `APM_FEED_URL` on the host to APM's address. In APM, a Full user
  creates a feed token under Connections, as a Power BI or Excel feed that covers those four
  datasets, and pastes it when importing. The token goes to this app's server for that one
  import and is not kept. Or set `APM_FEED_TOKEN` on the host: then nobody pastes anything,
  and the server uses the token only for a signed-in person.
- The server fetches from the configured address only, refuses redirects, and answers only
  this site's own pages. APM allows 60 feed requests an hour per token; one import uses four.
- **Not done:** nothing is written back to APM, the import runs when someone asks for it
  and not on a schedule, and licence values are not read. It has been run against a
  stand-in for APM's feeds built from APM's own code, not against the live APM.

### Infrastructure as code and discovery

Import also reads what describes or reports infrastructure, and makes a draft of it like any
other import. Each resource becomes an object with the matching component from the library
(an AWS EC2 instance, an Azure App Service, a Kubernetes Deployment), its type, address and
settings kept as fields. References between resources become relationships. Networks and
subnets become zones, with what sits in them drawn inside. The glue between resources
(listeners, target groups, security group rules, role attachments, route tables) is not drawn
as boxes: a load balancer reached through a listener and a target group is drawn with one
arrow to the instance it serves. A shared security group or role joins nothing.

- **Infrastructure as code.** Terraform (.tf files, `terraform show -json` of a plan or a
  state, and .tfstate), AWS CloudFormation and SAM templates (JSON or YAML, with !Ref, !GetAtt
  and !Sub), Azure ARM templates and Bicep files, Kubernetes and OpenShift manifests (a
  Service is joined to the workloads it selects, an Ingress or Route to its Services,
  namespaces become zones), Docker Compose files (depends_on, links and addresses in the
  environment) and Pulumi stack exports.
- **Files from what is running.** AWS Config query results (with what each resource is
  contained in), AWS Resource Explorer and tagging results, Azure Resource Graph results,
  Google Cloud Asset Inventory results, a ServiceNow CMDB export (configuration items and the
  cmdb_rel_ci relationships), and BMC Helix Discovery or Device42 results as JSON. Choose the
  tool under "What is running" when its rows could be either.

#### Live discovery

When this app's server has credentials for a source, Import shows **Discover what is
running** with a button for each connected source. The server reads the source, the dialog
shows what was found, and **Create draft to review** makes the draft. Only someone signed in
who is an owner or editor of the workspace can use it, and the credentials never reach the
browser. Each source reads at most 5,000 resources at a time; the draft says when it stopped.

The credentials are added by whoever runs the hosting, as environment variables (on Vercel:
Project → Settings → Environment Variables, then redeploy). Give each one read-only access.

| Source | Settings | Access it needs |
|---|---|---|
| AWS | `DISCOVERY_AWS_ACCESS_KEY_ID`, `DISCOVERY_AWS_SECRET_ACCESS_KEY`, `DISCOVERY_AWS_REGIONS` (comma separated). Optional: `DISCOVERY_AWS_SESSION_TOKEN`, `DISCOVERY_AWS_AGGREGATOR` | `config:SelectResourceConfig` (or `config:SelectAggregateResourceConfig`), with AWS Config recording |
| Azure | `DISCOVERY_AZURE_TENANT_ID`, `DISCOVERY_AZURE_CLIENT_ID`, `DISCOVERY_AZURE_CLIENT_SECRET`. Optional: `DISCOVERY_AZURE_SUBSCRIPTIONS` | Reader on the subscriptions |
| Google Cloud | `DISCOVERY_GCP_SERVICE_ACCOUNT` (the JSON key), `DISCOVERY_GCP_SCOPE` (`projects/ID`, `folders/N` or `organizations/N`) | Cloud Asset Viewer, with the Cloud Asset API on |
| ServiceNow | `DISCOVERY_SERVICENOW_URL` and `DISCOVERY_SERVICENOW_TOKEN`, or `DISCOVERY_SERVICENOW_USER` and `DISCOVERY_SERVICENOW_PASSWORD`. Optional: `DISCOVERY_SERVICENOW_QUERY` (an encoded query on cmdb_ci) | Read on cmdb_ci and cmdb_rel_ci |
| BMC Helix Discovery | `DISCOVERY_BMC_URL`, `DISCOVERY_BMC_TOKEN`. Optional: `DISCOVERY_BMC_API_VERSION` (default 1.0), `DISCOVERY_BMC_QUERIES` (one query per line, to replace the built-in ones) | A user that may run searches |
| Device42 | `DISCOVERY_DEVICE42_URL`, `DISCOVERY_DEVICE42_USER`, `DISCOVERY_DEVICE42_PASSWORD`. Optional: `DISCOVERY_DEVICE42_DOQL` (the query for service communications) | Read-only user with DOQL |

The names start with `DISCOVERY_` because Vercel keeps names such as `AWS_ACCESS_KEY_ID` for
itself. Addresses must be plain https, and the server does not follow redirects, so the
credentials go only where the settings say. A copy without accounts refuses live discovery
unless `DISCOVERY_REQUIRE_SIGN_IN=false` is set, which only makes sense on a copy that only
its owner can reach.

### Integrations (Settings → Integrations)

Owners connect outside services from the app itself; nothing has to be added to the hosting.
Addresses, regions and user names are kept with the workspace. Keys, passwords, tokens and
service-account keys are kept encrypted in Supabase Vault and are never sent back to a browser:
the form shows them only as "Kept". The `integrations` Edge Function (supabase/functions/integrations)
is the only code that reads them back, with the service role the platform gives it, after checking
the caller's own sign-in and role. Every change is written to the audit log, with the names of the
secret fields but never their values. Owners and editors can test a connection; its result is shown
next to the service.

| Group | Services | What the app does with it |
|---|---|---|
| AI | OpenAI (ChatGPT, paid), Groq, Google Gemini (AI Studio), OpenRouter, Cerebras, Mistral, GitHub Models, SambaNova, Cloudflare Workers AI | AI drafting and questions with the workspace's own key. Every request is still counted by the fair-use limits, and reaches the provider only with a ticket from that count. "Load models" lists what the key can use (for OpenAI, its chat models, newest first). |
| Cloud providers | AWS, Azure, Google Cloud | Import → Discover what is running |
| Discovery and CMDB | ServiceNow, BMC Helix Discovery, Device42 | Import → Discover what is running |
| Application portfolio | APM & Landscape | Import → From APM & Landscape, without pasting a token |
| Code | GitHub (and GitHub Enterprise) | Import → From a GitHub repository: the IaC files under a folder, read together |
| Identity and directory | Microsoft Entra ID (Azure AD, including AD synced to it), Okta | Import → People and teams: a draft of people and groups to choose owners from |
| Notifications | Microsoft Teams (Workflows webhook), Slack (incoming webhook), email through Resend, SendGrid, Mailgun or Postmark | A message when a review is asked for or decided, and Export → Share to channels. The text is written by the function from the workspace's records. |
| Work tracking | Jira Cloud, Azure DevOps Boards | A decision record → Create a Jira issue / work item, listed on the record as its follow-up |
| Documentation | Confluence Cloud | Export → Publish to Confluence: a page with the picture and the list of objects |

On-premises Active Directory is reached through Entra ID (Entra Connect), because the function runs in
the cloud and cannot reach a directory inside a private network. The same goes for any service on a
private network: it has to be reachable from the internet over https.

To deploy the function with the Supabase CLI: `supabase functions deploy integrations --no-verify-jwt`
(it checks each person's sign-in itself). It needs no secrets of its own. The hosted copy was
deployed with a one-line index.ts that imports handler.js of one commit of this repository
through jsDelivr (`https://cdn.jsdelivr.net/gh/e20etools/archone-diagrams@<commit>/supabase/functions/integrations/handler.js`);
after a change under src/lib/integrations, deploy it again with the new commit. The live discovery settings
on the server (DISCOVERY_*, below) still work, and a source connected in the workspace is used first.

### Business processes (BPM)

Menu → Processes. A process repository, a BPMN 2.0 modeler, simulation, decision tables and
process mining, all in the browser: the BPMN modeler is loaded only on the process pages, and an
event log is read on the person's computer and never uploaded.

- **Process landscape** (`/processes`). Levels L0 to L4 (process area, group, process,
  sub-process, activity) in three kinds: management, core and support. Shown as a process house,
  a hierarchy, a list, or a matrix of processes and the systems their steps use. "Start with a sample
  landscape" adds five areas and six modelled processes (order to cash, procure to pay, incident
  management, onboarding, loan origination, complaint handling), each with times and chances so
  they can be simulated at once.
- **New process**: blank, from a template, described in words, or imported from any tool that saves
  BPMN 2.0 (Camunda, Signavio, ARIS, Bizagi, Visio). A description goes to the AI model (the server's,
  or the workspace's own from Settings → Integrations) in a mode of its own (`mode: "process"`); without
  one, built-in rules draft it from lines such as "Sales: check the order" and "If ..., ...; otherwise ...".
- **Model**: bpmn.io's modeler (bpmn-js) with its toolbox, context pad and type changes. Selecting
  a step shows what BPMN does not hold: how long it takes (least, usually, most), who does it, cost,
  automation, the systems and data it uses (objects of the architecture model), RACI, the decision
  table of a business rule step and the process a call activity runs; on a flow out of a decision,
  the share of cases taking it. The model can show its checks, the waits from a simulation, or how
  often each step appears in a log. Export as BPMN, SVG or PNG. The bpmn.io mark stays on the canvas,
  as bpmn-js's licence asks.
- **Details and governance**: purpose, owner, how often it runs, KPIs with target and actual,
  risks and controls. Draft → in review (with a reviewer) → published as a numbered version →
  retired. The ten latest published versions are kept, compared with the model (steps added,
  removed, renamed) and can be started from again.
- **RACI** matrix per step (the lane counts as Responsible until set), with a check for steps no one
  does or with more than one Accountable, and a CSV download.
- **Systems**: link each step to objects of the model; "Update the architecture model" adds the process
  as a Process object, with "depends on" links to the applications and "reads/writes" to the data stores
  its steps use. The landscape's matrix shows every process against every system.
- **Simulation** (in the manner of BPSim): discrete events with a fixed seed, triangular times,
  arrivals, people per role with a cost an hour, queues, parallel joins, chances at decisions and
  timers. Scenarios are copied and changed (more people, a faster step, other chances) and run side
  by side: average time, 9 in 10 within, average wait, cost a case, bottleneck and how busy each role is.
- **Decisions**: DMN decision tables with FEEL unary tests (`-`, `>= 18`, `[1..5]`, `"gold","silver"`,
  `not("closed")`), seven hit policies, a "try it" panel that shows which rule applies, warnings for
  duplicate and unreachable rules, and DMN 1.3 import and export.
- **Process mining** (`/process-mining`, and the Mining tab of a process): CSV (columns guessed or
  chosen), XES and OCEL 2.0 JSON. It shows the process as it runs (drawn as BPMN, with how often each step
  was done and the share of cases going each way, at the level of detail chosen), the variants, the
  slowest handovers, rework and throughput times; compares the log with a model (the share of cases that
  follow it, the steps it does not allow, activities missing on either side); takes step times from the
  log for the simulation; or makes the discovered process a model to work on. A process keeps only a
  summary of the last log, never the events. "Try a sample log" uses a made-up purchase-to-pay log.

In hosted mode processes are kept in `process_models` (migration 20261117150000): members read,
owners and editors change, the audit log records added, changed (and whether the model changed),
sent for review, published version N, back to draft, retired and deleted, without the BPMN file; a
scenario starts with the processes of its workspace, and emptying the bin removes deleted processes
(20261117160000). There is no execution engine: processes are modelled, governed and analysed here,
and their BPMN and DMN files run in an engine of your choice.

**Processes through the API and MCP** (migration 20261118090000). `GET /processes` lists the
landscape without the BPMN files, filtered by `status`, `category`, `level`, `parent` (`none` for the
top), `owner`, `q`, `updatedSince`, and `uses=<object id>` for the processes whose steps use a
system. `GET /processes/{id}` returns the BPMN file, the step details, KPIs, risks, decision tables,
the published versions (without their files) and the names of the objects the steps use.

```bash
curl -X POST -H "Authorization: Bearer ark_..." -H "Content-Type: application/json" \
  -d '{"name":"Refunds","lanes":["Service desk","Finance"],
       "steps":[{"id":"check","name":"Check the request","type":"userTask","lane":"Service desk","minutes":10},
                {"id":"pay","name":"Pay the refund","type":"serviceTask","lane":"Finance"}]}' \
  https://<your-project>.supabase.co/functions/v1/api/v1/processes
```

- A process can be sent as `steps` and `flows` (without flows the steps follow one another), and the
  API lays it out as BPMN with its lanes, the same way the app does; or as a BPMN 2.0 file in `xml`,
  which must carry its diagram. A new process at level 2 or below starts with a start, a step and an
  end; an area or a group has no model.
- `PATCH` changes the fields sent. `"status": "review"` (with `reviewer`), `"published"` (the next
  version, with a `note`; the ten latest are kept), `"retired"` or `"draft"` moves it along, as the
  buttons in the app do. `kpis` and `risks` replace their lists; `elements` replaces the step details.
- Only a key with write access changes processes. A propose key cannot (proposals cover objects and
  relationships), and neither can a write key limited to domains, since a process is not inside a
  domain. Every change is in the audit log under the key's name.
- Everything is checked in the database and stored in the shape the app keeps; the app also reads
  every stored process with care, so a damaged part (one step's details, one KPI) is left out instead
  of the whole process.

### Flows: a use case, step by step

A diagram shows what exists. A flow tells what happens: one use case, in order, over the
boxes of one diagram ("A customer pays an invoice").

- **Write one:** open a diagram, press Flows, start a flow, then click the arrows in the
  order things happen. Each click adds a step from the arrow's start to its end. A step can
  also be added from two lists: against the arrow for an answer, or the same box twice for
  something that happens inside it. Steps take a sentence each and can be reordered.
- **Walk through it:** choosing a step brings its two boxes and its arrow forward and dims
  the rest. The left and right arrow keys move between steps; Escape stops.
- **Where it shows:** in the editor, while presenting (an open flow takes the arrow keys;
  with none open they move between diagrams), in a snapshot link, in a live link, and in the
  Word document, as a table of steps under its diagram. Not on the public trust page.
- **What it is:** a flow belongs to its diagram and points at its boxes. It changes nothing
  in the model, travels with the diagram into versions and scenarios, and shows up as a
  change when two versions are compared. A step whose box was taken off the diagram says
  so; deleting an object removes the steps about it.
- Up to 30 flows on a diagram and 60 steps in a flow.

Not done: flows in the slides export, flows through the REST API and the MCP server, and a
flow that crosses from one diagram into another.

### Links to the real thing

An object or a connection can link to where it really lives: the repository, the runbook,
the dashboard, the API contract. Add them under Links in its details.

- Only web addresses are accepted (`https://`, `http://`). `javascript:`, `data:` and
  `file:` are refused, and so is an address with a password in it. A link opens in a new
  tab, and the other site is not told which page it was opened from.
- Up to 20 links on one item. They are kept in versions and scenarios, appear in the audit
  log, and show as a change when two versions are compared.
- **They stay with people who are signed in.** A live link, a snapshot link and the public
  trust page leave them out, because such addresses often point at internal tools.

Not done: links in the spreadsheet import and export, in the REST API and in the MCP
server.

### A password and a last day for live links (hosted mode)

A live link can ask for a password, and can stop working after 1, 7, 30 or 90 days.

- The password is at least 8 characters. It is stored as a salted hash in a table the app
  cannot read, and never written to the audit log. It cannot be read back or changed: to
  change it, switch the link off and create a new one.
- A visitor types it on the link's page. It is sent in the body of the request, never in
  the address, and kept only as long as that page is open.
- After five wrong passwords the link shuts for fifteen minutes, also for the right one.
- A link past its last day says so, and shows nothing.

Snapshot links already had a password of their own (the diagram inside the link is
encrypted). SSO on links needs the paid sign-on features and is not done.

### Approval by Enterprise Architecture and Cybersecurity (hosted mode)

Each diagram is approved by two roles, Enterprise Architecture (EA) and Cybersecurity, before
it goes out. An owner names the approvers of each role in **Settings → Review and approval**
and can make that approval compulsory before publishing.

- **Sending.** An editor opens **Approval** on the diagram and sends it, with a note. Each role
  then **approves** it, **changes and approves** it (the approver edits the diagram on the
  canvas, then approves it as changed), **returns it with notes** to fix, or **rejects** it with
  a reason. A returned diagram is fixed and sent again; the sender, or an owner, can withdraw it.
- **Versions.** Once both roles have approved the diagram *as it is*, it becomes a new version:
  1, 2, 3. Each decision is bound to a fingerprint the database works out (a SHA-256 of the
  diagram, its boxes and where they are, and the objects and relationships it draws). Any change
  afterwards no longer matches: the diagram shows as "Changed after approval", and the next
  version needs both approvals again. If one approver changes the diagram during approval, the
  other role is asked to approve the changed diagram.
- **Nothing goes out before approval.** While approval is compulsory, live links show the last
  approved version (and nothing until there is one), verified copies are made only of it, and a
  snapshot link cannot be made of an unapproved diagram.
- **Approvals page.** Lists what waits for each approver, with a count in the menu, what was
  returned to its sender, and what was decided lately. Every step is in the audit log, and the
  decisions are kept as they were: the app cannot change or delete them.

### The information box of a diagram

A diagram can show an information box in a corner of the canvas (its settings, under
**Information box**): company name and logo, diagram name, version and where its approval
stands, who made it and when, who changed it last and when, the EA and Cybersecurity approvals
as yes or no, and an **authenticity seal**: the first twelve characters of the fingerprint, with
"Original: matches approved version N" or "Differs from approved version N".

- The box is optional. An owner sets the company and logo every box starts with, can make the
  box compulsory on every diagram, and can mark fields as required, so a diagram cannot hide them
  (**Settings → Branding → Information box**). A diagram can name a company and logo of its own.
- Exported PNG and PDF carry the box under the picture, with its seal and a QR code.
- Without a shared workspace the box shows what the browser knows, with dashes for approval.

### Verified copies, with a QR code and a time limit (hosted mode)

**Share → Verified copy** publishes a frozen copy of the diagram with its information box at an
unguessable address, with a QR code to print or put on a slide. Its link works for 1 hour, 24
hours, 7 or 30 days, until a chosen date and time (at most a year), or until it is switched off.

- Anyone opens it without an account. The page says whether the copy is genuine, whether it is
  an approved version, and whether the diagram has changed since (or a newer version was
  approved), and shows the seal code to compare with a printed copy.
- **Export → "Publish a verified copy"** puts the copy's QR code on the PNG or PDF and registers
  the file's SHA-256 with the copy. Whoever is sent the file drops it on the copy's page, which
  says whether it is exactly the file that was exported. The file is checked in the browser.
- An expired or switched-off link shows only that it no longer works. Copies are listed with how
  often they were opened.

### The component library

A library of 1,762 components to draw with, on its own page (Library) and in the panel on
the left of every diagram. Search it, open a section, then drag a component onto the canvas
or click it.

- **General components (481 in 22 sections):** business and strategy, people, applications,
  platforms and middleware, integration, databases and data, hardware and compute, storage
  and backup, data centre and facilities, network, security, identity and access, end-user
  computing, communications, containers and Kubernetes, engineering and DevOps, monitoring
  and operations, AI and analytics, IoT and OT, cloud (any provider), external services, and
  Gulf government and payment services (Nafath, Yakeen, SADAD, mada, ZATCA e-invoicing and
  others).
- **Container platforms (91):** Red Hat OpenShift (OCP, OKD, ROSA, ARO, Dedicated,
  MicroShift), SUSE Rancher (RKE2, K3s, Fleet), VMware Tanzu, Mirantis, Canonical, Nutanix,
  GKE Enterprise, Azure Arc, EKS Anywhere and other distributions; Nomad, Swarm and Mesos;
  runtimes (Docker Engine, Podman, containerd, CRI-O, Kata, gVisor); registries (Docker Hub,
  Harbor, Quay, Artifactory, Nexus); meshes, CNIs and ingress (Istio, Linkerd, Consul, Cilium,
  Calico, OVN-Kubernetes, Envoy, NGINX, Traefik, Gateway API, MetalLB); storage and backup
  (Rook Ceph, Longhorn, Portworx, OpenEBS, Trident, Velero, Kasten); GitOps and delivery
  (Argo CD, Flux, Tekton, operators); autoscaling, management and security (KEDA, Karpenter,
  ACM, ACS, NeuVector, Falco, Trivy, Kyverno, Gatekeeper, cert-manager).
- **Cloud providers (1,281 services):** Amazon Web Services, Microsoft Azure, Google Cloud,
  Oracle Cloud Infrastructure, IBM Cloud, Alibaba Cloud and Huawei Cloud, each in the
  provider's own sections. The AWS, Azure, Google Cloud and IBM names start from draw.io's
  shape libraries (Apache License 2.0), cleaned of repeats, retired products and icons that
  are not services; Google Cloud's were brought up to date. Oracle and Huawei are not in
  draw.io and its Alibaba list is out of date, so those three were listed by hand.
- **Icons:** every component is drawn with an icon for what it does (a firewall, a
  warehouse, a queue), from Lucide (ISC licence). Cloud services are drawn the same way, with
  the provider named beside them; the providers' own artwork is not included.
- **No repeats:** a name appears once in a section (case and punctuation ignored), and a
  cloud service once per provider. A test holds this.
- **What it becomes:** an ordinary object of one of the model's types (a firewall is a
  network device, Amazon S3 is storage), so checks, views and dependencies work as before.
  The object remembers its component, is drawn with its icon, and a cloud service gets its
  provider's name as its technology. An existing object can be told which component it is.
- **Basic information:** each component asks for what matters about it, from 44 sets of
  fields: a server's host name, serial number and warranty; a database's engine, recovery
  point and recovery time; a network device's management IP and firmware; a laptop's owner,
  asset tag and disk encryption; a data centre's tier and power; a cloud service's account,
  region and resource ID. Answers are kept as the object's fields, so they travel with it
  through versions, scenarios, exports and the API. A number, IP address, date or web
  address that does not look like one is marked, and kept.

Not done: choosing a component in the spreadsheet import and showing it in the exports, the
component in the REST API and the MCP server, and icons of your own uploaded for a
component.

### Your own components and protocols

Owners and editors change the library for their workspace; the built-in one stays as it is.

- **New component:** a name, its section (general or a cloud provider's), what it is in the
  model, the basic information it asks for, other names to find it by, and an icon picked
  from the library's icons. It joins its section, marked "Your own", and is found by name and
  search like any other.
- **Edit** any component, built-in ones included. A changed built-in one is marked "Changed
  here" and every object made from it shows the change; **Back to built-in** undoes it.
- **Duplicate** makes a copy of any component as the workspace's own, to change from there.
- **Remove** hides a built-in component from this workspace (objects made from it stay, drawn
  as their type), listed under "Removed" to **put back**. **Delete** takes away one of the
  workspace's own.
- **Protocols and ports** work the same way: New protocol (name, port, transport, group,
  whether it encrypts, what it is for), Edit, Duplicate, Remove or Delete, Back to built-in,
  and Put back. Renaming a protocol offers to rename it on the connections that carry it;
  removing one leaves connections as they are written. The checks use the "encrypts" answer.
- "Your own and changed" lists them all. They are kept with the workspace (in the browser, or
  in `library_items` when signed in, recorded in the audit log), travel into scenarios and
  backups, and apply everywhere the library is used: the diagram panel, the wizard, the
  object panel and the protocol suggestions.

### Large models

Measured on the build machine with a generated model (domains of systems of services and
databases, about 1.8 relationships per object). Each figure is one run, in milliseconds:

| Objects | All built-in checks | A journey rule | One edit | What to save | Compare two copies | Impact of one object | Arrows of a landscape view |
|--------:|--------:|--------:|--------:|--------:|--------:|--------:|--------:|
| 500 | 17 | 5 | 0 | 0 | 4 | 1 | 1 |
| 2,000 | 35 | 26 | 2 | 1 | 11 | 3 | 5 |
| 5,000 | 65 | 137 | 4 | 2 | 31 | 9 | 13 |

`src/lib/perf.test.ts` repeats this with loose limits, to catch something becoming many
times slower.

On the canvas, a diagram with more than 150 boxes draws only the boxes in view; a picture
export draws all of them first. In the browser check a diagram of 400 boxes opened in under
a second and, zoomed in, drew 80 of them. Not measured: diagrams of thousands of boxes,
automatic layout of a very large diagram, loading a large workspace from the hosted
database, and several people editing one at once.

## Run it

Needs Node.js 20.19 or newer.

```bash
npm install
npm run dev          # http://localhost:8080
```

To try AI drafting locally, copy `.env.example` to `.env.local` and fill in a provider.

While `npm run dev` is running, a tab reloads itself when it loses its connection to the dev
server (for example after the computer sleeps). That is the dev server's doing; a hosted
build does not reload.

## Check it

```bash
npm test                   # 593 tests: model, the component library, flows, links, protected live links, decisions, arranging, health, CALM, scenario merging, the trust page, the document, your own rules, large models, templates, the pull-request gate, the APM import, AI, questions, checks, MCP, import readers, sync engine, comparison, and the database rules and the API on a real Postgres
npm run build              # type-check and production build into dist/
npm run test:browser       # 241 end-to-end checks of browser-only mode (run after a build)
npm run test:browser:cloud # 124 end-to-end checks of hosted mode with several people
```

`test:browser` serves the production build, including `api/ai.js`, and walks through the
main flows: sample model, canvas editing, exports, share links, dependencies, AI draft and
review, backup, importing files. It starts a stand-in AI provider on localhost, so it needs no key.
Set `CHROME_PATH` if Chrome is not in a default location.

## Host it on Vercel

1. Put this folder in a GitHub repository.
2. In Vercel choose **Add New > Project** and import the repository. The included
   `vercel.json` sets the build command, the output folder, the page rewrites and the
   function settings.
3. Optional: add variables from `.env.example` under **Settings > Environment Variables**,
   then redeploy. The AI variables switch on AI drafting; the two Supabase variables switch
   on hosted mode.

`api/ai.js` is the Vercel Function behind `/api/ai`. It is a generated, self-contained
file: `npm run build` rebuilds it from `src/lib/ai`, and `npm test` fails if it is stale.

**Before you share the address:** in browser-only mode there is no sign-in, so anyone who can
reach the site can use it, including the AI endpoint. Set `AI_ACCESS_CODE` so only people
with the code can spend your AI budget, or switch on hosted mode, where the endpoint asks
for a signed-in person. Anyone can still create an account unless you turn sign-ups off in
Supabase, so keep a spending limit on the AI key either way.

### Closing the site to new accounts

The database can refuse new accounts by itself, which is useful for a private or pilot
site. Run these in the Supabase SQL Editor:

```sql
update public.signup_settings set open = false;                          -- stop new accounts
insert into public.allowed_signups (email) values ('new@example.com');   -- let one address in
update public.signup_settings set open = true;                           -- open again
```

While the site is closed, an address that is not on the list gets an error when it tries
to sign up, and people who already have an account are not affected. Add an address to the
list before you invite that person to a workspace. Neither table can be read or changed
through the app.

## Host it on Lovable

Not tried yet. Two things to know first:

- Lovable does not import an existing project in one step. The route is: create a new
  Lovable project, connect it to GitHub so that Lovable creates a repository, then replace
  that repository's contents with this folder and push. Lovable's own pages disagree on
  whether an existing repository can be attached, so expect to use the route above.
- Lovable does not run `api/` functions. The app works without them (text drafts fall back
  to the built-in rules). For AI on Lovable, deploy `supabase/functions/ai` as an Edge
  Function, turn off JWT verification for it (the function checks the origin and the
  optional access code itself), set the AI variables and `AI_ALLOWED_ORIGIN` as function
  secrets, and set `VITE_AI_ENDPOINT` to the function's address. With
  `AI_PROVIDER=lovable` the function calls the Lovable AI gateway and needs `AI_MODEL`.

The dev server already uses the host and port Lovable's preview expects (`::`, 8080).

## AI providers

| `AI_PROVIDER` | Needs | Notes |
| --- | --- | --- |
| `anthropic` | `AI_API_KEY` | `AI_MODEL` optional |
| `openai` | `AI_API_KEY`, `AI_MODEL` | For example `gpt-6.1-sol`. `AI_REASONING_EFFORT` optional: `low`, `medium`, `high` or `xhigh` |
| `groq` | `AI_API_KEY` (or `GROQ_API_KEY`) | Free plan for training. Defaults: `llama-3.3-70b-versatile` for text, `qwen/qwen3.8-27b` for pictures (`AI_MODEL`, `AI_VISION_MODEL` to change) |
| `lovable` | `AI_API_KEY` (or `LOVABLE_API_KEY`), `AI_MODEL` | Lovable AI gateway |
| `openai-compatible` | `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` | any endpoint that speaks `/chat/completions` |

Drafting from a picture needs a model that accepts images. `AI_VISION_MODEL` names a second
model for pictures when the main one reads text only (groq, openai and openai-compatible).

### Fair use of the AI

With accounts, every AI request is checked and counted before it reaches the model, so the
key is shared fairly and nobody can use more than their share.

- **Owners set the rules** in Settings → AI → Fair use and limits: AI on or off for the
  workspace; who may use it (every member, owners and editors, or owners only); what it may do
  (drafts from text and voice, drafts from a picture, answers on the Ask page); limits for
  each person (requests an hour, requests in 24 hours, tokens in 24 hours); limits for the
  whole workspace (requests and tokens in 24 hours, scenarios included). Defaults: 10 an hour,
  40 a day and 40,000 tokens a day per person; 300 requests and 150,000 tokens a day per
  workspace. Changes are recorded in the audit log.
- **Exceptions per person:** another daily limit, or AI paused, from the "Use by person" table.
- **How it is applied:** the AI server calls `ai_begin` in the database with the caller's own
  sign-in; the database checks the rules and counts the request, or refuses it with the
  reason and when to try again. After the answer the server calls `ai_finish` with the tokens
  the model reported. Windows roll (the last hour, the last 24 hours); a request the model
  fails does not count; a person's own use counts in every workspace, so a scenario or
  another workspace does not start them afresh. Only the server holds the key that closes a
  request, and nobody can write the usage table directly. `AI_GLOBAL_DAILY_REQUESTS` caps
  requests a day for everyone together (900 by default with Groq, to stay inside its free
  plan); `AI_FAIR_USE=off` switches the checks off for a database without the tables.
- **What people see:** everyone sees their own use and the workspace's against the limits,
  and what is left in the draft dialog and on the Ask page. Owners also see use by person
  (24 hours, 7 days, 30 days, tokens, last used) and requests by day for the last 14 days.
- In the browser-only copy nobody is counted; `AI_ACCESS_CODE` keeps others off the key.

### OpenAI (ChatGPT) with a workspace's own key

Settings → Integrations → AI provider → **OpenAI (ChatGPT)**, then the key from
https://platform.openai.com/api-keys, then **Save and test**. OpenAI bills its account per token;
there is no free plan.

- **Models.** The newest four are offered to pick from (November 2026), from the most capable:
  GPT-6 Astra (`gpt-6-astra`), GPT-6.1 Sol (`gpt-6.1-sol`, the balanced one, chosen at first),
  GPT-6.1 Terra (`gpt-6.1-terra`) and GPT-6 Luna (`gpt-6-luna`). All read pictures. Any other
  model can be typed in; **Load models** lists the chat models the key can use, newest first,
  so a model OpenAI releases later shows up there without a change to the app.
- **Reasoning effort.** These models think before they answer. Low (the first choice) keeps
  drafts quick and cheap; medium, high and extra high are slower and cost more; "Not set"
  leaves the model's own default. An older model that takes no effort is asked again without it.
- The app sends OpenAI `max_completion_tokens` instead of `max_tokens`, with room for the
  thinking, and leaves out `temperature`, which these models do not take.
- The key is kept encrypted in the database's vault and only the integrations function reads
  it. The fair-use limits in Settings → AI apply as for every provider.

### Free AI for training (Groq)

1. Sign in at https://console.groq.com and create a key under API Keys.
2. In Vercel: Project → Settings → Environment Variables, add `AI_API_KEY` with the key
   (and `AI_PROVIDER` = `groq`, unless it is already there), then redeploy.
3. Settings → AI in the app shows "Connected" and the two models.

The free plan allows a few requests a minute and a daily token budget per model. When it is
used up the app says so and asks to wait a minute; text drafts fall back to the built-in rules.
The same model answers questions on the Ask page that the built-in reader cannot.
The key is read on the server only and is never sent to the browser.

## Where things are

```
src/lib/            the model and all logic, free of React (tested in *.test.ts)
  types.ts          data shapes, validated with zod
  model.ts          objects, relationships, diagrams
  views.ts          what each view type shows; rolled-up arrows; layout per diagram
  graph.ts          dependency traversal and impact analysis
  share.ts          share-link packing and encryption
  exporters.ts      CSV, JSON, Mermaid, PlantUML
  repository.ts     where the workspace is stored (the seam for the phase 2 database)
  checks/           rule packs, the data fields and the data map; custom.ts and parseRule.ts
                    hold the workspace's own rules and the reader of rules written as sentences
  trust.ts          the public trust page: what it says and what may leave the workspace
  document/         the architecture as a Word file or slides
  mcp/              the MCP server for assistants
  ask/              ask the architecture: answers read from the model, the model as text for the AI model
  ai/               prompt, draft validation, built-in rules, provider calls, review
  bpm/              business processes: BPMN reading and writing, checks, simulation, DMN,
                    process mining, the repository and its templates, drafting from words
  import/           readers for Excel, CSV, Visio, draw.io, Mermaid and Structurizr files, and turning them into drafts
  cloud/            hosted mode: sync engine, row mapping, Supabase adapter, session,
                    comments, versions and review (collab.ts)
src/components/     canvas, panels, dialogs; cloud/ holds sign-in, members, comments,
                    version comparison, review settings
src/pages/          one file per screen; processes/ holds the process pages (loaded on demand)
src/components/bpm/ the BPMN canvas (bpmn-js)
server/             sources of the hosted AI function
api/ai.js           generated Vercel Function
api/apm.js          generated Vercel Function that reads the APM feeds
supabase/migrations/     the database schema and access rules
supabase/functions/ai/   Edge Function wrapper for Supabase or Lovable Cloud
supabase/functions/api/  Edge Function that serves the REST API
supabase/functions/mcp/  Edge Function that serves the MCP server
gate/               the pull-request gate: one generated file, its README and a workflow to copy
skills/             a skill for coding agents that work against the model
scripts/            build-api.mjs, browser-check.mjs
```

## Next phases (from the PRD)

- **Phase 2, done:** accounts, shared workspaces with roles, hosted database, real-time
  editing, comments and mentions, versions, review before publishing, spreadsheet import
  and export, Visio and draw.io import.
  Also done: REST API with keys, webhooks, live links and embeds.
  Also done: ask the architecture. Phase 2 is complete.
- **Phase 3, done so far:** audit log, checks with rule packs, data fields and data map,
  scenarios, editors limited to domains, MCP server, ArchiMate exchange, ArchiMate and
  BPMN notation with BPMN export, the evidence pack.
- **Phase 4, done so far** also includes business process management: a process landscape,
  BPMN 2.0 modelling, simulation, DMN decision tables and process mining.
- **Phase 3, still to come:** SSO and SCIM (needs a paid Supabase plan and an identity
  provider), cloud and CMDB discovery (needs a cloud account).
