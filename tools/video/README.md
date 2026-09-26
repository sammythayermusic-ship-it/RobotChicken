# tools/video — the launch videos

Everything here renders the promo and the explainer from the real site and game. Plan, beat
sheets and the VO script: `docs/plan-videos.md`.

```
pnpm --filter @cockfight/tools video:capture            # every shot (fights at 4K, ~40 min)
pnpm --filter @cockfight/tools video:capture slam brawl  # some shots
VIDEO_DRY=1 pnpm --filter @cockfight/tools video:capture slam   # step + log only: tune a script in 2 s
pnpm --filter @cockfight/tools video:capture sounds     # the game's sounds → <out>/sfx/*.wav
pnpm --filter @cockfight/tools video:online             # queue / result shots on the local open-mode stack (`pnpm dev`)
pnpm --filter @cockfight/tools video:build promo        # → <out>/promo.mp4
pnpm --filter @cockfight/tools video:build explainer    # → <out>/explainer.mp4 + .srt
```

`<out>` is `Claude outputs/video/` (git-ignored). `VIDEO_BASE_URL` picks the site (default
https://cockfightsol.fun); `VIDEO_OUT` moves the output.

- `rig.ts`: the browser, the tick loop, stills, live captures, cards, the sound export.
- `shots.ts`: the shot list; fight scripts run in the page and return both masks per tick.
- `cards/`: the title cards (HTML, the site's faces, CSS animations stepped by the rig).
- `edl.ts`: the two edits as data. `build.ts` renders them with ffmpeg.
- Inputs the build expects under `<out>`: `vo/vo-*.wav` (the Higgsfield takes), `music/promo.*` and
  `music/explainer.*` (optional; ducked under the VO), `fonts/Barlow-SemiBold.ttf` (captions).
