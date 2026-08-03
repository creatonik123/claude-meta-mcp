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

// ---- accountActiveDailyBudgetTotal: the live base of the cumulative account cap ----

test("accountActiveDailyBudgetTotal sums ONLY ACTIVE ad sets that own a daily budget, in major units", async () => {
  const m = createGuardMeta(
    fakeClient({
      [`/${ACCT}/adsets`]: {
        data: [
          { daily_budget: "10000", effective_status: "ACTIVE" }, // 100
          { daily_budget: "5000", effective_status: "ACTIVE" }, // 50
          { daily_budget: "99900", effective_status: "PAUSED" }, // idle -> excluded
          { effective_status: "ACTIVE" }, // CBO / no own budget -> excluded
          { daily_budget: "7700", effective_status: "CAMPAIGN_PAUSED" }, // excluded
        ],
      },
    }),
    ACCT,
    100
  );
  assert.deepEqual(await m.accountActiveDailyBudgetTotal("as_absent"), { total: 150, entityCounted: 0 });
});

test("accountActiveDailyBudgetTotal follows pagination and sums across pages", async () => {
  // fakeClient keys by path only, so emulate paging via a stateful client
  const pages = [
    { data: [{ daily_budget: "10000", effective_status: "ACTIVE" }], paging: { next: "n", cursors: { after: "c1" } } },
    { data: [{ daily_budget: "20000", effective_status: "ACTIVE" }] },
  ];
  let call = 0;
  const client = {
    async get() { return pages[call++] as never; },
    async post() { throw new Error("guard-meta must never POST"); },
  };
  const m = createGuardMeta(client, ACCT, 100);
  assert.deepEqual(await m.accountActiveDailyBudgetTotal("as_absent"), { total: 300, entityCounted: 0 });
  assert.equal(call, 2);
});

test("accountActiveDailyBudgetTotal returns null on a malformed page or malformed budget (never a partial sum)", async () => {
  const noData = createGuardMeta(fakeClient({ [`/${ACCT}/adsets`]: {} }), ACCT, 100);
  assert.equal(await noData.accountActiveDailyBudgetTotal("as_x"), null);
  const badBudget = createGuardMeta(
    fakeClient({ [`/${ACCT}/adsets`]: { data: [{ daily_budget: "abc", effective_status: "ACTIVE" }] } }),
    ACCT,
    100
  );
  assert.equal(await badBudget.accountActiveDailyBudgetTotal("as_x"), null);
});

test("accountActiveDailyBudgetTotal returns 0 when no ACTIVE ad set owns a budget (guard refuses on non-positive)", async () => {
  const m = createGuardMeta(fakeClient({ [`/${ACCT}/adsets`]: { data: [{ daily_budget: "5000", effective_status: "PAUSED" }] } }), ACCT, 100);
  assert.deepEqual(await m.accountActiveDailyBudgetTotal("as_x"), { total: 0, entityCounted: 0 });
});

test("accountActiveDailyBudgetTotal fails closed (null) when next exists but the after cursor is unusable", async () => {
  // more data exists (paging.next) but no cursor to fetch it -> NEVER a partial sum
  const noCursors = { data: [{ daily_budget: "10000", effective_status: "ACTIVE" }], paging: { next: "https://graph" } };
  const emptyAfter = { data: [{ daily_budget: "10000", effective_status: "ACTIVE" }], paging: { next: "https://graph", cursors: { after: "" } } };
  for (const page of [noCursors, emptyAfter]) {
    const client = {
      async get() { return page as never; },
      async post() { throw new Error("guard-meta must never POST"); },
    };
    assert.equal(await createGuardMeta(client, ACCT, 100).accountActiveDailyBudgetTotal("as_x"), null);
  }
});

test("accountActiveDailyBudgetTotal counts transitional/unrecognized statuses (overcount = tighter cap)", async () => {
  const m = createGuardMeta(
    fakeClient({
      [`/${ACCT}/adsets`]: {
        data: [
          { daily_budget: "10000", effective_status: "ACTIVE" }, // 100
          { daily_budget: "5000", effective_status: "IN_PROCESS" }, // transitional -> counted
          { daily_budget: "2000", effective_status: "SOME_FUTURE_STATUS" }, // unknown string -> counted
          { daily_budget: "99900", effective_status: "PAUSED" }, // definitively idle -> excluded
        ],
      },
    }),
    ACCT,
    100
  );
  assert.deepEqual(await m.accountActiveDailyBudgetTotal("as_x"), { total: 170, entityCounted: 0 });
});

test("accountActiveDailyBudgetTotal fails closed (null) on a NEGATIVE daily_budget row (never shrinks the total)", async () => {
  const m = createGuardMeta(
    fakeClient({
      [`/${ACCT}/adsets`]: {
        data: [
          { daily_budget: "10000", effective_status: "ACTIVE" },
          { daily_budget: "-5000", effective_status: "ACTIVE" }, // malformed: must poison the read
        ],
      },
    }),
    ACCT,
    100
  );
  assert.equal(await m.accountActiveDailyBudgetTotal("as_x"), null);
});

test("accountActiveDailyBudgetTotal fails closed (null) when pagination exhausts the page cap (never a partial sum)", async () => {
  // every page reports another page exists; after 10 pages the walk must give
  // up as UNKNOWN, not return the 10-page partial sum
  let calls = 0;
  const client = {
    async get() {
      calls++;
      return { data: [{ daily_budget: "10000", effective_status: "ACTIVE" }], paging: { next: "n", cursors: { after: `c${calls}` } } } as never;
    },
    async post() { throw new Error("guard-meta must never POST"); },
  };
  const m = createGuardMeta(client, ACCT, 100);
  assert.equal(await m.accountActiveDailyBudgetTotal("as_x"), null);
  assert.equal(calls, 10); // stopped at the cap, did not loop forever
});

test("accountActiveDailyBudgetTotal fails closed (null) when a row's status is missing", async () => {
  const m = createGuardMeta(
    fakeClient({ [`/${ACCT}/adsets`]: { data: [{ daily_budget: "10000" }] } }),
    ACCT,
    100
  );
  assert.equal(await m.accountActiveDailyBudgetTotal("as_x"), null);
});

test("accountActiveDailyBudgetTotal reports the target entity's contribution from the SAME walk", async () => {
  const m = createGuardMeta(
    fakeClient({
      [`/${ACCT}/adsets`]: {
        data: [
          { id: "as_target", daily_budget: "10000", effective_status: "ACTIVE" }, // 100 (the target)
          { id: "as_other", daily_budget: "5000", effective_status: "ACTIVE" }, // 50
        ],
      },
    }),
    ACCT,
    100
  );
  assert.deepEqual(await m.accountActiveDailyBudgetTotal("as_target"), { total: 150, entityCounted: 100 });
});

test("accountActiveDailyBudgetTotal reports entityCounted 0 when the target was skipped (e.g. paused mid-decision)", async () => {
  const m = createGuardMeta(
    fakeClient({
      [`/${ACCT}/adsets`]: {
        data: [
          { id: "as_target", daily_budget: "10000", effective_status: "PAUSED" }, // idle -> skipped
          { id: "as_other", daily_budget: "5000", effective_status: "ACTIVE" }, // 50
        ],
      },
    }),
    ACCT,
    100
  );
  assert.deepEqual(await m.accountActiveDailyBudgetTotal("as_target"), { total: 50, entityCounted: 0 });
});

test("currentBudget surfaces effective_status; missing -> null (guard refuses budget writes)", async () => {
  const withStatus = createGuardMeta(
    fakeClient({ "/23890": { daily_budget: "5000", lifetime_budget: "0", effective_status: "ACTIVE", campaign: {} } }),
    ACCT,
    100
  );
  assert.equal((await withStatus.currentBudget("23890"))?.effectiveStatus, "ACTIVE");
  const noStatus = createGuardMeta(
    fakeClient({ "/23890": { daily_budget: "5000", lifetime_budget: "0", campaign: {} } }),
    ACCT,
    100
  );
  assert.equal((await noStatus.currentBudget("23890"))?.effectiveStatus, null);
});

test("KNOWN_IDLE_STATUSES membership is pinned exactly — widening it would loosen the account cap", async () => {
  const { KNOWN_IDLE_STATUSES } = await import("./guard-meta.ts");
  assert.deepEqual(
    [...KNOWN_IDLE_STATUSES].sort(),
    ["ADSET_PAUSED", "ARCHIVED", "CAMPAIGN_PAUSED", "DELETED", "DISAPPROVED", "PAUSED"]
  );
});

// ---- entityCampaignId: the single Meta-side basis of campaign isolation ----
test("entityCampaignId returns the owning campaign of an ad/ad set", async () => {
  const m = createGuardMeta(fakeClient({ "/23890": { campaign_id: "120200123", id: "23890" } }), ACCT, 100);
  assert.equal(await m.entityCampaignId("23890"), "120200123");
});

test("entityCampaignId treats a campaign object as its own campaign", async () => {
  const m = createGuardMeta(fakeClient({ "/120200123": { id: "120200123" } }), ACCT, 100);
  assert.equal(await m.entityCampaignId("120200123"), "120200123");
});

test("entityCampaignId returns null when campaign_id is absent and the id is a DIFFERENT entity", async () => {
  // Graph returned some other object's id — must NOT be mistaken for the campaign.
  const m = createGuardMeta(fakeClient({ "/23890": { id: "99999" } }), ACCT, 100);
  assert.equal(await m.entityCampaignId("23890"), null);
});

test("entityCampaignId returns null on an empty/absent response (guard then fails closed)", async () => {
  const m = createGuardMeta(fakeClient({ "/23890": {} }), ACCT, 100);
  assert.equal(await m.entityCampaignId("23890"), null);
});

test("entityCampaignId ignores a non-string campaign_id (never coerces junk into scope)", async () => {
  const m = createGuardMeta(fakeClient({ "/23890": { campaign_id: 120200123 } }), ACCT, 100);
  assert.equal(await m.entityCampaignId("23890"), null);
});

test("entityCampaignId requests the campaign_id field and never POSTs", async () => {
  const c = fakeClient({ "/23890": { campaign_id: "120200123" } });
  await createGuardMeta(c, ACCT, 100).entityCampaignId("23890");
  assert.equal(c.gets[0].path, "/23890");
  assert.match(JSON.stringify(c.gets[0].params), /campaign_id/);
});
