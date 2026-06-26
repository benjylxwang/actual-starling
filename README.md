# actual-starling

Unofficial importer that pulls transactions from **Starling Bank (UK)** using a
Starling **personal access token** and imports them into
[Actual Budget](https://actualbudget.org) via the official
[`@actual-app/api`](https://www.npmjs.com/package/@actual-app/api) package.

It is a standalone community importer — the same category as
[moneyman](https://github.com/daniel-hauser/moneyman),
[actualplaid](https://github.com/alden/actualplaid), and
[enable-actual](https://github.com/RoadRunnerInABox/enable-actual). It is **not**
a core provider inside Actual's sync-server and depends on **no aggregator**
(no GoCardless, Enable Banking, or TrueLayer).

---

## ⚠️ Disclaimer

This is an **unofficial, personal project**. **Use at your own risk.** It is
**not affiliated with, endorsed by, or supported by Starling Bank or Actual
Budget.** You are responsible for your own access tokens, data, and budget. No
warranty — see [LICENSE](LICENSE).

---

## Why a personal token instead of an aggregator?

Aggregators (GoCardless, TrueLayer, Plaid, Enable Banking) sit on top of Open
Banking, where access is granted by a consent that **expires — typically every
90 days — and must be re-authorised** through a bank login + SCA flow. That
breaks unattended imports on a schedule.

A Starling **personal access token** is issued directly from your own Starling
developer account and **does not expire on a 90-day cycle**. You grant it
narrow, read-only scopes, and it keeps working until you revoke it. For a
single-user, self-hosted budget that you want to sync on a cron, that is far more
durable and has no third-party data processor in the path.

Trade-off: personal access tokens are a Starling-specific feature for your own
accounts only — this approach does not generalise to other banks. That is the
point: one bank, one durable token, no re-consent.

---

## Account model: Starling → Actual

| Starling thing        | What it is                                    | Maps to                              |
| --------------------- | --------------------------------------------- | ------------------------------------ |
| Personal account      | A real account                                | One Actual account (one source)      |
| Joint account         | A real account                                | One Actual account (one source)      |
| Easy Saver            | A real account                                | One Actual account (one source)      |
| Fixed Saver           | A real account                                | One Actual account (one source)      |
| Cash ISA              | A real account                                | One Actual account (one source)      |
| **Spending Space**    | A **pot inside** an account, not an account   | **No source** — internal transfers dropped |
| Savings Goal / Space  | A pot inside an account                       | **No source** — internal transfers dropped |

Each **real account** is one configured `SOURCE_n` → one Actual account. A
**Space** is not a separate account: its money movements appear in the parent
account's feed as internal transfers (`source = INTERNAL_TRANSFER`), which the
default `skipSources` filter drops so they aren't double-counted.

A single token can return multiple accounts (e.g. current account + Easy Saver).
Pin one with `SOURCE_n_ACCOUNT_UID`; otherwise the first account is used.

---

## How it works

- Pulls a **rolling window** of `LOOKBACK_DAYS` (default 30) from Starling's feed.
- Converts Starling's `amount.minorUnits` + `direction` to Actual's **signed
  integer** (OUT = negative).
- Uses Starling's `feedItemUid` as Actual's `imported_id`, so re-pulling an
  overlapping window **never creates duplicates** (`importTransactions` dedupes
  on `imported_id`).

---

## Setup

Requires **Node.js >= 18**.

```bash
git clone https://github.com/benjylxwang/actual-starling.git
cd actual-starling
npm install
cp .env.example .env
# edit .env — see comments in that file for every variable
```

### Create a Starling personal access token

1. Sign in at the [Starling Developer portal](https://developer.starlingbank.com).
2. Create a personal access token for the account(s) you want to import.
3. Grant only these **read-only** scopes:
   - `account:read` — list accounts
   - `transaction:read` — read the transaction feed
   - `balance:read` — read balances (used by `discover`)
   - `savings-goal:read` — list savings goals (used by `discover`)
   - `space:read` — list spaces (used by `discover`)

   The `import` mode strictly needs only `account:read` + `transaction:read`.

### Find your Actual Sync ID

In Actual: **Settings → Advanced → Sync ID** (a UUID). Put it in
`ACTUAL_SYNC_ID`. If your budget is end-to-end encrypted, also set
`ACTUAL_E2E_PASSWORD`.

---

## Usage

Three run modes:

### `discover` — inspect your Starling setup

```bash
npm run discover
```

For each unique token, prints its accounts (uid, type, defaultCategory,
balance), any savings goals / spaces with their uids, and ~3 sample raw feed
items showing `source` and `counterPartyType`. Use this to confirm how your
Space transfers are tagged before configuring sources. Optional calls are
wrapped in try/catch, so a missing scope won't crash it.

### `list-accounts` — get Actual account ids

```bash
npm run list-accounts
```

Prints each Actual account's id and name. Copy the ids into
`SOURCE_n_ACTUAL_ACCOUNT_ID` in `.env`.

### `import` (default) — import transactions

```bash
npm run import
# or just: node index.mjs
```

For each configured source: fetches the feed, applies `skipSources`, maps to
Actual transactions, and calls `importTransactions`. Logs added/updated counts
per source. **One source failing never aborts the others.**

**Dry run** — preview without writing anything:

```bash
npm run import:dry
# or: node index.mjs import --dry-run   (or set DRY_RUN=1)
```

Uses Actual's native `dryRun`: it downloads the budget and computes exactly what
*would* be added/updated, but writes nothing. The log shows `would-add` /
`would-update` plus the `skipped` and `belowFloor` counts — ideal for a first
take-over run to confirm the start-date floor is set correctly before committing.

---

## Migrating from GoCardless (keeping the same accounts)

If your Actual accounts already hold transactions from GoCardless (or any other
bank-sync), read this before your first import — otherwise you will get
duplicates.

**Why duplicates happen:** Actual dedupes on `imported_id`. GoCardless and this
tool use *different* `imported_id` namespaces (GoCardless's transaction id vs
Starling's `feedItemUid`), so the same real transaction looks like two different
ones. The overlapping window that both importers covered would be imported twice.

**The fix — a clean handover boundary:**

1. In Actual, **disconnect the GoCardless bank sync** on each Starling account
   (account → settings → unlink). This stops GoCardless adding anything new and
   makes Actual use strict id-checking on that account.
2. Look at each account and note the **date of the last GoCardless transaction**.
3. Set `SOURCE_n_START_DATE` to the **day after** that date (or simply the day
   you unlink). Everything dated **before** the floor stays owned by GoCardless;
   everything **on/after** is imported by this tool. No overlap, no duplicates.
4. Run `npm run import`. The log shows `belowFloor=<n>` — those are the older
   items the floor correctly dropped.

The floor is permanent and harmless to leave in place. `LOOKBACK_DAYS` still
controls the rolling window; the floor just guarantees the tool never reaches
back into GoCardless's territory. (A global `IMPORT_START_DATE` sets one floor
for all sources at once.)

> Tip: pick the floor a day or two safely after the last GoCardless item to
> avoid a same-day edge overlap. A handful of duplicates is easy to delete in
> Actual if you misjudge it — there is no data loss either way.

## Scheduling

Run `import` on whatever schedule you like. The rolling window + `imported_id`
dedupe make re-runs safe and idempotent.

**cron** (every 6 hours):

```cron
0 */6 * * * cd /opt/actual-starling && /usr/bin/node index.mjs import >> /var/log/actual-starling.log 2>&1
```

**systemd** (`actual-starling.service` + `actual-starling.timer`):

```ini
# /etc/systemd/system/actual-starling.service
[Unit]
Description=actual-starling import
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/opt/actual-starling
ExecStart=/usr/bin/node index.mjs import
EnvironmentFile=/opt/actual-starling/.env
```

```ini
# /etc/systemd/system/actual-starling.timer
[Unit]
Description=Run actual-starling every 6 hours

[Timer]
OnCalendar=*-*-* 0/6:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl enable --now actual-starling.timer
```

**Container loop** (simple shell loop, e.g. in Docker/Kubernetes):

```sh
while true; do
  node index.mjs import
  sleep 21600   # 6 hours
done
```

**Unraid** (User Scripts plugin): a ready-made script is in
[`deploy/unraid-user-script.sh`](deploy/unraid-user-script.sh). It runs the
importer inside an ephemeral `node` container (no node install on the host),
installs deps on first run, and is meant to be pasted into a User Script set to
"Scheduled Daily". Clone the repo to `/mnt/user/appdata/actual-starling` and put
your `.env` there first.

---

## Security

- **Read-only scopes only.** Grant the token nothing beyond the read scopes
  listed above. It can never move money or change your account.
- **Secrets live only in `.env`**, which is gitignored. Nothing sensitive is
  committed — `.gitignore` excludes `.env`, `.env.*` (except `.env.example`),
  `.actual-cache/`, and `node_modules/`.
- The downloaded budget cache (`.actual-cache/`) is local and gitignored.
- Revoke the token in the Starling developer portal if it is ever exposed.

---

## License

[MIT](LICENSE) © 2026 benjylxwang
