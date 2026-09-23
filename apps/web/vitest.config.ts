import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

// Unit tests only. The include is explicit so Vitest never picks up the
// Playwright specs in e2e/ (its default glob matches *.spec.ts).
export default defineProject({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    name: "web",
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
