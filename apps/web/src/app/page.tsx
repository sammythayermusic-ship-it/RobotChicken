import Link from "next/link";
import { RULES } from "@cockfight/sim";
import { ShowcaseSlot } from "@/components/site/ShowcaseSlot";

// Landing page. The wallet box opens the online lobby with the address filled
// in (/play?mode=online&wallet=…); the game server's gate does the checking.
const STEPS = [
  { n: "01", title: "Hold", body: "Hold $COCK in the wallet you paste. It is read, never spent. Holding more unlocks chrome, gold and diamond paint jobs." },
  { n: "02", title: "Fight", body: "1v1 robot-chicken duels, best of three. Peck, shove, slam, dive-kick, and a super when your Heat is full." },
  { n: "03", title: "Earn", body: "Winners get paid in SOL out of the coin's trading fees once payouts go live. The leaderboard is already counting." },
] as const;

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 pt-5 sm:px-6">
        <span className="font-display text-sm tracking-wider text-chrome">COCKFIGHT</span>
        <nav className="flex items-center gap-3">
          <Link href="/leaderboard" className="text-sm font-semibold uppercase tracking-widest text-ash hover:text-chrome">
            Leaderboard
          </Link>
          <span className="rounded-full border border-neon-cyan/40 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-neon-cyan">
            Preview build
          </span>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 sm:px-6">
        <section className="pt-8 sm:pt-12">
          <h1 className="chrome-text font-display text-[clamp(3rem,13vw,8.5rem)] leading-[0.9] tracking-tight">COCKFIGHT</h1>
          <p className="mt-4 max-w-xl text-lg text-ash sm:text-xl">
            Robot chickens. One junkyard pit. <span className="font-extrabold text-chrome">Hold to play. Win to earn.</span>
          </p>
        </section>

        <section className="mt-8 grid gap-6 lg:grid-cols-12">
          <div className="pit-poster relative aspect-[4/3] overflow-hidden rounded-2xl border border-neon-pink/30 shadow-[0_0_40px_-10px_rgb(255_46_136/0.5)] sm:aspect-[16/9] lg:col-span-8">
            <ShowcaseSlot className="absolute inset-0" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-pit/80 to-transparent" />
          </div>

          <div className="rust-plate flex flex-col justify-between gap-6 rounded-2xl border border-rust/40 p-5 sm:p-6 lg:col-span-4">
            <div>
              <h2 className="font-display text-xl text-amber">Enter the pit</h2>
              <form className="mt-4 flex flex-col gap-3" action="/play" method="get" data-testid="landing-wallet">
                <input type="hidden" name="mode" value="online" />
                <label htmlFor="wallet" className="text-sm font-semibold uppercase tracking-wider text-ash">
                  Solana wallet address
                </label>
                <input
                  id="wallet"
                  name="wallet"
                  type="text"
                  placeholder="Paste your wallet address"
                  autoComplete="off"
                  aria-describedby="wallet-note"
                  spellCheck={false}
                  className="w-full rounded-lg border border-steel bg-pit/70 px-3 py-3 font-mono text-sm text-chrome placeholder:text-ash/60 focus:border-neon-cyan focus:outline-none"
                />
                <button type="submit" className="rounded-lg border border-neon-cyan/60 py-2 font-display text-neon-cyan hover:bg-neon-cyan/10">
                  FIGHT ONLINE
                </button>
              </form>
              <p id="wallet-note" className="mt-2 text-sm text-ash">
                Hold $30 of $COCK to play online. The address is only read, never charged, and nothing is wagered.
              </p>
            </div>
            <Link
              href="/play"
              className="block rounded-xl bg-neon-pink py-4 text-center font-display text-2xl tracking-wider text-pit shadow-[0_0_28px_-4px_rgb(255_46_136/0.8)] transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-neon-cyan"
            >
              FIGHT
            </Link>
          </div>
        </section>

        <section aria-labelledby="how" className="mt-14 mb-16">
          <h2 id="how" className="font-display text-2xl text-chrome">
            How it works
          </h2>
          <ol className="mt-5 grid gap-4 sm:grid-cols-3">
            {STEPS.map((s) => (
              <li key={s.n} className="rounded-xl border border-steel bg-ink/80 p-5">
                <span className="font-display text-sm text-neon-cyan">{s.n}</span>
                <h3 className="mt-1 font-display text-lg text-chrome">{s.title}</h3>
                <p className="mt-2 text-ash">{s.body}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="border-t border-steel/70">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-5 text-xs text-ash sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span>Robot chickens only. No animals were harmed, or used.</span>
          <span>
            sim rules <code className="font-mono text-chrome" data-testid="rules-hash">{RULES.hash}</code>
          </span>
        </div>
      </footer>
    </div>
  );
}
