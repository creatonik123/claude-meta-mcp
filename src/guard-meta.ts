/**
 * Read-only Meta connector for the guard (GuardMeta): resolves an entity's owning
 * account, current budget, and the account's realised spend. READS ONLY — never
 * POSTs. Meta returns budgets in minor units (cents), so they're converted to major
 * (account currency) via the offset, mirroring the doer's write conversion.
 */
import type { GuardMeta, CurrentBudget, SpendSnapshot } from "./guard.js";
import type { GraphClient } from "./meta-adapters.js";

// Statuses that DEFINITIVELY do not deliver — the only ones excluded from the
// live account total. Exported so its exact membership is pinned by a test:
// widening it (e.g. with transitional statuses like IN_PROCESS/WITH_ISSUES)
// would UNDERCOUNT the live total and loosen the cumulative account cap.
export const KNOWN_IDLE_STATUSES: ReadonlySet<string> = new Set([
  "PAUSED",
  "CAMPAIGN_PAUSED",
  "ADSET_PAUSED",
  "ARCHIVED",
  "DELETED",
  "DISAPPROVED",
]);

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

    // Owning campaign, resolved from Meta (never from our own DB) for the campaign-scope guardrail.
    // An ad/ad set carries campaign_id; a campaign returns its own id. null when unreadable/absent so
    // the guard fails closed.
    async entityCampaignId(entityId) {
      const r = await client.get<Record<string, unknown>>(`/${entityId}`, { fields: "campaign_id,id" });
      const cid = r?.campaign_id;
      if (typeof cid === "string" && cid !== "") return cid;
      // A campaign object has no campaign_id field; its own id is the campaign.
      const own = r?.id;
      if (typeof own === "string" && own !== "" && String(own) === String(entityId)) return own;
      return null;
    },

    async currentBudget(entityId): Promise<CurrentBudget | null> {
      const r = await client.get<Record<string, unknown>>(`/${entityId}`, {
        fields: "daily_budget,lifetime_budget,effective_status,campaign{daily_budget,lifetime_budget}",
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
      const status = r?.effective_status;
      const effectiveStatus = typeof status === "string" && status !== "" ? status : null;
      return { dailyBudget, lifetimeBudget, ownedByCampaignCbo, effectiveStatus };
    },

    // Live sum of delivering ad sets' OWN daily budgets — the base of the
    // cumulative account cap. Fail-closed rules: a malformed page/budget or a
    // MISSING status returns null (the guard refuses); only statuses known to
    // be idle are excluded; any unrecognized status is COUNTED (overcounting
    // raises the projection, which tightens the cap — the safe direction).
    // entityCounted is the target entity's contribution INSIDE this same walk
    // (0 if it was skipped or absent), so the guard's projection swap can never
    // race a concurrent status change against a separate read of the entity.
    // Never returns a partial sum. Page cap sized generously above the
    // account's real ad-set count but small enough to bound the guard's
    // worst-case read time (the account write-lock lease must outlast it).
    async accountActiveDailyBudgetTotal(entityId: string): Promise<{ total: number; entityCounted: number } | null> {
      let after: string | undefined;
      let total = 0;
      let entityCounted = 0;
      for (let page = 0; page < 10; page++) {
        const r = await client.get<{
          data?: Array<Record<string, unknown>>;
          paging?: { next?: string; cursors?: { after?: string } };
        }>(`/${accountId}/adsets`, {
          fields: "id,daily_budget,effective_status",
          limit: 200,
          ...(after ? { after } : {}),
        });
        if (!Array.isArray(r?.data)) return null; // malformed page = unknown
        for (const row of r.data) {
          const status = row?.effective_status;
          if (typeof status !== "string" || status === "") return null; // unknown status = unknown total
          if (KNOWN_IDLE_STATUSES.has(status)) continue; // definitively not delivering
          if (row?.daily_budget == null || row.daily_budget === "") continue; // CBO / no own budget
          const major = toMajor(row.daily_budget);
          if (major === null || major < 0) return null; // malformed budget = unknown
          total += major;
          if (row?.id === entityId) entityCounted += major;
        }
        if (!r.paging?.next) return { total, entityCounted }; // no more pages — the sum is complete
        const nextAfter = r.paging?.cursors?.after;
        if (typeof nextAfter !== "string" || nextAfter === "") {
          return null; // more data exists but no usable cursor — NEVER a partial sum
        }
        after = nextAfter;
      }
      return null; // pagination did not terminate — treat as unknown
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
