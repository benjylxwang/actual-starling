import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedItemToActual } from '../index.mjs';

test('OUT becomes a negative signed integer', () => {
  const t = feedItemToActual({
    feedItemUid: 'abc',
    amount: { currency: 'GBP', minorUnits: 1234 },
    direction: 'OUT',
    settlementTime: '2026-06-20T10:00:00.000Z',
    counterPartyName: 'Coffee',
    status: 'SETTLED',
  });
  assert.equal(t.amount, -1234);
  assert.equal(t.date, '2026-06-20');
  assert.equal(t.payee_name, 'Coffee');
  assert.equal(t.imported_id, 'abc');
  assert.equal(t.cleared, true);
});

test('IN becomes a positive signed integer', () => {
  const t = feedItemToActual({
    feedItemUid: 'def',
    amount: { currency: 'GBP', minorUnits: 5000 },
    direction: 'IN',
    transactionTime: '2026-06-21T08:30:00.000Z',
    counterPartyName: 'Salary',
    status: 'SETTLED',
  });
  assert.equal(t.amount, 5000);
  assert.equal(t.date, '2026-06-21');
});

test('pending item is not cleared', () => {
  const t = feedItemToActual({
    feedItemUid: 'ghi',
    amount: { currency: 'GBP', minorUnits: 100 },
    direction: 'OUT',
    transactionTime: '2026-06-22T08:30:00.000Z',
    status: 'PENDING',
  });
  assert.equal(t.cleared, false);
});

test('settlementTime is preferred over transactionTime for date', () => {
  const t = feedItemToActual({
    feedItemUid: 'jkl',
    amount: { currency: 'GBP', minorUnits: 100 },
    direction: 'OUT',
    transactionTime: '2026-06-20T23:59:00.000Z',
    settlementTime: '2026-06-21T06:00:00.000Z',
    status: 'SETTLED',
  });
  assert.equal(t.date, '2026-06-21');
});

test('reference and spendingCategory fold into notes', () => {
  const t = feedItemToActual({
    feedItemUid: 'mno',
    amount: { currency: 'GBP', minorUnits: 100 },
    direction: 'OUT',
    transactionTime: '2026-06-22T08:30:00.000Z',
    reference: 'TESCO',
    spendingCategory: 'GROCERIES',
    status: 'SETTLED',
  });
  assert.equal(t.notes, 'TESCO · GROCERIES');
});

test('missing counterPartyName falls back to source then direction', () => {
  const withSource = feedItemToActual({
    feedItemUid: 'p',
    amount: { minorUnits: 100 },
    direction: 'OUT',
    transactionTime: '2026-06-22T08:30:00.000Z',
    source: 'DIRECT_DEBIT',
    status: 'SETTLED',
  });
  assert.equal(withSource.payee_name, 'DIRECT_DEBIT');

  const bare = feedItemToActual({
    feedItemUid: 'q',
    amount: { minorUnits: 100 },
    direction: 'IN',
    transactionTime: '2026-06-22T08:30:00.000Z',
    status: 'SETTLED',
  });
  assert.equal(bare.payee_name, 'Credit');
});
