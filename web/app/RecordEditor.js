"use client";
import { useEffect, useRef, useState } from "react";
import { CHAIN_HEX, EXPLORER, hashRows, normalizeRows } from "../lib/protocol.mjs";
const short = value => value ? `${value.slice(0, 10)}…${value.slice(-6)}` : "—";
export default function RecordEditor() {
  const [chain, setChain] = useState(null);
  const [selected, setSelected] = useState("");
  const [gas, setGas] = useState("");
  const [rowIndex, setRowIndex] = useState(0);
  const [provider, setProvider] = useState(null);
  const [account, setAccount] = useState("");
  const [network, setNetwork] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const gate = useRef(false);
  async function refresh() {
    const response = await fetch("/api/anchor", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Record service unavailable.");
    setChain(data); return data;
  }
  useEffect(() => {
    let active = true; let timer;
    const announce = event => { if (event.detail?.info?.rdns === "io.metamask") setProvider(event.detail.provider); };
    window.addEventListener("eip6963:announceProvider", announce); window.dispatchEvent(new Event("eip6963:requestProvider"));
    const injected = window.ethereum?.providers?.find(p => p.isMetaMask) ?? window.ethereum;
    if (injected?.isMetaMask) setProvider(current => current ?? injected);
    async function poll() {
      try {
        const response = await fetch("/api/anchor", { cache: "no-store" }); const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Record service unavailable.");
        if (active) setChain(data);
      } catch (e) { if (active) setError(e.message); }
      if (active) timer = setTimeout(poll, 12000);
    }
    poll();
    return () => { active = false; clearTimeout(timer); window.removeEventListener("eip6963:announceProvider", announce); };
  }, []);
  useEffect(() => {
    if (!provider) return;
    let active = true;
    const accounts = values => { if (active) setAccount(values[0] || ""); };
    const changed = value => { if (active) setNetwork(value); };
    const disconnected = () => accounts([]);
    Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]).then(([a, n]) => { accounts(a); changed(n); }).catch(() => {});
    provider.on?.("accountsChanged", accounts); provider.on?.("chainChanged", changed); provider.on?.("disconnect", disconnected);
    return () => { active = false; provider.removeListener?.("accountsChanged", accounts); provider.removeListener?.("chainChanged", changed); provider.removeListener?.("disconnect", disconnected); };
  }, [provider]);
  const records = chain?.txs ?? [];
  const record = records.find(tx => tx.hash === selected);
  const approved = !!account && !!chain?.allowedWallets.includes(account.toLowerCase());
  function choose(hash) {
    setSelected(hash); setRowIndex(0); setResult(null);
    const tx = records.find(item => item.hash === hash); setGas(tx ? String(tx.rows[0].gas) : "");
  }
  const validGas = gas.trim() !== "" && Number.isFinite(Number(gas)) && Number(gas) >= 0 && Number(gas) <= 1000000;
  const candidate = record && validGas ? record.rows.map((row, index) => index === rowIndex ? { ...row, gas: Number(gas) } : { ...row }) : null;
  let candidateHash = null;
  try { if (candidate) candidateHash = hashRows(candidate); } catch {}
  async function connect() {
    try {
      setError(""); if (!provider) throw new Error("Open this page in a browser with the MetaMask extension installed.");
      setAccount((await provider.request({ method: "eth_requestAccounts" }))[0] || "");
      setNetwork(await provider.request({ method: "eth_chainId" }));
    } catch (e) { setError(e.code === 4001 ? "Wallet connection declined." : e.message); }
  }
  async function submit() {
    if (gate.current || !record || !candidate) return;
    gate.current = true; setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/anchor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hash: record.hash, rows: normalizeRows(candidate) }) });
      const data = await response.json();
      setResult({ ok: response.ok, status: response.status, message: data.error || "The submitted readings match the anchored record.", rejected: response.status === 403 });
      await refresh();
    } catch (e) { setError(e.message); }
    finally { gate.current = false; setBusy(false); }
  }
  return <main className="wrap interference-page record-page">
    <header className="top"><div className="brand"><h1>AirSafe · Record Access</h1><p>Polygon Amoy · Transaction evidence and integrity verification</p></div><a className="console-link" href="/" target="_blank" rel="noreferrer">Monitoring dashboard ↗</a></header>
    <section className="panel chain"><div className="section-heading"><h2>User session</h2><button onClick={connect}>{account ? "Switch account in MetaMask" : "Connect MetaMask"}</button></div><div className="security-stats integrity-stats"><div><span>Wallet</span><strong>{short(account)}</strong></div><div><span>Access</span><strong>{account ? approved ? "Approved signer" : "Viewer" : "Public viewer"}</strong></div><div><span>Network</span><strong>{network === CHAIN_HEX ? "Polygon Amoy" : network || "Wallet disconnected"}</strong></div></div>{account && !approved && <p className="notice">This wallet can view records. Its address is not approved to sign new anchors.</p>}</section>
    <section className="panel chain"><div className="section-heading"><h2>Recorded readings</h2><button disabled={busy} onClick={() => refresh().catch(e => setError(e.message))}>Refresh records</button></div>
      {records.length === 0 ? <div className="record-empty"><strong>No anchored records available</strong><p>Connect the approved wallet on the dashboard, sign a batch, and register the confirmed transaction. It will appear here with its transaction hash.</p><a className="console-link" href="/">Open dashboard</a></div> : <label className="record-select">Transaction<select value={selected} onChange={e => choose(e.target.value)} disabled={busy}><option value="">Choose an anchored record</option>{records.map(tx => <option key={tx.hash} value={tx.hash}>{short(tx.hash)} · {tx.rows.length} readings · {tx.verification}</option>)}</select></label>}
      {record && <><p className="small-note">Source: {record.payload.src === "sim" ? "Browser-generated readings" : record.payload.src} · Signer {record.signer} · <a href={`${EXPLORER}/tx/${record.hash}`} target="_blank" rel="noreferrer">View transaction ↗</a></p><div className="integrity-controls"><label>Reading<select value={rowIndex} disabled={busy} onChange={e => { const index = Number(e.target.value); setRowIndex(index); setGas(String(record.rows[index].gas)); setResult(null); }}>{record.rows.map((row, index) => <option key={index} value={index}>#{index + 1} · {row.gas} ppm</option>)}</select></label><label htmlFor="record-gas">Proposed gas value (ppm)<input id="record-gas" type="number" min="0" max="1000000" value={gas} onChange={e => setGas(e.target.value)} disabled={busy} /></label><button className="primary" disabled={busy || !candidateHash || chain?.rpc !== "online"} onClick={submit}>{busy ? "Verifying…" : "Submit edited record"}</button></div><div className="security-stats integrity-stats"><div><span>Recorded gas</span><strong>{record.rows[rowIndex].gas} ppm</strong></div><div><span>Proposed gas</span><strong>{validGas ? gas : "—"} ppm</strong></div><div><span>Digest comparison</span><strong className={candidateHash === record.payload.h ? "lvl-SAFE" : "lvl-CAUTION"}>{candidateHash === record.payload.h ? "Match" : "Different"}</strong></div></div><div className="integrity-hashes"><div><span>Anchored SHA-256</span><code>{record.payload.h}</code></div><div><span>Proposed SHA-256</span><code>{candidateHash || "Enter a valid value"}</code></div></div><p className="small-note">Edits are submitted for server verification against the signed transaction. This form cannot rewrite a confirmed blockchain transaction.</p></>}
      {result && <div className={result.rejected ? "integrity-blocked" : "notice"} role="alert"><strong>{result.rejected ? "RECORD REJECTED — INTEGRITY OR ACCESS CHECK FAILED" : result.ok ? "RECORD VERIFIED" : "VERIFICATION NOT COMPLETED"}</strong><p>{result.message}</p><span>Server response: HTTP {result.status}{result.rejected ? " · Original anchored record preserved" : ""}</span></div>}
      {error && <p role="alert" className="notice failure">{error}</p>}
    </section>
  </main>;
}
