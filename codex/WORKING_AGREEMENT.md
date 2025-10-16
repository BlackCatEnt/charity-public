## `codex/WORKING_AGREEMENT.md`

# Charity Hive — Working Agreement (1-pager)

**Purpose.** Keep us shipping: clear stories, small batches, visible progress.
**Scope.** Applies to all work tracked in **@Charity-Hive-Project** and the `charity-hive` repo.

---

## 1) Boards, fields, & flow

* **Views we use**

  * **Backlog (Table)**: source of truth. Columns: *Epic, Area, Priority, Start, Due, Milestone, Status*.
  * **Board (Kanban)**: grouped by **Status** (To do / In progress / Done). Swimlanes by **Epic** when helpful.
  * **Roadmap**: Gantt using **Start/Due** (drag bars to adjust).
* **Status rules**

  * New item → **To do**. Work begins → **In progress**. Shippable/merged → **Done**.
* **Planning fields**

  * **Epic** = big rock lane (Keeper, Scribe, …)
  * **Area** = owning component (Keeper/Scribe/Sentry/BusyBee/Kodex/OBS)
  * **Priority** = High / Medium / Low
  * **Start/Due** = schedule window used by Roadmap
  * **Milestone** = release bucket (e.g., *Keeper v0.4 QoS*)

---

## 2) Story template (Definition of Ready)

Every story has:

**Title** – action + outcome
**Why** – 1–2 lines connecting to an Epic/goal
**Acceptance Criteria** – checklist of observable outcomes
**Definition of Done** – below
**Links** – design/spec/PRs/dashboards
**Labels** – one or more of: `keeper | scribe | sentry | busybee | kodex | obs` + `public` if OK for mirror
**Fields** – Epic, Area, Priority, Start, Due, Milestone

> **Definition of Ready (DoR)**
>
> * Scope is ≤ 2 days or split smaller
> * Acceptance criteria are testable
> * Dependencies called out
> * Owner (assignee) is known or “Unassigned” by choice

---

## 3) Definition of Done (DoD)

* Code merged to default branch (or feature branch behind flag)
* CI is green; lint/tests pass
* Telemetry/logs added if meaningful (Prom rule or counter when applicable)
* Docs updated (README/snippet or `codex/` note)
* If user-facing behavior: brief demo note or screenshot
* Issue **Status = Done** and linked to the right **Milestone**

---

## 4) Branching & PRs

* **Branch name**: `area/short-purpose-#issue` (e.g., `scribe/batching-exit-#15`)
* **PR checklist**

  * Ref issue number in title or body (`Fixes #15`)
  * What & why (1–3 bullets)
  * Screens/logs for visible changes
  * Rollback plan if risky
  * Tag with component label(s)

---

## 5) Cadence

* **Weekly planning** (15–20 min): groom top backlog, confirm Start/Due for the week
* **Daily sync** (async allowed): update **Status** and add a note if blocked
* **Friday wrap** (10 min): review Done items; note risks; adjust milestones/roadmap

---

## 6) Security & publishing

* Secrets live only in `.env` (never in repo).
* Public mirror uses the publish script; anything labeled **`public`** is safe to mirror.
* If in doubt, omit `public` and keep private.

---

## 7) Quality bars (by component)

* **Keeper**: E2E “walking skeleton” remains green; counters emit; failure paths logged
* **Scribe**: batching/backpressure exits cleanly; latency counters present; no hangs
* **Sentry**: Prom rules validated in CI; dashboards render with minimal deps
* **BusyBee**: dry-run logic deterministic; audit log for decisions
* **Kodex**: memory/guards tested; no lore creep; plan-vs-fact separated
* **OBS**: scenes exportable; assets tracked; checklist satisfied

---

## 8) How to add new work

1. Create item (Table: **Ctrl+Space**).
2. Fill **Epic, Area, Priority, Start, Due, Milestone**.
3. Add story body using the template above.
4. Move to **In progress** when you start.
5. Close PR → set **Done**.

---

**Link:** 👉 Project Home — @Charity-Hive-Project
**Doc owners:** @BlackCatEnt (+ Sage)

---
