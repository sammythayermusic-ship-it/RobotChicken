/**
 * /admin: Sammy's console (spec: basic auth, allowlisted IPs). Flagged
 * matches with the replay, wallet and hashes; one-click clear / void / ban;
 * the pool knobs (P_min, P_max, the guarantees, the caps), the payouts pause
 * switch, the seed top-up. It writes the settings and players tables through
 * the service key; the worker reads the settings every minute.
 *
 * Off (404) unless ADMIN_PASSWORD is set. Basic auth is compared in constant
 * time; with ADMIN_ALLOWED_IPS set, any other IP gets 403 before the password
 * is even looked at.
 */
import { timingSafeEqual } from "node:crypto";
import type { GameEnv } from "@cockfight/shared/env";
import { isWalletAddress } from "@cockfight/solana";
import { supabaseHeaders } from "./results";

export interface AdminDeps {
  env: GameEnv;
  fetch: typeof fetch;
  /** The web app's origin (replay links). */
  webOrigin: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KNOBS = ["p_min_usd", "p_max_usd", "g_win_usd", "g_daily_usd", "max_payout_usd", "max_daily_reward_usd", "max_hourly_usd", "max_daily_usd", "w_floor", "reserve_usd", "reserve_arm_usd"] as const;
type Knob = (typeof KNOBS)[number];

export type AdminResult = { status: number; body: unknown; html?: string };

export class AdminService {
  private readonly d: AdminDeps;
  constructor(d: AdminDeps) {
    this.d = d;
  }

  get enabled(): boolean {
    return !!this.d.env.ADMIN_PASSWORD && !!this.d.env.SUPABASE_URL && !!this.d.env.SUPABASE_SERVICE_ROLE_KEY;
  }

  /** 404 when off, 403 off the allowlist, 401 without the password, null when the request may proceed. */
  gate(headers: Headers, ip: string | null): AdminResult | null {
    if (!this.enabled) return { status: 404, body: { error: "not found" } };
    const allow = this.d.env.ADMIN_ALLOWED_IPS;
    if (allow.length > 0 && (!ip || !allow.includes(ip))) return { status: 403, body: { error: "forbidden" } };
    const auth = headers.get("authorization") ?? "";
    const [scheme, encoded] = auth.split(" ");
    if (scheme?.toLowerCase() !== "basic" || !encoded) return { status: 401, body: { error: "auth" } };
    let pass = "";
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      pass = decoded.slice(decoded.indexOf(":") + 1);
    } catch {
      return { status: 401, body: { error: "auth" } };
    }
    const want = Buffer.from(this.d.env.ADMIN_PASSWORD as string);
    const got = Buffer.from(pass);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return { status: 401, body: { error: "auth" } };
    return null;
  }

  private async db<T>(method: string, path: string, body?: unknown, prefer?: string): Promise<T> {
    const headers = supabaseHeaders(this.d.env.SUPABASE_SERVICE_ROLE_KEY as string);
    if (prefer) headers.prefer = prefer;
    const res = await this.d.fetch(`${this.d.env.SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`supabase ${method} ${path.split("?")[0]}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Everything the page shows, in one call. */
  async state(): Promise<AdminResult> {
    const [pool, settings, seed, flagged, events, held, payouts, players] = await Promise.all([
      this.db<unknown[]>("GET", "pool_state?select=*"),
      this.db<{ key: string; value: unknown; updated_at: string; updated_by: string | null }[]>("GET", "settings?select=*"),
      this.db<unknown[]>("GET", "seed?select=*"),
      this.db<unknown[]>("GET", "matches?select=id,p1,p2,winner,reason,ended_at,flag,payout,tier_paid,quality_bps,net_quality_p1,net_quality_p2,p1_ip_hash,p2_ip_hash,p1_fp,p2_fp&flag=not.is.null&order=ended_at.desc&limit=50"),
      this.db<unknown[]>("GET", "abuse_events?select=*&resolved_at=is.null&order=created_at.desc&limit=100"),
      this.db<unknown[]>("GET", "payouts?select=id,idem_key,to_address,amount,usd,status,last_error,attempts,created_at&status=in.(deferred,failed)&order=created_at.desc&limit=100"),
      this.db<unknown[]>("GET", "payouts?select=status,count:id.count()&status=in.(pending,deferred,sent,paid,failed,voided)"),
      this.db<unknown[]>("GET", "players?select=address,username,tier,elo,flagged,banned_until,last_seen&or=(flagged.eq.true,banned_until.gt.now)&order=last_seen.desc&limit=100"),
    ]);
    return { status: 200, body: { pool: pool[0] ?? null, settings, seed: seed[0] ?? null, flagged, events, held, payouts, players, webOrigin: this.d.webOrigin, knobs: KNOBS } };
  }

  async setKnob(body: unknown): Promise<AdminResult> {
    const b = obj(body);
    const key = String(b.key ?? "");
    if (!KNOBS.includes(key as Knob)) return { status: 400, body: { error: `unknown knob ${key}` } };
    const value = Number(b.value);
    if (!Number.isFinite(value) || value < 0) return { status: 400, body: { error: "value must be a number >= 0" } };
    await this.upsertSetting(key, value);
    return { status: 200, body: { ok: true, key, value } };
  }

  async clearKnob(body: unknown): Promise<AdminResult> {
    const key = String(obj(body).key ?? "");
    if (!KNOBS.includes(key as Knob)) return { status: 400, body: { error: `unknown knob ${key}` } };
    await this.db("DELETE", `settings?key=eq.${key}`);
    return { status: 200, body: { ok: true, key } };
  }

  async pause(body: unknown): Promise<AdminResult> {
    const b = obj(body);
    const paused = b.paused === true;
    const reason = paused ? String(b.reason ?? "paused from /admin").slice(0, 200) : null;
    await this.upsertSetting("payouts_paused", { paused, reason, at: new Date().toISOString() });
    return { status: 200, body: { ok: true, paused } };
  }

  /** Add PUMP Sammy already sent to the hot wallet to the prize pot (whole tokens, 6 decimals, or raw units). */
  async seedTopup(body: unknown): Promise<AdminResult> {
    const b = obj(body);
    let raw = String(b.amount ?? "");
    const tokens = String(b.tokens ?? "").trim();
    if (tokens) {
      const m = /^(\d{1,24})(?:\.(\d{1,6}))?$/.exec(tokens);
      if (!m) return { status: 400, body: { error: "tokens: a number of PUMP, up to 6 decimals" } };
      raw = (BigInt(m[1] as string) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0")).toString();
    }
    if (!/^\d{1,30}$/.test(raw) || BigInt(raw) === 0n) return { status: 400, body: { error: "amount: raw units (a positive integer)" } };
    await this.db("POST", "rpc/seed_topup", { p_amount: raw });
    return { status: 200, body: { ok: true, amount: raw } };
  }

  /** flag / clear / ban (hours) / unban a wallet. */
  async player(body: unknown): Promise<AdminResult> {
    const b = obj(body);
    const address = String(b.address ?? "");
    if (!isWalletAddress(address)) return { status: 400, body: { error: "address" } };
    const action = String(b.action ?? "");
    const patch: Record<string, unknown> =
      action === "flag" ? { flagged: true }
      : action === "clear" ? { flagged: false }
      : action === "ban" ? { banned_until: new Date(Date.now() + Math.max(1, Math.min(24 * 30, Number(b.hours) || 24)) * 3_600_000).toISOString() }
      : action === "unban" ? { banned_until: null }
      : {};
    if (Object.keys(patch).length === 0) return { status: 400, body: { error: "action: flag | clear | ban | unban" } };
    const rows = await this.db<unknown[]>("PATCH", `players?address=eq.${address}`, patch, "return=representation");
    if (rows.length === 0) {
      await this.db("POST", "players", { address, ...patch }, "return=minimal");
    }
    return { status: 200, body: { ok: true, address, ...patch } };
  }

  /** clear (release the held payout) / void (cancel it) a flagged match, and resolve its abuse events. */
  async match(body: unknown): Promise<AdminResult> {
    const b = obj(body);
    const id = String(b.id ?? "");
    if (!UUID.test(id)) return { status: 400, body: { error: "id" } };
    const action = String(b.action ?? "");
    if (action !== "clear" && action !== "void") return { status: 400, body: { error: "action: clear | void" } };
    const payoutPatch =
      action === "clear"
        ? { status: "pending", next_attempt_at: null, last_error: null }
        : { status: "voided", last_error: "voided from /admin" };
    await this.db("PATCH", `payouts?idem_key=eq.win:${id}&status=in.(pending,deferred)`, payoutPatch);
    await this.db("PATCH", `matches?id=eq.${id}`, { flag: action === "clear" ? null : "voided" });
    await this.db("PATCH", `abuse_events?match_id=eq.${id}&resolved_at=is.null`, { resolved_by: "admin", resolved_at: new Date().toISOString() });
    return { status: 200, body: { ok: true, id, action } };
  }

  /** retry (back to pending) / void a deferred or failed payout. */
  async payout(body: unknown): Promise<AdminResult> {
    const b = obj(body);
    const id = String(b.id ?? "");
    if (!UUID.test(id)) return { status: 400, body: { error: "id" } };
    const action = String(b.action ?? "");
    const patch =
      action === "retry" ? { status: "pending", next_attempt_at: null, last_error: null, tx_sig: null, sent_at: null }
      : action === "void" ? { status: "voided", last_error: "voided from /admin" }
      : null;
    if (!patch) return { status: 400, body: { error: "action: retry | void" } };
    const rows = await this.db<unknown[]>("PATCH", `payouts?id=eq.${id}&status=in.(deferred,failed,pending)`, patch, "return=representation");
    return { status: 200, body: { ok: rows.length === 1, id, action } };
  }

  private async upsertSetting(key: string, value: unknown): Promise<void> {
    await this.db("POST", "settings?on_conflict=key", { key, value, updated_at: new Date().toISOString(), updated_by: "admin" }, "resolution=merge-duplicates,return=minimal");
  }
}

function obj(body: unknown): Record<string, unknown> {
  return (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
}

/** The console: one page of plain HTML and JS talking to /admin/api/*. */
export const ADMIN_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>COCKFIGHT admin</title>
<style>
body{font:14px/1.4 ui-monospace,Menlo,monospace;background:#0b0a10;color:#e6e1d8;margin:0;padding:16px}
h1{font-size:18px;margin:0 0 12px}h2{font-size:15px;margin:20px 0 8px;color:#f7b955}
section{border:1px solid #333;border-radius:8px;padding:12px;margin-bottom:12px;background:#12111a}
table{border-collapse:collapse;width:100%}td,th{border-top:1px solid #2a2a33;padding:4px 6px;text-align:left;vertical-align:top;font-size:12px}
button{background:#222;color:#e6e1d8;border:1px solid #555;border-radius:4px;padding:3px 8px;cursor:pointer}button:hover{border-color:#f7b955}
button.danger{border-color:#c33}input{background:#000;color:#fff;border:1px solid #555;border-radius:4px;padding:3px 6px;width:8em}
.ok{color:#9be564}.bad{color:#ff5c8a}.muted{color:#888}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}
a{color:#5cd6ff}#msg{position:fixed;right:16px;bottom:16px;background:#222;padding:8px 12px;border-radius:6px;display:none}
</style></head><body>
<h1>COCKFIGHT admin <span id="clock" class="muted"></span></h1>
<section id="pool"><h2>Pool</h2><div class="grid" id="poolGrid"></div></section>
<section><h2>Payouts</h2>
<p id="pauseLine"></p>
<button id="pauseBtn"></button> <span class="muted">A cap hit pauses on its own; clear it here once you've looked.</span>
<p id="counts" class="muted"></p></section>
<section><h2>Knobs <span class="muted">(USD; blank = the env default; the worker reads them within a minute)</span></h2><div class="grid" id="knobs"></div></section>
<section><h2>Prize pot</h2><p id="seedLine"></p>
<label>add to prize pool (PUMP tokens) <input id="topup" placeholder="e.g. 7500"></label> <button id="topupBtn">Add</button>
<span class="muted">Only after the PUMP has actually landed in the HOT wallet. Wins pay from it within a minute.</span></section>
<section><h2>Flagged matches (payout held)</h2><table id="flagged"></table></section>
<section><h2>Held / failed payouts</h2><table id="held"></table></section>
<section><h2>Flagged and banned wallets</h2>
<p><input id="pAddr" placeholder="wallet address" style="width:28em"> <button data-p="flag">Flag</button> <button data-p="clear">Clear</button> <button data-p="ban" class="danger">Ban 24h</button> <button data-p="unban">Unban</button></p>
<table id="players"></table></section>
<section><h2>Open abuse events</h2><table id="events"></table></section>
<div id="msg"></div>
<script>
const $=s=>document.querySelector(s);const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
let S=null;
function toast(t,bad){const m=$("#msg");m.textContent=t;m.style.display="block";m.style.color=bad?"#ff5c8a":"#9be564";setTimeout(()=>m.style.display="none",3000)}
async function api(path,body){const r=await fetch("/admin/api/"+path,{method:body?"POST":"GET",headers:{"content-type":"application/json"},body:body?JSON.stringify(body):undefined});const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||("HTTP "+r.status),true);throw new Error(j.error)}return j}
const usd=(raw,p)=>p?"$"+((Number(raw)/10**p.decimals)*Number(p.price_usd)).toFixed(2):"?";
function render(){const p=S.pool;const paused=(S.settings.find(s=>s.key==="payouts_paused")||{}).value||{};
$("#clock").textContent=new Date().toISOString();
$("#poolGrid").innerHTML=p?[["next Rust win",usd(p.win_rust,p)],["next Chrome win",usd(p.win_chrome,p)],["next Gold win",usd(p.win_gold,p)],["today's top-10 pool",usd(p.daily_pool,p)],["per-win budget (D)",usd(p.per_win_budget,p)],["weighted matches 24h",(Number(p.weighted_milli)/1000).toFixed(1)],["gross fees 24h",usd(p.gross_24h,p)],["allowance (ledger)",usd(p.allowance,p)],["outstanding (booked, unsent)",usd(p.outstanding,p)],["hot target",usd(p.hot_target,p)],["price",("$"+Number(p.price_usd))],["computed",new Date(p.computed_at).toISOString()]].map(([k,v])=>"<div><div class=muted>"+k+"</div><div>"+esc(v)+"</div></div>").join(""):"<div class=muted>no pool yet (worker not running)</div>";
$("#pauseLine").innerHTML=paused.paused?"<span class=bad>PAUSED</span> — "+esc(paused.reason||"")+" <span class=muted>"+esc(paused.at||"")+"</span>":"<span class=ok>payouts running</span>";
$("#pauseBtn").textContent=paused.paused?"Resume payouts":"Pause payouts";$("#pauseBtn").className=paused.paused?"":"danger";
$("#counts").textContent="payouts: "+S.payouts.map(r=>r.status+" "+r.count).join(" · ");
$("#knobs").innerHTML=S.knobs.map(k=>{const s=S.settings.find(x=>x.key===k);return "<div><div class=muted>"+k+"</div><input data-k='"+k+"' value='"+esc(s?s.value:"")+"'> <button data-set='"+k+"'>Set</button> <button data-clr='"+k+"'>Default</button></div>"}).join("");
const pd=(S.pool&&S.pool.detail)||{};$("#seedLine").textContent=S.pool?"pot "+usd(pd.pot||"0",p)+" · reserve "+usd(pd.reserve||"0",p)+" · available for wins "+usd(S.pool.win_available||"0",p)+" · next Rust win "+usd(S.pool.win_rust||"0",p):"—";
$("#flagged").innerHTML="<tr><th>ended</th><th>match</th><th>winner</th><th>flag</th><th>tier / q</th><th>net q</th><th>payout</th><th>hashes</th><th></th></tr>"+(S.flagged.length?S.flagged.map(m=>"<tr><td>"+esc(m.ended_at)+"</td><td><a href='"+esc(S.webOrigin)+"/m/"+m.id+"' target=_blank>replay</a> <span class=muted>"+m.id.slice(0,8)+"</span></td><td><a href='"+esc(S.webOrigin)+"/p/"+esc(m.winner)+"' target=_blank>"+esc(m.winner)+"</a></td><td class=bad>"+esc(m.flag)+"</td><td>"+esc(m.tier_paid)+" / "+esc(m.quality_bps)+"</td><td>"+esc(m.net_quality_p1)+" / "+esc(m.net_quality_p2)+"</td><td>"+esc(m.payout)+"</td><td class=muted>"+esc((m.winner===m.p1?m.p1_ip_hash:m.p2_ip_hash)||"-")+"<br>"+esc((m.winner===m.p1?m.p1_fp:m.p2_fp)||"-")+"</td><td><button data-m='clear' data-id='"+m.id+"'>Clear &amp; pay</button> <button data-m='void' data-id='"+m.id+"' class=danger>Void</button> <button data-p='ban' data-addr='"+esc(m.winner)+"' class=danger>Ban 24h</button></td></tr>").join(""):"<tr><td colspan=9 class=muted>none</td></tr>");
$("#held").innerHTML="<tr><th>created</th><th>key</th><th>to</th><th>amount</th><th>status</th><th>why</th><th>tries</th><th></th></tr>"+(S.held.length?S.held.map(x=>"<tr><td>"+esc(x.created_at)+"</td><td>"+esc(x.idem_key)+"</td><td>"+esc(x.to_address)+"</td><td>"+esc(x.amount)+" ("+esc(x.usd)+")</td><td>"+esc(x.status)+"</td><td>"+esc(x.last_error)+"</td><td>"+esc(x.attempts)+"</td><td><button data-po='retry' data-id='"+x.id+"'>Retry</button> <button data-po='void' data-id='"+x.id+"' class=danger>Void</button></td></tr>").join(""):"<tr><td colspan=8 class=muted>none</td></tr>");
$("#players").innerHTML="<tr><th>address</th><th>name</th><th>tier</th><th>flagged</th><th>banned until</th><th>last seen</th></tr>"+(S.players.length?S.players.map(x=>"<tr><td>"+esc(x.address)+"</td><td>"+esc(x.username)+"</td><td>"+esc(x.tier)+"</td><td>"+(x.flagged?"<span class=bad>yes</span>":"")+"</td><td>"+esc(x.banned_until||"")+"</td><td>"+esc(x.last_seen)+"</td></tr>").join(""):"<tr><td colspan=6 class=muted>none</td></tr>");
$("#events").innerHTML="<tr><th>at</th><th>kind</th><th>address</th><th>match</th><th>details</th></tr>"+(S.events.length?S.events.map(e=>"<tr><td>"+esc(e.created_at)+"</td><td>"+esc(e.kind)+"</td><td>"+esc(e.address)+"</td><td>"+(e.match_id?"<a href='"+esc(S.webOrigin)+"/m/"+e.match_id+"' target=_blank>replay</a>":"")+"</td><td>"+esc(JSON.stringify(e.details))+"</td></tr>").join(""):"<tr><td colspan=5 class=muted>none</td></tr>");}
async function load(){S=await api("state");render()}
document.addEventListener("click",async e=>{const b=e.target.closest("button");if(!b)return;try{
if(b.id==="pauseBtn"){const paused=!((S.settings.find(s=>s.key==="payouts_paused")||{}).value||{}).paused;await api("pause",{paused,reason:paused?prompt("Reason?")||"paused from /admin":null})}
else if(b.dataset.set){await api("knob",{key:b.dataset.set,value:$("input[data-k='"+b.dataset.set+"']").value})}
else if(b.dataset.clr){await api("knob/clear",{key:b.dataset.clr})}
else if(b.id==="topupBtn"){await api("seed/topup",{tokens:$("#topup").value.trim()})}
else if(b.dataset.m){if(b.dataset.m==="void"&&!confirm("Void this payout?"))return;await api("match",{id:b.dataset.id,action:b.dataset.m})}
else if(b.dataset.po){if(b.dataset.po==="void"&&!confirm("Void this payout?"))return;await api("payout",{id:b.dataset.id,action:b.dataset.po})}
else if(b.dataset.p){const address=b.dataset.addr||$("#pAddr").value.trim();if(!address)return toast("address?",true);if(b.dataset.p==="ban"&&!confirm("Ban "+address+" for 24 h?"))return;await api("player",{address,action:b.dataset.p,hours:24})}
else return;toast("done");await load()}catch(err){}});
load().catch(()=>toast("couldn't load",true));setInterval(()=>load().catch(()=>{}),30000);
</script></body></html>`;
