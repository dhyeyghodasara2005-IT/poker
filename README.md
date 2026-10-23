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
- **Uneven splits.** Give winners more or fewer shares of a pot. This covers hi-lo
  games (high half and low half, including quartered pots) and running it twice.
- **Misdeal or chop.** Cancel a hand and every bet goes back to whoever made it.
  On a misdeal the same dealer redeals; on a chop the button moves on.
- **Short stacks.** A big blind who is all-in for less than the blind still sets
  the bet at the full big blind. A player facing only all-in opponents is asked to
  call only what is needed to match them.
- **Profit and loss.** Shown for every player as stack − total bought in. Totals
  confirm that no chips went missing.
- **Settle up.** The fewest payments needed to square everyone up.
- **Hand log and undo.** Every action is logged. Undo steps back through the
  last 100 changes.
- **Phone and computer.** On a phone, the action buttons fit on the first screen
  and are sized for thumbs. On a computer there are keyboard shortcuts: `D` deal,
  `F` fold, `C` check/call, `R` type a raise, `A` all-in amount, `Ctrl+Z` undo.

## Saving: nothing gets lost

Every change is saved on the device at once (localStorage). The status pill in
the header always shows where the game is saved.

When the app runs as the published claude.ai page, it also mirrors everything to
the page's database:

| Record | What it holds |
| --- | --- |
| `games/current` | The live game. It syncs between devices: open the page on a phone and a laptop, and the newer change wins. |
| `hands/<session>_<n>` | One permanent record per finished hand: who paid what, who won, stacks after, and the action log |
| `sessions/<session>` | Final results and full state of each session, saved when you tap "New session". These appear under **Past sessions**. |

Hand and session records go through an outbox that is also saved on the
device. If you're offline, or the tab closes before they are sent, they're sent
the next time the page opens. Failed writes retry with backoff, and also when
the connection comes back or the tab becomes visible. If two devices both
change the same game, the older copy is kept as a session record, not
thrown away.

**Backup** copies the whole game as text, and can restore it from pasted text.
This is useful for the local version, which has no database.

## Run it

There's no build step. Open `index.html` in a browser, or serve the folder:

```sh
npm start        # serves the folder at http://localhost:3000
```

## Tests

The game rules (`engine.js`) and the storage layer (`store.js`) are tested with
Node's built-in test runner. The storage tests use a fake database that can go
offline.

```sh
npm test
```

## Files

| File | Purpose |
| --- | --- |
| `engine.js` | Seats, blinds, betting rounds, side pots, payouts, settlement |
| `store.js` | Saving: device storage, cloud sync, outbox and retries |
| `app.js` | UI rendering and event handling |
| `styles.css` | Styles (light and dark themes) |
| `index.html` | Page shell |
