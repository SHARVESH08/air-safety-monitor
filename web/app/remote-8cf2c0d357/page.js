"use client";
// SIMULATOR remote: these buttons drive the fake readings on the dashboard.
import { useEffect, useState } from "react";

const KEY = "8cf2c0d357";

export default function Remote() {
  const [state, setState] = useState({ noLight: false, smallSpace: false, co2Presses: [] });
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        setState(await (await fetch("/api/state", { cache: "no-store" })).json());
      } catch {}
      if (alive) setTimeout(poll, 1500);
    }
    poll();
    return () => { alive = false; };
  }, []);

  async function send(action) {
    if (navigator.vibrate) navigator.vibrate(30);
    if (action === "co2") {
      setFlash(true);
      setTimeout(() => setFlash(false), 400);
    }
    try {
      const res = await fetch("/api/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, key: KEY }) });
      if (res.ok) setState(await res.json());
    } catch {}
  }

  const recent = state.co2Presses.filter((t) => state.serverTime - t < 60_000).length;

  return (
    <main className="remote">
      <h1>Remote</h1>
      <button className={`rbtn ${state.noLight ? "on" : ""}`} onClick={() => send("toggleLight")}>
        No light<small>{state.noLight ? "ON · tap to restore light" : "Tap while covering the LDR"}</small>
      </button>
      <button className={`rbtn ${state.smallSpace ? "on" : ""}`} onClick={() => send("toggleSpace")}>
        Small space<small>{state.smallSpace ? "ON · tap to release" : "Tap while closing in on the ultrasonic"}</small>
      </button>
      <button className={`rbtn ${flash ? "flash" : ""}`} onClick={() => send("co2")}>
        High CO₂<small>{recent ? `${recent} burst${recent > 1 ? "s" : ""} in the last minute · 1 = caution, 2+ = danger` : "Tap once per breath on the MQ135"}</small>
      </button>
      <button className="rbtn reset" onClick={() => send("reset")}>Reset everything</button>
    </main>
  );
}
