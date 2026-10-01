/** "Share on X" after a ranked win: a tweet intent linking the match replay. */
import { formatUsd } from "./data";

export const X_HANDLE = "CockFightSol";

export interface WinShare {
  /** Site origin, e.g. https://cockfightsol.fun (window.location.origin in the browser). */
  origin: string;
  matchId: string;
  opponent: string;
  /** USD value of the payout; 0 when the win paid nothing. */
  usd: number;
}

export function winTweet(w: WinShare): string {
  const paid = w.usd > 0 ? `Just won ${formatUsd(w.usd)} on COCKFIGHT` : "Just won a fight on COCKFIGHT";
  const opp = w.opponent ? ` against ${w.opponent}` : "";
  return `${paid}${opp} 🐓🤖\n\nHOLD $COCK. GET PAID.`;
}

export function winShareUrl(w: WinShare): string {
  const q = new URLSearchParams({ text: winTweet(w), url: `${w.origin}/m/${encodeURIComponent(w.matchId)}`, via: X_HANDLE });
  return `https://x.com/intent/post?${q.toString()}`;
}
