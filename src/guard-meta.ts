/**
 * Read-only Meta connector for the guard (GuardMeta): resolves an entity's owning
 * account, current budget, and the account's realised spend. READS ONLY — never
 * POSTs. Meta returns budgets in minor units (cents), so they're converted to major
 * (account currency) via the offset, mirroring the doer's write conversion.
 */
import type { GuardMeta, CurrentBudget, SpendSnapshot } from "./guard.js";
import type { GraphClient } from "./meta-adapters.js";

export function createGuardMeta(client: GraphClient, accountId: string, currencyOffset: number): GuardMeta {
  const toMajor = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n / currencyOffset : null;
  };

  return {
    async entityAccountId(entityId) {
      const r = await client.get<Record<string, unknown>>(`/${entityId}`, { fields: "account_id" });
      const id = r?.account_id;
      return typeof id === "string" && id !== "" ? id : null;
    },

    async currentBudget(entityId): Promise<CurrentBudget | null> {
      const r = await client.get<Record<string, unknown>>(`/${entityId}`, {
        fields: "daily_budget,lifetime_budget,campaign{daily_budget,lifetime_budget}",
      });
      const dailyBudget = toMajor(r?.daily_budget);
      const lifetimeBudget = toMajor(r?.lifetime_budget);
      const camp = (r?.campaign as Record<string, unknown>) || {};
      const campHasBudget = Number(camp.daily_budget) > 0 || Number(camp.lifetime_budget) > 0;
      const adsetHasBudget = (dailyBudget ?? 0) > 0 || (lifetimeBudget ?? 0) > 0;
      // No budget readable anywhere (neither ad set nor campaign) = unknown, not "no CBO".
      // Return null so the guard refuses (budget_unknown) rather than proceed on fabricated data.
      if (!adsetHasBudget && !campHasBudget) return null;
      // CBO: the budget lives on the campaign, not the ad set.
      const ownedByCampaignCbo = !adsetHasBudget && campHasBudget;
      return { dailyBudget, lifetimeBudget, ownedByCampaignCbo };
    },

    async realisedSpend(): Promise<SpendSnapshot | null> {
      const insights = (preset: string) =>
        client.get<{ data?: Array<Record<string, unknown>> }>(`/${accountId}/insights`, { fields: "spend", date_preset: preset });
      const [todayR, mtdR] = await Promise.all([insights("today"), insights("this_month")]);
      const todayRow = Array.isArray(todayR?.data) ? todayR.data[0] : undefined;
      const mtdRow = Array.isArray(mtdR?.data) ? mtdR.data[0] : undefined;
      const todaySpend = todayRow ? Number(todayRow.spend) : NaN;
      const mtdSpend = mtdRow ? Number(mtdRow.spend) : NaN;
      // "complete" gates the guard's spend cap: BOTH legs must parse, else the read is partial/unknown
      // and the guard must refuse — coercing a missing month-to-date to 0 would fail the cap OPEN.
      const complete = Number.isFinite(todaySpend) && Number.isFinite(mtdSpend) && todaySpend >= 0 && mtdSpend >= 0;
      return {
        today: Number.isFinite(todaySpend) ? todaySpend : 0,
        monthToDate: Number.isFinite(mtdSpend) ? mtdSpend : 0,
        dateStop: typeof todayRow?.date_stop === "string" ? (todayRow.date_stop as string) : "",
        complete,
      };
    },
  };
}
