import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "net",
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
