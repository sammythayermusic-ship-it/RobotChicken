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
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createEndpoint, createRouter, defineRoom, defineServer, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { loadGameEnv, type GameEnv } from "@cockfight/shared/env";
import { buildContext, setContext, type ContextOverrides, type GameContext } from "./context";
import { clientIp } from "./gate";
import { originPolicy } from "./origins";
import { FightRoom } from "./rooms/FightRoom";
import { QUEUE_ROOM, QueueRoom } from "./rooms/QueueRoom";
import { ROOM_KEY } from "./seats";
import { UsernameService } from "./usernames";

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

/** A JSON body posted as text/plain (a CORS "simple" request); null when it isn't JSON. */
function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

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
    const res = await ctx.gate.enter(parseBody(c.body), req ? clientIp(req.headers) : null);
    return Response.json(res.body, { status: res.status, headers: NO_STORE });
  });

  /** Usernames by signed message: a nonce, then the claim. Both posted as text/plain like /gate. */
  const usernames = new UsernameService(env.QUEUE_JWT_SECRET, ctx.supabase);
  const usernameNonce = createEndpoint("/username/nonce", { method: "POST" }, async (c) => {
    const res = usernames.nonce(parseBody(c.body));
    return Response.json(res.body, { status: res.status, headers: NO_STORE });
  });
  const usernameClaim = createEndpoint("/username", { method: "POST" }, async (c) => {
    const res = await usernames.claim(parseBody(c.body), c.request ? clientIp(c.request.headers) : null);
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
    // Pings every 1.5 s with 2 retries: a dead connection is noticed (and the
    // match paused) in about 3-4.5 s instead of the default 6-9 s.
    transport: new WebSocketTransport({ server: createServer(), beforeUpgrade: origins.beforeUpgrade, pingInterval: 1500, pingMaxRetries: 2 }),
    rooms: {
      [QUEUE_ROOM]: defineRoom(QueueRoom),
      fight: defineRoom(FightRoom),
    },
    // Colyseus' own router (no Express app is mounted); the matchmaking routes are added at listen().
    routes: createRouter({ health, config, gate, usernameNonce, usernameClaim, match, leaderboard }),
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
  limitBodies(http);
  // The one queue room (clients can't create queue rooms).
  await matchMaker.createRoom(QUEUE_ROOM, { key: ROOM_KEY });
}

/** Largest request body accepted (the gate's JSON and matchmaking options are tiny). */
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * Colyseus reads every request body into memory with no cap: refuse big or
 * unsized (chunked) bodies before any of its handlers run.
 */
function limitBodies(http: HttpServer): void {
  const handlers = http.listeners("request") as ((req: IncomingMessage, res: ServerResponse) => void)[];
  http.removeAllListeners("request");
  http.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const len = req.headers["content-length"];
      const n = len === undefined ? NaN : Number(len);
      if (req.headers["transfer-encoding"] !== undefined || !Number.isFinite(n) || n > MAX_BODY_BYTES) {
        res.writeHead(len === undefined ? 411 : 413, { "content-type": "text/plain", connection: "close" });
        res.end(len === undefined ? "length required" : "body too large");
        req.destroy();
        return;
      }
    }
    for (const h of handlers) h.call(http, req, res);
  });
}
