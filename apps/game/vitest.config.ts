import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "game", environment: "node", include: ["test/**/*.test.ts"], testTimeout: 20_000 },
});
