/**
 * The worker's HTTP surface: a health endpoint for Fly's machine check and
 * nothing else. The worker has no public service; Phase 3 adds the fee
 * claims and payouts it exists for.
 */
import { createServer, type Server } from "node:http";

export interface WorkerHealth {
  ok: true;
  /** Always false in this build: there is no payout code to enable yet. */
  payoutsEnabled: false;
}

export function createWorkerServer(): Server {
  const health: WorkerHealth = { ok: true, payoutsEnabled: false };
  const body = JSON.stringify(health);

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
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  });
}
