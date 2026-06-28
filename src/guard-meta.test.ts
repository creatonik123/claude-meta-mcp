import { test } from "node:test";
import assert from "node:assert/strict";
import { createGuardMeta } from "./guard-meta.ts";
import type { GraphClient } from "./meta-adapters.ts";

// Fake graph client: returns a canned response per requested path, records GETs.
function fakeClient(byPath: Record<string, Record<string, unknown>>): GraphClient & { gets: Array<{ path: string; params: unknown }> } {
  const gets: Array<{ path: string; params: unknown }> = [];
  return {
    gets,
    async get(path, params) { gets.push({ path, params }); return (byPath[path] ?? {}) as never; },
    async post() { throw new Error("guard-meta must never POST"); },
  };
}

const ACCT = "act_1133075730765139";

test("entityAccountId returns the entity's account_id", async () => {
  const m = createGuardMeta(fakeClient({ "/23890": { account_id: "1133075730765139" } }), ACCT, 100);
  assert.equal(await m.entityAccountId("23890"), "1133075730765139");
});

test("entityAccountId returns null when absent (fail-closed at the guard)", async () => {
  const m = createGuardMeta(fakeClient({ "/23890": {} }), ACCT, 100);
  assert.equal(await m.entityAccountId("23890"), null);
});

test("currentBudget converts minor units to major via the offset; not CBO when the ad set owns the budget", async () => {
  const m = createGuardMeta(fakeClient({ "/23890": { daily_budget: "5000", lifetime_budget: "0", campaign: {} } }), ACCT, 100);
  const b = await m.currentBudget("23890");
  assert.equal(b?.dailyBudget, 50); // 5000 cents / 100
  assert.equal(b?.ownedByCampaignCbo, false);
});

test("currentBudget flags CBO: ad set has no budget but the campaign does", async () => {
  const m = createGuardMeta(fakeClient({ "/23890": { campaign: { daily_budget: "20000" } } }), ACCT, 100);
  const b = await m.currentBudget("23890");
  assert.equal(b?.dailyBudget, null);
  assert.equal(b?.ownedByCampaignCbo, true);
});

test("realisedSpend reads today + month-to-date account spend, marks complete, carries date_stop", async () => {
  const m = createGuardMeta(
    fakeClient({
      [`/${ACCT}/insights`]: { data: [{ spend: "120.50", date_stop: "2026-06-28" }] },
    }),
    ACCT,
    100
  );
  const s = await m.realisedSpend();
  assert.equal(s?.today, 120.5);
  assert.equal(s?.dateStop, "2026-06-28");
  assert.equal(s?.complete, true);
});

test("realisedSpend with empty insights -> not complete (guard treats empty as unknown and refuses)", async () => {
  const m = createGuardMeta(fakeClient({ [`/${ACCT}/insights`]: { data: [] } }), ACCT, 100);
  const s = await m.realisedSpend();
  assert.equal(s?.complete, false);
});

test("realisedSpend: today present but month-to-date empty -> complete FALSE (never claim complete with MTD unknown)", async () => {
  const client: GraphClient = {
    async get(path: string, params: { date_preset?: string } = {}) {
      if (path !== `/${ACCT}/insights`) return {} as never;
      return (params.date_preset === "today" ? { data: [{ spend: "120.50", date_stop: "2026-06-28" }] } : { data: [] }) as never;
    },
    async post() { throw new Error("no"); },
  };
  const s = await createGuardMeta(client, ACCT, 100).realisedSpend();
  assert.equal(s?.complete, false); // MTD missing => must NOT be complete (else the monthly cap fails open)
});

test("realisedSpend: negative spend -> complete FALSE (negative is malformed; must not loosen the >= caps)", async () => {
  const m = createGuardMeta(fakeClient({ [`/${ACCT}/insights`]: { data: [{ spend: "-999", date_stop: "2026-06-28" }] } }), ACCT, 100);
  assert.equal((await m.realisedSpend())?.complete, false);
});

test("currentBudget returns null when no budget is readable anywhere (unknown -> guard refuses)", async () => {
  const m = createGuardMeta(fakeClient({ "/23890": { campaign: {} } }), ACCT, 100);
  assert.equal(await m.currentBudget("23890"), null);
});
