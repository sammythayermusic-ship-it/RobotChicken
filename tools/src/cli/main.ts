import { BlenderNotFoundError } from "../blender/run";

/**
 * Run a CLI body: its return value is the exit code; an unexpected error
 * prints one line (not a stack) and exits 2; a missing Blender exits 3 (not 127,
 * which pnpm reports as a misleading "spawn ENOENT").
 */
export function cli(body: (args: string[]) => Promise<number> | number): void {
  Promise.resolve()
    .then(() => body(process.argv.slice(2)))
    .then(
      (code) => process.exit(code),
      (e: unknown) => {
        console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
        if (process.env.DEBUG && e instanceof Error) console.error(e.stack);
        process.exit(e instanceof BlenderNotFoundError ? 3 : 2);
      },
    );
}

export interface ParsedArgs {
  flags: Set<string>;
  /** Options that take a value (`--out x` or `--out=x`), and `--flag=x` for a boolean flag that accepts one. */
  values: Map<string, string>;
  positional: string[];
}

/**
 * Split argv into known --flags, --options with values, and positionals;
 * unknown options are an error. `valueOptions` always take a value
 * (`--out x` or `--out=x`); a boolean flag may also be given one (`--arena=x`).
 */
export function parseArgs(args: string[], flags: readonly string[], usage: string, valueOptions: readonly string[] = []): ParsedArgs {
  const set = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--help" || a === "-h") {
      console.log(usage);
      process.exit(0);
    }
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (valueOptions.includes(name)) {
      const value = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (value === undefined || value === "" || (eq < 0 && value.startsWith("--"))) throw new Error(`${name} needs a value\n${usage}`);
      values.set(name, value);
    } else if (flags.includes(name)) {
      set.add(name);
      if (eq > 0) values.set(name, a.slice(eq + 1));
    } else throw new Error(`unknown option ${name}\n${usage}`);
  }
  return { flags: set, values, positional };
}
