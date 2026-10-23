const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');

function table(names, stack = 1000, sb = 10, bb = 20) {
  const s = E.createState();
  E.setBlinds(s, sb, bb);
  names.forEach((n, i) => E.addPlayer(s, n, Array.isArray(stack) ? stack[i] : stack));
  return s;
}
const id = (s, name) => s.players.find((p) => p.name === name).id;
const stack = (s, name) => s.players.find((p) => p.name === name).stack;
const toAct = (s) => E.getPlayer(s, s.hand.seats[s.hand.toAct]).name;
const total = (s) => s.players.reduce((a, p) => a + p.stack, 0) + (s.hand ? E.potTotal(s.hand) : 0);

test('blinds are posted and action starts left of the big blind', () => {
  const s = table(['Ann', 'Bob', 'Cat', 'Dan']);
  E.startHand(s);
  assert.equal(E.getPlayer(s, s.hand.dealerId).name, 'Ann');
  assert.equal(stack(s, 'Bob'), 990);
  assert.equal(stack(s, 'Cat'), 980);
  assert.equal(toAct(s), 'Dan');
  assert.equal(E.legalActions(s).toCall, 20);
});

test('button and blinds move one seat each hand', () => {
  const s = table(['Ann', 'Bob', 'Cat']);
  E.startHand(s);
  E.act(s, 'fold'); E.act(s, 'fold'); // Ann, Bob fold; Cat (BB) wins
  assert.equal(s.hand, null);
  const next = E.nextPositions(s);
  assert.deepEqual([next.dealerId, next.sbId, next.bbId], [id(s, 'Bob'), id(s, 'Cat'), id(s, 'Ann')]);
  assert.equal(stack(s, 'Cat'), 1010);
  assert.equal(stack(s, 'Bob'), 990);
});

test('heads-up: dealer posts small blind and acts first preflop, last after', () => {
  const s = table(['Ann', 'Bob']);
  E.startHand(s);
  assert.equal(s.hand.sbId, id(s, 'Ann'));
  assert.equal(toAct(s), 'Ann');
  E.act(s, 'call');
  assert.equal(toAct(s), 'Bob');
  assert.equal(E.legalActions(s).canCheck, true);
  E.act(s, 'check');
  assert.equal(s.hand.street, 'flop');
  assert.equal(toAct(s), 'Bob');
});

test('big blind gets the option to raise after limps', () => {
  const s = table(['Ann', 'Bob', 'Cat']);
  E.startHand(s);
  E.act(s, 'call'); E.act(s, 'call');
  assert.equal(toAct(s), 'Cat');
  const L = E.legalActions(s);
  assert.equal(L.canCheck, true);
  assert.equal(L.canRaise, true);
  assert.equal(L.minRaiseTo, 40);
  E.act(s, 'raise', 60);
  assert.equal(toAct(s), 'Ann');
  assert.equal(E.legalActions(s).toCall, 40);
  assert.equal(E.legalActions(s).minRaiseTo, 100);
});

test('rejects raises below the minimum', () => {
  const s = table(['Ann', 'Bob', 'Cat']);
  E.startHand(s);
  assert.throws(() => E.act(s, 'raise', 30), /Minimum raise is 40/);
});

test('full hand to showdown with a split pot and odd chip', () => {
  const s = table(['Ann', 'Bob', 'Cat'], 1000, 5, 10);
  E.startHand(s); // Ann D, Bob SB 5, Cat BB 10
  E.act(s, 'call'); E.act(s, 'call'); E.act(s, 'check'); // pot 30
  E.act(s, 'raise', 15); // Bob bets 15 on the flop
  E.act(s, 'fold'); // Cat
  E.act(s, 'call'); // Ann; pot 60 + Cat's 10 = 60
  E.act(s, 'check'); E.act(s, 'check'); // turn
  E.act(s, 'check'); E.act(s, 'check'); // river
  assert.equal(s.hand.street, 'showdown');
  assert.equal(s.hand.pots.length, 1);
  assert.equal(s.hand.pots[0].amount, 60);
  E.awardShowdownPot(s, 0, [id(s, 'Ann'), id(s, 'Bob')]);
  assert.equal(s.hand, null);
  assert.equal(stack(s, 'Ann') + stack(s, 'Bob') + stack(s, 'Cat'), 3000);
  assert.equal(stack(s, 'Bob'), 1005); // left of button gets nothing extra: 30 each
  assert.equal(stack(s, 'Ann'), 1005);
});

test('odd chip goes to the first winner left of the button', () => {
  const s = table(['Ann', 'Bob', 'Cat'], 1000, 5, 10);
  E.startHand(s);
  E.act(s, 'raise', 25); // Ann
  E.act(s, 'fold'); // Bob leaves 5 in
  E.act(s, 'call'); // Cat; pot 55
  for (let i = 0; i < 6; i++) E.act(s, 'check');
  E.awardShowdownPot(s, 0, [id(s, 'Ann'), id(s, 'Cat')]);
  assert.equal(stack(s, 'Cat'), 1003); // 975 + 28
  assert.equal(stack(s, 'Ann'), 1002); // 975 + 27
});

test('side pots with three all-ins', () => {
  const s = table(['Ann', 'Bob', 'Cat'], [100, 300, 500]);
  E.startHand(s); // Ann D, Bob SB, Cat BB
  E.act(s, 'allin'); // Ann to 100
  E.act(s, 'allin'); // Bob to 300
  E.act(s, 'allin'); // nobody left to raise against, so Cat just calls 300
  assert.equal(s.hand.street, 'showdown');
  assert.deepEqual(s.hand.pots.map((p) => p.amount), [300, 400]);
  assert.equal(stack(s, 'Cat'), 200);
  E.awardShowdownPot(s, 0, [id(s, 'Ann')]);
  E.awardShowdownPot(s, 1, [id(s, 'Cat')]);
  assert.equal(s.hand, null);
  assert.deepEqual([stack(s, 'Ann'), stack(s, 'Bob'), stack(s, 'Cat')], [300, 0, 600]);
  assert.equal(total(s), 900);
});

test('short all-in does not reopen raising for a player who already acted', () => {
  const s = table(['Ann', 'Bob', 'Cat'], [1000, 1000, 50]);
  E.startHand(s); // Ann D, Bob SB, Cat BB (50 stack)
  E.act(s, 'call'); // Ann calls 20
  E.act(s, 'call'); // Bob completes
  E.act(s, 'allin'); // Cat to 50: raise of 30 >= 20, full raise
  assert.equal(E.legalActions(s).canRaise, true);
  const t = table(['Ann', 'Bob', 'Cat'], [1000, 1000, 35]);
  E.startHand(t);
  E.act(t, 'call'); E.act(t, 'call');
  E.act(t, 'allin'); // Cat to 35: raise of 15 < 20, not full
  assert.equal(toAct(t), 'Ann');
  assert.equal(E.legalActions(t).canRaise, false);
  assert.equal(E.legalActions(t).toCall, 15);
});

test('no prompts once only one player has chips behind', () => {
  const s = table(['Ann', 'Bob'], [1000, 100]);
  E.startHand(s);
  E.act(s, 'raise', 100); // Ann
  E.act(s, 'allin'); // Bob calls all-in
  assert.equal(s.hand.street, 'showdown');
  assert.equal(stack(s, 'Ann'), 900);
});

test('busted players are skipped and can rebuy', () => {
  const s = table(['Ann', 'Bob', 'Cat'], [1000, 1000, 20]);
  E.startHand(s); // Cat BB all-in for 20
  E.act(s, 'call'); E.act(s, 'call');
  for (let i = 0; i < 6; i++) E.act(s, 'check');
  E.awardShowdownPot(s, 0, [id(s, 'Ann')]);
  assert.equal(stack(s, 'Cat'), 0);
  E.startHand(s);
  assert.deepEqual(s.hand.seats.map((x) => E.getPlayer(s, x).name), ['Bob', 'Ann']);
  E.act(s, 'fold');
  E.rebuy(s, id(s, 'Cat'), 500);
  const p = s.players.find((x) => x.name === 'Cat');
  assert.equal(p.buyIn, 520);
  assert.equal(E.net(p), -20);
});

test('settlement nets everyone to zero', () => {
  const s = table(['Ann', 'Bob', 'Cat']);
  s.players[0].stack = 1500; s.players[1].stack = 700; s.players[2].stack = 800;
  const t = E.settlement(s);
  assert.deepEqual(t, [
    { from: 'Bob', to: 'Ann', amount: 300 },
    { from: 'Cat', to: 'Ann', amount: 200 },
  ]);
});

test('chip total is conserved across many random hands', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const s = table(['A', 'B', 'C', 'D', 'E'], [500, 800, 1000, 300, 1200]);
  for (let h = 0; h < 300; h++) {
    s.players.forEach((p) => { if (p.stack === 0) E.rebuy(s, p.id, 400); });
    const before = s.players.reduce((a, p) => a + p.buyIn, 0);
    E.startHand(s);
    let guard = 0;
    while (s.hand && s.hand.street !== 'showdown' && guard++ < 200) {
      const L = E.legalActions(s);
      const r = rnd();
      if (r < 0.15) E.act(s, 'fold');
      else if (r < 0.65) E.act(s, L.canCheck ? 'check' : 'call');
      else if (r < 0.9 && L.canRaise) E.act(s, 'raise', Math.min(L.maxRaiseTo, L.minRaiseTo + Math.floor(rnd() * 100)));
      else if (L.canRaise) E.act(s, 'allin');
      else E.act(s, L.canCheck ? 'check' : 'call');
    }
    if (s.hand) {
      s.hand.pots.forEach((pot, i) => {
        if (!pot.winners) {
          const w = pot.eligible.filter(() => rnd() < 0.6);
          E.awardShowdownPot(s, i, w.length ? w : [pot.eligible[0]]);
        }
      });
    }
    assert.equal(s.hand, null);
    assert.equal(s.players.reduce((a, p) => a + p.stack, 0), before, 'hand ' + h);
  }
});

test('an uncalled bet is returned at showdown', () => {
  const s = table(['Ann', 'Bob'], [1000, 200]);
  E.startHand(s); // Ann SB/D, Bob BB
  E.act(s, 'raise', 600); // Ann
  E.act(s, 'call'); // Bob all-in for 200
  assert.equal(s.hand.street, 'showdown');
  assert.deepEqual(s.hand.pots.map((p) => p.amount), [400, 400]);
  assert.deepEqual(s.hand.pots[1].winners, [{ id: id(s, 'Ann'), amount: 400 }]);
  assert.equal(stack(s, 'Ann'), 800); // 400 uncalled came back
  assert.equal(E.potInPlay(s.hand), 400);
});

// ---------- outcome coverage ----------

test('big blind all-in for less than the blind: others still call the full blind', () => {
  const s = table(['Ann', 'Bob', 'Cat'], [1000, 1000, 5]);
  E.startHand(s); // Ann D, Bob SB, Cat BB all-in for 5
  assert.equal(toAct(s), 'Ann');
  assert.equal(E.legalActions(s).toCall, 20);
  E.act(s, 'call');
  assert.equal(E.legalActions(s).toCall, 10); // Bob completes
  E.act(s, 'call');
  for (let i = 0; i < 6; i++) E.act(s, 'check');
  assert.deepEqual(s.hand.pots.map((p) => p.amount), [15, 30]);
  E.awardShowdownPot(s, 0, [id(s, 'Cat')]);
  E.awardShowdownPot(s, 1, [id(s, 'Ann')]);
  assert.deepEqual([stack(s, 'Ann'), stack(s, 'Bob'), stack(s, 'Cat')], [1010, 980, 15]);
});

test('heads-up with a short big blind goes straight to showdown and returns the excess', () => {
  const s = table(['Ann', 'Bob'], [1000, 5]);
  E.startHand(s); // Ann SB 10, Bob BB all-in 5
  assert.equal(s.hand.street, 'showdown');
  assert.equal(stack(s, 'Ann'), 995); // 5 uncalled back
  E.awardShowdownPot(s, 0, [id(s, 'Bob')]);
  assert.equal(stack(s, 'Bob'), 10);
});

test('facing only an all-in smaller than the bet, the call is just enough to match it', () => {
  const s = table(['Ann', 'Bob', 'Cat'], [15, 1000, 1000]);
  E.startHand(s); // Ann D first, Bob SB 10, Cat BB 20
  E.act(s, 'call'); // Ann all-in for 15
  E.act(s, 'call'); // Bob completes to 20
  assert.equal(toAct(s), 'Cat');
  assert.equal(E.legalActions(s).canCheck, true);
});

test('everyone folds to the big blind (a walk)', () => {
  const s = table(['Ann', 'Bob', 'Cat', 'Dan'], [1000, 1000, 1000, 1000]);
  E.startHand(s);
  E.act(s, 'fold'); E.act(s, 'fold'); E.act(s, 'fold');
  assert.equal(s.hand, null);
  assert.deepEqual([stack(s, 'Bob'), stack(s, 'Cat')], [990, 1010]);
});

test('four-way all-in: tie for the main pot, different winners of each side pot', () => {
  const s = table(['A', 'B', 'C', 'D'], [100, 300, 300, 600]);
  E.startHand(s);
  E.act(s, 'allin'); E.act(s, 'allin'); E.act(s, 'allin'); E.act(s, 'allin');
  assert.deepEqual(s.hand.pots.map((p) => p.amount), [400, 600, 300]); // last is D's uncalled 300
  E.awardShowdownPot(s, 0, [id(s, 'A'), id(s, 'D')]);
  E.awardShowdownPot(s, 1, [id(s, 'B'), id(s, 'C')]);
  assert.deepEqual([stack(s, 'A'), stack(s, 'B'), stack(s, 'C'), stack(s, 'D')], [200, 300, 300, 500]);
});

test('three-way tie with an odd chip', () => {
  const s = table(['A', 'B', 'C', 'D'], [1000, 1000, 1000, 1000], 1, 2);
  E.startHand(s); // A D, B SB 1, C BB 2, D first
  E.act(s, 'call'); E.act(s, 'raise', 20); E.act(s, 'fold'); E.act(s, 'call'); E.act(s, 'call');
  for (let i = 0; i < 9; i++) E.act(s, 'check');
  assert.equal(s.hand.pots[0].amount, 61);
  E.awardShowdownPot(s, 0, [id(s, 'A'), id(s, 'C'), id(s, 'D')]);
  assert.deepEqual([stack(s, 'C'), stack(s, 'D'), stack(s, 'A')], [1001, 1000, 1000]); // C is first left of the button
});

test('hi-lo: high hand and a tie for low gets three quarters (quartered pot)', () => {
  const s = table(['A', 'B', 'C'], [1000, 1000, 1000]);
  E.startHand(s);
  E.act(s, 'raise', 200); E.act(s, 'call'); E.act(s, 'call'); // pot 600
  for (let i = 0; i < 9; i++) E.act(s, 'check');
  // A wins high (2 shares of 4) and ties B for low (1 share each).
  E.awardShowdownPot(s, 0, [id(s, 'A'), id(s, 'B')], [3, 1]);
  assert.deepEqual([stack(s, 'A'), stack(s, 'B'), stack(s, 'C')], [1250, 950, 800]);
});

test('run it twice: different winner each run takes half each', () => {
  const s = table(['A', 'B'], [500, 500]);
  E.startHand(s);
  E.act(s, 'allin'); E.act(s, 'call');
  E.awardShowdownPot(s, 0, [id(s, 'A'), id(s, 'B')], [1, 1]);
  assert.deepEqual([stack(s, 'A'), stack(s, 'B')], [500, 500]);
});

test('uneven shares are validated', () => {
  const s = table(['A', 'B'], [500, 500]);
  E.startHand(s);
  E.act(s, 'allin'); E.act(s, 'call');
  assert.throws(() => E.awardShowdownPot(s, 0, [id(s, 'A'), id(s, 'B')], [1, 0]), /whole number of shares/);
  assert.throws(() => E.awardShowdownPot(s, 0, [id(s, 'A'), id(s, 'A')]), /picked twice/);
});

test('misdeal returns every bet and the same dealer deals again', () => {
  const s = table(['A', 'B', 'C'], [1000, 1000, 1000]);
  E.startHand(s);
  E.act(s, 'raise', 60);
  E.voidHand(s, true);
  assert.equal(s.hand, null);
  assert.deepEqual([stack(s, 'A'), stack(s, 'B'), stack(s, 'C')], [1000, 1000, 1000]);
  assert.equal(E.nextPositions(s).dealerId, id(s, 'A'));
  assert.equal(s.lastHand.voided, true);
});

test('chop returns the blinds and the button moves on', () => {
  const s = table(['A', 'B', 'C'], [1000, 1000, 1000]);
  E.startHand(s);
  E.act(s, 'fold');
  E.voidHand(s, false);
  assert.deepEqual([stack(s, 'B'), stack(s, 'C')], [1000, 1000]);
  assert.equal(E.nextPositions(s).dealerId, id(s, 'B'));
});

test('cancelling at showdown undoes pots already paid out', () => {
  const s = table(['A', 'B', 'C'], [100, 300, 300]);
  E.startHand(s);
  E.act(s, 'allin'); E.act(s, 'allin'); E.act(s, 'allin');
  E.awardShowdownPot(s, 0, [id(s, 'A')]);
  E.voidHand(s, true);
  assert.deepEqual([stack(s, 'A'), stack(s, 'B'), stack(s, 'C')], [100, 300, 300]);
});
