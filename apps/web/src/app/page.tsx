import Link from "next/link";
import { RULES } from "@cockfight/sim";
import { PoolPanel } from "@/components/site/PoolPanel";
import { LandingFight } from "@/components/site/LandingFight";
import { ShowcaseSlot } from "@/components/site/ShowcaseSlot";

// Landing page. The wallet box + FIGHT opens the online lobby with the address
// filled in (/play?wallet=…), which checks it at once: one press to the queue.
const STEPS = [
  { n: "01", title: "Hold", body: "Hold $COCK in the wallet you paste. It is read, never spent. Holding more unlocks chrome, gold and diamond paint jobs." },
  { n: "02", title: "Fight", body: "1v1 robot-chicken duels, best of three. Peck, shove, slam, dive-kick, and a super when your Heat is full." },
  { n: "03", title: "Earn", body: "Every win pays in PUMP out of the coin's trading fees, within seconds of the knockout. The top 10 of each day split a second pool at midnight UTC." },
] as const;

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 pt-5 sm:px-6">
        <span className="font-display text-sm tracking-wider text-chrome">COCKFIGHT</span>
        <nav className="flex items-center gap-3">
          <Link href="/how-it-works" className="text-sm font-semibold uppercase tracking-widest text-ash hover:text-chrome">
            How it works
          </Link>
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

          <div className="rust-plate flex flex-col gap-4 rounded-2xl border border-rust/40 p-5 sm:p-6 lg:col-span-4">
            <h2 className="font-display text-xl text-amber">Enter the pit</h2>
            <LandingFight gateUsd={30} />
          </div>
        </section>

        <section aria-labelledby="pool" className="mt-8">
          <h2 id="pool" className="sr-only">
            Prize pool
          </h2>
          <PoolPanel />
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
