"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import InterferenceMonitor from "./InterferenceMonitor";
import { buildPayload, encodePayload, EXPLORER, CHAIN_HEX, HASH_RE, normalizeRows } from "../lib/protocol.mjs";

const short = value => value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "—";
const time = value => new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
const PENDING_KEY = "airsafe:pending:v2";
function download(proof) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(proof, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = `airsafe-${proof.hash}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function snapshot() {
  const response = await fetch("/api/anchor", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Monitoring unavailable.");
  return data;
}
export default function BlockchainPanel({ batch }) {
  const [provider, setProvider] = useState(null);
  const [account, setAccount] = useState("");
  const [network, setNetwork] = useState("");
  const [chain, setChain] = useState(null);
  const [error, setError] = useState("");
  const [monitorError, setMonitorError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [pending, setPending] = useState(null);
  const [localAlerts, setLocalAlerts] = useState([]);
  const [acknowledged, setAcknowledged] = useState([]);
  const [notifications, setNotifications] = useState("default");
  const seen = useRef(new Set());
  const initialized = useRef(false);
  const alive = useRef(true);
  const upload = useRef(null);
  const alert = useCallback((code, text, severity = "warning") => {
    setLocalAlerts(list => [{ id: `local-${Date.now()}`, code, message: text, at: Date.now(), severity }, ...list].slice(0, 10));
  }, []);
  useEffect(() => {
    alive.current = true;
    const announce = event => { if (event.detail?.info?.rdns === "io.metamask") setProvider(event.detail.provider); };
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const injected = window.ethereum?.providers?.find(p => p.isMetaMask) ?? window.ethereum;
    if (injected?.isMetaMask) setProvider(current => current ?? injected);
    if ("Notification" in window) setNotifications(Notification.permission);
    try {
      const saved = JSON.parse(localStorage.getItem(PENDING_KEY) || "null");
      if (saved && HASH_RE.test(saved.hash)) setPending({ hash: saved.hash, rows: normalizeRows(saved.rows) });
    } catch { setError("Saved pending evidence is unreadable. Import an exported evidence file to recover it."); }
    return () => { alive.current = false; window.removeEventListener("eip6963:announceProvider", announce); };
  }, []);
  useEffect(() => {
    if (!provider) return;
    let active = true;
    const accounts = values => { if (active) setAccount(values[0] || ""); };
    const changed = value => { if (active) setNetwork(value); };
    const disconnected = () => { accounts([]); setError("Wallet disconnected. Reconnect MetaMask before signing."); };
    Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })])
      .then(([a, n]) => { accounts(a); changed(n); }).catch(() => { if (active) setAccount(""); });
    provider.on?.("accountsChanged", accounts); provider.on?.("chainChanged", changed); provider.on?.("disconnect", disconnected);
    return () => { active = false; provider.removeListener?.("accountsChanged", accounts); provider.removeListener?.("chainChanged", changed); provider.removeListener?.("disconnect", disconnected); };
  }, [provider]);
  useEffect(() => {
    let active = true; let timer;
    async function poll() {
      try { const data = await snapshot(); if (active) { setChain(data); setMonitorError(""); } }
      catch (e) { if (active) { setMonitorError(e.message); setChain(current => current ? { ...current, rpc: "unavailable" } : null); } }
      if (active) timer = setTimeout(poll, 12000);
    }
    poll();
    return () => { active = false; clearTimeout(timer); };
  }, []);
  const allAlerts = [...localAlerts, ...(chain?.alerts ?? [])].sort((a, b) => b.at - a.at);
  useEffect(() => {
    const items = [...localAlerts, ...(chain?.alerts ?? [])];
    for (const item of items) {
      if (initialized.current && !seen.current.has(item.id) && notifications === "granted") {
        try { new Notification(`AirSafe: ${item.code}`, { body: item.message, tag: item.id }); } catch { /* In-app alerts remain available if desktop delivery fails. */ }
      }
      seen.current.add(item.id);
    }
    if (chain) initialized.current = true;
  }, [chain, localAlerts, notifications]);
  async function connect() {
    setError("");
    try {
      if (!provider) throw new Error("Install the MetaMask browser extension, then reload this page.");
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      setAccount(accounts[0] || ""); setNetwork(await provider.request({ method: "eth_chainId" }));
    } catch (e) { setError(e.code === 4001 ? "Connection declined. You can still monitor data." : e.message); }
  }
  async function switchNetwork() {
    try {
      try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] }); }
      catch (e) {
        if (e.code !== 4902) throw e;
        await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: CHAIN_HEX, chainName: "Polygon Amoy Testnet", nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 }, rpcUrls: ["https://rpc-amoy.polygon.technology"], blockExplorerUrls: [EXPLORER] }] });
      }
      setNetwork(await provider.request({ method: "eth_chainId" }));
    } catch (e) { setError(e.code === 4001 ? "Network request declined." : e.message); }
  }
  function remember(proof) {
    setPending(proof);
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(proof)); }
    catch { alert("BACKUP_NEEDED", "Browser storage is unavailable. Export pending evidence before leaving this page."); }
  }
  async function registerProof(proof) {
    const response = await fetch("/api/anchor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(proof) });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 403) alert("EVIDENCE_REJECTED", data.error, "critical");
      throw new Error(data.error || "Evidence registration failed.");
    }
    setPending(null);
    try { localStorage.removeItem(PENDING_KEY); } catch {}
    setMessage("Evidence registered. The server will continuously reverify it while this dashboard is open.");
    setChain(await snapshot());
  }
  async function run(action) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setMessage(""); setError("");
    try { await action(); } catch (e) {
      setError(e.code === 4001 ? "Signature declined. No anchor was submitted." : (e.shortMessage || e.message));
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  async function sign() {
    await run(async () => {
      const data = await snapshot(); setChain(data);
      const [accounts, id] = await Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]);
      if (id !== CHAIN_HEX) throw new Error("Switch MetaMask to Polygon Amoy before signing.");
      const from = accounts[0];
      if (!from || !data.allowedWallets.includes(from.toLowerCase())) throw new Error("This wallet is not approved. Configure its public address in ANCHOR_ALLOWED_WALLETS.");
      if (data.rpc !== "online") throw new Error("Server cannot verify the chain. Try again when RPC access recovers.");
      const rows = normalizeRows(batch.rows);
      const payload = buildPayload(rows, batch.kind);
      setMessage("Review the zero-value testnet transaction in MetaMask. A network fee applies.");
      const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from, to: from, value: "0x0", chainId: CHAIN_HEX, data: encodePayload(payload) }] });
      const proof = { hash, rows }; remember(proof);
      setMessage("Transaction submitted. Register evidence after it is mined; no second signature is needed.");
      await registerProof(proof);
    });
  }
  async function importProof(event) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    await run(async () => {
      if (file.size > 65536) throw new Error("Evidence file exceeds 64 KB.");
      const value = JSON.parse(await file.text());
      if (!HASH_RE.test(value?.hash ?? "")) throw new Error("Invalid transaction hash in evidence file.");
      const proof = { hash: value.hash, rows: normalizeRows(value.rows) };
      // Verification of imports never overwrites a different pending transaction.
      const response = await fetch("/api/anchor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(proof) });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 403) alert("EVIDENCE_REJECTED", data.error, "critical");
        throw new Error(data.error);
      }
      setMessage("Imported evidence matches its approved on-chain anchor."); setChain(await snapshot());
    });
  }
  const approved = account && chain?.allowedWallets.includes(account.toLowerCase());
  const openAlerts = allAlerts.filter(a => !acknowledged.includes(a.id));
  return <section className="blockchain-monitor" aria-label="Blockchain monitoring">
    <InterferenceMonitor />
    <div className="panel chain wallet-panel">
      <div className="section-heading"><div><h2>Evidence & blockchain</h2><p>Polygon Amoy testnet · SHA-256 batch anchors · MetaMask signing</p></div><span className="pill">SIMULATED SOURCE</span></div>
      <div className="wallet-toolbar">
        <button onClick={connect} disabled={busy}>{account ? "Reconnect MetaMask" : "Connect MetaMask"}</button>
        {account && network !== CHAIN_HEX && <button onClick={switchNetwork} disabled={busy}>Switch to Amoy</button>}
        <span className={approved ? "lvl-SAFE" : "lvl-CAUTION"}>{account ? `${short(account)} · ${approved ? "Approved signer" : "Not approved"}` : "Wallet disconnected · monitoring available"}</span>
        <span>Network: {network === CHAIN_HEX ? "Amoy (80002)" : network || "—"}</span>
      </div>
      {!chain?.allowedWallets?.length && <p className="notice">Signing setup: add your MetaMask public address to ANCHOR_ALLOWED_WALLETS in .env.local and restart the server.</p>}
      <div className="security-stats">
        <div><span>RPC verification</span><strong className={chain?.rpc === "online" ? "lvl-SAFE" : "lvl-CAUTION"}>{chain?.rpc === "online" ? "Online" : "Unknown / unavailable"}</strong></div>
        <div><span>Anchors verified now</span><strong>{chain?.rpc === "online" ? chain.txs.filter(t => t.verification === "verified").length : 0} / {chain?.txs.length ?? 0}</strong></div>
        <div><span>Open alerts</span><strong className={openAlerts.length ? "lvl-DANGER" : ""}>{openAlerts.length}</strong></div>
        <div><span>Evidence storage</span><strong>{chain?.storage ?? "—"}</strong></div>
      </div>
      {chain?.storage === "temporary memory" && <p className="notice">Local evidence and alerts are temporary. Configure Redis for persistence; export evidence to keep an independent copy.</p>}
      <div className="anchor-preview">
        <div><strong>{batch ? `${batch.rows.length} readings ready · ${batch.kind === "alert" ? "DANGER event" : "30-second batch"}` : "Collecting the first batch…"}</strong><p>Sign the latest batch explicitly. Monitoring never triggers wallet popups automatically.</p>{batch && <code>{buildPayload(batch.rows, batch.kind).h}</code>}</div>
        <button className="primary" onClick={sign} disabled={!batch || !approved || network !== CHAIN_HEX || busy || !!pending || chain?.rpc !== "online"}>{busy ? "Working…" : "Sign latest batch"}</button>
      </div>
      {pending && <div className="notice pending"><strong>Pending evidence: <a href={`${EXPLORER}/tx/${pending.hash}`} target="_blank" rel="noreferrer">{short(pending.hash)}</a></strong><p>After confirmation, retry registration. Keep an export if the server is unavailable.</p><button disabled={busy} onClick={() => run(() => registerProof(pending))}>Retry registration</button> <button onClick={() => download(pending)}>Export pending evidence</button><p>If the transaction was dropped, replaced, or rejected by policy, save its evidence before clearing it.</p><button disabled={busy} onClick={() => { download(pending); setPending(null); try { localStorage.removeItem(PENDING_KEY); } catch {} setMessage("Pending proof exported and cleared locally. The transaction itself is unchanged."); }}>Export & clear pending</button></div>}
      {message && <p role="status" className="notice">{message}</p>}
      {monitorError && <p role="alert" className="notice failure">{monitorError} Verification is unavailable.</p>}
      {error && <p role="alert" className="notice failure">{error}</p>}
      <div className="section-heading ledger-heading"><h2>Verified evidence ledger</h2><button disabled={busy} onClick={() => upload.current.click()}>Import / verify evidence</button><input ref={upload} type="file" accept="application/json,.json" onChange={importProof} hidden /></div>
      <p className="small-note">Latest 20 registered anchors · checks every 12 s while open · block {chain?.latestBlock ?? "—"} · checked {chain?.checkedAt ? time(chain.checkedAt) : "—"}</p>
      <div className="table-scroll"><table><thead><tr><th>Time (IST)</th><th>Batch / readings</th><th>Signer</th><th>Transaction</th><th>Integrity</th><th>Confirmations</th><th>Evidence</th></tr></thead><tbody>
        {(chain?.txs ?? []).map(tx => <tr key={tx.hash}><td>{time(tx.sentAt)}</td><td>{tx.payload?.kind} / {tx.rows?.length}</td><td>{short(tx.signer)}</td><td><a href={`${EXPLORER}/tx/${tx.hash}`} target="_blank" rel="noreferrer">{short(tx.hash)}</a></td><td title={tx.message} className={tx.verification === "verified" && chain?.rpc === "online" ? "lvl-SAFE" : "lvl-DANGER"}>{chain?.rpc === "online" ? tx.verification : "unknown"}</td><td>{chain?.rpc === "online" ? (tx.confirmations ?? "—") : "—"}</td><td><button onClick={() => download(tx)}>Export JSON</button></td></tr>)}
        {!chain?.txs.length && <tr><td colSpan={7}>No registered anchors. Connect an approved wallet and sign a batch to begin.</td></tr>}
      </tbody></table></div>
    </div>
    <div className={`panel security-alerts ${openAlerts.length ? "has-alerts" : ""}`}>
      <div className="section-heading"><h2>Security alerts</h2><div className="wallet-toolbar"><button onClick={() => alert("TEST_DRILL", "Test alert only: the security panel and notification path are working.")}>Run alert drill</button><button disabled={notifications === "granted"} onClick={async () => { if (!("Notification" in window)) return setError("Desktop notifications are unsupported in this browser."); setNotifications(await Notification.requestPermission()); }}>{notifications === "granted" ? "Desktop alerts enabled" : "Enable desktop alerts"}</button></div></div>
      <p className="small-note">Hash mismatch · unapproved submitted signer · reverted transaction · changed or missing receipt · RPC outage. Desktop alerts require this page to remain open and browser permission.</p>
      <div aria-live="polite">{allAlerts.length === 0 ? <p>No alerts recorded. This does not certify network or sensor security.</p> : allAlerts.map(item => <article key={item.id} className={`alert-item ${item.severity} ${acknowledged.includes(item.id) ? "acknowledged" : ""}`}><div><strong>{item.code.replaceAll("_", " ")}</strong><span>{time(item.at)}</span><p>{item.message}</p>{item.hash && <a href={`${EXPLORER}/tx/${item.hash}`} target="_blank" rel="noreferrer">Inspect transaction {short(item.hash)}</a>}</div><button disabled={acknowledged.includes(item.id)} onClick={() => setAcknowledged(list => [...list, item.id])}>{acknowledged.includes(item.id) ? "Acknowledged" : "Acknowledge"}</button></article>)}</div>
    </div>
  </section>;
}
