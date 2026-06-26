#!/usr/bin/env node
// actual-starling — unofficial Starling Bank -> Actual Budget importer.
// Uses a Starling personal access token (read-only) and the official
// @actual-app/api package. Not affiliated with Starling or Actual.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as api from '@actual-app/api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Tiny .env loader (no dependency) -------------------------------------
// Loads KEY=VALUE lines from .env in the project root into process.env,
// without overwriting variables already set in the real environment.
function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

// --- Config ---------------------------------------------------------------
const STARLING_BASE_URL = (
  process.env.STARLING_BASE_URL || 'https://api.starlingbank.com'
).replace(/\/$/, '');
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);

const ACTUAL = {
  serverURL: process.env.ACTUAL_SERVER_URL,
  password: process.env.ACTUAL_PASSWORD,
  syncId: process.env.ACTUAL_SYNC_ID,
  e2ePassword: process.env.ACTUAL_E2E_PASSWORD || undefined,
  dataDir: process.env.ACTUAL_DATA_DIR || path.join(__dirname, '.actual-cache'),
};

// Sources are numbered: SOURCE_1_*, SOURCE_2_*, ...
// Each source = one real Starling account -> one Actual account.
function loadSources() {
  const sources = [];
  for (let i = 1; ; i++) {
    const token = process.env[`SOURCE_${i}_STARLING_TOKEN`];
    if (!token) break;
    const skipRaw = process.env[`SOURCE_${i}_SKIP_SOURCES`];
    sources.push({
      index: i,
      name: process.env[`SOURCE_${i}_NAME`] || `source-${i}`,
      token,
      actualAccountId: process.env[`SOURCE_${i}_ACTUAL_ACCOUNT_ID`],
      accountUid: process.env[`SOURCE_${i}_ACCOUNT_UID`] || undefined,
      // Default: drop internal pot/space movements so they aren't double-counted.
      skipSources:
        skipRaw !== undefined
          ? skipRaw.split(',').map((s) => s.trim()).filter(Boolean)
          : ['INTERNAL_TRANSFER'],
    });
  }
  return sources;
}

// --- Starling API ---------------------------------------------------------
async function starling(token, endpoint) {
  const res = await fetch(`${STARLING_BASE_URL}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'actual-starling',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Starling ${endpoint} -> ${res.status} ${res.statusText} ${body}`.trim(),
    );
  }
  return res.json();
}

const getStarlingAccounts = (token) =>
  starling(token, '/api/v2/accounts').then((r) => r.accounts || []);

const getBalance = (token, accountUid) =>
  starling(token, `/api/v2/accounts/${accountUid}/balance`);

const getSavingsGoals = (token, accountUid) =>
  starling(token, `/api/v2/account/${accountUid}/savings-goals`);

const getSpaces = (token, accountUid) =>
  starling(token, `/api/v2/account/${accountUid}/spaces`);

function getFeed(token, accountUid, categoryUid, minTs, maxTs) {
  const qs = new URLSearchParams({
    minTransactionTimestamp: minTs,
    maxTransactionTimestamp: maxTs,
  });
  return starling(
    token,
    `/api/v2/feed/account/${accountUid}/category/${categoryUid}/transactions-between?${qs}`,
  ).then((r) => r.feedItems || []);
}

// Resolve which Starling account a source points at.
// Honours an explicit accountUid; otherwise takes the first account on the token.
async function resolveAccount(source) {
  const accounts = await getStarlingAccounts(source.token);
  if (accounts.length === 0) {
    throw new Error('token returned no accounts');
  }
  if (source.accountUid) {
    const match = accounts.find((a) => a.accountUid === source.accountUid);
    if (!match) {
      throw new Error(
        `accountUid ${source.accountUid} not found on this token`,
      );
    }
    return match;
  }
  return accounts[0];
}

// --- Mapping --------------------------------------------------------------
// Starling minorUnits + direction -> Actual signed integer (OUT = negative).
function feedItemToActual(item) {
  const minor = item.amount?.minorUnits ?? 0;
  const signed = item.direction === 'OUT' ? -minor : minor;
  const when = item.settlementTime || item.transactionTime || item.updatedAt;
  const date = when ? when.slice(0, 10) : undefined; // YYYY-MM-DD
  const payee =
    item.counterPartyName ||
    item.source ||
    (item.direction === 'OUT' ? 'Payment' : 'Credit');
  const noteBits = [item.reference, item.spendingCategory].filter(Boolean);
  return {
    date,
    amount: signed,
    payee_name: payee,
    imported_id: item.feedItemUid, // dedupe key — re-pulls never duplicate
    notes: noteBits.join(' · ') || undefined,
    cleared: item.status === 'SETTLED',
  };
}

// --- Time window ----------------------------------------------------------
function windowTimestamps() {
  const now = new Date();
  const min = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  return { minTs: min.toISOString(), maxTs: now.toISOString() };
}

// --- Modes ----------------------------------------------------------------
async function runDiscover() {
  const sources = loadSources();
  if (sources.length === 0) {
    console.log('No SOURCE_n_STARLING_TOKEN configured. Nothing to discover.');
    return;
  }
  // One token may appear once per real account; dedupe by token value.
  const seen = new Set();
  const { minTs, maxTs } = windowTimestamps();

  for (const source of sources) {
    if (seen.has(source.token)) continue;
    seen.add(source.token);
    console.log(`\n=== Token for ${source.name} (SOURCE_${source.index}) ===`);

    let accounts = [];
    try {
      accounts = await getStarlingAccounts(source.token);
    } catch (err) {
      console.log(`  accounts: FAILED — ${err.message}`);
      continue;
    }

    for (const acc of accounts) {
      console.log(`\n  Account: ${acc.name || '(unnamed)'}`);
      console.log(`    accountUid:      ${acc.accountUid}`);
      console.log(`    accountType:     ${acc.accountType}`);
      console.log(`    defaultCategory: ${acc.defaultCategory}`);
      console.log(`    currency:        ${acc.currency}`);

      try {
        const bal = await getBalance(source.token, acc.accountUid);
        const eff = bal.effectiveBalance;
        if (eff) {
          console.log(
            `    balance:         ${eff.minorUnits} (${eff.currency}, minor units)`,
          );
        }
      } catch (err) {
        console.log(`    balance:         unavailable (${err.message})`);
      }

      try {
        const goals = await getSavingsGoals(source.token, acc.accountUid);
        const list = goals.savingsGoalList || [];
        if (list.length) {
          console.log('    savings goals:');
          for (const g of list) {
            console.log(`      - ${g.name} [${g.savingsGoalUid}]`);
          }
        }
      } catch (err) {
        console.log(`    savings goals:   unavailable (${err.message})`);
      }

      try {
        const spaces = await getSpaces(source.token, acc.accountUid);
        const spend = spaces.spendingSpaces || [];
        const save = spaces.savingsSpaces || [];
        if (spend.length || save.length) {
          console.log('    spaces:');
          for (const s of spend) {
            console.log(
              `      - [spending] ${s.name} [${s.spaceUid || s.savingsGoalUid}]`,
            );
          }
          for (const s of save) {
            console.log(
              `      - [savings]  ${s.name} [${s.spaceUid || s.savingsGoalUid}]`,
            );
          }
        }
      } catch (err) {
        console.log(`    spaces:          unavailable (${err.message})`);
      }

      // Sample raw feed items so the user can confirm how Space transfers tag.
      try {
        const feed = await getFeed(
          source.token,
          acc.accountUid,
          acc.defaultCategory,
          minTs,
          maxTs,
        );
        console.log(`    sample feed items (${feed.length} in window):`);
        for (const item of feed.slice(0, 3)) {
          console.log(
            `      - ${item.direction} ${item.amount?.minorUnits} ` +
              `source=${item.source} counterPartyType=${item.counterPartyType} ` +
              `name=${item.counterPartyName || ''} status=${item.status}`,
          );
        }
      } catch (err) {
        console.log(`    feed:            unavailable (${err.message})`);
      }
    }
  }
}

async function withActual(fn) {
  if (!ACTUAL.serverURL || !ACTUAL.password || !ACTUAL.syncId) {
    throw new Error(
      'Missing ACTUAL_SERVER_URL / ACTUAL_PASSWORD / ACTUAL_SYNC_ID',
    );
  }
  fs.mkdirSync(ACTUAL.dataDir, { recursive: true });
  await api.init({
    dataDir: ACTUAL.dataDir,
    serverURL: ACTUAL.serverURL,
    password: ACTUAL.password,
  });
  try {
    await api.downloadBudget(
      ACTUAL.syncId,
      ACTUAL.e2ePassword ? { password: ACTUAL.e2ePassword } : {},
    );
    return await fn();
  } finally {
    await api.shutdown();
  }
}

async function runListAccounts() {
  await withActual(async () => {
    const accounts = await api.getAccounts();
    console.log('Actual accounts:');
    for (const a of accounts) {
      const flags = [a.offbudget ? 'off-budget' : null, a.closed ? 'closed' : null]
        .filter(Boolean)
        .join(', ');
      console.log(`  ${a.id}  ${a.name}${flags ? `  (${flags})` : ''}`);
    }
  });
}

async function runImport() {
  const sources = loadSources();
  if (sources.length === 0) {
    console.log('No SOURCE_n_STARLING_TOKEN configured. Nothing to import.');
    return;
  }
  const { minTs, maxTs } = windowTimestamps();

  await withActual(async () => {
    for (const source of sources) {
      try {
        if (!source.actualAccountId) {
          throw new Error('missing SOURCE_' + source.index + '_ACTUAL_ACCOUNT_ID');
        }
        const acc = await resolveAccount(source);
        const feed = await getFeed(
          source.token,
          acc.accountUid,
          acc.defaultCategory,
          minTs,
          maxTs,
        );

        const skip = new Set(source.skipSources);
        const kept = feed.filter((item) => !skip.has(item.source));
        const skipped = feed.length - kept.length;
        const txns = kept.map(feedItemToActual).filter((t) => t.date && t.imported_id);

        const result = await api.importTransactions(source.actualAccountId, txns);
        const added = result.added?.length ?? 0;
        const updated = result.updated?.length ?? 0;
        const errors = result.errors?.length ?? 0;
        console.log(
          `[${source.name}] feed=${feed.length} skipped=${skipped} ` +
            `imported=${txns.length} added=${added} updated=${updated} errors=${errors}`,
        );
        if (errors) console.log(`  errors:`, result.errors);
      } catch (err) {
        // Never let one source's failure abort the others.
        console.error(`[${source.name}] FAILED — ${err.message}`);
      }
    }
  });
}

// --- Entry point ----------------------------------------------------------
const mode = process.argv[2] || 'import';
const modes = {
  import: runImport,
  discover: runDiscover,
  'list-accounts': runListAccounts,
};

const handler = modes[mode];
if (!handler) {
  console.error(`Unknown mode "${mode}". Use: import | discover | list-accounts`);
  process.exit(1);
}

handler().catch((err) => {
  console.error(err);
  process.exit(1);
});
