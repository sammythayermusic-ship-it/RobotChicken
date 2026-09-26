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
  captions?: boolean;
}

const PHONE_BRAWL_IN = 60;

export const PROMO: Edit = {
  name: "promo",
  fps: 60,
  segments: [
    { kind: "black", dur: 0.25 },
    { kind: "card", card: "card-logo", dur: 1.55, fade: { out: 0.08 } },
    // three hits, cut on impact (peck hit f45 of this trim, shove f80, dash-peck f44, dive f58)
    { kind: "clip", shot: "peck", in: 38, out: 82, zoom: { scale: 1.35, cx: 0.5, cy: 0.62 }, sfx: true, crowd: true },
    { kind: "clip", shot: "shove", in: 62, out: 106, zoom: { scale: 1.3, cx: 0.42, cy: 0.62 }, sfx: true, crowd: true },
    { kind: "clip", shot: "dive-kick", in: 34, out: 72, zoom: { scale: 1.25, cx: 0.55, cy: 0.55 }, sfx: true, crowd: true },
    { kind: "clip", shot: "dash-peck", in: 2, out: 52, zoom: { scale: 1.3, cx: 0.45, cy: 0.62 }, sfx: true, crowd: true },
    // the slam in slow motion, 1v1 title over it
    { kind: "clip", shot: "slam", in: 62, out: 152, speed: 0.4, zoom: { scale: 1.5, cx: 0.55, cy: 0.6, to: { scale: 1.35 } }, overlays: [{ card: "card-t-1v1", at: 1.0, outFade: 0.25 }], sfx: true, crowd: true },
    // the phone
    { kind: "clip", shot: "phone-brawl", in: PHONE_BRAWL_IN, out: PHONE_BRAWL_IN + 180, phone: true, overlays: [{ card: "card-t-phone", at: 0.35, outFade: 0.25 }], sfx: true, crowd: true },
    // ring-out → paid
    { kind: "clip", shot: "ring-out", in: 165, out: 262, zoom: { scale: 1.2, cx: 0.7, cy: 0.6 }, sfx: true, crowd: true },
    { kind: "still", file: "online/result-paid.png", dur: 2.6, zoom: { scale: 2.5, cx: 0.5, cy: 0.82, to: { scale: 2.3 } }, overlays: [{ card: "card-t-paid", at: 0.45, outFade: 0.2 }], fade: { in: 0.08 } },
    // the site: hold to play
    { kind: "still", file: "home/still.png", dur: 3.0, zoom: { scale: 1.75, cx: 0.5, cy: 0.2, to: { cy: 0.25 } }, cover: [{ x: 2730, y: 20, w: 320, h: 70 }], overlays: [{ card: "card-t-hold", at: 0.3, outFade: 0.2 }], fade: { in: 0.08 } },
    // the super: heat full, rocket, KO in slow motion
    { kind: "clip", shot: "super-ko", in: 600, out: 641, zoom: { scale: 1.25, cx: 0.75, cy: 0.6 }, sfx: true, crowd: true },
    { kind: "clip", shot: "super-ko", in: 641, out: 700, speed: 0.35, zoom: { scale: 1.45, cx: 0.75, cy: 0.55, to: { scale: 1.2, cx: 0.7 } }, sfx: true, crowd: true, fade: { out: 0.1 } },
    { kind: "black", dur: 0.2 },
    { kind: "card", card: "card-end", dur: 6.0 },
  ],
  cues: [
    { t: 0.55, file: "impact", gain: 1 },
    { t: 0.55, file: "hit_slam", gain: 0.9 },
  ],
  vo: [
    { t: 0.45, file: "vo-7.wav", gain: 1 },
    { t: 24.6, file: "vo-8.wav", gain: 1 },
  ],
  music: { file: "promo", gain: 0.9, duck: false },
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
  music: { file: "explainer", gain: 0.55, duck: true },
  captions: true,
};
