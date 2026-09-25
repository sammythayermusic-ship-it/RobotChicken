/**
 * Input-timing analysis (spec: "input-timing analysis flags bots"). Looks at
 * one player's button masks tick by tick and flags what a human hand doesn't
 * do: button changes spaced with machine regularity, or a fixed macro
 * replayed over and over. A flag holds the win's payout for review in /admin
 * (record_match); it never decides a match.
 *
 * Conservative on purpose: a false flag costs a real player a wait and a
 * human look, so both tests need plenty of inputs before they say anything.
 */

export type BotFlag = "timing" | "macro";

export interface TimingReport {
  changes: number;
  meanInterval: number;
  /** Coefficient of variation of the intervals between button changes. */
  cv: number;
  /** Shortest period (in changes) the change sequence repeats with, or 0. */
  period: number;
  flag: BotFlag | null;
}

/** At least this many button changes before timing says anything. */
export const MIN_CHANGES = 60;
/** Intervals this regular (stddev / mean) are not a hand on a keyboard or a thumb on glass. */
export const MAX_CV = 0.04;
/** A sequence repeating at least this many times is a macro. */
export const MIN_REPEATS = 4;

export function analyzeTiming(masks: readonly number[]): TimingReport {
  const changes: { tick: number; mask: number }[] = [];
  let prev = 0;
  masks.forEach((m, tick) => {
    if (m !== prev) {
      changes.push({ tick, mask: m });
      prev = m;
    }
  });
  const n = changes.length;
  const none: TimingReport = { changes: n, meanInterval: 0, cv: 1, period: 0, flag: null };
  if (n < MIN_CHANGES) return none;
  const intervals = changes.slice(1).map((c, i) => c.tick - (changes[i] as { tick: number }).tick);
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
  const period = repeatPeriod(changes.slice(1).map((c, i) => `${c.mask}:${intervals[i]}`));
  const flag: BotFlag | null = cv < MAX_CV ? "timing" : period > 0 ? "macro" : null;
  return { changes: n, meanInterval: mean, cv, period, flag };
}

/** The shortest period p (2..64) such that the sequence is the same block repeated ≥ MIN_REPEATS times, else 0. */
export function repeatPeriod(seq: readonly string[]): number {
  for (let p = 2; p <= 64 && p * MIN_REPEATS <= seq.length; p++) {
    const reps = Math.floor(seq.length / p);
    let ok = true;
    for (let i = p; i < reps * p && ok; i++) if (seq[i] !== seq[i % p]) ok = false;
    if (ok) return p;
  }
  return 0;
}
