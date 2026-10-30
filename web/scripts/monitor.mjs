// Keep the backend verifier running when no dashboard tab is open.
// This process must remain running. It does not install a scheduled task.
const endpoint = new URL("/api/anchor", process.env.MONITOR_URL || "http://127.0.0.1:3000");
let seen = new Set();
let previousError = "";
console.log(`Monitoring ${endpoint.origin}. Press Ctrl+C to stop.`);
while (true) {
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(30000), cache: "no-store" });
    if (!response.ok) throw new Error(`Monitor returned HTTP ${response.status}`);
    const data = await response.json();
    if (previousError) console.log("Monitor service recovered.");
    previousError = "";
    for (const alert of [...data.alerts].reverse()) {
      if (!seen.has(alert.id)) console.log(`[${new Date(alert.at).toISOString()}] ${alert.severity.toUpperCase()} ${alert.code}: ${alert.message}${alert.hash ? ` (${alert.hash})` : ""}`);
    }
    seen = new Set(data.alerts.map(alert => alert.id));
  } catch (error) {
    if (previousError !== error.message) console.error(`Verification unavailable: ${error.message}`);
    previousError = error.message;
  }
  await new Promise(resolve => setTimeout(resolve, 15000));
}
