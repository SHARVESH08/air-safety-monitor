"use client";
// SIMULATOR: the dashboard generates every reading in the browser (see lib/simulator.js).
// It only polls /api/state for the hidden remote's button presses, plus Open-Meteo for real weather.
import { useEffect, useRef, useState } from "react";
import { createSimulator, step, classify, THRESHOLDS } from "../lib/simulator";

const LAT = 12.8406;
const LON = 80.1534;
const WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,relative_humidity_2m,surface_pressure,weather_code&timezone=Asia%2FKolkata`;
const HISTORY_S = 120;
const BATCH_S = 30;
const BATCH_EPOCH = Date.UTC(2026, 9, 28); // batch numbers count 30 s windows since this date
const EXPLORER = "https://amoy.polygonscan.com";

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return "0x" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function short(hex, a = 6, b = 4) {
  return hex ? `${hex.slice(0, a)}…${hex.slice(-b)}` : "—";
}

function ChainPanel({ chain, submitting }) {
  return (
    <div className="panel chain">
      <h2>
        Blockchain anchoring · Polygon Amoy
        {chain?.wallet && (
          <a className="addr" href={`${EXPLORER}/address/${chain.wallet}`} target="_blank" rel="noreferrer">
            {short(chain.wallet)}
          </a>
        )}
      </h2>
      <div className="chainmeta">
        <span>Block {chain?.latestBlock ?? "—"}</span>
        <span>Balance {chain?.balance != null ? `${chain.balance.toFixed(4)} POL` : "—"}</span>
        <span>{submitting ?? `SHA-256 of each ${BATCH_S} s batch signed by device key`}</span>
      </div>
      <table>
        <thead>
          <tr><th>Time</th><th>Type</th><th>Batch</th><th>Tx hash</th><th>Data hash</th><th>Fee (POL)</th><th>Status</th></tr>
        </thead>
        <tbody>
          {(chain?.txs ?? []).map((tx) => (
            <tr key={tx.hash}>
              <td>{istTime(tx.sentAt)}</td>
              <td className={tx.kind === "alert" ? "lvl-DANGER" : ""}>{tx.kind === "alert" ? "ALERT" : "BATCH"}</td>
              <td>#{tx.batch}</td>
              <td><a href={`${EXPLORER}/tx/${tx.hash}`} target="_blank" rel="noreferrer">{short(tx.hash, 10, 6)}</a></td>
              <td>{short(tx.dataHash, 8, 4)}</td>
              <td>{tx.fee != null ? tx.fee.toFixed(5) : "—"}</td>
              <td className={tx.block ? (tx.ok ? "lvl-SAFE" : "lvl-DANGER") : "lvl-CAUTION"}>
                {tx.block ? (tx.ok ? `✓ ${tx.confirmations ?? ""} conf · #${tx.block}` : "Reverted") : "Pending…"}
              </td>
            </tr>
          ))}
          {chain && !chain.txs.length && (
            <tr><td colSpan={7} style={{ color: "var(--muted)" }}>Waiting for first batch…</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function describeWeather(code) {
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly cloudy";
  if (code <= 48) return "Fog";
  if (code <= 67) return "Rain";
  if (code <= 82) return "Showers";
  return "Thunderstorm";
}

function istTime(ms) {
  return new Date(ms).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
}

function istDate(ms) {
  return new Date(ms).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
}

function GasChart({ history }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const pad = { l: 40, r: 8, t: 8, b: 18 };
    const max = Math.max(1800, ...history.map((p) => p + 100));
    const min = 300;
    const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (h - pad.t - pad.b);
    const x = (i) => pad.l + (i / (HISTORY_S - 1)) * (w - pad.l - pad.r);

    ctx.font = "10px Consolas, monospace";
    ctx.fillStyle = "#7d8a99";
    ctx.strokeStyle = "#1f2833";
    ctx.lineWidth = 1;
    for (let v = 400; v < max; v += 400) {
      ctx.beginPath();
      ctx.moveTo(pad.l, y(v));
      ctx.lineTo(w - pad.r, y(v));
      ctx.stroke();
      ctx.fillText(String(v), 4, y(v) + 3);
    }
    ctx.fillText(`-${HISTORY_S}s`, pad.l, h - 4);
    ctx.fillText("now", w - pad.r - 20, h - 4);

    for (const [v, color] of [[THRESHOLDS.gasCaution, "#f2b232"], [THRESHOLDS.gasDanger, "#ef4444"]]) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(pad.l, y(v));
      ctx.lineTo(w - pad.r, y(v));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    const offset = HISTORY_S - history.length;
    ctx.strokeStyle = "#4aa3ff";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    history.forEach((v, i) => (i ? ctx.lineTo(x(i + offset), y(v)) : ctx.moveTo(x(i + offset), y(v))));
    ctx.stroke();
  }, [history]);

  return <canvas ref={ref} />;
}

function Card({ label, value, unit, sub, tone, small }) {
  return (
    <div className={`card ${tone ?? ""}`}>
      <div className="label">{label}</div>
      <div className={`value ${small ? "word" : ""}`}>
        {value}
        <span className="unit">{unit}</span>
      </div>
      <div className="sub">{sub}</div>
    </div>
  );
}

export default function Dashboard() {
  const sim = useRef(createSimulator());
  const remote = useRef({ noLight: false, smallSpace: false, co2Presses: [] });
  const clockOffset = useRef(0);
  const lastPacket = useRef(0);
  const weatherRef = useRef(null);

  const [reading, setReading] = useState(null);
  const [weather, setWeather] = useState(null);
  const [history, setHistory] = useState([]);
  const [log, setLog] = useState([]);
  const [now, setNow] = useState(0);
  const [chain, setChain] = useState(null);
  const [submitting, setSubmitting] = useState(null);
  const batchBuffer = useRef([]);

  // On-chain log (shared by every open dashboard)
  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        setChain(await (await fetch("/api/anchor", { cache: "no-store" })).json());
      } catch {}
      if (alive) setTimeout(poll, 4000);
    }
    poll();
    return () => { alive = false; };
  }, []);

  async function submitAnchor(kind, rows, level) {
    const serverNow = Date.now() + clockOffset.current;
    const batch = Math.floor((serverNow - BATCH_EPOCH) / (BATCH_S * 1000));
    const dataHash = await sha256Hex(JSON.stringify(rows));
    setSubmitting(kind === "alert" ? "Signing ALERT transaction…" : `Signing batch #${batch}…`);
    try {
      await fetch("/api/anchor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, batch, dataHash, level, count: rows.length }) });
      setChain(await (await fetch("/api/anchor", { cache: "no-store" })).json());
    } catch {}
    setSubmitting(null);
  }

  // Remote button state
  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const res = await fetch("/api/state", { cache: "no-store" });
        const data = await res.json();
        clockOffset.current = data.serverTime - Date.now();
        remote.current = data;
        lastPacket.current = Date.now();
      } catch {}
      if (alive) setTimeout(poll, 500);
    }
    poll();
    return () => { alive = false; };
  }, []);

  // Real weather at VIT Chennai
  useEffect(() => {
    async function load() {
      try {
        const c = (await (await fetch(WEATHER_URL)).json()).current;
        const w = { temp: c.temperature_2m, humidity: c.relative_humidity_2m, pressure: c.surface_pressure, sky: describeWeather(c.weather_code) };
        weatherRef.current = w;
        setWeather(w);
      } catch {}
    }
    load();
    const id = setInterval(load, 10 * 60_000);
    return () => clearInterval(id);
  }, []);

  // Simulation loop: physics at 10 Hz, display at 2 Hz, chart at 1 Hz, log every 2 s
  useEffect(() => {
    let tick = 0;
    let packet = 1000 + Math.floor(Math.random() * 400);
    let last = performance.now();
    let latest = null;
    let lastLevel = "SAFE";

    const id = setInterval(() => {
      const t = performance.now();
      const dt = Math.min(0.5, (t - last) / 1000);
      last = t;
      const serverNow = Date.now() + clockOffset.current;
      latest = step(sim.current, dt, remote.current, serverNow, weatherRef.current);
      tick++;

      if (tick % 5 === 0) {
        setReading(latest);
        setNow(serverNow);
      }
      if (tick % 10 === 0) {
        setHistory((h) => [...h.slice(-(HISTORY_S - 1)), latest.gas]);
        const level = classify(latest).level;
        const row = { t: Math.floor(serverNow / 1000), gas: latest.gas, o2: +latest.o2.toFixed(2), lux: Math.round(latest.lux), confined: latest.dist < THRESHOLDS.distCaution, c: +latest.temp.toFixed(2), hpa: +latest.pressure.toFixed(2), level };
        batchBuffer.current.push(row);
        if (level === "DANGER" && lastLevel !== "DANGER") submitAnchor("alert", batchBuffer.current.slice(-10), level);
        lastLevel = level;
      }
      if (tick % (BATCH_S * 10) === 0) {
        const rows = batchBuffer.current;
        batchBuffer.current = [];
        const worst = rows.some((r) => r.level === "DANGER") ? "DANGER" : rows.some((r) => r.level === "CAUTION") ? "CAUTION" : "SAFE";
        submitAnchor("batch", rows, worst);
      }
      if (tick % 20 === 0) {
        packet++;
        const row = { id: packet, time: istTime(serverNow), ...latest, level: classify(latest).level };
        setLog((l) => [row, ...l].slice(0, 10));
      }
    }, 100);
    return () => clearInterval(id);
  }, []);

  const status = reading ? classify(reading) : { level: "SAFE", reasons: ["Connecting to device…"] };
  const sinceMs = now && lastPacket.current ? Math.max(0, Date.now() - lastPacket.current) : null;
  const online = sinceMs !== null && sinceMs < 5000;
  const r = reading;

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <h1>Confined-Space Air Safety Monitor</h1>
          <p>Node AQ-01 · ESP32-WROOM-32 · MQ135 · BMP280 · LDR · HC-SR04 · DS3231</p>
        </div>
        <div className="meta">
          <div>
            <div className="k">Device</div>
            <div className="v"><span className={`dot ${online ? "" : "off"}`} />{online ? `Online · ${(sinceMs / 1000).toFixed(1)} s ago` : "Reconnecting…"}</div>
          </div>
          <div>
            <div className="k">Location</div>
            <div className="v">VIT Chennai, Tamil Nadu</div>
          </div>
          <div>
            <div className="k">Outdoor</div>
            <div className="v">{weather ? `${weather.temp.toFixed(1)} °C · ${weather.humidity}% RH · ${weather.sky}` : "—"}</div>
          </div>
          <div>
            <div className="k">{now ? istDate(now) : "Time"} · IST</div>
            <div className="v">{now ? istTime(now) : "--:--:--"}</div>
          </div>
        </div>
      </header>

      <section className={`status ${status.level}`}>
        <div className="badge">{status.level}</div>
        <div className="reasons">{status.reasons.join(" · ")}</div>
      </section>

      <section className="grid">
        <Card label="CO₂e (MQ135)" value={r ? r.gas : "—"} unit="ppm" sub="Safe < 1000 · Danger ≥ 1500"
          tone={r && (r.gas >= THRESHOLDS.gasDanger ? "bad" : r.gas >= THRESHOLDS.gasCaution ? "warn" : "")} />
        <Card label="Oxygen (est.)" value={r ? r.o2.toFixed(1) : "—"} unit="%" sub="Normal 20.9 %"
          tone={r && (r.o2 < THRESHOLDS.o2Danger ? "bad" : r.o2 < THRESHOLDS.o2Caution ? "warn" : "")} />
        <Card label="Light (LDR)" value={r ? Math.round(r.lux) : "—"} unit="lux" sub={r && r.lux < THRESHOLDS.luxCaution ? "Low visibility" : "Ambient"}
          tone={r && r.lux < THRESHOLDS.luxCaution ? "warn" : ""} />
        <Card label="Space (HC-SR04)" value={r ? (r.dist < THRESHOLDS.distCaution ? "Confined" : "Not confined") : "—"} small
          sub={r && r.dist < THRESHOLDS.distCaution ? "Walls close on scan" : "Open area"}
          tone={r && r.dist < THRESHOLDS.distCaution ? "warn" : ""} />
        <Card label="Temperature (BMP280)" value={r ? r.temp.toFixed(2) : "—"} unit="°C" sub="Indoor" />
        <Card label="Pressure (BMP280)" value={r ? r.pressure.toFixed(2) : "—"} unit="hPa" sub="Station level" />
      </section>

      <section className="row">
        <div className="panel">
          <h2>CO₂e · last 2 minutes</h2>
          <GasChart history={history} />
        </div>
        <div className="panel">
          <h2>Packets received</h2>
          <table>
            <thead>
              <tr><th>#</th><th>Time</th><th>ppm</th><th>lux</th><th>Space</th><th>State</th></tr>
            </thead>
            <tbody>
              {log.map((row) => (
                <tr key={row.id}>
                  <td>{row.id}</td>
                  <td>{row.time}</td>
                  <td>{row.gas}</td>
                  <td>{Math.round(row.lux)}</td>
                  <td>{row.dist < THRESHOLDS.distCaution ? "Confined" : "Open"}</td>
                  <td className={`lvl-${row.level}`}>{row.level}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <ChainPanel chain={chain} submitting={submitting} />

      <div className="foot">{LAT.toFixed(4)}° N, {LON.toFixed(4)}° E · Vandalur–Kelambakkam Rd · sample rate 1 Hz</div>
    </div>
  );
}
