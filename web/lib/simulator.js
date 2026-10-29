// SIMULATOR: fake sensor physics. None of these values come from real hardware.
// Each reading eases towards a target (first-order lag, like a real sensor) and gets small noise.

export const THRESHOLDS = { gasCaution: 1000, gasDanger: 1500, o2Caution: 20.3, o2Danger: 19.5, distCaution: 50, luxCaution: 10 };

// Gas burst shape for one "High CO2" press: rises over ~3 s, clears over ~1 min.
const RISE_S = 2.2;
const DECAY_S = 40;
const BURST_PPM = 680;
const PEAK_T = (Math.log(DECAY_S / RISE_S) * DECAY_S * RISE_S) / (DECAY_S - RISE_S);
const PEAK = Math.exp(-PEAK_T / DECAY_S) - Math.exp(-PEAK_T / RISE_S);

function burst(ageS) {
  if (ageS < 0) return 0;
  return (BURST_PPM * (Math.exp(-ageS / DECAY_S) - Math.exp(-ageS / RISE_S))) / PEAK;
}

function gauss() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

function ease(current, target, dt, tau) {
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

export function createSimulator() {
  return { gasBase: 505, gas: 505, o2: 20.9, lux: 312, luxBase: 312, dist: 182, temp: 30.4, pressure: 1008.6 };
}

// remote: { noLight, smallSpace, co2Presses } ; nowMs: server-aligned clock ; weather: { temp, pressure } | null
export function step(s, dt, remote, nowMs, weather) {
  s.gasBase = ease(s.gasBase, 505, dt, 90) + gauss() * 1.4 * Math.sqrt(dt);
  const gasTarget = s.gasBase + (remote.co2Presses ?? []).reduce((sum, t) => sum + burst((nowMs - t) / 1000), 0);
  s.gas = ease(s.gas, gasTarget, dt, 0.8) + gauss() * 1.2;

  s.o2 = ease(s.o2, remote.smallSpace ? 19.2 : 20.9, dt, 45);

  s.luxBase = ease(s.luxBase, 312, dt, 20) + gauss() * 0.8 * Math.sqrt(dt);
  s.lux = ease(s.lux, remote.noLight ? 2 : s.luxBase, dt, 0.35);

  s.dist = ease(s.dist, remote.smallSpace ? 38 : 182, dt, 0.25);

  // Snap to the real weather once it first loads, so the page doesn't open with a visible drift.
  if (weather && !s.weatherSynced) {
    s.temp = weather.temp + 1.1;
    s.pressure = weather.pressure;
    s.weatherSynced = true;
  }
  s.temp = ease(s.temp, weather ? weather.temp + 1.1 : 30.4, dt, 30);
  s.pressure = ease(s.pressure, weather ? weather.pressure : 1008.6, dt, 30);

  return {
    gas: Math.max(350, Math.round(s.gas)),
    o2: s.o2 + gauss() * 0.01,
    lux: Math.max(0, s.lux + gauss() * (remote.noLight ? 0.3 : 1.5)),
    dist: s.dist + gauss() * (remote.smallSpace ? 1.2 : 0.4),
    temp: s.temp + gauss() * 0.02,
    pressure: s.pressure + gauss() * 0.03,
  };
}

export function classify(r) {
  const t = THRESHOLDS;
  const danger = [];
  const caution = [];
  if (r.gas >= t.gasDanger) danger.push("CO₂e above 1500 ppm");
  else if (r.gas >= t.gasCaution) caution.push("CO₂e above 1000 ppm");
  if (r.o2 < t.o2Danger) danger.push("O₂ below 19.5 %");
  else if (r.o2 < t.o2Caution) caution.push("O₂ dropping");
  if (r.dist < t.distCaution) caution.push("Confined space detected");
  if (r.lux < t.luxCaution) caution.push("Low light");
  if (danger.length) return { level: "DANGER", reasons: [...danger, ...caution] };
  if (caution.length) return { level: "CAUTION", reasons: caution };
  return { level: "SAFE", reasons: ["All readings within limits"] };
}
