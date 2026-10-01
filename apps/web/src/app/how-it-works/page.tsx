import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "How it works · COCKFIGHT",
  description: "Where the prize money comes from, how a win is paid, the tiers, the daily top 10, and the rules that keep the pool solvent.",
};

// The economy in plain words: also the explainer video's script (docs/plan-phase3.md).
const SECTIONS: { title: string; body: React.ReactNode }[] = [
  {
    title: "Where the money comes from",
    body: (
      <>
        <p>
          $COCK trades on pump.fun, paired with PUMP. Every buy and sell pays a <strong>3% creator fee</strong>, in PUMP. That fee is the
          whole prize economy: no tickets, no wagers, nothing is ever taken from a player.
        </p>
        <p>
          <strong>70% of every fee goes to players.</strong> 60% of all fees goes into the prize pot for winning matches, 10% is the
          daily pool for the top 10. The remaining 30% runs the game: servers, art, marketing.
        </p>
      </>
    ),
  },
  {
    title: "How a win gets paid",
    body: (
      <>
        <p>
          Every win pays a slice of the prize pot: <strong>5% of it for Rust, 8% for Chrome, 12% for Gold</strong>. Fees are claimed
          into the pot every minute, so the busier the coin trades, the bigger the pot and the bigger every win. Each win comes off
          the pot right away, so the next one pays a slice of what is left: the pot can never pay out more than it holds.
        </p>
        <p>
          Once the pot has reached $500, the last $100 always stays in it, so there is always a prize waiting. The money lands in the
          winner&apos;s wallet within seconds of the knockout, with a link to the transaction on the result screen. A Rust prize is at
          least $0.75 while the pot has it, and at most $75.
        </p>
      </>
    ),
  },
  {
    title: "Tiers",
    body: (
      <>
        <p>Holding more $COCK makes each win bigger. The tiers are by the dollar value of what the wallet holds:</p>
        <ul>
          <li>
            <strong>Rust</strong>, $30 and up: the minimum to play. A win pays 5% of the pot.
          </li>
          <li>
            <strong>Chrome</strong>, $250 and up: a win pays 8% of the pot.
          </li>
          <li>
            <strong>Gold</strong>, $1,000 and up: a win pays 12% of the pot.
          </li>
        </ul>
        <p>
          Everyone draws from one pot, and every win shrinks it, so a whale can&apos;t drain it by grinding. Matchmaking pairs you with your own tier first; after a minute you can be matched with anyone, and that fight
          pays the <em>lower</em> tier&apos;s rate, so nobody farms smaller wallets for bigger prizes.
        </p>
      </>
    ),
  },
  {
    title: "The daily top 10",
    body: (
      <p>
        At midnight UTC, 10% of the day&apos;s fees is split among the 10 players with the most wins that day: 25%, 18%, 13%, 10%,
        8%, 7%, 6%, 5%, 4%, 4%. The leaderboard shows the pool growing all day, the countdown, and what each rank would earn
        right now.
      </p>
    ),
  },
  {
    title: "Why the pot can't run dry",
    body: (
      <>
        <p>
          Every win is a share of what is in the pot, never a fixed amount, so the pot shrinks slower the smaller it gets, and every
          minute&apos;s fees refill it. Once it has held $500, $100 always stays in. The team can add to the pot at any time.
        </p>
        <p>
          There are caps per payment, per hour and
          per day; if one trips, payouts pause and the team is paged. Every payout has one unique key, so no crash or retry can ever
          pay twice. Everything on this site is read straight from the ledger.
        </p>
      </>
    ),
  },
  {
    title: "Fair play",
    body: (
      <ul>
        <li>40 paid wins per wallet per day, and 10 paid matches per day against the same opponent.</li>
        <li>The queue never pairs two players on one network or one browser, and won&apos;t rematch the same two wallets for two minutes.</li>
        <li>A forfeit inside 30 seconds pays nothing; a win with many dropped inputs pays half, or nothing.</li>
        <li>Every match has a replay. Flagged matches are reviewed by a human; a flagged wallet earns nothing until it is cleared.</li>
        <li>A username is claimed by signing a message with the wallet: nobody can take yours by pasting your address.</li>
      </ul>
    ),
  },
];

export default function HowItWorks() {
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 pt-5 sm:px-6">
        <Link href="/" className="font-display text-sm tracking-wider text-chrome">
          COCKFIGHT
        </Link>
        <Link href="/leaderboard" className="text-sm font-semibold uppercase tracking-widest text-ash hover:text-chrome">
          Leaderboard
        </Link>
      </header>
      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6" data-testid="how-it-works">
        <h1 className="chrome-text font-display text-4xl sm:text-6xl">HOW IT WORKS</h1>
        <p className="mt-3 text-lg text-ash">Hold to play. Win to earn. Here is exactly where the money comes from and how it moves.</p>
        <div className="mt-8 flex flex-col gap-8">
          {SECTIONS.map((s) => (
            <section key={s.title} className="rounded-2xl border border-steel bg-ink/80 p-5 [&_li]:mt-1 [&_p+p]:mt-3 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5">
              <h2 className="font-display text-2xl text-amber">{s.title}</h2>
              <div className="mt-3 text-ash [&_strong]:text-chrome">{s.body}</div>
            </section>
          ))}
        </div>
        <p className="mt-8 text-sm text-ash">
          Nothing here is financial advice. $COCK is a memecoin; its price can go to zero. Prizes come only from fees that were
          actually paid.
        </p>
        <Link href="/play?mode=online" className="mt-6 inline-block rounded-xl bg-neon-pink px-6 py-3 font-display text-xl tracking-wider text-pit">
          FIGHT
        </Link>
      </main>
    </div>
  );
}
