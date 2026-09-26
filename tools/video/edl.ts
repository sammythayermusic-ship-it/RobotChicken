/**
 * The edit, as data. Times are seconds on the output timeline; frames index
 * the captured shots (see each shot's events.json). Sources are the 2× fight
 * captures (3840×2160 @ 60), stills, alpha card sequences and the online
 * stills. `zoom` is a punch-in on the source (1 = full frame) centred at
 * (cx, cy) in 0..1; `speed` retimes (0.4 = 2.5× slow motion).
 */
export interface Zoom { scale: number; cx?: number; cy?: number; /** drift the centre over the segment */ to?: { scale?: number; cx?: number; cy?: number } }
export interface Overlay { card: string; /** seconds into the segment */ at: number; /** fade out this many seconds before the segment ends (0 = hold) */ outFade?: number }
export interface Fade { in?: number; out?: number }
/** `vo`: start this VO take (index into Edit.vo) when the segment starts. */
export type Segment = { vo?: number } & (
  | { kind: "clip"; shot: string; in: number; out: number; speed?: number; zoom?: Zoom; overlays?: Overlay[]; fade?: Fade; /** phone captures: framed on the pit background */ phone?: boolean; sfx?: boolean; crowd?: boolean }
  | { kind: "still"; file: string; dur: number; zoom?: Zoom; overlays?: Overlay[]; fade?: Fade; /** vertical pan on a tall page, in source px: from y to y */ pan?: { from: number; to: number; height?: number }; phone?: boolean; cover?: { x: number; y: number; w: number; h: number }[]; blur?: { x: number; y: number; w: number; h: number }[] }
  | { kind: "card"; card: string; dur: number; fade?: Fade; /** frames of the sequence to play before holding (default all) */ }
  | { kind: "black"; dur: number }
);

export interface Cue { t: number; file: string; gain?: number; pan?: number }
/** `t` is absolute, or omitted when a segment carries the VO's index in `vo`. */
export interface Vo { t?: number; file: string; gain?: number; text?: string }
export interface Edit {
  name: string;
  fps: number;
  segments: Segment[];
  /** extra sounds (impacts, stingers) on top of the per-tick game cues */
  cues: Cue[];
  vo: Vo[];
  /** music file (in <out>/music) if present; ducked under the VO */
  music?: { file: string; gain: number; duck: boolean };
  /** scales every game sound and cue (under a full song the hits sit lower) */
  sfxGain?: number;
  captions?: boolean;
}


/*
 * The promo is cut to Sammy's 30.4 s Suno spot "Hold Cock" (152 BPM, downbeats at
 * 0.44 + n·1.579 s). Structure from the timed transcript: "FIGHT" chant 0–1.4, verse 1.4–7.7
 * ("peck, shove, slam, dive kick" at 6.2–7.5), hook 7.7–13.9 ("paid in seconds" 12.2–13.3),
 * verse 2 13.9–20.6 ("Rooster Rocket… K.O." 17.4–19.6), instrumental outro to 30.4.
 * Each segment's frame count is chosen so the cuts land on those words.
 */
export const PROMO: Edit = {
  name: "promo",
  fps: 60,
  segments: [
    { kind: "black", dur: 0.44 },
    // downbeat 0.44: logo slam under the FIGHT chant, to 2.02
    { kind: "card", card: "card-logo", dur: 1.58, fade: { out: 0.06 } },
    // "Robot chickens in the junkyard pit" 2.02–3.60: a wide brawl (hit at +0.5 s)
    { kind: "clip", shot: "brawl", in: 20, out: 115, zoom: { scale: 1.15, cx: 0.5, cy: 0.6 }, sfx: true, crowd: true },
    // "Hold the coin, that's the ticket" 3.60–5.18: the phone
    { kind: "clip", shot: "phone-brawl", in: 60, out: 155, phone: true, overlays: [{ card: "card-t-phone", at: 0.15, outFade: 0.2 }], sfx: true, crowd: true },
    // "No buy-in, no bet, just the fight" 5.18–6.24: dash in, peck (hit at 5.91)
    { kind: "clip", shot: "dash-peck", in: 0, out: 64, zoom: { scale: 1.3, cx: 0.45, cy: 0.62 }, sfx: true, crowd: true },
    // "PECK / SHOVE / SLAM / DIVE KICK" 6.24–7.50: four impacts, 19 frames each, impact 8 frames in
    { kind: "clip", shot: "peck", in: 47, out: 66, zoom: { scale: 1.4, cx: 0.5, cy: 0.62 }, sfx: true, crowd: true },
    { kind: "clip", shot: "shove", in: 72, out: 91, zoom: { scale: 1.35, cx: 0.42, cy: 0.62 }, sfx: true, crowd: true },
    { kind: "clip", shot: "slam", in: 76, out: 95, zoom: { scale: 1.4, cx: 0.55, cy: 0.6 }, sfx: true, crowd: true },
    { kind: "clip", shot: "dive-kick", in: 50, out: 69, zoom: { scale: 1.3, cx: 0.55, cy: 0.55 }, sfx: true, crowd: true },
    // "goodnight" → hook "HOLD COCK get paid" 7.50–9.92: the slam in slow motion, 1v1 title
    { kind: "clip", shot: "slam", in: 70, out: 128, speed: 0.4, zoom: { scale: 1.5, cx: 0.55, cy: 0.6, to: { scale: 1.35 } }, overlays: [{ card: "card-t-1v1", at: 0.6, outFade: 0.2 }], sfx: true, crowd: true },
    // hook cont. 9.92–11.50: ring-out (over the edge at 10.75)
    { kind: "clip", shot: "ring-out", in: 170, out: 265, zoom: { scale: 1.2, cx: 0.7, cy: 0.6 }, sfx: true, crowd: true },
    // "win the fight… paid in seconds, no delay" 11.50–13.88: the result card
    { kind: "still", file: "online/result-paid.png", dur: 2.38, zoom: { scale: 2.5, cx: 0.5, cy: 0.82, to: { scale: 2.3 } }, overlays: [{ card: "card-t-paid", at: 0.3, outFade: 0.2 }], fade: { in: 0.06 } },
    // "Three percent fee… Rust, Chrome, Gold" 13.88–17.36: the site
    { kind: "still", file: "home/still.png", dur: 3.48, zoom: { scale: 1.75, cx: 0.5, cy: 0.2, to: { cy: 0.25 } }, cover: [{ x: 2730, y: 20, w: 320, h: 70 }], overlays: [{ card: "card-t-hold", at: 0.2, outFade: 0.2 }], fade: { in: 0.06 } },
    // "Rooster Rocket when the Heat hits red" 17.36–19.00: heat full (18.5), rocket
    { kind: "clip", shot: "super-ko", in: 543, out: 641, zoom: { scale: 1.25, cx: 0.75, cy: 0.6 }, sfx: true, crowd: true },
    // "K.O. — check your wallet — enough said" 19.00–22.56: the hit and the KO in slow motion
    { kind: "clip", shot: "super-ko", in: 641, out: 716, speed: 0.35, zoom: { scale: 1.45, cx: 0.75, cy: 0.55, to: { scale: 1.2, cx: 0.7 } }, sfx: true, crowd: true, fade: { out: 0.12 } },
    // outro 22.56–30.40: end card; the tag lands on the downbeat at 24.14
    { kind: "card", card: "card-end", dur: 7.84 },
  ],
  cues: [
    { t: 0.44, file: "impact", gain: 0.9 },
    { t: 0.44, file: "hit_slam", gain: 0.8 },
  ],
  vo: [{ t: 24.14, file: "vo-8.wav", gain: 1 }],
  music: { file: "promo", gain: 1.0, duck: false },
  sfxGain: 0.7,
};

/* The explainer: VO drives the timing. Starts are measured from the takes. */
const VO = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ i }));
const VO_TEXT: Record<number, string> = {
  0: "This is COCKFIGHT. One-v-one robot chickens, in your browser, on your phone. | Win the fight. Get paid.",
  1: "$COCK trades on pump.fun. Every buy and sell pays a 3% creator fee. | 70% of every fee goes to players: 50% to the fight pool, 20% to the daily top ten. | The rest runs the game. No tickets. No wagers. | Nothing is ever taken from a player.",
  2: "Hold $30 of $COCK. Connect your wallet. | Hit ranked, and you're matched with someone in your tier in seconds.",
  3: "Knock them out, and the prize lands in your wallet within seconds, | with the transaction right on the screen. | Prizes float with the fees: more volume, bigger wins. | The game can never promise more than the fees brought in.",
  4: "Rust, $30, plays for the base prize. | Chrome, $250, pays 2.5×. | Gold, $1,000, pays 6×. | Everyone draws from one pool, so nobody can grind it dry.",
  5: "At midnight UTC, 20% of the day's fees goes to the top ten. | A seed wallet lifts quiet days, and can never drain faster than 1/14 a day. | Every match has a replay. Every payout is on the ledger.",
  6: "cockfightsol.fun. Hold $COCK. Fight.",
};

export const EXPLAINER: Edit = {
  name: "explainer",
  fps: 30,
  segments: [
    // 0 hook
    { kind: "black", dur: 0.4 },
    { kind: "clip", shot: "brawl", in: 20, out: 150, zoom: { scale: 1.15, cx: 0.5, cy: 0.6 }, sfx: true, crowd: true, fade: { in: 0.2 }, vo: 0 },
    { kind: "clip", shot: "dash-peck", in: 0, out: 60, zoom: { scale: 1.3, cx: 0.45, cy: 0.62 }, sfx: true, crowd: true },
    { kind: "clip", shot: "slam", in: 66, out: 130, speed: 0.6, zoom: { scale: 1.45, cx: 0.55, cy: 0.6 }, sfx: true, crowd: true },
    { kind: "clip", shot: "phone-portrait", in: 40, out: 130, phone: true, sfx: true, crowd: true },
    { kind: "clip", shot: "super-ko", in: 590, out: 641, zoom: { scale: 1.25, cx: 0.75, cy: 0.6 }, sfx: true, crowd: true },
    { kind: "clip", shot: "super-ko", in: 641, out: 690, speed: 0.4, zoom: { scale: 1.4, cx: 0.75, cy: 0.55, to: { scale: 1.2 } }, sfx: true, crowd: true, fade: { out: 0.2 } },
    // 1 where the money comes from
    { kind: "still", file: "how-it-works/still.png", dur: 4.6, pan: { from: 380, to: 470 }, fade: { in: 0.2 }, vo: 1 },
    { kind: "card", card: "card-x-split", dur: 12.0, fade: { in: 0.15, out: 0.2 } },
    { kind: "still", file: "home/still.png", dur: 6.5, zoom: { scale: 1.75, cx: 0.5, cy: 0.18, to: { cy: 0.25 } }, cover: [{ x: 2730, y: 20, w: 320, h: 70 }], fade: { in: 0.2, out: 0.2 } },
    // 2 how to play
    { kind: "still", file: "home/still.png", dur: 3.6, zoom: { scale: 1.9, cx: 0.7, cy: 0.33, to: { scale: 1.8 } }, fade: { in: 0.15 }, vo: 2 },
    { kind: "still", file: "online/lobby.png", dur: 2.2, zoom: { scale: 1.4, cx: 0.5, cy: 0.3 } },
    { kind: "still", file: "online/queue.png", dur: 2.6, zoom: { scale: 1.5, cx: 0.5, cy: 0.3, to: { scale: 1.4 } } },
    { kind: "clip", shot: "brawl", in: 0, out: 80, zoom: { scale: 1.15, cx: 0.5, cy: 0.6 }, sfx: true, crowd: true },
    // 3 how a win is paid
    { kind: "clip", shot: "ring-out", in: 165, out: 262, zoom: { scale: 1.2, cx: 0.7, cy: 0.6 }, sfx: true, crowd: true, vo: 3 },
    { kind: "still", file: "online/result-open.png", dur: 1.3, zoom: { scale: 2.3, cx: 0.5, cy: 0.82 } },
    { kind: "still", file: "online/result-paid.png", dur: 4.2, zoom: { scale: 2.3, cx: 0.5, cy: 0.82, to: { scale: 2.5 } } },
    { kind: "still", file: "how-it-works/still.png", dur: 9.0, pan: { from: 830, to: 1000 }, fade: { in: 0.2, out: 0.2 } },
    // 4 tiers
    { kind: "card", card: "card-x-tiers", dur: 12.6, fade: { in: 0.15, out: 0.2 }, vo: 4 },
    { kind: "clip", shot: "brawl", in: 200, out: 580, zoom: { scale: 1.1, cx: 0.5, cy: 0.6 }, sfx: true, crowd: true, fade: { in: 0.2, out: 0.2 } },
    // 5 top 10, seed, fair play
    { kind: "card", card: "card-x-top10", dur: 8.2, fade: { in: 0.15, out: 0.2 }, vo: 5 },
    { kind: "card", card: "card-x-safe", dur: 8.1, fade: { in: 0.15, out: 0.2 } },
    // 6 CTA
    { kind: "card", card: "card-end", dur: 6.5, fade: { in: 0.1 }, vo: 6 },
  ],
  cues: [{ t: 0.45, file: "impact", gain: 0.8 }],
  vo: VO.map((v) => ({ file: `vo-${v.i}.wav`, gain: 1, text: VO_TEXT[v.i] })),
  music: { file: "explainer", gain: 0.16, duck: true }, // the Suno bed is mastered hot; ~-16 dB puts it ~9 dB under the voice
  captions: true,
};
