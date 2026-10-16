# Poker Chip Ledger

A chip tracker for home poker games, played with real cards. You enter each
player's action (fold, check, call, bet/raise, all-in) and the app moves the
chips. It also handles blinds, side pots and payouts, and shows each player's
profit or loss.

## Features

- **Players and buy-ins.** Add players with any buy-in. Add chips (rebuys) later,
  sit players out, or remove them, which cashes them out.
- **Blinds that rotate.** The dealer button moves one seat after every hand, and
  the small and big blinds follow it. Heads-up uses the correct rule: the dealer
  posts the small blind and acts first before the flop. You can also hand the
  button to any player.
- **Betting rounds.** Preflop, flop, turn and river, with the right player to act.
  Buttons show the exact call amount. Minimum raises are enforced, and the big
  blind gets the option. A short all-in does not reopen raising.
- **Raise presets.** Min, ½ pot, pot and all-in, or type any amount.
- **Side pots.** Built automatically when players are all-in for different
  amounts. Uncalled bets go back to the bettor.
- **Showdown.** Tap the winner of each pot, or several players to split it. Odd
  chips go to the first winner left of the button.
- **Profit and loss.** Shown for every player as stack − total bought in. Totals
  confirm that no chips went missing.
- **Settle up.** The fewest payments needed to square everyone up.
- **Hand log and undo.** Every action is logged. Undo steps back through the
  last 100 changes.
- Saves in the browser automatically (localStorage). Works on a phone.

## Run it

There's no build step. Open `index.html` in a browser, or serve the folder:

```sh
npm start        # serves the folder at http://localhost:3000
```

## Tests

The game rules live in `engine.js` as pure functions, and `tests/engine.test.js`
tests them.

```sh
npm test
```

## Files

| File | Purpose |
| --- | --- |
| `engine.js` | Seats, blinds, betting rounds, side pots, payouts, settlement |
| `app.js` | UI rendering and event handling |
| `styles.css` | Styles (light and dark themes) |
| `index.html` | Page shell |
