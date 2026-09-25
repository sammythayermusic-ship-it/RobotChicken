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

/** Split argv into known --flags and positionals; unknown flags are an error. */
export function parseArgs(args: string[], flags: readonly string[], usage: string): { flags: Set<string>; positional: string[] } {
  const set = new Set<string>();
  const positional: string[] = [];
  for (const a of args) {
    if (a === "--help" || a === "-h") {
      console.log(usage);
      process.exit(0);
    }
    if (a.startsWith("--")) {
      if (!flags.includes(a)) throw new Error(`unknown option ${a}\n${usage}`);
      set.add(a);
    } else positional.push(a);
  }
  return { flags: set, positional };
}
