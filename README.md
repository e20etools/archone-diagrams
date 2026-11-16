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
ask `may_connect`. 17 tools.

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

`/objects`, `/relationships` and `/diagrams` each take GET (list, with filters and a cursor),
POST, and GET, PATCH and DELETE on `/{id}`. `/model` returns everything in one reply, and
`/openapi.json` describes the API for tools (no key needed). Things to know:

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
  diagram is reported as a change to that diagram.
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
npm test                   # 316 tests: model, decisions, arranging, health, CALM, scenario merging, the trust page, the document, AI, questions, checks, MCP, import readers, sync engine, comparison, and the database rules and the API on a real Postgres
npm run build              # type-check and production build into dist/
npm run test:browser       # 119 end-to-end checks of browser-only mode (run after a build)
npm run test:browser:cloud # 83 end-to-end checks of hosted mode with several people
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
| `openai` | `AI_API_KEY`, `AI_MODEL` | |
| `lovable` | `AI_API_KEY` (or `LOVABLE_API_KEY`), `AI_MODEL` | Lovable AI gateway |
| `openai-compatible` | `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` | any endpoint that speaks `/chat/completions` |

Drafting from a picture needs a model that accepts images.
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
  checks/           rule packs, the data fields and the data map
  trust.ts          the public trust page: what it says and what may leave the workspace
  document/         the architecture as a Word file or slides
  mcp/              the MCP server for assistants
  ask/              ask the architecture: answers read from the model, the model as text for the AI model
  ai/               prompt, draft validation, built-in rules, provider calls, review
  import/           readers for Excel, CSV, Visio, draw.io, Mermaid and Structurizr files, and turning them into drafts
  cloud/            hosted mode: sync engine, row mapping, Supabase adapter, session,
                    comments, versions and review (collab.ts)
src/components/     canvas, panels, dialogs; cloud/ holds sign-in, members, comments,
                    version comparison, review settings
src/pages/          one file per screen
server/             sources of the hosted AI function
api/ai.js           generated Vercel Function
supabase/migrations/     the database schema and access rules
supabase/functions/ai/   Edge Function wrapper for Supabase or Lovable Cloud
supabase/functions/api/  Edge Function that serves the REST API
supabase/functions/mcp/  Edge Function that serves the MCP server
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
- **Phase 3, still to come:** SSO and SCIM (needs a paid Supabase plan and an identity
  provider), cloud and CMDB discovery (needs a cloud account).
