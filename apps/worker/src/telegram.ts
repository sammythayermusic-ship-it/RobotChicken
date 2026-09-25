/**
 * Alerts to Sammy's Telegram (the bot token and chat id are env). Identical
 * messages are sent at most once every ten minutes, so a stuck condition
 * doesn't flood the chat; every alert is also logged.
 */
import type { Alerts } from "@cockfight/economy";

export interface TelegramOptions {
  token?: string;
  chatId?: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

export class TelegramAlerts implements Alerts {
  private readonly o: TelegramOptions;
  private readonly recent = new Map<string, number>();
  readonly failures: string[] = [];

  constructor(o: TelegramOptions = {}) {
    this.o = o;
  }

  get enabled(): boolean {
    return !!(this.o.token && this.o.chatId);
  }

  async alert(kind: "pause" | "low_sol" | "claim_failed" | "info", message: string): Promise<void> {
    const now = (this.o.now ?? Date.now)();
    const text = `${kind === "pause" ? "⏸" : kind === "low_sol" ? "⛽" : kind === "claim_failed" ? "⚠️" : "ℹ️"} COCKFIGHT ${kind}: ${message}`;
    (this.o.log ?? ((l) => console.log(l)))(`[alert] ${text}`);
    const last = this.recent.get(text);
    if (last !== undefined && now - last < 10 * 60_000) return;
    this.recent.set(text, now);
    if (this.recent.size > 200) for (const [k, t] of this.recent) if (now - t > 60 * 60_000) this.recent.delete(k);
    if (!this.enabled) return;
    try {
      const res = await (this.o.fetch ?? fetch)(`https://api.telegram.org/bot${this.o.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.o.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) this.failures.push(`HTTP ${res.status}`);
    } catch (e) {
      this.failures.push(e instanceof Error ? e.message : String(e));
    }
  }
}
