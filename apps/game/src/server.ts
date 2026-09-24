/**
 * Game server factory. Importing this module has no side effects; each call
 * builds a server (nothing listens until `listen()`), so tests can make one
 * with `gracefullyShutdown: false`. Colyseus' test `boot()` does not turn that
 * off for Server instances, and its process handlers would outlive the test.
 *
 * Colyseus keeps the matchmaker, its room registry and the CORS hook in
 * module-level singletons, so the last server made in a process wins. A
 * process runs one server in production. The rooms' services (gate, result
 * stores) follow the same rule (context.ts).
 */
import { createServer } from "node:http";
import { createEndpoint, createRouter, defineRoom, defineServer, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { loadGameEnv, type GameEnv } from "@cockfight/shared/env";
import { buildContext, setContext, type ContextOverrides, type GameContext } from "./context";
import { clientIp } from "./gate";
import { originPolicy } from "./origins";
import { FightRoom } from "./rooms/FightRoom";
import { QueueRoom } from "./rooms/QueueRoom";

export interface MakeServerOptions {
  /** Parsed environment. Defaults to `loadGameEnv(process.env)`. */
  env?: GameEnv;
  /**
   * Install Colyseus' SIGINT/SIGTERM/SIGUSR2 and uncaughtException handlers,
   * which drain rooms and then call `process.exit`. Default true; tests pass false.
   */
  gracefullyShutdown?: boolean;
  /** Test doubles for the rooms' services. */
  context?: ContextOverrides;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NO_STORE = { "cache-control": "no-store" };

export function makeServer(opts: MakeServerOptions = {}) {
  const env = opts.env ?? loadGameEnv(process.env);
  const origins = originPolicy(env.ALLOWED_ORIGINS);
  const ctx: GameContext = buildContext(env, opts.context);
  setContext(ctx);

  // 0.18's only CORS hook: a process-global override (see matchmaker/controller.ts).
  // Colyseus applies it to every HTTP response, matchmaking included.
  matchMaker.controller.getCorsHeaders = origins.corsHeaders;

  const health = createEndpoint("/health", { method: "GET" }, async () => {
    // 503 while draining, so Fly's proxy stops sending new players to this machine.
    const ok = matchMaker.state === matchMaker.MatchMakerState.READY;
    return Response.json(
      { ok, region: env.FLY_REGION, rooms: matchMaker.stats.local.roomCount },
      { status: ok ? 200 : 503, headers: NO_STORE },
    );
  });

  /** What the web app needs to know before showing the queue: open or gated, the gate in USD. */
  const config = createEndpoint("/config", { method: "GET" }, async () => Response.json(ctx.gate.config(), { headers: NO_STORE }));

  /**
   * POST /gate {address, turnstile} → {ok, usd, tier, token} or why not.
   * The browser posts it as text/plain (a CORS "simple" request, no preflight).
   */
  const gate = createEndpoint("/gate", { method: "POST" }, async (c) => {
    const req = c.request;
    let body: unknown = c.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = null;
      }
    }
    const res = await ctx.gate.enter(body, req ? clientIp(req.headers) : null);
    return Response.json(res.body, { status: res.status, headers: NO_STORE });
  });

  /** Finished matches this process played (open playtests, and ranked ones as a fallback to Supabase). */
  const match = createEndpoint("/api/matches/:id", { method: "GET" }, async (c) => {
    const id = String(c.params.id ?? "");
    const m = UUID.test(id) ? ctx.memory.getMatch(id) : null;
    return m ? Response.json(m, { headers: { "cache-control": "public, max-age=3600" } }) : Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
  });

  const leaderboard = createEndpoint("/api/leaderboard", { method: "GET" }, async () =>
    Response.json({ rows: ctx.memory.leaderboard(), source: "memory" }, { headers: { "cache-control": "public, max-age=15" } }),
  );

  return defineServer({
    greet: false,
    gracefullyShutdown: opts.gracefullyShutdown ?? true,
    // Explicit transport over our own http.Server: without one, core falls back
    // to a dynamic import("@colyseus/ws-transport"), which a single-file bundle
    // with no node_modules cannot resolve.
    transport: new WebSocketTransport({ server: createServer(), beforeUpgrade: origins.beforeUpgrade }),
    rooms: {
      queue: defineRoom(QueueRoom),
      fight: defineRoom(FightRoom),
    },
    // Colyseus' own router (no Express app is mounted); the matchmaking routes are added at listen().
    routes: createRouter({ health, config, gate, match, leaderboard }),
  });
}

/** The typed server; `@colyseus/sdk` clients can take it as a type parameter. */
export type GameServer = ReturnType<typeof makeServer>;

/**
 * `server.listen()` that rejects when the port cannot be bound. Colyseus
 * 0.18.15 attaches its bind-error handler only after 'listening', so on
 * EADDRINUSE its promise never settles and the process stays up serving nothing.
 */
export async function listen(server: GameServer, port: number, hostname: string): Promise<void> {
  const http = server.transport.server;
  if (!http) throw new Error("game server transport has no http.Server");
  let onError: ((err: Error) => void) | undefined;
  const bindFailed = new Promise<never>((_, reject) => {
    onError = reject;
    http.once("error", onError);
  });
  try {
    await Promise.race([server.listen(port, hostname), bindFailed]);
  } finally {
    if (onError) http.off("error", onError);
  }
}
