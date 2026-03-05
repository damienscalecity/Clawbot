#!/usr/bin/env node
/**
 * Trading212 daily weekday digest (06:00 Mauritius) - Node.js (no external deps)
 *
 * Requirements implemented:
 * - Read TRADING212_KEY, TRADING212_SECRET from env
 * - Basic auth header
 * - Base URL: https://live.trading212.com
 * - GET /api/v0/equity/account/cash
 * - wait 6000ms
 * - GET /api/v0/equity/positions
 * - Use global fetch if present, otherwise https.request
 * - On 429 or 401/403: wait 60s and retry ONCE (single failing chain)
 * - Maintain /data/.openclaw/workspace/memory/portfolio-state.json
 * - Keep last 60 snapshots
 * - If last snapshot <10h ago -> exit silently (no output)
 * - Output short French digest (max ~8 lines) to stdout
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const args = process.argv.slice(2);
const FLAG_PRINT_POSITION_KEYS = args.includes('--print-position-keys');
const FLAG_EXPORT_ANALYSIS = args.includes('--export-analysis');
const FLAG_SAFE = args.includes('--safe') || FLAG_PRINT_POSITION_KEYS;

const STATE_PATH = path.resolve('/data/.openclaw/workspace/memory/portfolio-state.json');
const LOCK_PATH = path.resolve('/data/.openclaw/workspace/memory/portfolio-state.lock');
const BASE = 'https://live.trading212.com';
const CASH_PATH = '/api/v0/equity/account/cash';
const POS_PATH = '/api/v0/equity/positions';

const key = process.env.TRADING212_KEY || process.env.TRADING212_API_KEY || process.env.T212_KEY;
const secret = process.env.TRADING212_SECRET || process.env.TRADING212_SECRET_KEY || process.env.TRADING212_API_SECRET || process.env.T212_SECRET;
if (!key || !secret) {
  console.error('Missing Trading212 credentials (TRADING212_KEY + TRADING212_SECRET/TRADING212_SECRET_KEY)');
  process.exit(2);
}
const authHeader = 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');

function nowTs() { return Math.floor(Date.now()/1000); }

function readState(){
  try{
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  }catch(e){
    return {snapshots:[]};
  }
}
function writeState(obj){
  try{
    fs.mkdirSync(path.dirname(STATE_PATH), {recursive:true});
    fs.writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2), 'utf8');
  }catch(e){
    console.error('Failed to write state', e);
  }
}

function wait(ms){ return new Promise(r=>setTimeout(r, ms)); }

function acquireLock(){
  try{
    fs.mkdirSync(path.dirname(LOCK_PATH), {recursive:true});
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    return fd;
  }catch(e){
    return null;
  }
}
function releaseLock(fd){
  try{ if (fd != null) fs.closeSync(fd); }catch(e){}
  try{ fs.unlinkSync(LOCK_PATH); }catch(e){}
}

function lowerCaseHeaders(headersObj){
  const out = {};
  if (!headersObj) return out;
  for (const [k,v] of Object.entries(headersObj)) out[String(k).toLowerCase()] = v;
  return out;
}

function parseResetSeconds(resetHeader){
  // T212 docs mention x-ratelimit-reset (usually seconds until reset or epoch seconds). We'll support both.
  if (resetHeader == null) return null;
  const n = Number(resetHeader);
  if (!Number.isFinite(n)) return null;
  // heuristic: if huge, treat as epoch seconds
  if (n > 10_000_000_000) return Math.max(0, Math.floor(n/1000) - nowTs());
  if (n > 1_000_000_000) return Math.max(0, Math.floor(n) - nowTs());
  // else treat as seconds-until-reset
  return Math.max(0, Math.floor(n));
}

async function fetchWithFallback(url, headers){
  if (typeof fetch === 'function') {
    const res = await fetch(url, {method:'GET', headers});
    const status = res.status;
    const text = await res.text();
    let json = null;
    try{ json = JSON.parse(text); }catch(e){ json = null; }

    const h = {};
    try{
      // node fetch Headers iterable
      for (const [k,v] of res.headers.entries()) h[k] = v;
    }catch(e){}

    return {status, json, text, headers: lowerCaseHeaders(h)};
  }

  // fallback to https.request
  return new Promise((resolve, reject)=>{
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + (u.search||''),
      method: 'GET',
      headers: headers,
      port: 443,
    };
    const req = https.request(opts, res=>{
      let bufs = [];
      res.on('data', c=>bufs.push(c));
      res.on('end', ()=>{
        const text = Buffer.concat(bufs).toString('utf8');
        let json = null;
        try{ json = JSON.parse(text); }catch(e){ json = null; }
        resolve({status: res.statusCode, json, text, headers: lowerCaseHeaders(res.headers)});
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchWithRateLimit(url, headers, {maxRetries=2, label=''} = {}){
  let attempt = 0;
  while (true){
    const resp = await fetchWithFallback(url, headers);

    const resetS = parseResetSeconds(resp.headers && resp.headers['x-ratelimit-reset']);
    const remaining = resp.headers && resp.headers['x-ratelimit-remaining'] != null
      ? Number(resp.headers['x-ratelimit-remaining'])
      : null;

    if (resp.status !== 429) {
      // If we're close to the limit, add a tiny delay to be polite
      if (Number.isFinite(remaining) && remaining <= 1 && Number.isFinite(resetS) && resetS > 0) {
        await wait(Math.min(2000, resetS * 1000));
      }
      return resp;
    }

    if (attempt >= maxRetries) return resp;

    const sleepMs = (Number.isFinite(resetS) && resetS > 0)
      ? (resetS * 1000 + 250)
      : 2000;

    // minimal log (no sensitive data)
    console.log(`RateLimit(429)${label?` ${label}`:''}: attente ${Math.ceil(sleepMs/1000)}s`);
    await wait(sleepMs);
    attempt++;
  }
}

async function callChainOnce(){
  const headers = {'Authorization': authHeader, 'Accept':'application/json'};
  const results = {errors:[]};
  // cash
  const cashResp = await fetchWithRateLimit(BASE + CASH_PATH, headers, {label:'cash'});
  results.cash = cashResp;
  if ([429,401,403].includes(cashResp.status)) {
    results.errors.push({status: cashResp.status, endpoint: CASH_PATH});
    return results;
  }
  // positions
  const posResp = await fetchWithRateLimit(BASE + POS_PATH, headers, {label:'positions'});
  results.positions = posResp;
  if ([429,401,403].includes(posResp.status)) {
    results.errors.push({status: posResp.status, endpoint: POS_PATH});
    return results;
  }
  return results;
}

function extractCashTotal(obj){
  // expect cash.total and cash.free or similar
  if (!obj) return null;
  if (obj.total != null) return Number(obj.total);
  if (obj.cash != null && obj.cash.total != null) return Number(obj.cash.total);
  // try nested first element
  if (Array.isArray(obj) && obj.length && obj[0].total!=null) return Number(obj[0].total);
  return null;
}
function extractCashFree(obj){
  if (!obj) return null;
  if (obj.free != null) return Number(obj.free);
  if (obj.cash != null && obj.cash.free != null) return Number(obj.cash.free);
  if (Array.isArray(obj) && obj.length && obj[0].free!=null) return Number(obj[0].free);
  return null;
}

function pickFirstNumber(obj, keys){
  for (const k of keys){
    if (obj && obj[k] != null && obj[k] !== ''){
      const n = Number(obj[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function pickFirstString(obj, keys){
  for (const k of keys){
    const v = obj ? obj[k] : null;
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return '';
}

function computePositionsList(posJson){
  const arr = Array.isArray(posJson)
    ? posJson
    : (posJson && Array.isArray(posJson.positions))
      ? posJson.positions
      : [];

  const list = [];
  const currencies = new Set();

  for (const p of arr){
    // ticker can be nested (instrument object) depending on API version
    const instr = (p && typeof p.instrument === 'object') ? p.instrument : null;

    const ticker =
      pickFirstString(p, ['ticker','symbol','instrumentCode','code']) ||
      pickFirstString(instr, ['ticker','symbol','instrumentCode','code']) ||
      pickFirstString(p, ['instrument']);

    const ccy = pickFirstString(p && p.walletImpact, ['currency']);
    if (ccy) currencies.add(ccy);

    const currentValue =
      pickFirstNumber(p && p.walletImpact, ['currentValue']) ??
      pickFirstNumber(p, ['marketValue','marketValueInAccountCurrency','currentValue','currentValueInAccountCurrency','value','valueInAccountCurrency']) ??
      (() => {
        const qty = pickFirstNumber(p, ['quantity','qty']);
        const price = pickFirstNumber(p, ['currentPrice','lastPrice','averagePrice']);
        if (qty != null && price != null) return qty * price;
        return 0;
      })();

    const upl = pickFirstNumber(p && p.walletImpact, ['unrealizedProfitLoss']);

    if (!ticker) continue;
    list.push({ticker, value: Number(currentValue)||0, upl: (upl==null? null : Number(upl))});
  }

  // merge by ticker
  const map = new Map();
  for (const it of list){
    const prev = map.get(it.ticker);
    if (!prev) map.set(it.ticker, {ticker: it.ticker, value: it.value, upl: it.upl});
    else {
      prev.value += (Number(it.value)||0);
      // upl can be null if missing on some lines; only sum when both sides are numbers
      if (Number.isFinite(prev.upl) && Number.isFinite(it.upl)) prev.upl += it.upl;
      else if (!Number.isFinite(prev.upl) && Number.isFinite(it.upl)) prev.upl = it.upl;
    }
  }

  const merged = Array.from(map.values());
  merged.sort((a,b)=>b.value - a.value);
  return {positions: merged, currencies: Array.from(currencies)};
}

function formatPct(x){
  return (100 * x).toFixed(1) + '%';
}

(async function main(){
  const lockFd = acquireLock();
  if (!lockFd) {
    // another instance is running; exit silently
    process.exit(0);
  }
  const cleanup = () => releaseLock(lockFd);
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  // enforce once-per-10h rule (allow override for manual testing)
  const state = readState();
  const last = state.snapshots && state.snapshots.length ? state.snapshots[state.snapshots.length-1] : null;
  if (!process.env.FORCE_RUN && last && (nowTs() - last.ts) < 10*3600){
    // silent exit
    process.exit(0);
  }

  // attempt chain, with one retry on rate/auth errors
  let res = await callChainOnce();
  if (res.errors.length){
    // wait 60s and retry once
    await wait(60000);
    const retry = await callChainOnce();
    // if still errors, output single error report and exit
    if (retry.errors.length){
      const codes = [...res.errors, ...retry.errors].map(e=>`${e.status}:${e.endpoint}`).join(', ');
      console.log(`Erreur: ${codes} — next attempt tomorrow`);
      process.exit(0);
    } else {
      res = retry;
    }
  }

  const cashJson = res.cash.json;
  const posJson = res.positions.json;

  // Export analysis locally (can include amounts) but prints nothing sensitive to stdout
  if (FLAG_EXPORT_ANALYSIS) {
    const outPath = path.resolve('/data/.openclaw/workspace/memory/portfolio-analysis.json');

    const arr = Array.isArray(posJson)
      ? posJson
      : (posJson && Array.isArray(posJson.positions))
        ? posJson.positions
        : [];

    // Build a rich export per raw position line (no merging)
    const rawPositions = arr.map(p => {
      const instr = (p && typeof p.instrument === 'object') ? p.instrument : null;
      const ticker =
        pickFirstString(p, ['ticker','symbol','instrumentCode','code']) ||
        pickFirstString(instr, ['ticker','symbol','instrumentCode','code']) ||
        pickFirstString(p, ['instrument']);

      return {
        ticker,
        instrument: instr || p.instrument || null,
        quantity: p.quantity ?? null,
        currentPrice: p.currentPrice ?? null,
        averagePricePaid: p.averagePricePaid ?? null,
        walletImpact: p.walletImpact ?? null,
        createdAt: p.createdAt ?? null,
      };
    });

    const payload = {
      exportedAt: new Date().toISOString(),
      cash: cashJson,
      positionsRaw: rawPositions
    };

    try {
      fs.mkdirSync(path.dirname(outPath), {recursive:true});
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
      console.log('OK: export local écrit (memory/portfolio-analysis.json).');
    } catch (e) {
      console.log('Erreur: export local impossible.');
      process.exitCode = 1;
    }
    process.exit(0);
  }

  // SAFE MODE: only print field names/types from one position object
  if (FLAG_PRINT_POSITION_KEYS) {
    const arr = Array.isArray(posJson)
      ? posJson
      : (posJson && Array.isArray(posJson.positions))
        ? posJson.positions
        : [];

    const p = arr[0];
    if (!p || typeof p !== 'object') {
      console.log('positions: (empty or not an object)');
      process.exit(0);
    }

    const keys = Object.keys(p).sort();
    console.log('position.keys:', keys.join(', '));

    // types (no values)
    for (const k of keys) {
      const v = p[k];
      const t = (v === null) ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      console.log(`- ${k}: ${t}`);
    }

    // walletImpact keys/types (no values)
    if (p.walletImpact && typeof p.walletImpact === 'object') {
      const wk = Object.keys(p.walletImpact).sort();
      console.log('walletImpact.keys:', wk.join(', '));
      for (const k of wk) {
        const v = p.walletImpact[k];
        const t = (v === null) ? 'null' : Array.isArray(v) ? 'array' : typeof v;
        console.log(`- walletImpact.${k}: ${t}`);
      }
    } else {
      console.log('walletImpact: (missing or not an object)');
    }

    process.exit(0);
  }

  let total = extractCashTotal(cashJson);
  let free = extractCashFree(cashJson);
  const computed = computePositionsList(posJson);
  const positions = computed.positions;
  const currencies = computed.currencies;

  const sumPos = positions.reduce((s,p)=>s + (p.value||0), 0);
  if (total == null) total = (Number(free)||0) + sumPos;
  if (free == null) free = 0;

  // prepare top3 (by value)
  const top3 = positions.slice(0,3);
  const top1 = top3[0] || {value:0};
  const top3sum = top3.reduce((s,p)=>s + (p.value||0), 0);
  const conc1 = total ? (top1.value / total) : 0;
  const conc3 = total ? (top3sum / total) : 0;

  // delta vs last snapshot if available
  let delta = null;
  if (last && last.total != null) delta = total - last.total;

  // build snapshot entry
  const snapshot = {
    ts: nowTs(),
    total,
    free,
    top: top3.map(p=>({ticker:p.ticker, value:p.value}))
  };
  state.snapshots = state.snapshots || [];
  state.snapshots.push(snapshot);
  // keep last 60
  if (state.snapshots.length > 60) state.snapshots = state.snapshots.slice(state.snapshots.length-60);
  writeState(state);

  // Compose short French digest (focus performance)
  const lines = [];
  const sign = delta==null ? '' : (delta>=0?'+':'') + (delta/1).toFixed(2);

  // If API reports position values in a currency, reflect it (avoid hardcoding EUR)
  const ccyLabel = (currencies && currencies.length === 1) ? currencies[0] : 'EUR';
  const ccyNote = (currencies && currencies.length > 1) ? ` (devises: ${currencies.join(',')})` : '';

  // Performance / summary
  lines.push(`Portefeuille: ${total.toFixed(2)} ${ccyLabel} ${delta!=null?`(${sign})`:''}${ccyNote}`);
  lines.push(`Cash: ${free.toFixed(2)} ${ccyLabel}`);

  // Top positions by weight (kept short)
  for (let i=0;i<3;i++){
    const p = top3[i];
    if (p) lines.push(`${i+1}. ${p.ticker} — ${formatPct(total? p.value/total : 0)}`);
    else lines.push(`${i+1}. -`);
  }

  // P&L latent (if available)
  const withUpl = positions.filter(p => Number.isFinite(p.upl));
  if (withUpl.length) {
    const totalUpl = withUpl.reduce((s,p)=>s + (p.upl||0), 0);
    lines.push(`P&L latent: ${(totalUpl>=0?'+':'')}${totalUpl.toFixed(2)} ${ccyLabel}`);

    // worst/best contributor (by absolute upl)
    const sortedUpl = withUpl.slice().sort((a,b)=> (b.upl||0) - (a.upl||0));
    const best = sortedUpl[0];
    const worst = sortedUpl[sortedUpl.length-1];
    if (best) lines.push(`Meilleur: ${best.ticker} ${(best.upl>=0?'+':'')}${best.upl.toFixed(2)} ${ccyLabel}`);
    if (worst) lines.push(`Pire: ${worst.ticker} ${(worst.upl>=0?'+':'')}${worst.upl.toFixed(2)} ${ccyLabel}`);
  }

  // (Optional) risk line if concentrated
  if (conc1 > 0.25) lines.push(`Note: Concentration élevée (${top1.ticker} ${formatPct(conc1)})`);

  const finalLines = lines.filter((l,i)=>!(l==='' && i>6));
  console.log(finalLines.join('\n'));
})();
