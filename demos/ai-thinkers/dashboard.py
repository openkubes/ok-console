#!/usr/bin/env python3
"""Read-only, loopback-only AI Thinkers HOTL event dashboard (local demo only)."""
import argparse
import json
import os
import stat
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-HOTL_DEMO'; style-src 'nonce-HOTL_DEMO'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<title>OpenKubes AI Thinkers | HOTL</title>
<style nonce="HOTL_DEMO">
:root{color-scheme:dark;font-family:system-ui,-apple-system,sans-serif;background:#080f20;color:#edf3ff}
*{box-sizing:border-box}body{margin:0}main{max-width:1060px;margin:0 auto;padding:34px 22px 70px}
h1{font-size:clamp(30px,5vw,49px);margin:10px 0}h1 em{font-style:normal;color:#4de1e9}
p,.muted{color:#a9bad3}h2{font-size:18px;margin:0 0 18px}.eyebrow{letter-spacing:.17em;font-weight:700;font-size:12px;color:#58e6e5}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px;margin:24px 0}
.card{background:#111f36;border:1px solid #2c405f;border-radius:16px;padding:22px;min-width:0}
.big{font-size:28px;font-weight:800;overflow-wrap:anywhere}.green{color:#5ae1af}.cyan{color:#51dfef}.amber{color:#ffc878}
.flow{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px;margin:23px 0}
.step{border:1px solid #344b67;border-radius:12px;padding:14px 8px;text-align:center;background:#13243c;font-size:13px}
.step.done{background:#113a37;border-color:#2d9d87}.step.fail{background:#412331;border-color:#ff7598}
.step span{display:block;font-size:22px;font-weight:800;margin-bottom:8px;color:#56e4ef}
.timeline{display:flex;flex-direction:column;gap:10px}.event{padding:14px 16px;border-radius:11px;background:#0b172b;border:1px solid #263951}
.event b{font-size:13px;letter-spacing:.03em}.event time{color:#9fb0c6;font-size:12px;float:right}
.event small{display:block;color:#a8b9cf;margin-top:7px;overflow-wrap:anywhere}
.banner{padding:13px 16px;background:#14233a;border:1px solid #2d415e;border-radius:12px;margin:14px 0}
footer{margin-top:24px;font-size:12px;color:#93a7c1}a{color:#56e4ef}
@media(max-width:720px){.grid{grid-template-columns:1fr}.flow{grid-template-columns:1fr 1fr}.event time{float:none;display:block;margin-top:6px}}
</style></head><body><main>
<div class="eyebrow">OPENKUBES · LOCAL KIND EXPERIMENT</div>
<h1>AI Thinkers <em>HOTL</em></h1>
<p>Human-on-the-Loop · AI proposes · Policy constrains · Kubernetes recovers · Evidence records</p>
<div class="banner" id="notice">Waiting for local events. Start the HOTL supervisor in a separate terminal.</div>
<div class="grid">
<div class="card"><div class="muted">Recorded session mode</div><div class="big cyan" id="mode">—</div></div>
<div class="card"><div class="muted">Latest observed result</div><div class="big" id="result">—</div></div>
<div class="card"><div class="muted">Events recorded</div><div class="big" id="count">0</div></div>
</div>
<section class="card"><h2>Recovery sequence</h2>
<div class="flow" id="flow">
<div class="step" data-event="HOTL_ENABLED"><span>01</span>Enable HOTL</div>
<div class="step" data-event="DRIFT_CONFIRMED"><span>02</span>Detect drift</div>
<div class="step" data-event="AI_PROPOSAL"><span>03</span>AI proposal</div>
<div class="step" data-event="HOTL_EXECUTED"><span>04</span>Bounded patch</div>
<div class="step" data-event="HOTL_RECOVERY_VERIFIED"><span>05</span>Verify 2/2</div>
</div></section>
<section class="card" style="margin-top:16px"><h2>Evidence timeline <span class="muted">(newest first)</span></h2><div class="timeline" id="timeline">No events yet</div></section>
<footer>Read-only display on 127.0.0.1. No Kubernetes credentials in this browser. JSONL is a local, mutable demo log, not signed evidence. This display cannot enable, pause or stop the supervisor. Use Ctrl-C in its terminal to prevent future actions. Once-only completion is not an ongoing authorization.</footer>
</main>
<script nonce="HOTL_DEMO">
const $=id=>document.getElementById(id);
const names=['HOTL_ENABLED','DRIFT_CONFIRMED','AI_PROPOSAL','HOTL_EXECUTED','HOTL_RECOVERY_VERIFIED'];
const title=e=>e.replaceAll('_',' ');
function render(data){
 const es=data.events||[];const kinds=new Set(es.map(e=>e.event));
 $('count').textContent=String(data.total);
 const enabled=es.find(e=>e.event==='HOTL_ENABLED');
 $('mode').textContent=enabled?(enabled.mode==='one-shot'?'ONE SHOT':'WATCH MODE'):'NOT ENABLED';
 let result='AWAITING DRIFT',klass='amber';
 if(kinds.has('HOTL_RECOVERY_VERIFIED')){result='READY VERIFIED';klass='green'}
 if(kinds.has('HOTL_FAILED_CLOSED')){result='FAIL CLOSED';klass='amber'}
 if(kinds.has('HOTL_EXECUTED')&&!kinds.has('HOTL_RECOVERY_VERIFIED')&&!kinds.has('HOTL_FAILED_CLOSED')){result='EXECUTED';klass='cyan'}
 $('result').className='big '+klass;$('result').textContent=result;
 $('notice').textContent=es.length?'Recorded events only; refreshes every 2 seconds. This page cannot determine whether the supervisor is still running.':'No HOTL events recorded in this runtime. Start the supervisor first.';
 document.querySelectorAll('.step').forEach(s=>{s.className='step'+(kinds.has(s.dataset.event)?' done':'');});
 if(kinds.has('HOTL_FAILED_CLOSED')){for(const s of document.querySelectorAll('.step')){if(!kinds.has(s.dataset.event))s.className='step fail';}}
 const root=$('timeline');root.replaceChildren();
 if(!es.length){root.textContent='No events yet';return}
 for(const e of [...es].reverse()){
  const box=document.createElement('div');box.className='event';
  const b=document.createElement('b');b.textContent=title(e.event);box.appendChild(b);
  const t=document.createElement('time');t.textContent=e.at||'';box.appendChild(t);
  const small=document.createElement('small');
  if(e.event==='AI_PROPOSAL')small.textContent='Model '+(e.model||'')+' · exact nginx/2 demo proposal';
  else if(e.event==='HOTL_EXECUTED')small.textContent=e.action||'';
  else if(e.event==='HOTL_RECOVERY_VERIFIED')small.textContent=(e.result||'')+' · desired '+(e.desired??2)+' / ready '+(e.ready??2);
  else if(e.event==='HOTL_FAILED_CLOSED')small.textContent=e.reason||'Execution stopped';
  else if(e.event==='DRIFT_CONFIRMED')small.textContent='Drift observed twice with consistent UID and generation';
  else if(e.event==='HOTL_ENABLED')small.textContent='Operator enabled '+(e.mode||'')+' mode for local kind only';
  box.appendChild(small);root.appendChild(box);
 }
}
async function refresh(){
 try{const r=await fetch('/api/events',{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);render(await r.json());}
 catch(e){$('notice').textContent='Evidence feed unavailable: '+String(e.message)}
}
refresh();setInterval(refresh,2000);
</script></body></html>"""

ALLOWED = {
    "HOTL_ENABLED", "DRIFT_CONFIRMED", "AI_PROPOSAL", "HOTL_EXECUTED",
    "HOTL_RECOVERY_VERIFIED", "HOTL_FAILED_CLOSED", "HOTL_STOPPED_BY_OPERATOR",
}


def read_events(audit):
    if not audit.exists():
        return [], 0
    if audit.is_symlink() or not audit.is_file() or audit.stat().st_size > 2_000_000:
        raise ValueError("AUDIT_FILE_UNSAFE_OR_TOO_LARGE")
    parsed = []
    with audit.open(encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue  # Partial event while writer flushes.
            if isinstance(obj, dict) and obj.get("event") in ALLOWED:
                e = {"event": obj["event"], "at": str(obj.get("at", ""))[:40]}
                if e["event"] == "HOTL_ENABLED":
                    e["mode"] = str(obj.get("mode", ""))[:24]
                elif e["event"] == "AI_PROPOSAL":
                    e["model"] = str(obj.get("model", ""))[:48]
                elif e["event"] == "HOTL_EXECUTED":
                    e["action"] = str(obj.get("action", ""))[:40]
                elif e["event"] == "HOTL_RECOVERY_VERIFIED":
                    e["result"] = str(obj.get("result", ""))[:40]
                    state = obj.get("observed") or {}
                    if isinstance(state, dict):
                        for key in ("ready", "desired"):
                            if type(state.get(key)) is int:
                                e[key] = state[key]
                elif e["event"] == "HOTL_FAILED_CLOSED":
                    e["reason"] = str(obj.get("reason", ""))[:100]
                parsed.append(e)
    return parsed[-80:], len(parsed)


def serve(runtime, port):
    audit = runtime / "ai-thinkers-evidence.jsonl"

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/":
                body = HTML.encode("utf-8")
                mime = "text/html; charset=utf-8"
                status = 200
            elif self.path == "/api/events":
                try:
                    events, total = read_events(audit)
                    body = json.dumps({"events": events, "total": total}).encode("utf-8")
                    status = 200
                except (OSError, ValueError):
                    body = b'{"error":"AUDIT_UNAVAILABLE"}'
                    status = 503
                mime = "application/json; charset=utf-8"
            else:
                body = b'{"error":"NOT_FOUND"}'
                mime = "application/json; charset=utf-8"
                status = 404
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            self.send_error(405, "Read-only dashboard")

        def log_message(self, format, *args):
            return

    print(f"AI Thinkers read-only dashboard: http://127.0.0.1:{port}/", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--port", type=int, default=8794)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("invalid TCP port")
    runtime = Path(args.runtime_dir).expanduser()
    if runtime.is_symlink():
        parser.error("runtime symlinks not supported")
    runtime = runtime.resolve(strict=True)
    if not runtime.is_dir() or stat.S_IMODE(runtime.stat().st_mode) & 0o077:
        parser.error("runtime directory must be private")
    serve(runtime, args.port)


if __name__ == "__main__":
    main()
