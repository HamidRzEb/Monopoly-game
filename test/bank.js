// The bank: borrowing limits, installments with interest, early repayment, debt rules, net worth.
'use strict';
const assert = require('assert');
const { Game } = require('../js/engine.js');

const mk = (n = 2) => new Game({ players: Array.from({ length: n }, (_, i) => ({ name: 'P' + i })) });
const SPACES = Game.SPACES;

// --- borrowing limits
{
  const g = mk();
  // with $1,500 and no property the bank lends up to half: $700 (rounded down to a $50 step is not used: step is $100)
  assert.strictEqual(g.creditAvailable(0), 700);
  assert(g.canBorrow(0, 750), 'not a multiple of the step');
  assert(g.canBorrow(0, 50));
  assert(g.canBorrow(0, 800), 'over the credit limit');
  assert.strictEqual(g.canBorrow(0, 500), null);
  assert(g.canBorrow(1, 100), 'not your turn');
  g.borrow(0, 500);
  assert.strictEqual(g.players[0].cash, 2000);
  assert.strictEqual(g.debtOf(0), 500);
  // owing money lowers what you can still borrow; the loan's cash raises asset worth so the limit moves up too
  assert.strictEqual(g.creditAvailable(0), Math.min(2000, Math.floor(0.5 * 2000 / 100) * 100) - 500);
  assert.strictEqual(g.netWorth(0), 1500, 'borrowing does not make you richer');
}
// --- max three loans at once
{
  const g = mk(); g.players[0].cash = 10000;
  for (let i = 0; i < 3; i++) g.borrow(0, 100);
  assert(/at most 3/.test(g.canBorrow(0, 100)));
}
// --- installments: one slice of principal + 5% interest on the balance, at the start of each of your turns
{
  const g = mk(); g.phase = 'postroll';
  g.borrow(0, 500);
  const before = g.players[0].cash;
  g.endTurn(0);               // P1's turn: nothing due for P1
  assert.strictEqual(g.players[0].cash, before);
  g.phase = 'postroll'; g.endTurn(1);   // back to P0: first payment due = 100 principal + 25 interest
  assert.strictEqual(g.current, 0);
  assert.strictEqual(g.players[0].cash, before - 125, 'first payment is principal slice + 5% of 500');
  assert.strictEqual(g.loansOf(0)[0].remaining, 400);
  g.phase = 'postroll'; g.endTurn(0); g.phase = 'postroll'; g.endTurn(1);
  assert.strictEqual(g.players[0].cash, before - 125 - 120, 'second payment: 100 + 5% of 400');
  // five rounds in total clear the loan
  for (let k = 0; k < 3; k++) { g.phase = 'postroll'; g.endTurn(0); g.phase = 'postroll'; g.endTurn(1); }
  assert.strictEqual(g.loansOf(0).length, 0, 'loan is gone after 5 payments');
  assert.strictEqual(g.players[0].cash, before - (125 + 120 + 115 + 110 + 105), 'total interest on a 500 loan is 75');
}
// --- early repayment cuts the interest
{
  const g = mk(); g.borrow(0, 500);
  assert(g.canRepay(0, 1, 600));
  assert(g.canRepay(0, 99, 100), 'unknown loan');
  g.repay(0, 1, 300);
  assert.strictEqual(g.loansOf(0)[0].remaining, 200);
  g.phase = 'postroll'; const c0 = g.players[0].cash; g.endTurn(0); g.phase = 'postroll'; g.endTurn(1);
  assert.strictEqual(g.players[0].cash, c0 - (100 + 10), 'interest is now on 200, not 500');
  assert.strictEqual(g.loansOf(0)[0].remaining, 100, 'one slice of principal was paid');
  g.repay(0, 1, 100);
  assert.strictEqual(g.loansOf(0).length, 0, 'paying the balance clears the loan');
}
// --- can't afford a payment -> normal debt rules; a new loan can settle it
{
  const g = mk(); g.phase = 'postroll';
  g.borrow(0, 500); g.players[0].cash = 10;
  g.endTurn(0); g.phase = 'postroll'; g.endTurn(1);
  assert.strictEqual(g.phase, 'debt', 'unaffordable bank payment puts the player into debt');
  assert.strictEqual(g.debt.amount, 125);
  assert.strictEqual(g.debt.creditor, null);
  g.players[0].cash = 10; // owns nothing, so it can't raise money by selling; bankruptcy cancels the loan
  g.declareBankruptcy(0);
  assert.strictEqual(g.loans.length, 0, 'a bankrupt player owes nothing any more');
}
// --- the time limit ranks by net worth AFTER debt
{
  const g = mk(); g.rules.maxRounds = 1; g.phase = 'postroll';
  g.borrow(0, 700);      // P0 is up $700 in cash but owes $700
  g.endTurn(0); g.phase = 'postroll'; g.endTurn(1);   // round 2 > maxRounds -> time's up
  assert.strictEqual(g.phase, 'gameover');
  assert.strictEqual(g.endedByLimit, true);
  assert(g.netWorth(0) <= 1500 && g.netWorth(1) === 1500);
}
// --- the snapshot carries loans so browsers can show them
{
  const g = mk(); g.borrow(0, 200);
  const view = Game.fromSnapshot(g.snapshot());
  assert.strictEqual(view.debtOf(0), 200);
  assert.strictEqual(view.canBorrow(0, 100), null);
}
console.log('bank OK');
