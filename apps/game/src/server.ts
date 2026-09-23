/**
 * Game server factory. Importing this module has no side effects; each call
 * builds a server (nothing listens until `listen()`), so tests can make one
 * with `gracefullyShutdown: false`. Colyseus' test `boot()` does not turn that
 * off for Server instances, and its process handlers would outlive the test.
 *
 * Colyseus keeps the matchmaker, its room registry and the CORS hook in
 * module-level singletons, so the last server made in a process wins. A
 * process runs one server in production.
 */
import { createServer } from "node:http";
import { createEndpoint, createRouter, defineRoom, defineServer, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { loadGameEnv, type GameEnv } from "@cockfight/shared/env";
import { originPolicy } from "./origins";
import { FightRoom } from "./rooms/FightRoom";
import { LobbyRoom } from "./rooms/LobbyRoom";

export interface MakeServerOptions {
  /** Parsed environment. Defaults to `loadGameEnv(process.env)`. */
  env?: GameEnv;
  /**
   * Install Colyseus' SIGINT/SIGTERM/SIGUSR2 and uncaughtException handlers,
   * which drain rooms and then call `process.exit`. Default true; tests pass false.
   */
  gracefullyShutdown?: boolean;
}

export function makeServer(opts: MakeServerOptions = {}) {
  const env = opts.env ?? loadGameEnv(process.env);
  const origins = originPolicy(env.ALLOWED_ORIGINS);

  // 0.18's only CORS hook: a process-global override (see matchmaker/controller.ts).
  // Colyseus applies it to every HTTP response, matchmaking included.
  matchMaker.controller.getCorsHeaders = origins.corsHeaders;

  const health = createEndpoint("/health", { method: "GET" }, async () => {
    // 503 while draining, so Fly's proxy stops sending new players to this machine.
    const ok = matchMaker.state === matchMaker.MatchMakerState.READY;
    return Response.json(
      { ok, region: env.FLY_REGION, rooms: matchMaker.stats.local.roomCount },
      { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
    );
  });

  return defineServer({
    greet: false,
    gracefullyShutdown: opts.gracefullyShutdown ?? true,
    // Explicit transport over our own http.Server: without one, core falls back
    // to a dynamic import("@colyseus/ws-transport"), which a single-file bundle
    // with no node_modules cannot resolve.
    transport: new WebSocketTransport({ server: createServer(), beforeUpgrade: origins.beforeUpgrade }),
    rooms: {
      lobby: defineRoom(LobbyRoom),
      fight: defineRoom(FightRoom),
    },
    // Colyseus' own router (no Express app is mounted); the matchmaking routes are added at listen().
    routes: createRouter({ health }),
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
