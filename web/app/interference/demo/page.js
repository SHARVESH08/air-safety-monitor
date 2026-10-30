import TamperDemo from "../../TamperDemo";
export const metadata = { title: "AirSafe · Interference Console" };
export default function InterferencePage() {
  return <main className="wrap interference-page"><header className="top"><div className="brand"><h1>Interference Console</h1><p>Controlled demo · submit a modified sample from this separate interface</p></div><a className="demo-console-link" href="/#interference-demo" target="_blank" rel="noreferrer">Open monitoring dashboard ↗</a></header><p className="notice">Keep the monitoring dashboard open in another tab in the same browser. Start a demo session, then attempt to change 505 ppm to 999 ppm. The dashboard will show the mismatch, rejected write and restricted session automatically.</p><TamperDemo controls /><p className="small-note">Use the same hostname in both tabs. Demo sessions are shared through this browser and expire after 15 minutes. No real blockchain or wallet is modified.</p></main>;
}
