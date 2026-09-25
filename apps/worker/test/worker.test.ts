import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkerServer } from "../src/server";

async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

describe("worker HTTP", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createWorkerServer(() => ({ ok: true, mode: "health", payoutsEnabled: false, startedAt: "2026-09-25T00:00:00.000Z" }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("GET /health reports the mode with payouts disabled", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, mode: "health", payoutsEnabled: false, startedAt: "2026-09-25T00:00:00.000Z" });
  });

  it("answers HEAD /health and ignores the query string", async () => {
    const head = await fetch(`${base}/health`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await fetch(`${base}/health?probe=1`)).status).toBe(200);
  });

  it("has no other routes or methods", async () => {
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/payouts`)).status).toBe(404);
    const post = await fetch(`${base}/health`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("worker process", () => {
  it("boots from env alone in health mode (no database: nothing to compute), and exits 0 on SIGTERM", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: join(import.meta.dirname, ".."),
      // PAYOUTS_ENABLED=true without a database, RPC or keys must still send nothing.
      env: { PATH: process.env.PATH ?? "", PORT: String(port), PAYOUTS_ENABLED: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const exit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;

    try {
      const deadline = Date.now() + 10_000;
      let body: unknown;
      while (body === undefined) {
        try {
          body = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
        } catch {
          if (Date.now() > deadline || child.exitCode !== null) throw new Error(`worker did not start:\n${out}`);
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      expect(body).toMatchObject({ ok: true, mode: "health", payoutsEnabled: false });
      expect(out).toContain("health only: set SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY, HELIUS_API_KEY or SOLANA_RPC_URL, PAYOUT_MINT");

      child.kill("SIGTERM");
      const [code, signal] = await exit;
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(out).toContain("SIGTERM: shutting down");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
