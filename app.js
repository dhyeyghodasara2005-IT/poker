(function () {
  'use strict';

  var E = window.PokerEngine;
  var HISTORY_LIMIT = 100;
  var fmt = new Intl.NumberFormat();

  var state;
  var history = [];
  var ui = {
    raiseTo: null, // raise amount being typed for the current actor
    raiseFor: null, // `${hand}:${street}:${player}:${currentBet}` the amount belongs to
    picks: {}, // showdown pot index -> selected winner ids
    shares: {}, // showdown pot index -> { playerId: shares } for uneven splits
    voidOpen: false, // misdeal/chop choices showing
    openRow: null, // player id whose tools are expanded
    armed: null // id of a destructive button waiting for a second tap
  };

  var $ = function (id) { return document.getElementById(id); };

  // ---------- persistence ----------
  // GameStore (store.js) saves every change on this device at once and mirrors
  // it to the artifact database when the page runs on claude.ai.

  var store = window.GameStore.createStore({
    storage: safeStorage(),
    onRemote: adoptRemote,
    onStatus: renderSaveStatus
  });

  function safeStorage() {
    try { return window.localStorage; } catch (e) { return null; }
  }

  function newId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function newSession(settings) {
    var s = E.createState();
    if (settings) s.settings = settings;
    s.sessionId = newId();
    s.startedAt = Date.now();
    return s;
  }

  function load() {
    var saved = store.loadLocal();
    if (saved) {
      state = saved.state;
      history = saved.history;
    } else {
      state = sampleState();
      history = [];
    }
    if (!state.sessionId) { state.sessionId = newId(); state.startedAt = Date.now(); }
    store.prime(state, !state.sample);
  }

  function save() {
    store.save(state, history, !state.sample);
  }

  function connectCloud() {
    if (!window.claude || typeof window.claude.use !== 'function') return;
    window.claude.use('db').then(function (db) {
      if (!db) return;
      store.connect(db);
      watchSessions(db);
    }).catch(function () { /* stays on this device */ });
  }

  // Another device saved a newer game.
  function adoptRemote(remote) {
    if (!state.sample && state.players.length &&
        (remote.state.sessionId !== state.sessionId || store.hasUnsynced())) {
      // Keep what this device had, so nothing is lost if both were in use.
      archiveSession(state, remote.state.sessionId === state.sessionId ? 'conflict' : 'replaced');
    }
    state = remote.state;
    history = [];
    ui.picks = {};
    ui.raiseFor = null;
    ui.armed = null;
    store.adopt(state, remote.savedAt);
    render();
    toast('Updated from another device');
  }

  // A hand still in progress is treated as void: chips in its pot go back to their owners.
  function summary(s) {
    return s.players.map(function (p) {
      var stack = p.stack + (s.hand && s.hand.p[p.id] ? s.hand.p[p.id].total : 0);
      return { name: p.name, buyIn: p.buyIn, stack: stack, net: stack - p.buyIn };
    });
  }

  function archiveSession(s, reason) {
    if (!s || s.sample || (!s.players.length && !s.handCount)) return;
    var id = s.sessionId || newId();
    if (reason === 'conflict') id += '~conflict-' + Date.now().toString(36);
    store.enqueue('sessions/' + id, {
      sessionId: s.sessionId || id,
      reason: reason || 'ended',
      startedAt: s.startedAt || null,
      endedAt: Date.now(),
      handCount: s.handCount,
      blinds: { small: s.settings.smallBlind, big: s.settings.bigBlind },
      players: summary(s),
      state: s
    });
  }

  // One permanent record per finished hand, beyond the on-screen log limit.
  function recordHand(s) {
    var lh = s.lastHand;
    if (!lh || s.sample) return;
    var nm = function (id) { var p = E.getPlayer(s, id); return p ? p.name : '?'; };
    store.enqueue('hands/' + s.sessionId + '_' + lh.number, {
      sessionId: s.sessionId,
      number: lh.number,
      finishedAt: Date.now(),
      blinds: { small: s.settings.smallBlind, big: s.settings.bigBlind },
      dealer: nm(s.dealerId),
      voided: !!lh.voided,
      contributions: lh.contributions.map(function (c) { return { name: nm(c.id), amount: c.amount }; }),
      awards: lh.awards.map(function (a) { return { name: nm(a.id), amount: a.amount }; }),
      players: summary(s),
      log: s.log.filter(function (e) { return e.hand === lh.number; }).map(function (e) { return e.text; })
    });
  }

  var pastSessions = [];
  function watchSessions(db) {
    try {
      db.collection('sessions').orderBy('endedAt', 'desc').limit(20).onSnapshot(function (snap) {
        pastSessions = snap.docs.map(function (d) { return d.data(); });
        renderPast();
      }, function () { /* list stays as it was */ });
    } catch (e) { /* no history list */ }
  }

  function renderSaveStatus(st) {
    var el = $('save-status');
    if (!el) return;
    el.textContent = st.label;
    el.dataset.tone = st.tone;
    el.title = st.pending ? st.pending + ' change' + (st.pending === 1 ? '' : 's') + ' waiting to sync' : '';
  }

  window.addEventListener('online', function () { store.kick(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') store.flushNow();
    else store.kick();
  });
  window.addEventListener('pagehide', function () { store.flushNow(); });

  // ---------- backup ----------

  function exportText() {
    return JSON.stringify({ app: 'poker-chip-ledger', exportedAt: new Date().toISOString(), state: state }, null, 2);
  }

  function copyGameData() {
    var text = exportText();
    var box = $('backup-box');
    function fallback() {
      box.value = text;
      box.focus();
      box.select();
      toast('Copy the selected text');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Game data copied'); }, fallback);
    } else {
      fallback();
    }
  }

  function restoreGameData() {
    var parsed;
    try { parsed = JSON.parse($('backup-box').value); } catch (e) { parsed = null; }
    var s = parsed && (parsed.state || parsed);
    if (!s || !Array.isArray(s.players) || !s.settings) {
      toast('Paste game data copied from this app first');
      return;
    }
    if (mutate(function () {
      archiveSession(state, 'replaced');
      state = s;
      state.sample = false;
      if (!state.sessionId) { state.sessionId = newId(); state.startedAt = Date.now(); }
    })) {
      $('backup-box').value = '';
      toast('Game restored');
    }
  }

  // A few hands already played, so the ledger shows how profit and loss read.
  function sampleState() {
    var s = newSession();
    s.sample = true;
    E.setBlinds(s, 10, 20);
    ['Asha', 'Ben', 'Carlos', 'Dee'].forEach(function (n) { E.addPlayer(s, n, 1000); });
    // Hand 1: Dee raises, Asha calls, Dee takes it down on the flop.
    E.startHand(s);
    E.act(s, 'raise', 60); E.act(s, 'call'); E.act(s, 'fold'); E.act(s, 'fold');
    E.act(s, 'raise', 80); E.act(s, 'fold');
    // Hand 2: three-way to showdown, Carlos wins.
    E.startHand(s);
    E.act(s, 'call'); E.act(s, 'fold'); E.act(s, 'call'); E.act(s, 'check');
    E.act(s, 'check'); E.act(s, 'raise', 40); E.act(s, 'call'); E.act(s, 'call');
    for (var i = 0; i < 6; i++) E.act(s, 'check');
    E.awardShowdownPot(s, 0, [s.players[2].id]);
    return s;
  }

  // ---------- mutations ----------

  function mutate(fn) {
    var before = JSON.stringify(state);
    var handBefore = state.hand ? state.hand.number : null;
    try {
      fn();
    } catch (err) {
      state = JSON.parse(before);
      toast(err.message);
      render();
      return false;
    }
    history.push(before);
    if (history.length > HISTORY_LIMIT) history.shift();
    ui.armed = null;
    if (handBefore != null && !state.hand && state.lastHand && state.lastHand.number === handBefore) recordHand(state);
    save();
    render();
    return true;
  }

  function undo() {
    if (!history.length) return;
    state = JSON.parse(history.pop());
    ui.picks = {};
    ui.raiseFor = null;
    ui.armed = null;
    save();
    render();
    toast('Undone');
  }

  var toastTimer;
  function toast(text) {
    var el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  // ---------- helpers ----------

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function n(x) { return fmt.format(x); }
  function signed(x) { return (x > 0 ? '+' : x < 0 ? '−' : '') + n(Math.abs(x)); }
  function name(id) { var p = E.getPlayer(state, id); return p ? esc(p.name) : '?'; }

  function badges(id, pos) {
    if (!pos) return '';
    var out = '';
    if (pos.dealerId === id) out += '<span class="badge badge-d" title="Dealer">D</span>';
    if (pos.sbId === id) out += '<span class="badge badge-sb" title="Small blind">SB</span>';
    if (pos.bbId === id) out += '<span class="badge badge-bb" title="Big blind">BB</span>';
    return out;
  }

  function currentPositions() {
    var h = state.hand;
    if (h) return { dealerId: h.dealerId, sbId: h.sbId, bbId: h.bbId };
    return E.nextPositions(state);
  }

  // ---------- render ----------

  function render() {
    renderBanner();
    renderFelt();
    renderAction();
    renderLedger();
    renderSettings();
    renderSettle();
    renderLog();
    renderPast();
    $('undo-btn').disabled = history.length === 0;
    var reset = $('reset-btn');
    reset.classList.toggle('armed', ui.armed === 'reset');
    reset.textContent = ui.armed === 'reset' ? 'Tap again to clear' : 'New session';
  }

  function renderBanner() {
    $('banner').innerHTML = state.sample
      ? '<div class="banner"><span>This is a <b>sample table</b> with two hands played. ' +
        'Start fresh to enter your own players.</span>' +
        '<button type="button" class="btn-primary btn-small" data-action="fresh">Start fresh</button></div>'
      : '';
  }

  function renderFelt() {
    var h = state.hand;
    var pos = currentPositions();
    var sbbb = n(state.settings.smallBlind) + ' / ' + n(state.settings.bigBlind);
    var html = '<div class="felt-head">';
    if (h) {
      var idx = h.street === 'showdown' ? 4 : E.STREETS.indexOf(h.street);
      html += '<span class="label">Hand #' + h.number + ' · Blinds ' + sbbb + '</span><div class="street-track">';
      E.STREETS.concat('showdown').forEach(function (s, i) {
        html += '<span class="' + (i < idx ? 'done' : i === idx ? 'now' : '') + '">' + s + '</span>';
      });
      html += '</div></div>';
      var L = E.legalActions(state);
      html += '<div class="pot"><span class="label">Pot</span><span class="pot-amount">' + n(E.potInPlay(h)) +
        '</span><span class="pot-sub">' + (h.currentBet ? 'Bet to match ' + n(h.currentBet) : (L ? 'No bet yet this round' : '&nbsp;')) +
        '</span></div>';
      html += '<div class="seats">';
      h.seats.forEach(function (id, i) {
        var hp = h.p[id];
        var p = E.getPlayer(state, id);
        var cls = 'seat' + (hp.folded ? ' folded' : '') + (i === h.toAct ? ' turn' : '');
        var tag = hp.folded ? '<span class="tag">fold</span>' : hp.allIn ? '<span class="tag tag-allin">all-in</span>' : '';
        html += '<div class="' + cls + '"><div class="seat-name">' + name(id) + badges(id, pos) + '</div>' +
          '<div class="seat-meta num">' + n(p.stack) + ' ' + tag + '</div>' +
          '<div class="seat-bet">' + (hp.bet ? 'bet ' + n(hp.bet) : '') + '</div></div>';
      });
      html += '</div>';
    } else {
      html += '<span class="label">Between hands · Blinds ' + sbbb + '</span>' +
        '<span class="label">' + state.handCount + ' hand' + (state.handCount === 1 ? '' : 's') + ' played</span></div>';
      var inPlay = state.players.reduce(function (s, p) { return s + p.stack; }, 0);
      html += '<div class="pot"><span class="label">Chips on the table</span><span class="pot-amount">' + n(inPlay) +
        '</span><span class="pot-sub">' + state.players.length + ' player' + (state.players.length === 1 ? '' : 's') + '</span></div>';
    }
    $('felt').innerHTML = html;
  }

  function raiseKey(L) {
    var h = state.hand;
    return h.number + ':' + h.street + ':' + L.playerId + ':' + L.currentBet;
  }

  function clampRaise(L, v) {
    return Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, Math.round(v)));
  }

  function renderAction() {
    var h = state.hand;
    var el = $('action');
    if (!h) { el.innerHTML = renderNextHand(); return; }
    if (h.street === 'showdown') { el.innerHTML = renderShowdown() + renderVoid(); return; }

    var L = E.legalActions(state);
    if (!L) { el.innerHTML = ''; return; }
    var key = raiseKey(L);
    if (ui.raiseFor !== key) { ui.raiseFor = key; ui.raiseTo = L.minRaiseTo; }

    var callLabel = L.canCheck ? 'Check' : (L.callAmount < L.toCall ? 'Call ' + n(L.callAmount) + ' all-in' : 'Call ' + n(L.callAmount));
    var html = '<div class="actor"><div><span class="label">To act</span><div class="actor-name">' + name(L.playerId) + '</div></div>' +
      '<div class="actor-facts"><span>Stack <b>' + n(L.stack) + '</b></span><span>In this round <b>' + n(L.bet) + '</b></span>' +
      '<span>To call <b>' + n(L.toCall) + '</b></span></div></div>';
    html += '<div class="act-row"><button type="button" class="btn-fold" data-action="fold">Fold<kbd>F</kbd></button>' +
      '<button type="button" class="btn-call" data-action="' + (L.canCheck ? 'check' : 'call') + '">' + callLabel + '<kbd>C</kbd></button></div>';

    if (L.canRaise) {
      var verb = L.isBet ? 'Bet' : 'Raise to';
      var potAfterCall = L.pot + L.toCall;
      var presets = [
        ['Min', L.minRaiseTo],
        ['½ pot', clampRaise(L, L.currentBet + potAfterCall / 2)],
        ['Pot', clampRaise(L, L.currentBet + potAfterCall)],
        ['All-in', L.maxRaiseTo]
      ];
      html += '<div class="raise"><div class="raise-presets">';
      presets.forEach(function (p) {
        html += '<button type="button" class="btn-small" data-action="preset" data-value="' + p[1] + '">' + p[0] + '</button>';
      });
      html += '</div><div class="raise-go"><div class="field"><label class="label" for="raise-input">' +
        (L.isBet ? 'Bet amount' : 'Raise to') + '<kbd>R</kbd></label>' +
        '<input type="number" id="raise-input" min="' + L.minRaiseTo + '" max="' + L.maxRaiseTo + '" step="1" inputmode="numeric" value="' + ui.raiseTo + '"></div>' +
        '<button type="button" class="btn-primary" data-action="raise" id="raise-btn">' + verb + ' ' + n(ui.raiseTo) + '</button></div>' +
        '<p class="hint">' + (L.isBet ? '' : 'Total for this round. ') + 'Minimum ' + n(L.minRaiseTo) + ', maximum ' + n(L.maxRaiseTo) + ' (all-in).</p></div>';
    } else if (L.stack > L.toCall) {
      html += '<p class="hint">Raising is closed: a short all-in did not reopen the betting.</p>';
    }
    el.innerHTML = html + renderVoid();
  }

  function renderVoid() {
    if (!ui.voidOpen) {
      return '<div class="void"><button type="button" class="btn-small" data-action="void-open">Misdeal or chop…</button></div>';
    }
    return '<div class="void"><p class="hint">Cancel this hand: every bet goes back to whoever made it.</p><div class="row-tools">' +
      '<button type="button" class="btn-small" data-action="void" data-keep="1">Misdeal: same dealer redeals</button>' +
      '<button type="button" class="btn-small" data-action="void" data-keep="0">Chop: button moves on</button>' +
      '<button type="button" class="btn-small" data-action="void-close">Keep playing</button></div></div>';
  }

  function sharesFor(potIndex) {
    var map = (ui.shares && ui.shares[potIndex]) || {};
    return function (id) { return map[id] || 1; };
  }

  function renderNextHand() {
    var pos = E.nextPositions(state);
    var html = '<div class="next-hand"><h2>Next hand</h2>';
    if (pos) {
      html += '<div class="next-pos">' +
        '<span><span class="badge badge-d">D</span>' + name(pos.dealerId) + '</span>' +
        (pos.sbId !== pos.dealerId ? '<span><span class="badge badge-sb">SB</span>' + name(pos.sbId) + ' posts ' + n(state.settings.smallBlind) + '</span>'
          : '<span><span class="badge badge-sb">SB</span>Dealer posts ' + n(state.settings.smallBlind) + '</span>') +
        '<span><span class="badge badge-bb">BB</span>' + name(pos.bbId) + ' posts ' + n(state.settings.bigBlind) + '</span></div>' +
        '<button type="button" class="btn-primary deal" data-action="deal">Deal hand #' + (state.handCount + 1) + '<kbd>D</kbd></button>';
    } else {
      html += '<p class="empty">Add at least two players with chips to deal a hand.</p>';
    }
    if (state.lastHand && state.lastHand.voided) {
      html += '<div class="last-hand">Hand #' + state.lastHand.number + ' was cancelled. All bets went back.</div>';
    } else if (state.lastHand) {
      var lh = state.lastHand;
      var winners = lh.awards.filter(function (a) { return a.amount > 0; });
      var paid = {};
      lh.contributions.forEach(function (c) { paid[c.id] = c.amount; });
      html += '<div class="last-hand">Hand #' + lh.number + ': ' + winners.map(function (a) {
        return '<b>' + name(a.id) + '</b> collected ' + n(a.amount) + ' (net ' + signed(a.amount - (paid[a.id] || 0)) + ')';
      }).join(', ') + '.</div>';
    }
    return html + '</div>';
  }

  function renderShowdown() {
    var h = state.hand;
    var html = '<div class="panel-head"><h2>Showdown</h2><span class="label">Tap the winner, or several to split</span></div>';
    var n0 = h.seats.length;
    var leftOfButton = function (a, b) {
      return ((h.seats.indexOf(a) - 1 + n0) % n0) - ((h.seats.indexOf(b) - 1 + n0) % n0);
    };
    var openCount = 0;
    h.pots.forEach(function (pot, i) {
      var title = h.pots.length === 1 ? 'Pot' : i === 0 ? 'Main pot' : 'Side pot ' + i;
      if (pot.winners) {
        var returned = pot.eligible.length === 1;
        html += '<div class="pot-card settled"><div class="pot-card-head"><span class="label">' + title +
          (returned ? ' · uncalled, returned' : '') + '</span><span class="num">' + n(pot.amount) + '</span></div>' +
          '<div>' + pot.winners.map(function (w) { return name(w.id) + ' +' + n(w.amount); }).join(', ') + '</div></div>';
        return;
      }
      openCount++;
      var picked = ui.picks[i] || [];
      html += '<div class="pot-card"><div class="pot-card-head"><span class="label">' + title + ' · ' +
        pot.eligible.length + ' players</span><span class="num">' + n(pot.amount) + '</span></div><div class="pick">';
      pot.eligible.forEach(function (id) {
        html += '<button type="button" data-action="pick" data-pot="' + i + '" data-id="' + id + '" aria-pressed="' +
          (picked.indexOf(id) >= 0) + '">' + name(id) + '</button>';
      });
      html += '</div>';
      var shareOf = sharesFor(i);
      var ordered = picked.slice().sort(leftOfButton);
      var parts = E.splitByShares(pot.amount, ordered.map(function (id) { return shareOf(id); }));
      var even = ordered.every(function (id) { return shareOf(id) === shareOf(ordered[0]); });
      if (picked.length > 1) {
        html += '<div class="shares"><p class="hint">Equal shares for a tie. For hi-lo, a quartered pot or run it twice, ' +
          'give more shares to whoever won more of this pot.</p>';
        ordered.forEach(function (id, k) {
          var sh = shareOf(id);
          html += '<div class="share-row"><span class="share-name">' + name(id) + '</span>' +
            '<span class="stepper"><button type="button" class="btn-small" data-action="share" data-delta="-1" data-pot="' + i +
            '" data-id="' + id + '"' + (sh <= 1 ? ' disabled' : '') + ' aria-label="Fewer shares for ' + name(id) + '">−</button>' +
            '<span class="num">' + sh + ' share' + (sh === 1 ? '' : 's') + '</span>' +
            '<button type="button" class="btn-small" data-action="share" data-delta="1" data-pot="' + i + '" data-id="' + id +
            '" aria-label="More shares for ' + name(id) + '">+</button></span>' +
            '<span class="num share-amt">' + n(parts[k]) + '</span></div>';
        });
        html += '</div>';
      }
      html += '<button type="button" class="btn-primary" data-action="award" data-pot="' + i + '"' +
        (picked.length ? '' : ' disabled') + '>' +
        (picked.length === 0 ? 'Pick a winner' : picked.length === 1 ? 'Award ' + n(pot.amount) + ' to ' + name(picked[0])
          : even ? 'Split ' + n(pot.amount) + ' (' + n(Math.floor(pot.amount / picked.length)) + ' each)'
            : 'Divide ' + n(pot.amount) + ' by shares') + '</button></div>';
    });
    if (!openCount) html += '<p class="empty">All pots settled.</p>';
    return html;
  }

  function renderLedger() {
    var h = state.hand;
    var pos = currentPositions();
    $('blinds-label').textContent = 'Blinds ' + n(state.settings.smallBlind) + ' / ' + n(state.settings.bigBlind);
    if (!state.players.length) {
      $('ledger').innerHTML = '<p class="empty">No players yet. Add everyone at the table below, with their buy-in.</p>';
      $('totals').innerHTML = '';
      return;
    }
    var html = '';
    var sorted = state.players.slice();
    sorted.forEach(function (p) {
      var hp = h && h.p[p.id];
      var net = E.net(p);
      var status = '';
      if (hp && hp.folded) status = '<span class="tag">folded</span>';
      else if (hp && hp.allIn) status = '<span class="tag tag-allin">all-in</span>';
      else if (h && !hp) status = '<span class="tag">not in hand</span>';
      if (p.sittingOut) status += '<span class="tag">sitting out</span>';
      else if (p.stack === 0 && !hp) status += '<span class="tag">busted</span>';
      var out = p.sittingOut || (p.stack === 0 && !hp);
      html += '<div class="ledger-row' + (out ? ' out' : '') + '">' +
        '<div class="who"><span class="who-name">' + esc(p.name) + '</span>' + badges(p.id, pos) + status + '</div>' +
        '<span class="pl ' + (net > 0 ? 'up' : net < 0 ? 'down' : 'even') + '" title="Profit / loss">' + signed(net) + '</span>' +
        '<div class="figures"><span>Stack <b>' + n(p.stack) + '</b></span><span>Bought in <b>' + n(p.buyIn) + '</b></span>' +
        (hp ? '<span>In pot <b>' + n(hp.total) + '</b></span>' : '') +
        '<button type="button" class="btn-small" data-action="tools" data-id="' + p.id + '" aria-expanded="' + (ui.openRow === p.id) + '">' +
        (ui.openRow === p.id ? 'Close' : 'Manage') + '</button></div>';
      if (ui.openRow === p.id) html += rowTools(p, hp);
      html += '</div>';
    });
    $('ledger').innerHTML = html;

    var stacks = 0, buyIns = 0, inPot = h ? E.potInPlay(h) : 0;
    state.players.forEach(function (p) { stacks += p.stack; buyIns += p.buyIn; });
    $('totals').innerHTML =
      '<div><span class="label">Bought in</span><span class="num">' + n(buyIns) + '</span></div>' +
      '<div><span class="label">In stacks</span><span class="num">' + n(stacks) + '</span></div>' +
      '<div><span class="label">In the pot</span><span class="num">' + n(inPot) + '</span></div>';
  }

  function rowTools(p, hp) {
    var h = state.hand;
    var canRebuy = !hp || hp.folded;
    var html = '<div class="row-tools">';
    if (canRebuy) {
      html += '<span class="rebuy"><input type="number" id="rebuy-' + p.id + '" min="1" step="1" inputmode="numeric" value="' +
        state.settings.defaultBuyIn + '" aria-label="Rebuy amount for ' + esc(p.name) + '">' +
        '<button type="button" class="btn-small" data-action="rebuy" data-id="' + p.id + '">Add chips</button></span>';
    }
    if (!hp) {
      html += '<button type="button" class="btn-small" data-action="sitout" data-id="' + p.id + '">' +
        (p.sittingOut ? 'Deal back in' : 'Sit out') + '</button>';
      if (!h && !p.sittingOut && p.stack > 0) {
        html += '<button type="button" class="btn-small" data-action="button" data-id="' + p.id + '">Give dealer button</button>';
      }
      var armed = ui.armed === 'remove-' + p.id;
      html += '<button type="button" class="btn-small btn-danger' + (armed ? ' armed' : '') + '" data-action="remove" data-id="' + p.id + '">' +
        (armed ? 'Tap again: cash out ' + n(p.stack) : 'Remove') + '</button>';
    } else if (!canRebuy) {
      html += '<span class="hint">Chips can be added after this hand.</span>';
    }
    return html + '</div>';
  }

  function renderSettings() {
    var s = state.settings;
    [['set-sb', s.smallBlind], ['set-bb', s.bigBlind], ['set-buyin', s.defaultBuyIn]].forEach(function (pair) {
      var input = $(pair[0]);
      if (document.activeElement !== input) input.value = pair[1];
    });
    var add = $('add-buyin');
    if (document.activeElement !== add && !add.dataset.touched) add.value = s.defaultBuyIn;
  }

  function renderSettle() {
    var transfers = E.settlement(state);
    var el = $('settle');
    if (!state.players.length) { el.innerHTML = '<p class="empty">Nothing to settle yet.</p>'; return; }
    var note = state.hand ? '<p class="hint">Chips in the current pot count once the hand is settled.</p>' : '';
    if (!transfers.length) { el.innerHTML = '<p class="empty">Everyone is even.</p>' + note; return; }
    el.innerHTML = '<ul class="settle">' + transfers.map(function (t) {
      return '<li><span>' + esc(t.from) + ' pays ' + esc(t.to) + '</span><span class="num">' + n(t.amount) + '</span></li>';
    }).join('') + '</ul>' + note;
  }

  function renderPast() {
    var panel = $('past-panel');
    panel.hidden = !pastSessions.length;
    if (!pastSessions.length) return;
    $('past').innerHTML = '<ul class="past">' + pastSessions.map(function (p) {
      var when = p.endedAt ? new Date(p.endedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
      var players = (p.players || []).slice().sort(function (a, b) { return b.net - a.net; });
      var note = p.reason === 'conflict' ? ' · copy kept from another device' : p.reason === 'replaced' ? ' · replaced' : '';
      return '<li><div class="past-head"><span>' + esc(when) + '</span><span class="label">' + (p.handCount || 0) +
        ' hands' + note + '</span></div><div class="past-nets num">' + players.map(function (x) {
          return '<span class="' + (x.net > 0 ? 'up' : x.net < 0 ? 'down' : '') + '">' + esc(x.name) + ' ' + signed(x.net) + '</span>';
        }).join('') + '</div></li>';
    }).join('') + '</ul>';
  }

  function renderLog() {
    var items = state.log.slice(-80).reverse();
    $('log').innerHTML = items.length ? items.map(function (e) {
      return '<li><span class="h">' + (e.hand ? '#' + e.hand : '') + '</span><span>' + esc(e.text) + '</span></li>';
    }).join('') : '<li><span></span><span class="empty">Actions will appear here.</span></li>';
  }

  // ---------- events ----------

  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    var action = btn.dataset.action;
    var id = btn.dataset.id ? Number(btn.dataset.id) : null;

    if (action !== 'reset' && action !== 'remove' && ui.armed) { ui.armed = null; }

    switch (action) {
      case 'undo': undo(); break;
      case 'export': copyGameData(); break;
      case 'restore': restoreGameData(); break;
      case 'reset':
        if (ui.armed !== 'reset') { ui.armed = 'reset'; render(); return; }
        archiveSession(state, 'ended');
        history.push(JSON.stringify(state));
        state = newSession(state.settings);
        ui = { raiseTo: null, raiseFor: null, picks: {}, shares: {}, voidOpen: false, openRow: null, armed: null };
        save(); render(); toast('New session started');
        break;
      case 'fresh':
        mutate(function () { state = newSession(state.settings); });
        ui.openRow = null;
        $('add-name').focus();
        break;
      case 'deal':
        ui.picks = {};
        ui.shares = {};
        ui.voidOpen = false;
        mutate(function () { E.startHand(state); });
        break;
      case 'fold': case 'check': case 'call':
        mutate(function () { E.act(state, action); });
        break;
      case 'preset': {
        ui.raiseTo = Number(btn.dataset.value);
        render();
        break;
      }
      case 'raise': {
        var v = Number($('raise-input').value);
        mutate(function () { E.act(state, 'raise', v); });
        break;
      }
      case 'pick': {
        var pot = Number(btn.dataset.pot);
        var list = (ui.picks[pot] || []).slice();
        var at = list.indexOf(id);
        if (at >= 0) list.splice(at, 1); else list.push(id);
        ui.picks[pot] = list;
        render();
        break;
      }
      case 'share': {
        var sp = Number(btn.dataset.pot);
        ui.shares = ui.shares || {};
        var m = ui.shares[sp] = ui.shares[sp] || {};
        m[id] = Math.max(1, (m[id] || 1) + Number(btn.dataset.delta));
        render();
        break;
      }
      case 'award': {
        var potIdx = Number(btn.dataset.pot);
        var winners = ui.picks[potIdx] || [];
        var shareOf = sharesFor(potIdx);
        var shares = winners.map(function (w) { return shareOf(w); });
        if (mutate(function () { E.awardShowdownPot(state, potIdx, winners, shares); })) {
          if (!state.hand) { ui.picks = {}; ui.shares = {}; ui.voidOpen = false; }
        }
        break;
      }
      case 'void-open': ui.voidOpen = true; render(); break;
      case 'void-close': ui.voidOpen = false; render(); break;
      case 'void': {
        var keep = btn.dataset.keep === '1';
        ui.voidOpen = false;
        ui.picks = {};
        ui.shares = {};
        if (mutate(function () { E.voidHand(state, keep); })) toast(keep ? 'Misdeal: bets returned' : 'Hand chopped: bets returned');
        break;
      }
      case 'tools':
        ui.openRow = ui.openRow === id ? null : id;
        render();
        break;
      case 'rebuy': {
        var amt = $('rebuy-' + id).value;
        if (mutate(function () { E.rebuy(state, id, amt); })) toast('Chips added');
        break;
      }
      case 'sitout': {
        var pl = E.getPlayer(state, id);
        mutate(function () { E.setSittingOut(state, id, !pl.sittingOut); });
        break;
      }
      case 'button':
        mutate(function () { E.setButton(state, id); });
        break;
      case 'remove':
        if (ui.armed !== 'remove-' + id) { ui.armed = 'remove-' + id; render(); return; }
        ui.openRow = null;
        mutate(function () { E.removePlayer(state, id); });
        break;
    }
  });

  document.addEventListener('input', function (ev) {
    var t = ev.target;
    if (t.id === 'raise-input') {
      ui.raiseTo = Number(t.value) || 0;
      var L = E.legalActions(state);
      var btn = $('raise-btn');
      if (btn && L) btn.textContent = (L.isBet ? 'Bet ' : 'Raise to ') + n(ui.raiseTo);
    }
    if (t.id === 'add-buyin') t.dataset.touched = '1';
  });

  // Desktop shortcuts: F fold, C check/call, R raise amount, A all-in, D deal, Ctrl+Z undo.
  document.addEventListener('keydown', function (ev) {
    var t = ev.target;
    if (ev.key === 'Enter' && t.id === 'raise-input') {
      ev.preventDefault();
      $('raise-btn').click();
      return;
    }
    if (ev.key === 'Escape' && t.id === 'raise-input') { t.blur(); return; }
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
    if (typing || ev.altKey) return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      undo();
      return;
    }
    if (ev.ctrlKey || ev.metaKey) return;
    var click = function (sel) { var b = document.querySelector(sel); if (b && !b.disabled) { ev.preventDefault(); b.click(); } };
    switch (ev.key.toLowerCase()) {
      case 'f': click('[data-action=fold]'); break;
      case 'c': click('[data-action=call], [data-action=check]'); break;
      case 'd': click('[data-action=deal]'); break;
      case 'a': {
        var presets = document.querySelectorAll('[data-action=preset]');
        if (presets.length) { ev.preventDefault(); presets[presets.length - 1].click(); $('raise-input').focus(); }
        break;
      }
      case 'r': {
        var input = $('raise-input');
        if (input) { ev.preventDefault(); input.focus(); input.select(); }
        break;
      }
    }
  });

  $('add-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var nameInput = $('add-name');
    var buyIn = $('add-buyin');
    var ok = mutate(function () {
      E.addPlayer(state, nameInput.value, buyIn.value);
      state.sample = false;
    });
    if (ok) {
      nameInput.value = '';
      delete buyIn.dataset.touched;
      buyIn.value = state.settings.defaultBuyIn;
      nameInput.focus();
    }
  });

  $('settings-form').addEventListener('change', function () {
    var sb = $('set-sb').value;
    var bb = $('set-bb').value;
    var buyIn = $('set-buyin').value;
    mutate(function () {
      E.setBlinds(state, sb, bb);
      var b = Number(buyIn);
      if (!(b > 0) || Math.floor(b) !== b) throw new Error('Default buy-in must be a whole number above 0.');
      state.settings.defaultBuyIn = b;
    });
  });
  $('settings-form').addEventListener('submit', function (ev) { ev.preventDefault(); });

  load();
  render();
  connectCloud();
})();
