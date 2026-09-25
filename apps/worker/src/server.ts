/**
 * The worker's HTTP surface: /health for Fly's machine check and for a quick
 * look at what the treasury is doing. No public service; no secrets in the
 * body (amounts and modes only).
 */
import { createServer, type Server } from "node:http";

export interface WorkerStatus {
  ok: boolean;
  mode: "health" | "observer" | "live";
  payoutsEnabled: boolean;
  startedAt: string;
  error?: string;
  lastError?: string;
  errors?: number;
  lastClaimAt?: string;
  lastMidnight?: { at: string; daily: number; seed: string | null };
  pay?: { at: string; sent: number; deferred: number; confirmed: number; retried: number; failed: number };
  pool?: {
    computedAt: string;
    priceUsd: number;
    perWin: { rust: string; chrome: string; gold: string };
    dailyPool: string;
    perWinBudget: string;
    weightedMilli: string;
  };
}

export function createWorkerServer(status: () => WorkerStatus): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/health") {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", "content-type": "application/json" }).end('{"error":"method not allowed"}');
      return;
    }
    const s = status();
    const body = JSON.stringify(s);
    res.writeHead(s.ok ? 200 : 503, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  });
}
