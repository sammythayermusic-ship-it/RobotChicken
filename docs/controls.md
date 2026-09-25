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

## Touch (phones and tablets)

The on-screen buttons show on any touch screen (or with `/play?touch=1`) and play P1 against the CPU.
They make exactly the keyboard's bits, so every move below works the same way.

| Button | Keyboard equivalent | Notes |
|---|---|---|
| D-pad ◀ ▶ | ← → | Walk; double-tap (or rock the thumb back through the middle and out again) to dash. |
| D-pad ▼ (hold) | ↓ | Block. Diagonals work (▼▶ is ↓ + →). |
| D-pad ▲ | ↑ | Jump (the context button is easier). |
| PECK | Space | Every tap is one press. Toward + PECK shoves, ▼ + PECK slams. Reads **SUPER** when the meter is full, the pad is neutral and you're on the ground. |
| JUMP / SLAM / DIVE | ↑ / ↓ + Space / Space in the air | JUMP on the ground (hold to keep jumping); **SLAM** when ▼ is held as the thumb lands; **DIVE** in the air (pressed early in a jump, it waits for the dive). The label shows what a press will do and holds until you let go. |
| Timer (top middle) | Esc / P | Pause. Upright, the PAUSE and SOUND pills on the panel pause and mute. |

Upright, the fight sits on top and the controller panel below; the whole left half of the panel is the
d-pad and the right half presses whichever button is nearer. Sideways, the buttons sit see-through in
the bottom corners and the camera keeps the fighters' feet above them.

## Moves

| Move | Input | Frames (startup / active / recovery @ 60 Hz) | Notes |
|---|---|---|---|
| Peck | PECK (also away + PECK) | 4 / 2 / 8 | +5 on hit, −1 on block. On hit (not on block), PECK again with no direction in frames 5–10 cancels into the super if the meter is full. |
| Shove | toward + PECK | 8 / 3 / 16 | Pushes 2 units (1 on block). Can ring out: it rings out a defender hit more than 8 units from the centre. |
| Ground slam | ↓ + PECK | 14 / 4 / 22 | Unblockable, grounded targets only (jump it). Launches → knockdown. Can ring out. |
| Dive kick | PECK in the air | 6 hover, active until landing, 24 landing recovery | 45° dive. Unblockable. Once per jump, from the 14th air tick (near the top of the jump); PECK pressed earlier in the rise waits for it. |
| Rooster Rocket (super) | PECK with full Heat and no direction held (↑ too) | 10 / 6 / 30 | Screen-wide, 30% damage, invulnerable frames 1–16, blockable (10% chip), can ring out. Costs the whole meter. With full Heat, away + PECK is still a peck and keeps the meter. |
| Dash | double-tap ← or → within 12 ticks | 12 total, invulnerable 3–6 | Back dash is shorter. Works while holding the other direction. |
| Jump | ↑ | 36 airborne ticks | Hold toward/away as you jump to jump that way; the arc is fixed (no air control). |
| Block | hold ↓ | | Blocks peck, shove and super (10% chip). Not slam or dive kick. |

- **Buffer:** PECK is remembered for 5 ticks (so it can be pressed a little early), together with the
  directions held when it was pressed: toward + PECK tapped late in another move still comes out as a shove.
- **Knockdown:** 40 ticks down, a 20-tick get-up, then 2 more invulnerable ticks once you can act, so a jump
  or dash out can't be beaten by a perfectly timed attack.
- **Heat:** +8 per hit landed, +3 per hit blocked, −1 per second, stays full once full. Resets each round.
- **Ring-outs** only happen when a shove, slam or super carries you past the edge; you can't walk off.
