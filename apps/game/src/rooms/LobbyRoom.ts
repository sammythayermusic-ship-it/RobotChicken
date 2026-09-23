/**
 * Phase 0 lobby: accepts joins and does nothing else, so the smoke test can
 * prove matchmaking and the WebSocket join work in the production bundle.
 * Phase 2 turns it into the ranked queue (balance gate + QUEUE_JWT_SECRET).
 *
 * Named like core's own `LobbyRoom` export on purpose; that one is never
 * imported here.
 */
import { Room } from "@colyseus/core";

export class LobbyRoom extends Room {}
