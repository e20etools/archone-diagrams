import { describe, expect, it } from "vitest";
import { createObject, emptyWorkspace } from "../model";
import { textModelToProposal } from "./draft";
import { isMermaid, mermaidBlocks, readMermaid } from "./mermaid";
import { isStructurizr, readStructurizr } from "./structurizr";

const names = (model: { elements: { name: string; typeId: string }[] }) => Object.fromEntries(model.elements.map((e) => [e.name, e.typeId]));
const links = (model: { elements: { id: string; name: string }[]; links: { sourceId: string; targetId: string; label: string }[] }) => {
  const name = (id: string) => model.elements.find((e) => e.id === id)?.name ?? `?${id}`;
  return model.links.map((l) => `${name(l.sourceId)} > ${name(l.targetId)}${l.label ? `: ${l.label}` : ""}`);
};

describe("Mermaid flowcharts", () => {
  const source = `---
title: ignored
---
%%{init: {"theme": "dark"}}%%
flowchart LR
  %% the shop
  user((Customer)) --> web["Web shop<br/>React"]
  web -->|REST| api[Orders API]
  api -- reads and writes --> db[(Orders DB)]
  api -.-> q([Events queue]):::hot
  api ==> pay{{Payment provider}}
  subgraph shop [Online shop]
    web
    api
    db
  end
  subgraph outer["Retail"]
    subgraph inner[Fulfilment]
      wms[Picking service]
    end
  end
  q --> wms & mail[Mailer]
  a1 --- a2; a2 <-- back --> a3
  classDef hot fill:#f96
  click web "https://example.com"
  linkStyle 0 stroke:red
`;
  const model = readMermaid(source);

  it("reads boxes of every shape, with their text and a type guessed from shape and words", () => {
    expect(names(model)).toMatchObject({
      Customer: "actor",
      "Web shop": "application",
      "Orders API": "service",
      "Orders DB": "database",
      "Events queue": "queue",
      "Payment provider": "application",
      "Picking service": "service",
      Mailer: "application",
      "Online shop": "system",
      Retail: "domain",
      Fulfilment: "system",
    });
    expect(model.elements.find((e) => e.name === "Web shop")?.description).toBe("React");
    expect(model.skipped).toEqual([]);
  });

  it("reads arrows of every style, their labels, chains and groups", () => {
    expect(links(model)).toEqual([
      "Customer > Web shop",
      "Web shop > Orders API: REST",
      "Orders API > Orders DB: reads and writes",
      "Orders API > Events queue",
      "Orders API > Payment provider",
      "Events queue > Picking service",
      "Events queue > Mailer",
      "a1 > a2",
      "a2 > a3: back",
    ]);
  });

  it("puts a box inside the group it was first written in", () => {
    const parent = (name: string) => model.elements.find((e) => e.id === model.elements.find((x) => x.name === name)?.parentId)?.name ?? null;
    expect(parent("Picking service")).toBe("Fulfilment");
    expect(parent("Fulfilment")).toBe("Retail");
    // The web shop was first written outside the group, so it stays outside.
    expect(parent("Web shop")).toBeNull();
    expect(parent("Mailer")).toBeNull();
  });

  it("finds a diagram inside a Markdown file and says which kinds it cannot read", () => {
    const markdown = "# Notes\n\n```mermaid\ngraph TD\n  A[Billing] --> B[(Ledger)]\n```\n\n```mermaid\nflowchart LR\n  X --> Y\n```\n";
    expect(mermaidBlocks(markdown)).toHaveLength(2);
    expect(isMermaid(markdown)).toBe(true);
    const read = readMermaid(markdown);
    expect(names(read)).toEqual({ Billing: "application", Ledger: "database" });
    expect(read.skipped).toEqual(["the file holds 2 diagrams and only the first was read"]);
    expect(isMermaid("name,type\nA,service")).toBe(false);
    expect(() => readMermaid("sequenceDiagram\n  A->>B: hi")).toThrow(/Only flowcharts .* and C4 diagrams can be imported/);
    expect(() => readMermaid("hello")).toThrow(/No Mermaid flowchart or C4 diagram/);
    expect(readMermaid("flowchart TD\n  A --> B\n  this is :: not a line").skipped).toEqual(["1 line could not be read"]);
  });
});

describe("Mermaid C4 diagrams", () => {
  const model = readMermaid(`C4Container
  title Container diagram for Internet Banking
  Person(customer, "Customer", "A customer of the bank")
  System_Ext(mail, "E-mail system", "Microsoft Exchange")
  Enterprise_Boundary(bank, "Big Bank") {
    System_Boundary(ib, "Internet Banking") {
      Container(spa, "Single-page app", "JavaScript, Angular", "The banking front end")
      Container(api, "API application", "Java, Spring MVC", "Provides banking functions")
      ContainerDb(db, "Database", "Oracle", "Stores accounts")
      ContainerQueue(q, "Events", "Kafka")
    }
  }
  Rel(customer, spa, "Uses", "HTTPS")
  Rel(spa, api, "Calls", "JSON/HTTPS")
  Rel_D(api, db, "Reads from and writes to", "JDBC")
  BiRel(api, q, "Publishes")
  Rel_Back(mail, api, "Sends e-mail using")
  UpdateRelStyle(customer, spa, $offsetY="-40")
`);

  it("reads people, systems, containers and boundaries with what C4 says they are", () => {
    expect(model.title).toBe("Container diagram for Internet Banking");
    expect(names(model)).toEqual({
      Customer: "actor",
      "E-mail system": "external-system",
      "Big Bank": "domain",
      "Internet Banking": "system",
      "Single-page app": "application",
      "API application": "service",
      Database: "database",
      Events: "queue",
    });
    const api = model.elements.find((e) => e.name === "API application")!;
    expect(api).toMatchObject({ technology: "Java, Spring MVC", description: "Provides banking functions", parentId: "ib" });
    expect(model.elements.find((e) => e.name === "Customer")?.description).toBe("A customer of the bank");
    expect(model.skipped).toEqual([]);
  });

  it("reads relationships with their technology, and turns a backwards one around", () => {
    expect(links(model)).toEqual(["Customer > Single-page app: Uses", "Single-page app > API application: Calls", "API application > Database: Reads from and writes to", "API application > Events: Publishes", "API application > E-mail system: Sends e-mail using"]);
    expect(model.links[1].technology).toBe("JSON/HTTPS");
  });
});

describe("Structurizr DSL", () => {
  const source = `/* a workspace */
workspace "Big Bank" "The bank's landscape" {
    !identifiers hierarchical
    model {
        customer = person "Customer" "A customer of the bank" "Customer"
        group "Retail" {
            bank = softwareSystem "Internet Banking" "Lets customers bank online" {
                web = container "Web application" "Delivers the front end" "Java and Spring MVC"
                api = container "API application" "Banking functions" "Java" {
                    signin = component "Sign-in controller" "Signs people in" "Spring MVC"
                    -> db "Reads from and writes to" "JDBC"
                }
                db = container "Database" "Accounts" "Oracle" {
                    tags "Database"
                }
                web -> api "Calls" "JSON/HTTPS"
            }
        }
        mainframe = softwareSystem "Mainframe" {
            description "The core banking system"
            tags "Existing System"
            properties {
                "Owner" "Core"
            }
        }
        # relationships
        customer -> bank.web "Uses" "HTTPS"
        bank.api -> mainframe "Gets account data from" // the old way
        customer -> nowhere "Lost"
        live = deploymentEnvironment "Live" {
            deploymentNode "bigbank-web" "" "Ubuntu 22.04" {
                containerInstance bank.web
            }
        }
        !include other.dsl
    }
    views {
        systemContext bank "Context" {
            include *
            autolayout lr
        }
        styles {
            element "Person" { shape person }
        }
    }
}`;
  const model = readStructurizr(source);

  it("reads the model block and nothing from the views", () => {
    expect(model.title).toBe("Big Bank");
    expect(names(model)).toEqual({
      Customer: "actor",
      Retail: "domain",
      "Internet Banking": "system",
      "Web application": "web-app",
      "API application": "service",
      "Sign-in controller": "component",
      Database: "database",
      Mainframe: "external-system",
      "bigbank-web": "server",
    });
    const mainframe = model.elements.find((e) => e.name === "Mainframe")!;
    expect(mainframe.description).toBe("The core banking system");
    expect(model.elements.find((e) => e.name === "Web application")).toMatchObject({ technology: "Java and Spring MVC", description: "Delivers the front end" });
    expect(model.elements.find((e) => e.name === "Customer")?.tags).toEqual(["customer"]);
  });

  it("resolves short and dotted names, 'this', and instances on deployment nodes", () => {
    expect(links(model)).toEqual([
      "API application > Database: Reads from and writes to",
      "Web application > API application: Calls",
      "Customer > Web application: Uses",
      "API application > Mainframe: Gets account data from",
      "Web application > bigbank-web",
    ]);
    expect(model.links.at(-1)?.kind).toBe("hosted_on");
    expect(model.skipped).toEqual(["1 relationship names something that is not in the file", "1 included file was not followed"]);
  });

  it("knows its own files and refuses others", () => {
    expect(isStructurizr(source)).toBe(true);
    expect(isStructurizr("flowchart LR\n A --> B")).toBe(false);
    expect(() => readStructurizr("just some text")).toThrow(/does not look like a Structurizr DSL file/);
    expect(() => readStructurizr("workspace {\n model {\n }\n}")).toThrow(/no people, systems or containers/);
  });

  it("becomes a draft that nests by level, reuses objects by name and guesses relationship kinds", () => {
    let ws = emptyWorkspace("T");
    const existing = createObject(ws, { name: "mainframe", typeId: "system" });
    ws = existing.ws;
    const draft = textModelToProposal(ws, model, "structurizr", "bank.dsl");
    expect(draft).toMatchObject({ origin: "import", importKind: "structurizr", engine: "Structurizr import", source: "bank.dsl", status: "pending" });
    expect(draft.placeAsDrawn).toBeUndefined();
    const by = (name: string) => draft.objects.find((o) => o.name === name)!;
    const parent = (name: string) => draft.objects.find((o) => o.key === by(name).parentKey)?.name ?? null;
    expect(by("Mainframe").matchId).toBe(existing.object.id);
    expect(parent("Internet Banking")).toBe("Retail");
    expect(parent("API application")).toBe("Internet Banking");
    expect(parent("Sign-in controller")).toBe("API application");
    expect(by("Customer").tags).toEqual(["customer"]);
    const kind = (source: string, target: string) => draft.relationships.find((r) => r.sourceKey === by(source).key && r.targetKey === by(target).key);
    expect(kind("API application", "Database")).toMatchObject({ kind: "reads_writes", protocol: "JDBC", label: "Reads from and writes to" });
    expect(kind("Web application", "bigbank-web")?.kind).toBe("hosted_on");
    expect(kind("API application", "Mainframe")?.kind).toBe("calls");
    expect(draft.notes).toContain("laid out afresh");
    expect(draft.notes).toContain("1 included file was not followed");
  });

  it("gives a Mermaid group that cannot hold its boxes a note instead of a wrong parent", () => {
    const flow = readMermaid("flowchart TD\n  subgraph a[Area]\n    subgraph b[Shop]\n      subgraph c[Deep]\n        x[Thing]\n      end\n    end\n  end\n");
    const draft = textModelToProposal(emptyWorkspace("T"), flow, "mermaid", "a.mmd");
    const by = (name: string) => draft.objects.find((o) => o.name === name)!;
    // Area and Shop both hold groups, so both read as domains; a domain cannot sit inside a domain.
    expect(by("Shop").parentKey).toBeNull();
    expect(by("Deep").parentKey).toBe(by("Shop").key);
    expect(by("Thing").parentKey).toBe(by("Deep").key);
    expect(draft.notes).toMatch(/1 element could not keep its place inside another/);
  });
});
