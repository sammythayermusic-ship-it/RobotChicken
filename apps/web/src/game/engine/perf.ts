import type { WebGLRenderer } from "three";

export interface PerfSnapshot {
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  over16: number;
  frames: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  dpr: number;
  tier: string;
  gpu: string;
}

/** Rolling frame-time stats + renderer counters for the FPS meter, bench and e2e budgets. */
export class PerfMeter {
  private readonly times: number[] = [];
  private last = -1;
  private readonly cap: number;
  drawCalls = 0;
  triangles = 0;
  programs = 0;
  gpu = "";

  constructor(windowFrames = 240) {
    this.cap = windowFrames;
  }

  frame(now: number, renderer: WebGLRenderer): void {
    if (this.last >= 0) {
      this.times.push(now - this.last);
      if (this.times.length > this.cap) this.times.shift();
    }
    this.last = now;
    this.drawCalls = renderer.info.render.calls;
    this.triangles = renderer.info.render.triangles;
    this.programs = renderer.info.programs?.length ?? 0;
    if (!this.gpu) this.gpu = gpuName(renderer);
  }

  reset(): void {
    this.times.length = 0;
    this.last = -1;
  }

  snapshot(dpr: number, tier: string): PerfSnapshot {
    const s = [...this.times].sort((a, b) => a - b);
    const q = (p: number) => (s.length ? (s[Math.min(s.length - 1, Math.floor(p * s.length))] as number) : 0);
    const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
    return {
      fps: mean ? 1000 / mean : 0,
      p50: q(0.5),
      p95: q(0.95),
      p99: q(0.99),
      over16: s.length ? s.filter((t) => t > 16.7 * 1.2).length / s.length : 0,
      frames: s.length,
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      programs: this.programs,
      dpr,
      tier,
      gpu: this.gpu,
    };
  }
}

function gpuName(renderer: WebGLRenderer): string {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  } catch {
    return "unknown";
  }
}
