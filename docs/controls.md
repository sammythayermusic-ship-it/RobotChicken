# Controls

The sim reads a 5-button mask per player: ← → ↑ ↓ and PECK. Everything else is a combination.

## Keyboard

| Action | vs CPU (spec) | Also | 2P: P1 (left) | 2P: P2 (right) |
|---|---|---|---|---|
| Walk | ← → | A D | A D | ← → |
| Jump | ↑ | W | W | ↑ |
| Block (hold) | ↓ | S | S | ↓ |
| Peck | Space | J | Space / F | / . Enter Numpad0 |
| Pause | Esc / P | | Esc / P | Esc / P |

Ctrl, Cmd, Alt and Shift are never bound (Cmd+W would close the tab; Shift ×5 opens Sticky Keys on Windows).
The Controls panel on `/play` has a key tester: cheap laptop keyboards can't register some key
combinations at once ("ghosting"); if a key doesn't light up while the other player holds theirs,
use the alternate key.

## Moves

| Move | Input | Frames (startup / active / recovery @ 60 Hz) | Notes |
|---|---|---|---|
| Peck | PECK | 4 / 2 / 8 | +5 on hit, −1 on block. On hit, cancels into shove or super (frames 5–10). |
| Shove | toward + PECK | 8 / 3 / 16 | Pushes 2 units. Can ring out. |
| Ground slam | ↓ + PECK | 14 / 4 / 22 | Unblockable, grounded targets only. Launches → knockdown. Can ring out. |
| Dive kick | PECK in the air | 6 hover, active until landing, 14 landing recovery | 45° dive. Unblockable. Once per jump, from 4 air ticks and 0.9 units high. |
| Rooster Rocket (super) | PECK standing still with full Heat | 10 / 6 / 30 | Screen-wide, 30% damage, invulnerable frames 1–16, blockable (10% chip), can ring out. Costs the whole meter. |
| Dash | double-tap ← or → within 12 ticks | 12 total, invulnerable 3–6 | Back dash is shorter. |
| Jump | ↑ | 36 airborne ticks | Hold toward/away to drift. |
| Block | hold ↓ | | Blocks peck, shove and super (10% chip). Not slam or dive kick. |

Heat: +8 per hit landed, +3 per hit blocked, −1 per second, stays full once full. Resets each round.
Ring-outs only happen when a shove, slam or super carries you past the edge; you can't walk off.
