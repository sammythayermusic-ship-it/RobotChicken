// Its own file on purpose: vitest isolates files, and this one needs a second
// Colyseus server whose global matchmaker must not touch fightRoom.test.ts.
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { loadGameEnv } from "@cockfight/shared/env";
import { expect, it, vi } from "vitest";
import { listen, makeServer } from "../src/server";

it("listen() rejects when the port is taken instead of hanging", async () => {
  const blocker = createNetServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const { port } = blocker.address() as AddressInfo;
  const server = makeServer({ env: loadGameEnv({}), gracefullyShutdown: false });
  const printed = vi.spyOn(console, "error").mockImplementation(() => {}); // ws-transport also prints the bind error
  try {
    await expect(listen(server, port, "127.0.0.1")).rejects.toThrow(/EADDRINUSE/);
  } finally {
    printed.mockRestore();
    await server.gracefullyShutdown(false);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});
