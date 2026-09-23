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

const SIM_SYNTAX = [
  {
    selector: `MemberExpression[object.name='Math'][property.name!=/${SIM_MATH_ALLOWED}/]`,
    message: "packages/sim: only Math.abs/min/max/trunc/imul/sign/clz32 are allowed (determinism).",
  },
  // Aliasing or destructuring Math would slip past the rule above.
  { selector: "VariableDeclarator[init.name='Math']", message: "packages/sim: don't alias or destructure Math." },
  { selector: ":matches(CallExpression, NewExpression, ArrayExpression, Property, SpreadElement, ReturnStatement, AssignmentExpression) > Identifier[name='Math']", message: "packages/sim: don't pass Math around." },
  { selector: "BinaryExpression[operator='**']", message: "packages/sim: no ** (use integer multiplication)." },
  { selector: "AssignmentExpression[operator='**=']", message: "packages/sim: no **=." },
  // One division rule: idiv / mulDiv in fixed.ts (hash.ts's exact carry is the only other site).
  { selector: "BinaryExpression[operator='/']", message: "packages/sim: divide with idiv / mulDiv (fixed.ts)." },
  { selector: "AssignmentExpression[operator='/=']", message: "packages/sim: divide with idiv / mulDiv (fixed.ts)." },
  { selector: "Literal[raw=/^\\d*\\.\\d/]", message: "packages/sim: integers only (no fractional literals)." },
  { selector: "ForInStatement", message: "packages/sim: no for...in (iteration order must be explicit)." },
  {
    selector: "CallExpression[callee.property.name=/^(localeCompare|toLocaleString|toLocaleUpperCase|toLocaleLowerCase)$/]",
    message: "packages/sim: locale-dependent calls differ between machines.",
  },
];
const SIM_NO_OBJECT_ITERATION = {
  selector: "CallExpression[callee.object.name='Object'][callee.property.name=/^(keys|values|entries)$/]",
  message: "packages/sim: iterate explicit field lists, not Object.keys/values/entries.",
};
const SIM_GLOBALS = [
  "Date", "performance", "window", "document", "process", "setTimeout", "setInterval", "requestAnimationFrame",
  "parseFloat", "globalThis", "self", "crypto", "Intl", "navigator",
].map((name) => ({ name, message: "packages/sim: no clocks, environment, randomness or locale (determinism)." }));

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
    // Deterministic simulation: no float sources, no clocks, no environment.
    files: ["packages/sim/src/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...SIM_SYNTAX, SIM_NO_OBJECT_ITERATION],
      "no-restricted-globals": ["error", ...SIM_GLOBALS],
      "no-restricted-properties": [
        "error",
        { object: "Number", property: "parseFloat", message: "packages/sim: integers only." },
        { object: "Reflect", property: "ownKeys", message: "packages/sim: iterate explicit field lists." },
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
    // rules.ts compiles JSON data (plain objects) into ordered tables: the one
    // place Object.keys is legitimate. Everything else still applies.
    files: ["packages/sim/src/rules.ts"],
    rules: { "no-restricted-syntax": ["error", ...SIM_SYNTAX] },
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
