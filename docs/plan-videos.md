# Launch videos: the promo and the explainer

Two 16:9 videos for X (@CockFightSol), the pump.fun coin page and the site, cut from real
website and game footage. Everything is scripted and rendered by code so it can be re-shot in an
hour when the art, the numbers or the coin change (the site runs on the test coin today).

Decisions Sammy made (2026-09-26): 16:9 for X only; AI voice from Higgsfield (never ElevenLabs);
all footage scripted on the Mac; fully automated ffmpeg edit; fight-game-trailer tone; generated
music; live dollar amounts hidden, mechanics shown; gritty fight-announcer voice.

## Deliverables

| File | Length | Spec | Use |
|---|---|---|---|
| `promo.mp4` | 30 s | 1920×1080, 60 fps, H.264 high, AAC | launch tweet, pinned, coin page |
| `explainer.mp4` | 75–90 s | 1920×1080, 30 fps, VO + burned captions, `.srt` too | "how it works" tweet, `/how-it-works`, replies to "how do I get paid?" |
| `promo-loop.mp4` (free by-product) | 10 s | silent loop | site hero / stream idle |

Output lands in `Claude outputs/video/` (git-ignored); the rig lives in `tools/video/` on branch
`launch-videos` (one PR, Sammy merges).

## How the footage is made

**Frame-stepped capture, not screen recording.** `/play?mode=2p&manual=1&debug=1&seed=…` exposes
`__cockfight.fight.setInput(p, mask)` and `stepTicks(n)`. The rig (Playwright, headed Chromium on
the Mac's GPU, 1920×1080, `quality=high`) steps one tick, grabs one PNG, repeats. That gives:

- true 60 fps with no dropped frames, and free slow-motion (render every tick, play at 24 fps =
  2.5×; the slam and the KO get this);
- choreographed fights: both players' buttons are scripted, so each shot is a beat (dash-in peck,
  shove, slam launch, dive kick, ring-out, super KO) instead of hoping the CPU does something;
- an event log per tick (hits, KO, round) that the edit uses to place SFX and cuts on the impact
  frame. The game's own sounds from `apps/web/public/audio` are laid back in at those ticks, so the
  trailer sounds like the game even though capture is silent.

Same rig, other pages: front page with the live pool (amount masked in the edit), `/play` mode
select, wallet gate + tier badge, queue "searching…", `/leaderboard` with the countdown,
`/how-it-works`, the result screen with the payout link, a replay page, and a 390×844 phone
viewport with touch controls composited into a phone frame.

Title cards are HTML in `tools/video/cards/` using the site's display font and `chrome-text`,
captured at 1080p, animated in ffmpeg (punch-in, shake, xfade). Nothing is drawn twice.

## Audio

- Music: Higgsfield text-to-music, 2–3 candidates per video (30 s trailer: industrial / drum-heavy,
  a drop at 0:08 and a stinger at 0:28; explainer: low, driving, VO-friendly). Sammy picks.
- Voice: Higgsfield TTS, MiniMax or Seed Speech engine, 2 "gritty announcer" takes to choose from.
  Sammy can swap in his own read later without touching the cut (same timing markers).
- SFX: the game's hit / KO / UI sounds, plus a couple of generated impacts for the logo slams.
- Mix: VO −16 LUFS-ish with music ducked under it; final loudness −14 LUFS for X.

## Promo, 30 s, beat sheet

| Time | Picture | Text on screen | Sound |
|---|---|---|---|
| 0–2 | black → chrome COCKFIGHT logo slams in with shake | | metallic clank |
| 2–8 | three matches, one hit each, cut on impact: peck, shove, dash-in | | hits, music starts |
| 8–12 | slam launch at 2.5× slow-mo, arena lights | 1v1. ROBOT CHICKENS. | whoosh, drop |
| 12–16 | phone viewport, thumbs-on-controls framing, a dive kick | PLAY FROM YOUR PHONE. | |
| 16–20 | ring-out → K.O. HUD → result screen, payout link (amount masked) | WIN. GET PAID IN SECONDS. | KO sting |
| 20–24 | front page live pool ticking (masked), leaderboard countdown | HOLD $COCK TO PLAY. WINNERS SPLIT THE FEES. | |
| 24–28 | super KO at slow-mo → hard cut to logo | | stinger |
| 28–30 | end card | cockfightsol.fun · @CockFightSol · HOLD $COCK. GET PAID. | |

## Explainer, ~80 s, VO script (from `/how-it-works`, which is the canonical wording)

1. **Hook (0–6)** KO clip. "This is COCKFIGHT. One-v-one robot chickens, in your browser, on your
   phone. Win the fight, get paid."
2. **Where the money comes from (6–24)** animated 3 % → 70 / 30 split card (no pump.fun footage).
   "$COCK trades on pump.fun. Every buy and sell pays a three percent creator fee. Seventy percent of
   every fee goes to players: fifty to the fight pool, twenty to the daily top ten. The rest runs the
   game. No tickets. No wagers. Nothing is ever taken from a player."
3. **How to play (24–40)** gate → queue → match. "Hold thirty dollars of $COCK. Connect your wallet.
   Hit ranked, and you're matched with someone in your tier in seconds."
4. **How a win is paid (40–54)** result screen, tx link, pool page. "Knock them out and the prize
   lands in your wallet within seconds, with the transaction right on the screen. Prizes float with
   the fees: more volume, bigger wins. The game can never promise more than the fees brought in."
5. **Tiers (54–66)** Rust / Chrome / Gold card. "Rust, thirty dollars, plays for the base prize.
   Chrome, two-fifty, pays two and a half times. Gold, a thousand, pays six times. Everyone draws from
   one pool, so nobody can grind it dry."
6. **Daily top 10, seed, fair play (66–80)** leaderboard countdown, replay page. "At midnight UTC,
   twenty percent of the day's fees goes to the top ten. A seed wallet lifts quiet days and can never
   drain faster than a fourteenth a day. Every match has a replay. Every payout is on the ledger."
7. **CTA (80–86)** end card. "cockfightsol dot fun. Hold $COCK. Fight."

## Status (2026-09-26): final

Both videos are signed off by Sammy (cut 3): `Claude outputs/video/promo.mp4` (30.4 s, 1080p60, cut to
his Suno spot "Hold Cock") and `explainer.mp4` (1:40, 1080p30, captions + `.srt`, his Suno bed
"Midrange Empty" ducked under the voice). Voice: Higgsfield's ElevenLabs engine, preset Gideon,
with "Cockfight" spelled as a word in the spoken copy (all caps read as "cock fit"). Music and VO
takes live in `Claude outputs/video/{music,vo}/` (git-ignored, on the Mac); the Suno prompts are in
`Claude outputs/video/music/SUNO-PROMPTS.md`. The payout card is still the staged one: re-shoot it
from a real ranked match after the live payout test (`video:online`) and rebuild.

## Work plan

1. `tools/video/capture.ts`: the rig (page → tick loop → PNG sequence + `events.json`), shot list as
   data (`shots.json`: url, viewport, script of inputs per tick, ticks to render, slow-mo factor).
2. Shoot: the six fight beats, the site tour, the phone shots. Contact sheet for review.
3. Cards: logo, five promo titles, split diagram, tier card, end card.
4. Audio: music candidates, two VO takes, SFX list → Sammy picks (one message).
5. `tools/video/build.ts`: EDL in JSON → ffmpeg filtergraph → `promo.mp4`, `explainer.mp4` (+ srt).
6. Review cut 1 → notes → cut 2. Re-shoot is one command once the real coin exists.

## Decided by Sammy (2026-09-26)

- **Tagline:** "HOLD $COCK. GET PAID." (payouts are in PUMP, so no "win SOL" on screen).
- **The payout shot:** staged now (masked amount, real-looking tx link); re-shot from the real match
  after the live payout test.
- **pump.fun:** not on screen. The 3 % → 70 / 30 card and the VO carry that section.
