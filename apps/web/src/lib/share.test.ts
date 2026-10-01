import { describe, expect, it } from "vitest";
import { winShareUrl, winTweet } from "./share";

describe("win share", () => {
  it("names the prize when the win paid", () => {
    expect(winTweet({ origin: "https://cockfightsol.fun", matchId: "abc", opponent: "rooster", usd: 12.5 })).toBe(
      "Just won $12.50 on COCKFIGHT against rooster 🐓🤖\n\nHOLD $COCK. GET PAID.",
    );
  });

  it("links the replay and tags the account", () => {
    const u = new URL(winShareUrl({ origin: "https://cockfightsol.fun", matchId: "m 1", opponent: "", usd: 0 }));
    expect(u.origin + u.pathname).toBe("https://x.com/intent/post");
    expect(u.searchParams.get("url")).toBe("https://cockfightsol.fun/m/m%201");
    expect(u.searchParams.get("via")).toBe("CockFightSol");
    expect(u.searchParams.get("text")).toMatch(/^Just won a fight on COCKFIGHT 🐓/);
  });
});
