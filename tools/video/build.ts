/**
 * pnpm --filter @cockfight/tools video:build [promo|explainer]
 *
 * Renders each segment of the EDL to a 1920×1080 intermediate, concatenates
 * them, builds the audio (the game's own sounds at the ticks the director
 * fired them, extra cues, the VO, an optional music bed ducked under the VO),
 * burns captions, and muxes <out>/<name>.mp4 (+ .srt). Needs ffmpeg.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXPLAINER, PROMO, type Edit, type Segment, type Zoom, type Overlay } from "./edl";

const repo = resolve(import.meta.dirname, "../..");
const OUT = process.env.VIDEO_OUT ?? join(repo, "Claude outputs", "video");
const SHOTS = join(OUT, "shots");
const W = 1920, H = 1080;
const PIT = "0x0a0710";

const which = (process.argv[2] ?? "promo").toLowerCase();
const EDITS: Record<string, Edit> = { promo: PROMO, explainer: EXPLAINER };
const found = EDITS[which];
if (!found) throw new Error(`unknown edit ${which}; promo | explainer`);
const edit: Edit = found;

const work = join(OUT, "work", edit.name);
mkdirSync(work, { recursive: true });

/* ---------- helpers ---------- */

function ffmpeg(args: string[], label: string): void {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "inherit", "pipe"], maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${label}):\nffmpeg ${args.join(" ")}\n${r.stderr}`);
}
function probe(file: string): { w: number; h: number; frames: number; dur: number } {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames:format=duration", "-of", "json", file], { encoding: "utf8" });
  const j = JSON.parse(r.stdout);
  return { w: j.streams[0].width, h: j.streams[0].height, frames: Number(j.streams[0].nb_frames ?? 0), dur: Number(j.format?.duration ?? 0) };
}
function audioDur(file: string): number {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  return Number(r.stdout.trim());
}
const fmt = (n: number) => Number(n.toFixed(4)).toString();
const shotFile = (shot: string) => join(SHOTS, shot, "shot.mp4");
const cardDir = (card: string) => join(SHOTS, card);
const cardFrames = (card: string) => readdirSync(cardDir(card)).filter((f) => /^f\d{5}\.png$/.test(f)).length;
interface EventsJson { frames: number; from?: number; events?: Record<string, { kind: string; x?: number; side?: number }[]>; sounds?: Record<string, string[]>; states?: Record<string, { f: { x: number }[] }> }
function shotEvents(shot: string): EventsJson {
  const dry = join(SHOTS, shot, "events.dry.json");
  const real = join(SHOTS, shot, "events.json");
  // the dry file has the sound cues; both index frames identically
  return JSON.parse(readFileSync(existsSync(dry) ? dry : real, "utf8"));
}

/**
 * A punch-in (with optional drift) on a source of sw×sh over `dur` seconds.
 * zoompan keeps the input's aspect, so a source that is not 16:9 (a tall page
 * still) is first cropped to a 16:9 band around the drift's midpoint and the
 * zoom runs inside that band (its centres remapped).
 */
function zoomFilter(z: Zoom | undefined, sw: number, sh: number, dur: number): string {
  const s0 = z?.scale ?? 1, s1 = z?.to?.scale ?? s0;
  const cx0 = z?.cx ?? 0.5, cx1 = z?.to?.cx ?? cx0;
  let cy0 = z?.cy ?? 0.5, cy1 = z?.to?.cy ?? cy0;
  let pre = "";
  const bandH = Math.round((sw * 9) / 16);
  if (Math.abs(sh - bandH) > 2) {
    const y = Math.max(0, Math.min(sh - bandH, Math.round(((cy0 + cy1) / 2) * sh - bandH / 2)));
    pre = `crop=w=${sw}:h=${bandH}:x=0:y=${y},`;
    cy0 = (cy0 * sh - y) / bandH;
    cy1 = (cy1 * sh - y) / bandH;
  }
  const frames = Math.max(1, Math.round(dur * 60));
  const p = `min(1\\,in/${frames})`;
  const zoom = `(${fmt(s0)}+(${fmt(s1)}-${fmt(s0)})*${p})`;
  const cx = `(${fmt(cx0)}+(${fmt(cx1)}-${fmt(cx0)})*${p})*iw`;
  const cy = `(${fmt(cy0)}+(${fmt(cy1)}-${fmt(cy0)})*${p})*ih`;
  const x = `max(0\\,min(iw-iw/zoom\\,${cx}-iw/zoom/2))`;
  const y = `max(0\\,min(ih-ih/zoom\\,${cy}-ih/zoom/2))`;
  return `${pre}zoompan=z='${zoom}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=60`;
}

/** phone captures: fit inside the frame on the pit background with a hairline */
function phoneFrame(sw: number, sh: number): string {
  const portrait = sh > sw;
  const th = portrait ? 1000 : 820;
  const tw = Math.round((th * sw) / sh);
  return `scale=${tw}:${th}:flags=lanczos,pad=${tw + 6}:${th + 6}:3:3:color=0x3a3345,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${PIT}`;
}

function fadeFilter(f: { in?: number; out?: number } | undefined, dur: number): string {
  const parts: string[] = [];
  if (f?.in) parts.push(`fade=t=in:st=0:d=${fmt(f.in)}:color=${PIT}`);
  if (f?.out) parts.push(`fade=t=out:st=${fmt(Math.max(0, dur - f.out))}:d=${fmt(f.out)}:color=${PIT}`);
  return parts.join(",");
}

/** overlay alpha card sequences (they hold their last frame until the segment ends, then fade) */
function overlayInputs(overlays: Overlay[] | undefined, dur: number, base: string, inputs: string[], startIdx: number): { chain: string; last: string } {
  if (!overlays?.length) return { chain: "", last: base };
  let last = base;
  let chain = "";
  overlays.forEach((o, i) => {
    const n = cardFrames(o.card);
    const idx = startIdx + i;
    inputs.push("-framerate", "60", "-start_number", "0", "-i", join(cardDir(o.card), "f%05d.png"));
    const hold = Math.max(0, dur - o.at - n / 60 + 1);
    const outFade = o.outFade ? `,fade=t=out:st=${fmt(dur - o.at - o.outFade)}:d=${fmt(o.outFade)}:alpha=1` : "";
    chain += `[${idx}:v]format=rgba,tpad=stop_mode=clone:stop_duration=${fmt(hold)},setpts=PTS+${fmt(o.at)}/TB${outFade}[ov${i}];`;
    chain += `[${last}][ov${i}]overlay=0:0:eof_action=pass:format=auto[o${i}];`;
    last = `o${i}`;
  });
  return { chain, last };
}

/* ---------- segments ---------- */

interface Rendered { file: string; dur: number; start: number; seg: Segment }

function renderSegment(seg: Segment, i: number): Rendered & { sfx: { t: number; name: string; pan: number }[] } {
  const file = join(work, `seg${String(i).padStart(2, "0")}.mp4`);
  // Unchanged segments are not re-rendered (the EDL entry is the cache key).
  const key = JSON.stringify({ seg, fps: edit.fps, v: 2 });
  const keyFile = file + ".json";
  const cached = existsSync(file) && existsSync(keyFile) && readFileSync(keyFile, "utf8") === key;
  const ffmpegSeg = (args: string[], label: string) => {
    if (cached) return;
    ffmpeg(args, label);
    writeFileSync(keyFile, key);
  };
  const enc = ["-r", String(edit.fps), "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-pix_fmt", "yuv420p", "-an", file];
  const sfx: { t: number; name: string; pan: number }[] = [];
  let dur = 0;

  if (seg.kind === "black") {
    dur = seg.dur;
    ffmpegSeg(["-f", "lavfi", "-i", `color=c=${PIT}:s=${W}x${H}:r=${edit.fps}:d=${fmt(dur)}`, ...enc], `black ${i}`);
  } else if (seg.kind === "card") {
    const n = cardFrames(seg.card);
    dur = seg.dur;
    const hold = Math.max(0, dur - n / 60);
    const fades = fadeFilter(seg.fade, dur);
    const vf = `[1:v]format=rgba,tpad=stop_mode=clone:stop_duration=${fmt(hold)}[c];[0:v][c]overlay=0:0:shortest=1:format=auto,trim=duration=${fmt(dur)},setpts=PTS-STARTPTS${fades ? "," + fades : ""}[v]`;
    ffmpegSeg(["-f", "lavfi", "-i", `color=c=${PIT}:s=${W}x${H}:r=60:d=${fmt(dur + 1)}`, "-framerate", "60", "-start_number", "0", "-i", join(cardDir(seg.card), "f%05d.png"), "-filter_complex", vf, "-map", "[v]", ...enc], `card ${i}`);
  } else if (seg.kind === "still") {
    const src = join(SHOTS, seg.file);
    const p = probe(src);
    dur = seg.dur;
    const inputs = ["-loop", "1", "-framerate", "60", "-t", fmt(dur + 0.1), "-i", src];
    let pre = "";
    if (seg.cover) for (const c of seg.cover) pre += `drawbox=x=${c.x}:y=${c.y}:w=${c.w}:h=${c.h}:color=${PIT}@1:t=fill,`;
    let view: string;
    if (seg.pan) {
      // a tall page: a 16:9 window slides from y=from to y=to
      const ph = seg.pan.height ?? Math.round((p.w * H) / W);
      view = `crop=w=${p.w}:h=${ph}:x=0:y='${fmt(seg.pan.from)}+(${fmt(seg.pan.to)}-${fmt(seg.pan.from)})*min(1\\,t/${fmt(dur)})',scale=${W}:${H}:flags=lanczos`;
    } else if (seg.phone) view = phoneFrame(p.w, p.h);
    else view = zoomFilter(seg.zoom, p.w, p.h, dur);
    const ov = overlayInputs(seg.overlays, dur, "base", inputs, 1);
    const fades = fadeFilter(seg.fade, dur);
    const vf = `[0:v]${pre}${view},trim=duration=${fmt(dur)},setpts=PTS-STARTPTS[base];${ov.chain}[${ov.last}]${fades ? fades + "," : ""}format=yuv420p[v]`;
    ffmpegSeg([...inputs, "-filter_complex", vf, "-map", "[v]", "-t", fmt(dur), ...enc], `still ${i}`);
  } else {
    const src = shotFile(seg.shot);
    const p = probe(src);
    const speed = seg.speed ?? 1;
    const n = seg.out - seg.in;
    dur = n / 60 / speed;
    const inputs = ["-i", src];
    const view = seg.phone ? phoneFrame(p.w, p.h) : zoomFilter(seg.zoom, p.w, p.h, dur);
    const ov = overlayInputs(seg.overlays, dur, "base", inputs, 1);
    const fades = fadeFilter(seg.fade, dur);
    const vf = `[0:v]trim=start_frame=${seg.in}:end_frame=${seg.out},setpts=(PTS-STARTPTS)/${fmt(speed)},fps=60,${view}[base];${ov.chain}[${ov.last}]${fades ? fades + "," : ""}format=yuv420p[v]`;
    ffmpegSeg([...inputs, "-filter_complex", vf, "-map", "[v]", "-t", fmt(dur), ...enc], `clip ${i} (${seg.shot})`);
    if (seg.sfx) {
      const ev = shotEvents(seg.shot);
      for (const [k, names] of Object.entries(ev.sounds ?? {})) {
        const f = Number(k);
        if (f < seg.in || f >= seg.out) continue;
        const t = (f - seg.in) / 60 / speed;
        const st = ev.states?.[k];
        const hit = ev.events?.[k]?.find((e) => e.kind === "hit");
        const x = hit?.x ?? st?.f[0]?.x ?? 0;
        const pan = Math.max(-1, Math.min(1, x / 10000)) * 0.5;
        for (const name of names) sfx.push({ t, name, pan });
      }
    }
  }
  return { file, dur, start: 0, seg, sfx };
}

/* ---------- audio ---------- */

const GAIN: Record<string, number> = {
  hit_light: 0.8, hit_heavy: 0.95, hit_slam: 1, hit_super: 1, block: 0.7, whiff_light: 0.35, whiff_heavy: 0.45,
  scream_light: 0.5, scream_medium: 0.6, scream_heavy: 0.7, scream_ko: 0.8, crowd_swell: 0.5, crowd_roar: 0.7, ko_horn: 0.9,
  round_bell: 0.8, countdown_tick: 0.6, fight: 0.8, ringout: 0.9, super_start: 0.9, heat_full: 0.7, dash: 0.4, jump: 0.3, land: 0.35,
  timeout: 0.7, win_jingle: 0.8, crowd_loop: 0.22, impact: 1, stinger: 0.9,
};

function synthImpacts(): void {
  const dir = join(OUT, "sfx");
  const impact = join(dir, "impact.wav");
  if (!existsSync(impact)) {
    // a sub thump + a short noise crack, for the logo slams
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=48:duration=1.2", "-f", "lavfi", "-i", "anoisesrc=color=brown:duration=0.35:amplitude=0.9",
      "-filter_complex", "[0:a]afade=t=out:st=0.05:d=1.1,volume=1.6[s];[1:a]highpass=f=120,afade=t=out:st=0.02:d=0.3,volume=0.7[n];[s][n]amix=inputs=2:normalize=0,alimiter=limit=0.95[a]", "-map", "[a]", "-ar", "48000", impact], "impact");
  }
}

function pan2(p: number): string {
  const l = Math.sqrt((1 - p) / 2), r = Math.sqrt((1 + p) / 2);
  return `pan=stereo|c0=${fmt(l)}*c0|c1=${fmt(r)}*c0`;
}

function buildAudio(rendered: (Rendered & { sfx: { t: number; name: string; pan: number }[] })[], total: number): string {
  synthImpacts();
  const sfxDir = join(OUT, "sfx");
  const inputs: string[] = [];
  const chains: string[] = [];
  const mixIn: string[] = [];
  let idx = 0;
  const add = (file: string, t: number, gain: number, pan: number, extra = "") => {
    inputs.push("-i", file);
    const d = Math.round(t * 1000);
    chains.push(`[${idx}:a]aformat=sample_rates=48000:channel_layouts=mono,${pan2(pan)},volume=${fmt(gain)}${extra},adelay=${d}|${d}[a${idx}]`);
    mixIn.push(`[a${idx}]`);
    idx++;
  };
  // game sounds at their ticks
  for (const r of rendered) {
    for (const s of r.sfx) {
      const f = join(sfxDir, s.name + ".wav");
      if (!existsSync(f) || s.name === "crowd_loop") continue;
      add(f, r.start + s.t, (GAIN[s.name] ?? 0.6) * (edit.sfxGain ?? 1), s.pan);
    }
    // crowd bed under fight clips
    if (r.seg.kind === "clip" && r.seg.crowd) {
      const loop = join(sfxDir, "crowd_loop.wav");
      if (existsSync(loop)) {
        inputs.push("-stream_loop", "-1", "-i", loop);
        const d = Math.round(r.start * 1000);
        chains.push(`[${idx}:a]aformat=sample_rates=48000:channel_layouts=mono,atrim=duration=${fmt(r.dur)},${pan2(0)},volume=${fmt((GAIN.crowd_loop ?? 0.2) * (edit.sfxGain ?? 1))},afade=t=in:d=0.15,afade=t=out:st=${fmt(Math.max(0, r.dur - 0.2))}:d=0.2,adelay=${d}|${d}[a${idx}]`);
        mixIn.push(`[a${idx}]`);
        idx++;
      }
    }
  }
  for (const c of edit.cues) add(join(sfxDir, c.file + ".wav"), c.t, (c.gain ?? 1) * (GAIN[c.file] ?? 1) * (edit.sfxGain ?? 1), c.pan ?? 0);
  // VO (each take is split: one copy into the mix, one into the music's sidechain key)
  const voStarts = voTimes(rendered);
  const voKeys: string[] = [];
  edit.vo.forEach((v, i) => {
    const t = voStarts[i];
    if (t == null) return;
    inputs.push("-i", join(OUT, "vo", v.file));
    const d = Math.round(t * 1000);
    chains.push(`[${idx}:a]aformat=sample_rates=48000:channel_layouts=mono,highpass=f=70,acompressor=threshold=-18dB:ratio=3:attack=5:release=80,volume=${fmt((v.gain ?? 1) * 1.4)},${pan2(0)},adelay=${d}|${d},asplit=2[a${idx}][k${idx}]`);
    mixIn.push(`[a${idx}]`);
    voKeys.push(`[k${idx}]`);
    idx++;
  });
  // music (optional), ducked under the VO with a sidechain compressor
  const musicFile = edit.music ? findMusic(edit.music.file) : null;
  if (musicFile) {
    const musicLen = audioDur(musicFile);
    // A bed shorter than the picture loops (the seam falls under the end card); a longer one is faded out.
    if (musicLen < total) inputs.push("-stream_loop", "-1");
    inputs.push("-i", musicFile);
    const m = idx++;
    const fadeOut = musicLen > total + 0.5 || musicLen < total ? `,afade=t=out:st=${fmt(Math.max(0, total - 2.5))}:d=2.5` : "";
    const bed = `[${m}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=duration=${fmt(total)}${fadeOut},volume=${fmt(edit.music!.gain)}[m0]`;
    if (edit.music!.duck && voKeys.length) {
      chains.push(`${voKeys.join("")}amix=inputs=${voKeys.length}:normalize=0,apad,atrim=duration=${fmt(total)}[vokey]`);
      chains.push(bed);
      chains.push(`[m0][vokey]sidechaincompress=threshold=0.08:ratio=4:attack=20:release=600:level_sc=1.2:makeup=1[music]`);
    } else {
      chains.push(bed.replace("[m0]", "[music]"));
      // unused keys must still be consumed
      if (voKeys.length) chains.push(`${voKeys.join("")}amix=inputs=${voKeys.length}:normalize=0,anullsink`);
    }
    mixIn.push("[music]");
  } else if (voKeys.length) {
    chains.push(`${voKeys.join("")}amix=inputs=${voKeys.length}:normalize=0,anullsink`);
  }
  // a silent full-length bed so the mix always runs to the end of the picture
  inputs.push("-f", "lavfi", "-t", fmt(total), "-i", "anullsrc=r=48000:cl=stereo");
  mixIn.push(`[${idx}:a]`);
  idx++;
  const mixed = join(work, "mix.wav");
  const n = mixIn.length;
  const fc = `${chains.join(";")};${mixIn.join("")}amix=inputs=${n}:normalize=0:dropout_transition=0,atrim=duration=${fmt(total)},alimiter=limit=0.97,loudnorm=I=-14:TP=-1.5:LRA=11[out]`;
  ffmpeg([...inputs, "-filter_complex", fc, "-map", "[out]", "-ar", "48000", "-ac", "2", mixed], "mix");
  return mixed;
}

function findMusic(base: string): string | null {
  const dir = join(OUT, "music");
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((f) => f.toLowerCase().startsWith(base) && /\.(wav|mp3|aif|aiff|m4a|flac)$/i.test(f));
  return f ? join(dir, f) : null;
}

/** VO start times: explicit `t`, or the start of the segment that carries the index */
function voTimes(rendered: Rendered[]): (number | undefined)[] {
  return edit.vo.map((v, i) => {
    if (v.t != null) return v.t;
    const seg = rendered.find((r) => r.seg.vo === i);
    return seg ? seg.start + 0.25 : undefined;
  });
}

/* ---------- captions ---------- */

function srtTime(t: number): string {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
}
function captions(rendered: Rendered[]): { srt: string; lines: { a: number; b: number; text: string }[] } {
  const starts = voTimes(rendered);
  const lines: { a: number; b: number; text: string }[] = [];
  edit.vo.forEach((v, i) => {
    const t0 = starts[i];
    if (t0 == null || !v.text) return;
    const d = audioDur(join(OUT, "vo", v.file));
    const parts = v.text.split("|").map((s) => s.trim()).filter(Boolean);
    const chars = parts.reduce((a, p) => a + p.length, 0);
    let t = t0;
    for (const p of parts) {
      const dd = (d * p.length) / chars;
      lines.push({ a: t, b: t + dd - 0.05, text: p });
      t += dd;
    }
  });
  const srt = lines.map((l, i) => `${i + 1}\n${srtTime(l.a)} --> ${srtTime(l.b)}\n${l.text}\n`).join("\n");
  return { srt, lines };
}

/* ---------- main ---------- */

console.log(`building ${edit.name} (${edit.segments.length} segments)…`);
const rendered: (Rendered & { sfx: { t: number; name: string; pan: number }[] })[] = [];
let t = 0;
edit.segments.forEach((seg, i) => {
  const r = renderSegment(seg, i);
  r.start = t;
  t += r.dur;
  rendered.push(r);
  process.stdout.write(`  ${String(i).padStart(2, "0")} ${seg.kind.padEnd(5)} ${fmt(r.start).padStart(7)}s +${fmt(r.dur)}s${"shot" in seg ? " " + seg.shot : "card" in seg ? " " + seg.card : "file" in seg ? " " + seg.file : ""}\n`);
});
const total = t;
console.log(`  total ${fmt(total)}s`);

// concat video
const list = join(work, "list.txt");
writeFileSync(list, rendered.map((r) => `file '${r.file.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
const video = join(work, "video.mp4");
ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", video], "concat");

// audio
const mix = buildAudio(rendered, total);

// captions (alpha PNGs from the rig) + mux
const final = join(OUT, `${edit.name}.mp4`);
const capInputs: string[] = [];
let capChain = "";
if (edit.captions) {
  const c = captions(rendered);
  writeFileSync(join(OUT, `${edit.name}.srt`), c.srt);
  const capDir = join(work, "cap");
  const linesFile = join(work, "captions.json");
  const key = JSON.stringify(c.lines.map((l) => l.text));
  const doneFile = join(work, "captions.done");
  if (!existsSync(doneFile) || readFileSync(doneFile, "utf8") !== key) {
    writeFileSync(linesFile, key);
    const r = spawnSync("npx", ["tsx", join(import.meta.dirname, "captions.ts"), linesFile, capDir], { stdio: "inherit", cwd: join(repo, "tools") });
    if (r.status !== 0) throw new Error("captions render failed");
    writeFileSync(doneFile, key);
  }
  let last = "0:v";
  c.lines.forEach((l, i) => {
    capInputs.push("-i", join(capDir, `cap${String(i).padStart(2, "0")}.png`));
    const idx = 2 + i;
    capChain += `[${last}][${idx}:v]overlay=0:0:enable='between(t\\,${fmt(l.a)}\\,${fmt(l.b)})':format=auto[c${i}];`;
    last = `c${i}`;
  });
  capChain = capChain.replace(/\[c(\d+)\];$/, "[vout]");
  if (!c.lines.length) capChain = "";
}
const vfArgs = capChain ? ["-filter_complex", capChain, "-map", "[vout]", "-map", "1:a"] : ["-map", "0:v", "-map", "1:a"];
ffmpeg(["-i", video, "-i", mix, ...capInputs, ...vfArgs, "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-profile:v", "high", "-r", String(edit.fps),
  "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", final], "mux");
const p = probe(final);
console.log(`→ ${final}  ${p.w}×${p.h} ${fmt(p.dur)}s ${edit.fps}fps`);
const voStarts = voTimes(rendered);
edit.vo.forEach((v, i) => {
  const t0 = voStarts[i];
  if (t0 == null) return;
  const d = audioDur(join(OUT, "vo", v.file));
  const next = voStarts.slice(i + 1).find((x) => x != null) ?? total;
  const slack = next - (t0 + d);
  console.log(`  vo ${i} ${v.file} at ${fmt(t0)}s for ${fmt(d)}s, ${slack >= 0 ? "slack" : "OVERLAP"} ${fmt(Math.abs(slack))}s`);
});
