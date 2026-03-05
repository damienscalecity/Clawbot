#!/usr/bin/env node
/**
 * Rebalance helper for Trading212.
 *
 * Default mode: PLAN ONLY (dry-run). Writes memory/orders-plan.json
 * Execute mode: set CONFIRM_SEND=YES and pass --execute (NOT recommended without review).
 *
 * Notes:
 * - Trading212 order endpoints may be non-idempotent. We keep a local sent-order journal.
 * - This script uses market orders (per user choice).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE = 'https://live.trading212.com';
const ORDERS_MARKET_PATH = '/api/v0/equity/orders/market';

const ANALYSIS_PATH = path.resolve('/data/.openclaw/workspace/memory/portfolio-analysis.json');
const PLAN_PATH = path.resolve('/data/.openclaw/workspace/memory/orders-plan.json');
const SENT_PATH = path.resolve('/data/.openclaw/workspace/memory/orders-sent.json');

const args = process.argv.slice(2);
const FLAG_EXECUTE = args.includes('--execute');

const key = process.env.TRADING212_KEY || process.env.TRADING212_API_KEY || process.env.T212_KEY;
const secret = process.env.TRADING212_SECRET || process.env.TRADING212_SECRET_KEY || process.env.TRADING212_API_SECRET || process.env.T212_SECRET;

function nowTs() { return Math.floor(Date.now()/1000); }
function wait(ms){ return new Promise(r=>setTimeout(r, ms)); }

function lowerCaseHeaders(headersObj){
  const out = {};
  if (!headersObj) return out;
  for (const [k,v] of Object.entries(headersObj)) out[String(k).toLowerCase()] = v;
  return out;
}
function parseResetSeconds(resetHeader){
  if (resetHeader == null) return null;
  const n = Number(resetHeader);
  if (!Number.isFinite(n)) return null;
  if (n > 10_000_000_000) return Math.max(0, Math.floor(n/1000) - nowTs());
  if (n > 1_000_000_000) return Math.max(0, Math.floor(n) - nowTs());
  return Math.max(0, Math.floor(n));
}

async function fetchJson(method, url, headers, bodyObj){
  if (typeof fetch === 'function') {
    const res = await fetch(url, {
      method,
      headers,
      body: bodyObj ? JSON.stringify(bodyObj) : undefined
    });
    const status = res.status;
    const text = await res.text();
    let json = null;
    try{ json = JSON.parse(text); }catch(e){ json = null; }
    const h = {};
    try{ for (const [k,v] of res.headers.entries()) h[k]=v; }catch(e){}
    return {status, json, text, headers: lowerCaseHeaders(h)};
  }

  return new Promise((resolve, reject)=>{
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + (u.search||''),
      method,
      headers,
      port: 443,
    };
    const req = https.request(opts, res=>{
      let bufs=[];
      res.on('data', c=>bufs.push(c));
      res.on('end', ()=>{
        const text = Buffer.concat(bufs).toString('utf8');
        let json=null;
        try{ json = JSON.parse(text);}catch(e){ json=null; }
        resolve({status: res.statusCode, json, text, headers: lowerCaseHeaders(res.headers)});
      });
    });
    req.on('error', reject);
    if (bodyObj) req.write(JSON.stringify(bodyObj));
    req.end();
  });
}

async function fetchWithRateLimit(method, url, headers, bodyObj, {maxRetries=2, label=''} = {}){
  let attempt = 0;
  while (true){
    const resp = await fetchJson(method, url, headers, bodyObj);
    const resetS = parseResetSeconds(resp.headers && resp.headers['x-ratelimit-reset']);

    if (resp.status !== 429) return resp;
    if (attempt >= maxRetries) return resp;

    const sleepMs = (Number.isFinite(resetS) && resetS > 0) ? (resetS*1000 + 250) : 2000;
    console.log(`RateLimit(429)${label?` ${label}`:''}: attente ${Math.ceil(sleepMs/1000)}s`);
    await wait(sleepMs);
    attempt++;
  }
}

function readJson(p, fallback){
  try{ return JSON.parse(fs.readFileSync(p,'utf8')); }catch(e){ return fallback; }
}
function writeJson(p, obj){
  fs.mkdirSync(path.dirname(p), {recursive:true});
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function mergeByTicker(exportObj){
  const pos = exportObj.positionsRaw || [];
  const total = Number(exportObj.cash?.total||0);
  const map = new Map();
  for (const r of pos){
    const t = r.ticker;
    if (!t) continue;
    const wi = r.walletImpact || {};
    const cv = Number(wi.currentValue||0);
    const tc = Number(wi.totalCost||0);
    const upl = Number(wi.unrealizedProfitLoss||0);
    const name = r.instrument?.name || null;
    const prev = map.get(t) || {ticker:t,name,currentValue:0,totalCost:0,upl:0};
    prev.currentValue += cv;
    prev.totalCost += tc;
    prev.upl += upl;
    if (!prev.name && name) prev.name = name;
    map.set(t, prev);
  }
  const merged = [...map.values()].map(x=>({
    ...x,
    weight: total ? x.currentValue/total : 0,
  })).sort((a,b)=>b.currentValue-a.currentValue);
  return {total, merged};
}

function buildTargets(){
  // Hard-coded target model per conversation.
  // Core: 10 x 7% (GOOGL chosen over GOOG; MA chosen; no ETFs)
  // Risk: 6 x 5% incl PLTR.
  const core = [
    {ticker:'NVDA_US_EQ', pct:0.07},
    {ticker:'AVGO_US_EQ', pct:0.07},
    {ticker:'FB_US_EQ', pct:0.07},
    {ticker:'AMZN_US_EQ', pct:0.07},
    {ticker:'AAPL_US_EQ', pct:0.07},
    {ticker:'MSFT_US_EQ', pct:0.07},
    {ticker:'GOOGL_US_EQ', pct:0.07},
    {ticker:'MA_US_EQ', pct:0.07},
    {ticker:'CME_US_EQ', pct:0.07},
    {ticker:'SUp_EQ', pct:0.07},
  ];
  const risk = [
    {ticker:'PLTR_US_EQ', pct:0.05},
    {ticker:'TSLA_US_EQ', pct:0.05},
    {ticker:'AMD_US_EQ', pct:0.05},
    {ticker:'NFLX_US_EQ', pct:0.05},
    {ticker:'EQIX_US_EQ', pct:0.05},
    // defense placeholder (Europe) – user suggested Rheinmetall but also wants a drone-related pick.
    // We'll leave as RHM.DE-like ticker unknown here; must be set via env DEFENSE_TICKER.
    {ticker: process.env.DEFENSE_TICKER || 'RHM_DE', pct:0.05},
  ];

  return {core, risk, targets: [...core, ...risk]};
}

function buildPlan(exportObj){
  const {total, merged} = mergeByTicker(exportObj);
  const {targets} = buildTargets();
  const targetMap = new Map(targets.map(t=>[t.ticker, t.pct]));

  // Define explicit sells: ETFs + GOOG + V (keep MA) + micro noise (weight < 0.3%) + zombies list
  const explicitSellTickers = new Set([
    'GOOG_US_EQ',
    'V_US_EQ',
    'EQQQl_EQ',
    'VUSAl_EQ',
    // zombies mentioned
    'TLRY1_US_EQ','ETSY_US_EQ','SQ_US_EQ','GIS_US_EQ','EZJl_EQ'
  ]);

  // micro positions
  for (const p of merged){
    if (p.weight < 0.003) explicitSellTickers.add(p.ticker);
  }

  // Never auto-sell target tickers (except GOOG/V/ETFs above)
  for (const t of targetMap.keys()) {
    if (!['GOOG_US_EQ','V_US_EQ','EQQQl_EQ','VUSAl_EQ'].includes(t)) explicitSellTickers.delete(t);
  }

  const plan = {
    createdAt: new Date().toISOString(),
    portfolioTotal: total,
    targetModel: buildTargets(),
    sells: [],
    trims: [],
    buys: [],
    notes: []
  };

  const byTicker = new Map(merged.map(p=>[p.ticker,p]));

  // Build sells (sell full current quantity by using negative quantity equal to current quantity)
  // We need quantities: derive from export positionsRaw per ticker sum quantities.
  const qtyByTicker = new Map();
  for (const r of exportObj.positionsRaw || []){
    const t = r.ticker;
    if (!t) continue;
    qtyByTicker.set(t, (qtyByTicker.get(t)||0) + Number(r.quantity||0));
  }

  for (const t of [...explicitSellTickers]){
    const q = qtyByTicker.get(t) || 0;
    if (q > 0) plan.sells.push({ticker:t, quantity: -q});
  }

  // PLTR trim: target 5%
  const pltr = byTicker.get('PLTR_US_EQ');
  if (pltr){
    const targetValue = total * 0.05;
    const excessValue = pltr.currentValue - targetValue;
    if (excessValue > 1){
      // approximate quantity to sell using currentPrice from one raw line
      const rawLine = (exportObj.positionsRaw||[]).find(r=>r.ticker==='PLTR_US_EQ' && r.currentPrice!=null);
      const px = rawLine ? Number(rawLine.currentPrice) : null;
      const qTotal = qtyByTicker.get('PLTR_US_EQ') || 0;
      if (px && qTotal>0){
        const estQtyToSell = Math.min(qTotal, excessValue / (px));
        plan.trims.push({ticker:'PLTR_US_EQ', quantity: -estQtyToSell, reason:'trim to 5%'});
        plan.notes.push('PLTR: trim en 4 tranches recommandé (ce plan ne prépare que la tranche #1).');
      } else {
        plan.notes.push('PLTR: impossible de calculer la quantité à vendre (prix/qty manquants).');
      }
    }
  }

  // Buys: for each target ticker, compute delta value vs current, convert to quantity using currentPrice
  for (const tgt of targets){
    const cur = byTicker.get(tgt.ticker);
    const curVal = cur ? cur.currentValue : 0;
    const targetVal = total * tgt.pct;
    const need = targetVal - curVal;
    if (need <= 1) continue;

    // get price
    const rawLine = (exportObj.positionsRaw||[]).find(r=>r.ticker===tgt.ticker && r.currentPrice!=null);
    const px = rawLine ? Number(rawLine.currentPrice) : null;
    if (!px || !Number.isFinite(px) || px<=0) {
      plan.notes.push(`BUY ${tgt.ticker}: prix manquant, impossible de calculer quantité.`);
      continue;
    }
    const qty = need / px;
    plan.buys.push({ticker:tgt.ticker, quantity: qty});
  }

  // sort orders by size heuristic: sells first, then trims, then buys
  return plan;
}

async function placeMarketOrder(authHeader, ticker, quantity){
  const headers = {
    'Authorization': authHeader,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
  const body = {ticker, quantity, extendedHours: true};
  const url = BASE + ORDERS_MARKET_PATH;
  return fetchWithRateLimit('POST', url, headers, body, {label:`order:${ticker}`});
}

(async function main(){
  const exportObj = readJson(ANALYSIS_PATH, null);
  if (!exportObj){
    console.error('Missing analysis export. Run: node trading212-digest.js --export-analysis');
    process.exit(2);
  }

  const plan = buildPlan(exportObj);
  writeJson(PLAN_PATH, plan);
  console.log('PLAN_WRITTEN', PLAN_PATH);
  console.log(`Orders: sells=${plan.sells.length}, trims=${plan.trims.length}, buys=${plan.buys.length}`);

  if (!FLAG_EXECUTE) return;
  if (process.env.CONFIRM_SEND !== 'YES') {
    console.error('Refusing to execute: set CONFIRM_SEND=YES');
    process.exit(3);
  }
  if (!key || !secret) {
    console.error('Missing Trading212 credentials');
    process.exit(2);
  }

  const authHeader = 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');

  const sent = readJson(SENT_PATH, {sentAt:[], orders:[]});
  const already = new Set((sent.orders||[]).map(o=>o.fingerprint));
  const toSend = [];
  for (const o of [...plan.sells, ...plan.trims, ...plan.buys]){
    // fingerprint (best-effort)
    const fp = `${o.ticker}:${Number(o.quantity).toFixed(8)}`;
    if (already.has(fp)) continue;
    toSend.push({...o, fingerprint: fp});
  }

  console.log(`EXECUTE: sending ${toSend.length} orders (market).`);
  for (const o of toSend){
    const resp = await placeMarketOrder(authHeader, o.ticker, o.quantity);
    sent.orders.push({
      fingerprint: o.fingerprint,
      ticker: o.ticker,
      quantity: o.quantity,
      ts: new Date().toISOString(),
      status: resp.status,
      response: resp.json || null
    });
    writeJson(SENT_PATH, sent);

    if (resp.status < 200 || resp.status >= 300) {
      // Common safe failure: trying to sell something that's not owned (portfolio changed since plan)
      const errType = resp.json && resp.json.type;
      if (resp.status === 400 && errType === '/api-errors/selling-equity-not-owned') {
        console.error('ORDER_SKIPPED_NOT_OWNED', o.ticker);
        continue;
      }
      console.error('ORDER_FAILED', o.ticker, resp.status);
      process.exit(10);
    }
    // gentle pacing
    await wait(250);
  }

  console.log('EXECUTE_DONE');
})();
