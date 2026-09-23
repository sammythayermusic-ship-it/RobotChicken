import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * One flat config for the whole monorepo. eslint-config-next already bundles
 * typescript-eslint's recommended set, so it is applied everywhere (adding
 * tseslint.configs.recommended separately would redefine the plugin). The
 * Next-specific rules are harmless outside apps/web.
 */

// The sim must be bit-identical on every JS engine: only integer-exact Math
// helpers are allowed. Transcendentals (sin, pow, ...) may differ between
// engines, and round/floor are banned to keep one division rule (fixed.ts).
const SIM_MATH_ALLOWED = "^(abs|min|max|trunc|imul|sign|clz32)$";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    settings: { next: { rootDir: "apps/web/" } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Deterministic simulation: no floats sources, no clocks, no environment.
    files: ["packages/sim/src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `MemberExpression[object.name='Math'][property.name!=/${SIM_MATH_ALLOWED}/]`,
          message: "packages/sim: only Math.abs/min/max/trunc/imul/sign/clz32 are allowed (determinism).",
        },
        { selector: "BinaryExpression[operator='**']", message: "packages/sim: no ** (use integer multiplication)." },
        { selector: "AssignmentExpression[operator='**=']", message: "packages/sim: no **=." },
        { selector: "ForInStatement", message: "packages/sim: no for...in (iteration order must be explicit)." },
        {
          selector: "CallExpression[callee.object.name='Object'][callee.property.name=/^(keys|values|entries)$/]",
          message: "packages/sim: iterate explicit field lists, not Object.keys/values/entries.",
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "Date", message: "packages/sim: time is the tick counter." },
        { name: "performance", message: "packages/sim: time is the tick counter." },
        { name: "window", message: "packages/sim: no DOM." },
        { name: "document", message: "packages/sim: no DOM." },
        { name: "process", message: "packages/sim: no Node." },
        { name: "setTimeout", message: "packages/sim: no timers." },
        { name: "setInterval", message: "packages/sim: no timers." },
        { name: "requestAnimationFrame", message: "packages/sim: no timers." },
        { name: "parseFloat", message: "packages/sim: integers only." },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["three", "three/*"], message: "packages/sim must not import three." },
            { group: ["@colyseus/*", "colyseus"], message: "packages/sim must not import colyseus." },
            { group: ["zod", "zod/*"], message: "packages/sim runtime must not import zod." },
            { group: ["node:*"], message: "packages/sim must not import Node built-ins." },
          ],
        },
      ],
    },
  },
  {
    // rules.ts compiles JSON data (plain objects) into ordered tables, the one
    // place Object.keys is legitimate. The Math restriction still applies.
    files: ["packages/sim/src/rules.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `MemberExpression[object.name='Math'][property.name!=/${SIM_MATH_ALLOWED}/]`,
          message: "packages/sim: only Math.abs/min/max/trunc/imul/sign/clz32 are allowed (determinism).",
        },
        { selector: "BinaryExpression[operator='**']", message: "packages/sim: no **." },
        { selector: "ForInStatement", message: "packages/sim: no for...in." },
      ],
    },
  },
  {
    // The game engine is framework-free three.js; React lives only in game/react/.
    files: ["apps/web/src/game/**/*.{ts,tsx}"],
    ignores: ["apps/web/src/game/react/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["react", "react-dom", "react/*"], message: "apps/web/src/game is framework-free; put React in game/react/." }] },
      ],
    },
  },
  {
    // Imperative three.js code mutates scene objects by design.
    files: ["apps/web/src/game/**/*.{ts,tsx}"],
    rules: { "react-hooks/immutability": "off" },
  },
  globalIgnores([
    "**/node_modules/**",
    ".claude/**",
    "**/.next/**",
    "**/dist/**",
    "**/out/**",
    "**/build/**",
    "**/coverage/**",
    "**/test-results/**",
    "**/playwright-report/**",
    "**/next-env.d.ts",
    "apps/web/public/decoders/**",
    "art/blender/out/**",
  ]),
]);
