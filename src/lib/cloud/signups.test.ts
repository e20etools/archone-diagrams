import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const dir = (path: string) => fileURLToPath(new URL(`../../../supabase/${path}`, import.meta.url));
let db: PGlite;
const join = (email: string) => db.query("insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id", [email]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(dir("tests/supabase-shim.sql"), "utf8"));
  for (const file of readdirSync(dir("migrations")).sort()) await db.exec(readFileSync(dir(`migrations/${file}`), "utf8"));
}, 60_000);

describe("closing the site to new accounts", () => {
  it("takes new accounts until it is closed, then only the addresses on the list", async () => {
    await join("first@example.com");
    await db.exec("update public.signup_settings set open = false");
    await expect(join("stranger@example.com")).rejects.toThrow(/not taking new accounts/);
    await db.query("insert into public.allowed_signups (email, note) values ('invited@example.com', 'New architect')");
    await join("Invited@Example.com");
    await expect(join("other@example.com")).rejects.toThrow(/not taking new accounts/);
    expect((await db.query<{ n: number }>("select count(*)::int as n from auth.users")).rows[0].n).toBe(2);
    await db.exec("update public.signup_settings set open = true");
    await join("later@example.com");
  });

  it("keeps the switch and the list away from people who use the app", async () => {
    for (const role of ["anon", "authenticated"]) {
      await expect(
        db.transaction(async (tx) => {
          await tx.exec(`set local role ${role}`);
          await tx.query("select * from public.signup_settings");
        }),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.transaction(async (tx) => {
          await tx.exec(`set local role ${role}`);
          await tx.query("insert into public.allowed_signups (email) values ('me@example.com')");
        }),
      ).rejects.toThrow(/permission denied/);
    }
    await expect(db.exec("insert into public.signup_settings (id, open) values (false, true)")).rejects.toThrow(/check constraint/);
    await expect(db.exec("insert into public.allowed_signups (email) values ('Upper@Example.com')")).rejects.toThrow(/check constraint/);
  });
});
