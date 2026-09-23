import { defineProject } from "vitest/config";

export default defineProject({ test: { name: "solana", environment: "node", include: ["test/**/*.test.ts"] } });
