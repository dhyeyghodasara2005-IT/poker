/*
 * Poker chip engine: seats, blinds, betting rounds, side pots and payouts.
 * Pure logic with no DOM access. Every function mutates the state object it is
 * given; callers snapshot the state themselves if they want undo.
 */
(function (root) {
  'use strict';

  var STREETS = ['preflop', 'flop', 'turn', 'river'];
  var LOG_LIMIT = 300;

  function createState() {
    return {
      settings: { smallBlind: 10, bigBlind: 20, defaultBuyIn: 1000 },
      players: [],
      nextId: 1,
      dealerId: null, // dealer of the most recent hand
      dealerIndex: 0, // table index of that dealer, used if they leave
      buttonOverride: null, // player chosen by hand to deal next
      hand: null,
      handCount: 0,
      log: []
    };
  }

  // ---------- helpers ----------

  function chips(value, label) {
    var n = Number(value);
    if (!isFinite(n) || n < 0 || Math.floor(n) !== n) {
      throw new Error((label || 'Amount') + ' must be a whole number of chips.');
    }
    return n;
  }

  function getPlayer(state, id) {
    for (var i = 0; i < state.players.length; i++) {
      if (state.players[i].id === id) return state.players[i];
    }
    return null;
  }

  function nameOf(state, id) {
    var p = getPlayer(state, id);
    return p ? p.name : '?';
  }

  function addLog(state, text) {
    state.log.push({ hand: state.hand ? state.hand.number : null, text: text });
    if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
  }

  function isEligible(p) {
    return !p.sittingOut && p.stack > 0;
  }

  function inHand(state, id) {
    return !!(state.hand && state.hand.p[id]);
  }

  // ---------- player management ----------

  function addPlayer(state, name, buyIn) {
    name = String(name == null ? '' : name).trim();
    if (!name) throw new Error('Enter a player name.');
    var lower = name.toLowerCase();
    if (state.players.some(function (p) { return p.name.toLowerCase() === lower; })) {
      throw new Error(name + ' is already at the table.');
    }
    var amount = chips(buyIn == null || buyIn === '' ? state.settings.defaultBuyIn : buyIn, 'Buy-in');
    if (amount <= 0) throw new Error('Buy-in must be more than 0.');
    var p = { id: state.nextId++, name: name, stack: amount, buyIn: amount, sittingOut: false };
    state.players.push(p);
    addLog(state, name + ' buys in for ' + amount + '.');
    return p;
  }

  function removePlayer(state, id) {
    if (inHand(state, id)) throw new Error('Finish the hand before removing a player in it.');
    var idx = state.players.findIndex(function (p) { return p.id === id; });
    if (idx < 0) return;
    var p = state.players[idx];
    state.players.splice(idx, 1);
    if (state.dealerId === id) state.dealerIndex = idx;
    else if (idx < state.dealerIndex) state.dealerIndex--;
    if (state.buttonOverride === id) state.buttonOverride = null;
    var net = p.stack - p.buyIn;
    addLog(state, p.name + ' leaves with ' + p.stack + ' (' + (net >= 0 ? '+' : '') + net + ').');
  }

  function rebuy(state, id, amount) {
    if (inHand(state, id) && !state.hand.p[id].folded) {
      throw new Error('A player can only add chips between hands or after folding.');
    }
    var p = getPlayer(state, id);
    if (!p) throw new Error('Unknown player.');
    var n = chips(amount, 'Rebuy');
    if (n <= 0) throw new Error('Rebuy must be more than 0.');
    p.stack += n;
    p.buyIn += n;
    addLog(state, p.name + ' rebuys for ' + n + '.');
  }

  function setSittingOut(state, id, sittingOut) {
    if (inHand(state, id)) throw new Error('Finish the hand before sitting a player out.');
    var p = getPlayer(state, id);
    if (p) p.sittingOut = !!sittingOut;
  }

  function setButton(state, id) {
    if (state.hand) throw new Error('Move the button between hands.');
    var p = getPlayer(state, id);
    if (!p || !isEligible(p)) throw new Error('That player cannot take the button.');
    state.buttonOverride = id;
  }

  function setBlinds(state, smallBlind, bigBlind) {
    var sb = chips(smallBlind, 'Small blind');
    var bb = chips(bigBlind, 'Big blind');
    if (bb <= 0) throw new Error('Big blind must be more than 0.');
    if (sb > bb) throw new Error('Small blind cannot be bigger than the big blind.');
    state.settings.smallBlind = sb;
    state.settings.bigBlind = bb;
  }

  // ---------- positions ----------

  function nextEligibleAfter(state, index) {
    var n = state.players.length;
    for (var i = 1; i <= n; i++) {
      var p = state.players[(index + i) % n];
      if (isEligible(p)) return p;
    }
    return null;
  }

  // Seats for the next hand, dealer first, in table order.
  function upcomingSeats(state) {
    var eligible = state.players.filter(isEligible);
    if (eligible.length < 2) return null;
    var dealer = null;
    var override = state.buttonOverride != null ? getPlayer(state, state.buttonOverride) : null;
    if (override && isEligible(override)) {
      dealer = override;
    } else if (state.dealerId == null) {
      dealer = eligible[0];
    } else {
      var idx = state.players.findIndex(function (p) { return p.id === state.dealerId; });
      // A departed dealer's seat is gone, so the player now at that index is next.
      dealer = idx >= 0 ? nextEligibleAfter(state, idx) : nextEligibleAfter(state, state.dealerIndex - 1);
    }
    var start = state.players.indexOf(dealer);
    var seats = [];
    for (var i = 0; i < state.players.length; i++) {
      var p = state.players[(start + i) % state.players.length];
      if (isEligible(p)) seats.push(p.id);
    }
    return seats;
  }

  function positionsFor(seats) {
    var n = seats.length;
    if (n === 2) return { dealer: 0, sb: 0, bb: 1, firstPreflop: 0 };
    return { dealer: 0, sb: 1, bb: 2, firstPreflop: 3 % n };
  }

  function nextPositions(state) {
    var seats = state.hand ? null : upcomingSeats(state);
    if (!seats) return null;
    var pos = positionsFor(seats);
    return { dealerId: seats[pos.dealer], sbId: seats[pos.sb], bbId: seats[pos.bb] };
  }

  // ---------- hand flow ----------

  function put(state, id, amount) {
    var p = getPlayer(state, id);
    var hp = state.hand.p[id];
    var amt = Math.min(amount, p.stack);
    p.stack -= amt;
    hp.bet += amt;
    hp.total += amt;
    if (p.stack === 0) hp.allIn = true;
    return amt;
  }

  function startHand(state) {
    if (state.hand) throw new Error('A hand is already in progress.');
    var seats = upcomingSeats(state);
    if (!seats) throw new Error('At least two players with chips are needed to deal.');
    var pos = positionsFor(seats);
    var sb = state.settings.smallBlind;
    var bb = state.settings.bigBlind;

    state.handCount++;
    state.buttonOverride = null;
    state.dealerId = seats[pos.dealer];
    state.dealerIndex = state.players.findIndex(function (p) { return p.id === state.dealerId; });

    var hand = {
      number: state.handCount,
      street: 'preflop',
      seats: seats,
      dealerId: seats[pos.dealer],
      sbId: seats[pos.sb],
      bbId: seats[pos.bb],
      p: {},
      currentBet: 0,
      minRaise: bb,
      toAct: -1,
      pots: null,
      result: null
    };
    seats.forEach(function (id) {
      hand.p[id] = { bet: 0, total: 0, folded: false, allIn: false, acted: false };
    });
    state.hand = hand;

    addLog(state, 'Hand #' + hand.number + ': ' + nameOf(state, hand.dealerId) + ' deals.');
    var sbPaid = put(state, hand.sbId, sb);
    var bbPaid = put(state, hand.bbId, bb);
    addLog(state, nameOf(state, hand.sbId) + ' posts small blind ' + sbPaid +
      (hand.p[hand.sbId].allIn ? ' (all-in)' : '') + '.');
    addLog(state, nameOf(state, hand.bbId) + ' posts big blind ' + bbPaid +
      (hand.p[hand.bbId].allIn ? ' (all-in)' : '') + '.');
    hand.currentBet = Math.max(sbPaid, bbPaid);

    var first = findNextActor(state, pos.firstPreflop);
    if (first >= 0) hand.toAct = first;
    else endStreet(state);
    return hand;
  }

  function livePlayers(hand) {
    return hand.seats.filter(function (id) { return !hand.p[id].folded; });
  }

  function activePlayers(hand) {
    return hand.seats.filter(function (id) { return !hand.p[id].folded && !hand.p[id].allIn; });
  }

  function needsAction(hand, id) {
    var hp = hand.p[id];
    if (hp.folded || hp.allIn) return false;
    if (hp.bet < hand.currentBet) return true;
    if (hp.acted) return false;
    // Nobody left to bet against: a matched player has nothing to decide.
    return activePlayers(hand).length > 1;
  }

  function findNextActor(state, fromPos) {
    var hand = state.hand;
    var n = hand.seats.length;
    for (var i = 0; i < n; i++) {
      var pos = (fromPos + i) % n;
      if (needsAction(hand, hand.seats[pos])) return pos;
    }
    return -1;
  }

  function legalActions(state) {
    var hand = state.hand;
    if (!hand || hand.toAct < 0 || hand.street === 'showdown' || hand.result) return null;
    var id = hand.seats[hand.toAct];
    var p = getPlayer(state, id);
    var hp = hand.p[id];
    var toCall = Math.max(0, hand.currentBet - hp.bet);
    var othersWithChips = activePlayers(hand).filter(function (x) { return x !== id; }).length > 0;
    var maxTo = hp.bet + p.stack;
    var canRaise = !hp.acted && p.stack > toCall && othersWithChips;
    return {
      playerId: id,
      stack: p.stack,
      bet: hp.bet,
      currentBet: hand.currentBet,
      toCall: toCall,
      callAmount: Math.min(toCall, p.stack),
      canCheck: toCall === 0,
      canCall: toCall > 0,
      canRaise: canRaise,
      isBet: hand.currentBet === 0,
      minRaiseTo: Math.min(hand.currentBet + hand.minRaise, maxTo),
      maxRaiseTo: maxTo,
      pot: potTotal(hand)
    };
  }

  function potTotal(hand) {
    return hand.seats.reduce(function (sum, id) { return sum + hand.p[id].total; }, 0);
  }

  // Chips still waiting to be awarded (excludes pots already paid out at showdown).
  function potInPlay(hand) {
    var paid = 0;
    (hand.pots || []).forEach(function (pot) { if (pot.winners) paid += pot.amount; });
    return potTotal(hand) - paid;
  }

  function act(state, type, amount) {
    var L = legalActions(state);
    if (!L) throw new Error('No one is waiting to act.');
    var hand = state.hand;
    var id = L.playerId;
    var hp = hand.p[id];
    var who = nameOf(state, id);

    if (type === 'allin') {
      if (L.maxRaiseTo <= hand.currentBet) type = 'call';
      else if (L.canRaise) { type = 'raise'; amount = L.maxRaiseTo; }
      else if (L.canCall) type = 'call';
      else throw new Error(who + ' cannot raise here. Check instead.');
    }

    switch (type) {
      case 'fold':
        hp.folded = true;
        hp.acted = true;
        addLog(state, who + ' folds.');
        break;
      case 'check':
        if (!L.canCheck) throw new Error(who + ' must call ' + L.toCall + ' or fold.');
        hp.acted = true;
        addLog(state, who + ' checks.');
        break;
      case 'call': {
        if (!L.canCall) throw new Error('Nothing to call. Check instead.');
        var paid = put(state, id, L.toCall);
        hp.acted = true;
        addLog(state, who + ' calls ' + paid + (hp.allIn ? ' and is all-in.' : '.'));
        break;
      }
      case 'raise': {
        if (!L.canRaise) throw new Error(who + ' cannot raise here.');
        var to = chips(amount, 'Raise');
        if (to > L.maxRaiseTo) throw new Error(who + ' only has ' + L.maxRaiseTo + ' in total for this round.');
        if (to < L.minRaiseTo) {
          throw new Error((L.isBet ? 'Minimum bet' : 'Minimum raise') + ' is ' + L.minRaiseTo + '.');
        }
        var size = to - hand.currentBet;
        put(state, id, to - hp.bet);
        if (size >= hand.minRaise) {
          // A full raise reopens the betting for everyone else.
          hand.minRaise = size;
          hand.seats.forEach(function (other) { if (other !== id) hand.p[other].acted = false; });
        }
        hand.currentBet = to;
        hp.acted = true;
        addLog(state, who + (L.isBet ? ' bets ' : ' raises to ') + to + (hp.allIn ? ' (all-in).' : '.'));
        break;
      }
      default:
        throw new Error('Unknown action: ' + type);
    }
    afterAction(state);
  }

  function afterAction(state) {
    var hand = state.hand;
    var live = livePlayers(hand);
    if (live.length === 1) {
      winUncontested(state, live[0]);
      return;
    }
    var next = findNextActor(state, (hand.toAct + 1) % hand.seats.length);
    if (next >= 0) hand.toAct = next;
    else endStreet(state);
  }

  function endStreet(state) {
    var hand = state.hand;
    hand.seats.forEach(function (id) {
      hand.p[id].bet = 0;
      hand.p[id].acted = false;
    });
    hand.currentBet = 0;
    hand.minRaise = state.settings.bigBlind;
    hand.toAct = -1;

    var idx = STREETS.indexOf(hand.street);
    if (hand.street === 'river' || activePlayers(hand).length <= 1) {
      if (hand.street !== 'river') addLog(state, 'All-in: deal out the rest of the board.');
      goShowdown(state);
      return;
    }
    hand.street = STREETS[idx + 1];
    addLog(state, capital(hand.street) + '. Pot ' + potTotal(hand) + '.');
    var first = findNextActor(state, 1 % hand.seats.length);
    if (first >= 0) hand.toAct = first;
    else endStreet(state);
  }

  function capital(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function winUncontested(state, id) {
    var hand = state.hand;
    var pot = potTotal(hand);
    getPlayer(state, id).stack += pot;
    hand.result = { awards: [{ id: id, amount: pot }], uncontested: true };
    addLog(state, nameOf(state, id) + ' wins ' + pot + ' uncontested.');
    finishHand(state);
  }

  // Splits contributions into a main pot and side pots by all-in level.
  function computePots(hand) {
    var contrib = hand.seats.map(function (id) {
      return { id: id, amt: hand.p[id].total, live: !hand.p[id].folded };
    });
    var levels = [];
    contrib.forEach(function (c) {
      if (c.live && levels.indexOf(c.amt) < 0) levels.push(c.amt);
    });
    levels.sort(function (a, b) { return a - b; });

    var pots = [];
    var prev = 0;
    levels.forEach(function (level) {
      var amount = 0;
      contrib.forEach(function (c) {
        amount += Math.min(c.amt, level) - Math.min(c.amt, prev);
      });
      var eligible = contrib.filter(function (c) { return c.live && c.amt >= level; })
        .map(function (c) { return c.id; });
      prev = level;
      if (amount <= 0) return;
      var last = pots[pots.length - 1];
      if (last && last.eligible.join() === eligible.join()) last.amount += amount;
      else pots.push({ amount: amount, eligible: eligible });
    });

    var counted = pots.reduce(function (s, p) { return s + p.amount; }, 0);
    var leftover = potTotal(hand) - counted;
    if (leftover > 0 && pots.length) pots[pots.length - 1].amount += leftover;
    return pots;
  }

  function goShowdown(state) {
    var hand = state.hand;
    hand.street = 'showdown';
    hand.toAct = -1;
    hand.pots = computePots(hand).map(function (pot, i) {
      return { amount: pot.amount, eligible: pot.eligible, winners: null, index: i };
    });
    // A pot only one player can win is an uncalled bet: give it straight back.
    hand.pots.forEach(function (pot) {
      if (pot.eligible.length === 1) awardPot(state, pot, pot.eligible, true);
    });
    addLog(state, 'Showdown. Pick the winner of each pot.');
    maybeFinish(state);
  }

  function awardPot(state, pot, winners, returned) {
    var hand = state.hand;
    var n = hand.seats.length;
    // Odd chips go to the first winner left of the button.
    var ordered = winners.slice().sort(function (a, b) {
      return ((hand.seats.indexOf(a) - 1 + n) % n) - ((hand.seats.indexOf(b) - 1 + n) % n);
    });
    var share = Math.floor(pot.amount / ordered.length);
    var odd = pot.amount - share * ordered.length;
    pot.winners = ordered.map(function (id, i) {
      var amount = share + (i < odd ? 1 : 0);
      getPlayer(state, id).stack += amount;
      return { id: id, amount: amount };
    });
    var label = hand.pots.length > 1 ? (pot.index === 0 ? 'the main pot' : 'side pot ' + pot.index) : 'the pot';
    if (returned) {
      addLog(state, 'Uncalled ' + pot.amount + ' returned to ' + nameOf(state, ordered[0]) + '.');
    } else if (ordered.length === 1) {
      addLog(state, nameOf(state, ordered[0]) + ' wins ' + label + ' (' + pot.amount + ').');
    } else {
      addLog(state, ordered.map(function (id) { return nameOf(state, id); }).join(' and ') +
        ' split ' + label + ' (' + pot.amount + ').');
    }
  }

  function awardShowdownPot(state, potIndex, winners) {
    var hand = state.hand;
    if (!hand || hand.street !== 'showdown') throw new Error('There is no showdown to settle.');
    var pot = hand.pots[potIndex];
    if (!pot || pot.winners) throw new Error('That pot is already settled.');
    if (!winners || !winners.length) throw new Error('Pick at least one winner.');
    winners.forEach(function (id) {
      if (pot.eligible.indexOf(id) < 0) throw new Error(nameOf(state, id) + ' is not in that pot.');
    });
    awardPot(state, pot, winners, false);
    maybeFinish(state);
  }

  function maybeFinish(state) {
    var hand = state.hand;
    if (!hand.pots.every(function (p) { return p.winners; })) return;
    var totals = {};
    hand.pots.forEach(function (pot) {
      pot.winners.forEach(function (w) { totals[w.id] = (totals[w.id] || 0) + w.amount; });
    });
    hand.result = {
      awards: Object.keys(totals).map(function (id) { return { id: Number(id), amount: totals[id] }; }),
      uncontested: false
    };
    finishHand(state);
  }

  function finishHand(state) {
    var hand = state.hand;
    state.lastHand = {
      number: hand.number,
      awards: hand.result.awards,
      contributions: hand.seats.map(function (id) { return { id: id, amount: hand.p[id].total }; })
    };
    state.hand = null;
    state.players.forEach(function (p) {
      if (p.stack === 0) addLog(state, p.name + ' is out of chips.');
    });
  }

  // ---------- money ----------

  function net(p) { return p.stack - p.buyIn; }

  // Fewest transfers that settle everyone's profit and loss.
  function settlement(state) {
    var debtors = [];
    var creditors = [];
    state.players.forEach(function (p) {
      var n = net(p);
      if (n < 0) debtors.push({ id: p.id, name: p.name, amount: -n });
      else if (n > 0) creditors.push({ id: p.id, name: p.name, amount: n });
    });
    debtors.sort(function (a, b) { return b.amount - a.amount; });
    creditors.sort(function (a, b) { return b.amount - a.amount; });
    var transfers = [];
    var i = 0;
    var j = 0;
    while (i < debtors.length && j < creditors.length) {
      var amt = Math.min(debtors[i].amount, creditors[j].amount);
      transfers.push({ from: debtors[i].name, to: creditors[j].name, amount: amt });
      debtors[i].amount -= amt;
      creditors[j].amount -= amt;
      if (debtors[i].amount === 0) i++;
      if (creditors[j].amount === 0) j++;
    }
    return transfers;
  }

  var api = {
    STREETS: STREETS,
    createState: createState,
    addPlayer: addPlayer,
    removePlayer: removePlayer,
    rebuy: rebuy,
    setSittingOut: setSittingOut,
    setButton: setButton,
    setBlinds: setBlinds,
    nextPositions: nextPositions,
    startHand: startHand,
    legalActions: legalActions,
    act: act,
    awardShowdownPot: awardShowdownPot,
    computePots: computePots,
    potTotal: potTotal,
    potInPlay: potInPlay,
    getPlayer: getPlayer,
    net: net,
    settlement: settlement
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PokerEngine = api;
})(typeof window !== 'undefined' ? window : this);
