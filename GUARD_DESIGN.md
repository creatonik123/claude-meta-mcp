# AdPilot guarded MCP server — design v3 (final build spec)

Survived two adversarial review rounds (round 1: 7 critical design flaws fixed;
round 2: design confirmed sound, 11 changes folded in) plus real-world web
research on Meta API behaviour. Ships **recommend-only**: every write defaults OFF.
This is the spec we build to, test-first.

---

## 0. Real-world facts that shape this design (web-verified, June 2026)
- **Meta overspends daily budgets by up to 75%/day** (weekly spend ≤ 7× daily). A
  budget number is NOT a spend ceiling — so spend caps MUST be enforced on realised
  spend + a circuit-breaker, never on budget alone.
- **No confirmation that Meta accepted a budget write** → post-write read-back is mandatory.
- **Insights spend lags 15–30 min (hours under load), revised upward; conversions
  settle at T+1/T+3/T+7** → treat same-day spend as a LOWER bound with a safety margin.
- **Rate limits:** read = 1 pt, write = 3 pts; dev tier max score 60 / 300s (our app
  is likely dev tier — explains the overnight `partial`), standard tier 9000. Only
  **4 budget changes/hour/ad set**. → backoff on the throttle header, serialize, no
  retry storms; **request Standard tier** (dependency).
- **Agent must not be able to edit its own rules** → rules + caps are version-
  controlled, PR-gated, read-only to the running agent.

## 1. Principles
- **Guard runs IN CODE inside the MCP write handlers** — last line of defence
  regardless of caller (PRD §6a). The Vercel decision app is advisory only.
- **Fail-closed:** any safety read that errors / is null / missing / empty / stale /
  unexpected → structured refusal + log. Never "treat unknown as zero/OK".
- **Two distinct safety reflexes (no contradiction):**
  - *Uncertainty* about a single action → do nothing, alert (fail-closed).
  - *Confirmed* spend emergency → act in the safe direction (stop spend) — but only
    once that action type is enabled; until then, **alert loudly** (see §5).

## 2. Architecture (PRD-faithful: one guarded server, humans included)
- **One guarded MCP server** is the single Meta-write path for BOTH the engine AND
  approvers' ad-hoc Claude sessions — so even a senior human's change inherits every
  guardrail (PRD §6a: "interactive human sessions inherit the guardrails"). We do
  NOT lock humans to read-only.
- Security comes from the guard + credential, not from blocking people:
  - **Credential-level scope:** the Meta System User token is asset-scoped to ONLY
    `act_1133075730765139`; at boot, `GET /me/assigned_ad_accounts` must NOT contain
    `act_2218833115522041` or the server refuses to start. Code allow/deny constants
    sit on top. (Dependency: a Business Manager admin creates this token.)
  - Bearer compared with `crypto.timingSafeEqual` over equal-length SHA-256 hashes;
    401 rate-limit + alert; `trust proxy` set to the exact hop count (never `true`);
    write endpoint restricted to the engine's egress at the network layer.

## 3. Tool surface
- **Reads:** registered by an exact-name allow-list (the startup gate, already built).
  Read-only enforced *mechanically* too: any read handler that can reach
  `meta.post/delete` or hand out a Page token is excluded; re-audit on every
  `git pull upstream`, gated in CI.
- **Writes:** ONLY three purpose-built gated tools, each builds its own minimal Meta
  request (never forwards the caller's argument bag):
  1. `pause_entity` — sets status to PAUSED only.
  2. `adjust_adset_budget` — one budget number, clamped.
  3. `publish_approved_creative` — a SINGLE ATOMIC op (not a re-entrant chain).
- **Activation is intentionally absent** (decision pending: a 4th gated op with its
  own caps recheck, or manual). A startup assertion refuses to boot if any registered
  tool is outside {read allow-list} ∪ {3 gated writes}, if any write name also appears
  in the raw `register*` functions, or if any registered write schema accepts an
  `account_id` field.

## 4. The gate (every write; fixed order; all fail-closed)
1. **Kill switch** — env flag OR DB row; re-read BOTH at the last moment after commit,
   before the Meta POST (the POST is non-transactional; env flag is authoritative with
   a short in-memory TTL). Missing/NULL/unknown row = ON (frozen).
2. **Action mode** — per action type, strict positive-allow: execute ONLY if the value
   is exactly a known-enabled token (DB enum/CHECK). Default OFF = recommend-only.
3. **Account scope** — allowed account is a hardcoded constant (never a request field);
   forbidden account is an explicit deny constant. Resolve the TRUE owner of the EXACT
   id being POSTed (the campaign on a CBO write) via Meta and require
   `canonicalize(account_id) === canonicalize(ALLOWED)`; a 200 with the field absent =
   ambiguous = refuse. Re-resolve inside the critical section and again on verify.
4. **Strict argument allow-list** (Zod `.strict()`) on the exact object sent to Meta:
   `pause` == exactly `{status:'PAUSED'}`; `budget` == exactly one finite-positive-int
   budget field, nothing else; ACTIVE/ARCHIVED rejected for all gated ops.
5. **Budget rules:**
   - Resolve the authoritative budget locus; REFUSE ad-set budget writes when the
     campaign owns the budget (CBO); block `lifetime_budget` in recommend-only/early ramp.
   - **Per-entity clamp:** ±25% vs the entity's **frozen start-of-day snapshot** (§6),
     tracked per entity per day. Reject NaN/non-finite/zero baselines (require an
     explicit absolute first-budget ceiling instead of "unconstrained").
   - **Account aggregate clamp (PRD ±20%/account/day):** refuse if the post-change sum
     of managed budgets exceeds +20% of the start-of-day account total.
   - **Cross-day creep clamp:** refuse if the entity's budget would exceed a hard
     per-entity absolute ceiling or +X% vs a 7/30-day trailing baseline (stops nightly
     +25% compounding to ~5×/week); require human re-approval beyond a configured multiple.
   - Compute the FINAL value, run ALL caps against it, and **REFUSE** (never
     clamp-and-proceed) if any cap is exceeded.
6. **Spend caps on REAL money** — account-level Insights `spend`, `date_preset=today`
   (daily) and `this_month` (monthly), in the account timezone. NEVER the `amount_spent`
   scalar. Empty/partial page = INDETERMINATE = refuse (require positive proof: assert
   `date_stop == account-tz today`, refuse on unfetched `paging.next` or stale snapshot).
   Treat same-day spend as a lower bound: enforce against a pacing-margined figure (and
   cap same-day decisions at a fraction of A$340 given Meta's 75% flex). Reconcile prior-
   day upward revisions into MTD; apply a near-month-end revision buffer.
7. **Approval (publish only)** — the immutable approval record stores the FULL canonical
   creative payload (asset + message + link + headline + CTA + page_id, every referenced
   id owner-checked). One shared canonical serializer (sorted keys, field whitelist, NFC,
   page_id as string) + SHA-256, used by both capture and publish. `publish` builds the
   Meta body deterministically from the stored payload and asserts `hash(builtBody) ==
   approval.hash` immediately before each POST. Inner upload/create steps are PRIVATE
   functions (not guard entry points), forced status=PAUSED, refused if the target ad set
   or its campaign is ACTIVE. One-time-consume on verified success only, behind a
   flow-level idempotency key (retry resumes the same flow; CONSUMING state needs human
   resolution, no auto-retry). DB-layer immutability: MCP role has no UPDATE/DELETE on
   `approval_records`.
8. **Safe write sequence** — durable PENDING intent committed (own transaction) BEFORE
   the Meta call, counted pessimistically toward caps. Three outcomes:
   applied+verified / applied-but-unverified = NEEDS-RECONCILE (freeze action type +
   alert; never reported as a clean refusal) / not-applied. Accumulator semantics:
   not-applied decrements; verified reconciles to real delta; unverified keeps the count
   and freezes; an orphan sweeper freezes PENDING rows older than a bound; the budget-delta
   accumulator is advisory and rebuildable from the audit log, with realised-spend (§6) as
   the hard backstop. A failed result-append after a verified write = NEEDS-RECONCILE.
   Verify `effective_status` (not configured) with bounded re-read/backoff. Idempotency
   keys on budget AND publish (Meta writes are not idempotent; no write confirmation).
9. **Per-account serialization** — a SESSION-level advisory lock (finally-unlock) held
   ONLY across decide→write→log (slow reads snapshotted first); write timeout < lock
   timeout; never held across the Meta HTTP call. Inside the lock, gate budget on
   `max(meta_spend, today's PENDING+applied budget deltas)` so back-to-back decisions see
   each other immediately. Single-instance asserted at boot (or all accumulator inputs
   re-read from authoritative storage, no process cache).

## 5. Spend circuit-breaker (the watchdog) — follows the recommend-only ramp
A scheduled job reads realised account spend each cycle, independent of any
recommendation. This is the ONLY thing that bounds spend on entities AdPilot never
writes to (a pre-existing/human-set ACTIVE budget, or Meta's 75% pacing overspend).
- **Recommend-only (now):** the watchdog only **alerts loudly** when today/MTD crosses
  the cap (or a fraction of it) — it takes no write (consistent with recommend-only and
  PRD R6's "real-time alert when spend pacing >120%").
- **Once pause-autonomy is enabled (later):** it auto-pauses the highest-spending active
  entities (or trips the kill switch), through the same guarded `pause_entity`.

## 6. Start-of-day snapshot job
Scheduled at 00:00 account-tz: writes each managed entity's authoritative budget into an
immutable per-day row BEFORE any write is permitted that day. Budget writes for an entity
with no snapshot for the current account-tz day → refuse (fail-closed). Clamp against the
frozen snapshot, never live Meta state. Out-of-band changes → alert/re-snapshot, never
silently adopt. Derive the local date ONCE per cycle and key BOTH the snapshot and the
spend window on it (DST-safe).

## 7. Rate-limit discipline
Read the `x-fb-ads-insights-throttle` / usage headers on every response; exponential
backoff with jitter; serialize writes (3 pts each, 4 budget-changes/hr/ad-set limit);
no retry storms. Request Marketing API **Standard tier** (dependency) — dev tier (score
60) is why the overnight run came back `partial`.

## 8. Config & "agent can't edit its own rules"
Rules, thresholds, caps, action-modes, allow/deny constants live in version-controlled
config + DB rows the running agent can READ but not WRITE; changes are PRs / operator
DB actions. Schema-version contract on shared tables (kill_switch / approval_records /
audit_log / snapshots): all gate DB reads go through one accessor that re-reads
schema_version in the same transaction (no cached startup value); refuse on mismatch;
migrations bump schema_version in the same transaction as the DDL.

## 9. Testing (TDD — write the test first, watch it refuse)
Every gate branch, on injected fakes (`createGuard({db, meta, config, now})`), no live
Meta/DB/money: 40%→clamped-to-25%; clamp-to-25%-still-over-cap → REFUSE; account
aggregate >+20% → refuse; kill-switch ON / NULL row / DB-unreachable → refuse;
action-OFF → refuse; wrong/forbidden/absent account → refuse; CBO budget → refuse;
pause-with-status=ACTIVE → refuse; empty Insights page → refuse (not zero); stale
spend snapshot → refuse; unapproved / altered-payload / replayed creative → refuse;
publish into ACTIVE parent → refuse; retry after unverified write → no double-apply;
DST day-boundary correctness; startup assertion fails on an ungated registered write.

## 10. Audit (PRD R7)
Append-only log of every decision AND action AND tool call (incl. reads) with timestamp,
entity, metrics snapshot, rule(s) triggered, LLM rationale, action, actor (agent vs which
human), approval refs, outcome. ≥2-year retention. Refusals are logged too.

## 11. Deferred (out of scope until the autonomy phase)
Auto-rollback; server hosting location; the activation story (4th op vs manual);
bid-cap / cost-cap controls; A/B promotion (R5).

## 12. Dependencies to raise with the sponsor / Business Manager admin
- Meta **System User token asset-scoped to only `act_1133075730765139`** (real safety;
  the code deny-constant alone is insufficient).
- Request Marketing API **Standard tier** (dev tier rate limits cause `partial` runs).
- Lower the Meta-side account spending limit nearer A$9,250 as a tighter hard backstop.

## 13. PRD traceability
R3 → §3,4 (allow-list, ±25%, ±20%/account/day, caps, kill switch). R4 → §4.7 (approval
gate, immutable records, publish-only path). R7 → §10 (append-only audit incl. reads).
R8 → §4.2 + §5 (per-action recommend-only→confirm→autonomous ramp). §6a → §2 (one
guarded server, humans inherit guardrails; backstop). §9 Day-3 exit → §9 (unit tests
refuse correctly). R6 alert → §5 (watchdog alerts now, enforces later).

## 14. Residual risks (accepted, documented)
Same-day/trailing Meta spend is an upward-revised estimate; caps are soft for the lag
window — the Meta-side monthly limit is the only hard backstop. Read-after-write is
eventually consistent; a verified change can briefly report stale; recovery from
NEEDS-RECONCILE is human-driven (auto-rollback deferred). Account ownership is mutable
(TOCTOU) — credential scoping is the real mitigation. Controls that freeze on routine
Meta flakiness tempt operators to bypass — mitigated by a safe narrow force-pause
override and decoupled liveness. Shared tables have two writers — correctness during
migrations depends on the migration owner honouring the schema-version + lock discipline.
