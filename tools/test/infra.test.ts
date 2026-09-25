import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { repoPath } from "../src/root";

type Toml = Record<string, unknown>;
const load = (p: string) => parse(readFileSync(repoPath(p), "utf8")) as Toml;

describe("deploy configs", () => {
  it("game fly.toml: iad, WebSocket-safe service on 2567, never auto-stopped, /health checked", () => {
    const t = load("apps/game/fly.toml");
    expect(t.app).toBe("cockfight-game");
    expect(t.primary_region).toBe("iad");
    const http = t.http_service as Toml;
    expect(http.internal_port).toBe(2567);
    expect(http.auto_stop_machines).toBe("off");
    expect(http.min_machines_running).toBeGreaterThanOrEqual(1);
    const checks = http.checks as Toml[];
    expect(checks.some((c) => c.path === "/health")).toBe(true);
    expect((t.env as Toml).PORT).toBe("2567");
  });
  it("worker fly.toml: no public service, internal /health check on 8080", () => {
    const t = load("apps/worker/fly.toml");
    expect(t.app).toBe("cockfight-worker");
    expect(t.http_service).toBeUndefined();
    expect(t.services).toBeUndefined();
    const alive = (t.checks as Toml).alive as Toml;
    expect(alive.port).toBe(8080);
    expect(alive.path).toBe("/health");
  });
  it("both Dockerfiles copy every workspace manifest before the filtered install", () => {
    // A package missing here gets no node_modules in the image, and the bundle can't resolve its imports.
    const manifests = ["apps", "packages"].flatMap((dir) =>
      readdirSync(repoPath(dir), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => `${dir}/${d.name}/package.json`),
    );
    manifests.push("tools/package.json");
    for (const file of ["apps/game/Dockerfile", "apps/worker/Dockerfile"]) {
      const src = readFileSync(repoPath(file), "utf8");
      const install = src.indexOf("pnpm install");
      for (const m of manifests) {
        const at = src.indexOf(`COPY ${m} `);
        expect(at, `${file} copies ${m}`).toBeGreaterThan(-1);
        expect(at, `${file} copies ${m} before installing`).toBeLessThan(install);
      }
    }
  });
  it("vercel.json installs only the web app and deploys to iad1", () => {
    const v = JSON.parse(readFileSync(repoPath("apps/web/vercel.json"), "utf8")) as Toml;
    expect(String(v.installCommand)).toContain("--filter @cockfight/web");
    expect(v.regions).toEqual(["iad1"]);
  });
  it(".env.example documents every env var the schemas read", () => {
    const example = readFileSync(repoPath(".env.example"), "utf8");
    const envSrc = readFileSync(repoPath("packages/shared/src/env.ts"), "utf8");
    const keys = [...envSrc.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1] as string);
    const ignored = new Set(["NODE_ENV", "FLY_REGION"]);
    for (const k of keys) if (!ignored.has(k)) expect(example, k).toMatch(new RegExp(`^${k}=`, "m"));
  });
});
