import test from 'node:test';
import assert from 'node:assert/strict';
import { postTransfer } from '../src/utils.js';

test('rejects missing accounts', () => {
  assert.throws(() => postTransfer({ amount: 10 }));
});

test('posts a transfer', () => {
  const r = postTransfer({ from: 'a', to: 'b', amount: 5 });
  assert.equal(r.amount, 5);
});
