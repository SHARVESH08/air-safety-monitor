"use client";
import { useEffect, useRef, useState } from "react";
const SESSION_KEY = "airsafe:sandbox:active";
const sample = () => [{ t: Math.floor(Date.now() / 1000), gas: 505, o2: 20.9, lux: 312, confined: false, c: 30.4, hpa: 1008.6, level: "SAFE" }];
async function request(body) {
  const response = await fetch("/api/sandbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (data.error) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
}
export default function InterferenceMonitor({ controls = false }) {
  const [current, setSession] = useState(null);
  const [gas, setGas] = useState("999");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const gate = useRef(false);
  useEffect(() => {
    let active = true; let timer;
    async function poll() {
      if (!active) return;
      if (!gate.current) {
        try {
          const token = localStorage.getItem(SESSION_KEY);
          if (!token) setSession(null);
          else {
            const data = await request({ action: "status", session: token });
            if (active && !gate.current && token === localStorage.getItem(SESSION_KEY)) { setSession(data); setError(""); }
          }
        } catch (e) {
          if (active && !gate.current) {
            setError(e.message);
            if (e.status === 404) { localStorage.removeItem(SESSION_KEY); setSession(null); }
          }
        }
      }
      if (active) timer = setTimeout(poll, 1000);
    }
    const changed = e => { if (e.key === SESSION_KEY && active && !gate.current) { setSession(null); } };
    window.addEventListener("storage", changed);
    poll();
    return () => { active = false; clearTimeout(timer); window.removeEventListener("storage", changed); };
  }, []);
  async function start() {
    const session = await request({ action: "start", rows: sample() });
    localStorage.setItem(SESSION_KEY, session.session);
    setSession(session);
    return session;
  }
  async function run(action) {
    if (gate.current) return;
    gate.current = true; setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e.message); }
    finally { gate.current = false; setBusy(false); }
  }
  function simulate() {
    run(async () => {
      const value = Number(gas);
      if (!gas.trim() || !Number.isFinite(value) || value < 0 || value > 1000000 || value === 505) throw new Error("Enter a different gas value between 0 and 1000000 ppm; the original sample is 505 ppm.");
      let session = current;
      if (!session) session = await start();
      setSession(await request({ action: "write", session: session.session, gas: value }));
    });
  }
  function reset() {
    run(async () => {
      if (current) await request({ action: "reset", session: current.session }).catch(() => {});
      localStorage.removeItem(SESSION_KEY); setSession(null); setGas("999");
    });
  }
  return <section className={`panel tamper-panel ${current?.locked ? "restricted" : ""}`} aria-label="Interference monitor" id="interference-monitor">
    <div className="section-heading"><div><h2>{controls ? "Interference console" : "Interference monitor"}</h2><p>{controls ? "Submit an altered sample here; watch the main dashboard detect and restrict it." : "Watching the separate interference console for altered samples and blocked writes."}</p></div><span className="pill">CONTROLLED SANDBOX</span></div>
    <p className="small-note">An isolated server sandbox uses the same canonical SHA-256 hashing as the evidence ledger. No wallet is needed. No blockchain transaction or real user restriction is created.</p>
    {controls ? <div className="integrity-controls"><button disabled={busy || !!current} onClick={() => run(start)}>Start session</button><label htmlFor="attempted-gas">Attempted gas value (ppm)<input id="attempted-gas" type="number" min="0" max="1000000" value={gas} disabled={busy || current?.locked} onChange={e => setGas(e.target.value)} /></label><button className="primary" disabled={busy || current?.locked} onClick={simulate}>{busy ? "Checking…" : "Simulate interference"}</button>{current?.locked && <button disabled={busy} onClick={() => run(async () => setSession(await request({ action: "write", session: current.session, gas: Number(gas) })))}>Try another write</button>}<button disabled={busy} onClick={reset}>Reset session</button></div> : <p><a className="console-link" href="/interference/console" target="_blank" rel="noreferrer">Open interference console ↗</a><span className="small-note"> Updates here automatically every second.</span></p>}
    {error && <p role="alert" className="notice failure">{error}</p>}
    <div className="integrity-result" aria-live="polite">
      {!current && <p className="notice">Ready: the sandbox protects an original reading of <strong>505 ppm</strong>. {controls ? "Change it to 999 ppm and click Simulate interference." : "Open the interference console in another tab in this browser to start."}</p>}
      {current?.locked && <div className="integrity-blocked" role="alert"><strong>INTERFERENCE DETECTED — WRITE BLOCKED</strong><p>Hash mismatch detected. The altered sample was rejected and this sandbox writer session is now restricted.</p><span>Original preserved · HTTP 403 · Further writes denied with HTTP 423</span></div>}
      {current && <><div className="security-stats integrity-stats"><div><span>Original protected sample</span><strong className="lvl-SAFE">{current.originalGas} ppm</strong></div><div><span>Attempted replacement</span><strong className="lvl-DANGER">{current.attemptedGas ?? "—"} ppm</strong></div><div><span>Writer access</span><strong className={current.locked ? "lvl-DANGER" : "lvl-SAFE"}>{current.locked ? "RESTRICTED" : "Active"}</strong></div></div><div className="integrity-hashes"><div><span>Original SHA-256</span><code>{current.originalHash}</code></div><div><span>Attempted SHA-256</span><code>{current.attemptedHash ?? "No modified sample submitted"}</code></div></div><ol className="integrity-events">{current.events.map((event, index) => <li key={index}><strong>{event.title}</strong><p>{event.detail}</p><time>{new Date(event.at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })} IST</time></li>)}</ol></>}
    </div>
  </section>;
}
