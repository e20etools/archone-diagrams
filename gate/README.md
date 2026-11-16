# The pull-request gate

`archone-gate.mjs` checks the connections a repository declares against the architecture
model in ArchONE Diagrams, with the same rules the MCP tool `may_connect` uses. It is one
file with no dependencies and runs on Node 20 or newer. It is generated from
`src/lib/gate`; change it there and run `npm run build:api`.

## What a repository adds

A file named `archone.json` at its root, saying which system this repository is and what
it connects to:

```json
{
  "system": "Orders service",
  "connections": [
    { "to": "Orders database", "protocol": "TLS", "kind": "reads_writes" },
    { "to": "Payment provider", "protocol": "HTTPS" }
  ]
}
```

`system` and `to` are names or ids of objects in the model. `kind` is optional and is used
when a connection is proposed; it is one of `calls`, `depends_on`, `reads_writes`,
`hosted_on`, `routes_to`, `replicates_to`, `flows_to`. A repository that holds several
systems puts the same shape in a list under `"systems"`.

## What the gate answers

| The model says | Meaning | Result |
|---|---|---|
| Yes | The relationship is in the model and no rule forbids it | passes |
| No | A rule forbids it: a retired or deprecated target, a data store reached from outside, an unencrypted protocol, sensitive data to an outside system | fails |
| Not known | An end is not in the model, or the relationship is not | warns, or fails with `--unknown fail` |

With `--propose`, connections the model does not know, between two objects it does know,
are filed as one proposal that names the pull request. A person reviews it in the app under
Drafts; nothing reaches the model before that.

## Running it

```bash
ARCHONE_API_URL=https://<project>.supabase.co/functions/v1/api/v1 \
ARCHONE_API_KEY=ark_... \
node archone-gate.mjs --file archone.json --unknown warn --propose
```

An owner creates the key under Settings. Read access is enough to check; `--propose` needs
a key that may propose. Exit code 0 means passed, 1 did not pass, 2 could not run. In GitHub
Actions the report is also written to the run's summary page. `github-workflow.yml` in this
folder is a workflow to copy.

## What it does not do

- It reads the declaration, not the code. A connection the code makes and the file does not
  declare is not seen.
- It checks against the working model. In a workspace that requires review, that can be
  ahead of the published version.
- It has been run against the API handler and database rules in the tests, not from a real
  GitHub Actions run.
