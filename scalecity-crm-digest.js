#!/usr/bin/env node
/**
 * ScaleCity CRM Morning Digest
 *
 * Reads SCALECITY_CRM_API_KEY from env.
 * Calls Supabase Edge Function crm-read-api.
 * Outputs a short French digest focused on operational issues.
 */

const https = require('https');

const BASE = 'https://abzscorgyedhyhlxzzkc.supabase.co/functions/v1/crm-read-api';
const apiKey = process.env.SCALECITY_CRM_API_KEY;
if (!apiKey) {
  console.error('Missing SCALECITY_CRM_API_KEY');
  process.exit(2);
}

const args = process.argv.slice(2);
const hours = Number((args.find(a=>a.startsWith('--hours='))||'').split('=')[1] || '24');
const orgId = (args.find(a=>a.startsWith('--org='))||'').split('=')[1] || null;
const leadSampleLimit = Number((args.find(a=>a.startsWith('--lead-sample-limit='))||'').split('=')[1] || '10');
const FLAG_MAURITIUS_DAY = args.includes('--mauritius-day');

function sinceIso(hoursBack){
  return new Date(Date.now() - hoursBack*3600*1000).toISOString();
}

function mauritiusDayWindowUtc(refDate = new Date()){
  // Mauritius is UTC+4 year-round.
  const offsetMs = 4 * 3600 * 1000;
  const mutNow = new Date(refDate.getTime() + offsetMs);
  // window for "yesterday" in MUT: [00:00, 24:00)
  const y = mutNow.getUTCFullYear();
  const m = mutNow.getUTCMonth();
  const d = mutNow.getUTCDate();
  const startMut = new Date(Date.UTC(y, m, d) - 24*3600*1000); // yesterday 00:00 MUT in MUT-clock
  const endMut = new Date(Date.UTC(y, m, d)); // today 00:00 MUT
  // convert MUT-clock instants back to UTC by subtracting offset
  const startUtc = new Date(startMut.getTime() - offsetMs);
  const endUtc = new Date(endMut.getTime() - offsetMs);
  return {startUtc, endUtc};
}

function inWindow(iso, startUtc, endUtc){
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= startUtc.getTime() && t < endUtc.getTime();
}

function getJson(url){
  return new Promise((resolve,reject)=>{
    https.get(url, {
      headers: {
        'x-api-key': apiKey,
        'Accept': 'application/json'
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null;
        try{ json = JSON.parse(data); }catch(e){ json = null; }
        resolve({status: res.statusCode, json, text: data});
      });
    }).on('error', reject);
  });
}

function fmtPct(x){
  if (x == null || !Number.isFinite(Number(x))) return 'n/a';
  return Number(x).toFixed(1) + '%';
}

function pick(obj, key, def=null){
  return obj && obj[key] != null ? obj[key] : def;
}

function canonicalCampaignKey(name){
  if (!name || typeof name !== 'string') return '(unknown)';
  let s = name.trim();
  if (!s) return '(unknown)';
  // normalize dash variants
  s = s.replace(/[–—]/g, '-');
  // collapse whitespace
  s = s.replace(/\s+/g, ' ');
  // Prefer splitting on " - " (with spaces) to avoid breaking tickers like "A-B"
  const parts = s.split(' - ').map(x=>x.trim()).filter(Boolean);
  const head = parts.length ? parts[0] : s;
  return head.toLowerCase();
}

(async function main(){
  // Time window
  let since;
  let windowStartUtc = null;
  let windowEndUtc = null;
  if (FLAG_MAURITIUS_DAY) {
    const w = mauritiusDayWindowUtc(new Date());
    windowStartUtc = w.startUtc;
    windowEndUtc = w.endUtc;
    since = w.startUtc.toISOString();
  } else {
    since = sinceIso(hours);
  }
  const u = new URL(BASE);
  u.searchParams.set('sections', 'statistics,lead_lists');
  u.searchParams.set('since', since);
  if (orgId) u.searchParams.set('organization_id', orgId);

  const r = await getJson(u);
  if (r.status !== 200 || !r.json) {
    console.log(`Erreur CRM (${r.status})`);
    process.exit(1);
  }

  const stats = r.json.statistics || {};
  const breakdown = stats.status_breakdown || {};

  const totalLeads = pick(stats, 'total_leads', 0);
  const revenue = pick(stats, 'total_revenue', 0);
  const crRdv = pick(stats, 'conversion_rate_rdv', null);
  const crVendu = pick(stats, 'conversion_rate_vendu', null);

  // Operational issue heuristics
  const toAssign = Number(breakdown.a_attribuer || 0);
  const newLeads = Number(breakdown.nouveau || 0);
  const nrp = Number(breakdown.nrp || 0);
  const setting = Number(breakdown.setting || 0);
  const negoc = Number(breakdown.en_cours_de_negociation || 0);

  const lines = [];
  if (FLAG_MAURITIUS_DAY && windowStartUtc && windowEndUtc) {
    lines.push(`CRM Digest (hier — jour Maurice) — fenêtre UTC: ${windowStartUtc.toISOString()} → ${windowEndUtc.toISOString()}`);
  } else {
    lines.push(`CRM Digest (${hours}h) — leads: ${totalLeads}, CA: ${revenue}€`);
  }
  lines.push(`Conv RDV: ${fmtPct(crRdv)} | Conv vendu: ${fmtPct(crVendu)}`);

  // Key alerts
  const alerts = [];
  if (toAssign > 0) alerts.push(`À attribuer: ${toAssign}`);
  if (newLeads > 0) alerts.push(`Nouveaux: ${newLeads}`);
  if (nrp > 0) alerts.push(`NRP: ${nrp}`);
  if (setting > 0) alerts.push(`Setting: ${setting}`);
  if (negoc > 0) alerts.push(`Négociation: ${negoc}`);
  if (alerts.length) lines.push('Focus: ' + alerts.join(' | '));

  // Media-buyer view (recommended): leads by lead_list (list is the reference)
  const uLists = new URL(BASE);
  uLists.searchParams.set('sections', 'lead_lists');
  uLists.searchParams.set('since', sinceIso(24*30));
  uLists.searchParams.set('limit', '500');
  if (orgId) uLists.searchParams.set('organization_id', orgId);

  const u2 = new URL(BASE);
  u2.searchParams.set('sections', 'leads');
  u2.searchParams.set('since', since);
  u2.searchParams.set('limit', '2000');
  if (orgId) u2.searchParams.set('organization_id', orgId);

  const u7 = new URL(BASE);
  u7.searchParams.set('sections', 'leads');
  u7.searchParams.set('since', sinceIso(24*7));
  u7.searchParams.set('limit', '5000');
  if (orgId) u7.searchParams.set('organization_id', orgId);

  const [rLists, r2, r7] = await Promise.all([getJson(uLists), getJson(u2), getJson(u7)]);

  if (rLists.status === 200 && rLists.json && Array.isArray(rLists.json.lead_lists) &&
      r2.status === 200 && r2.json && Array.isArray(r2.json.leads) &&
      r7.status === 200 && r7.json && Array.isArray(r7.json.leads)) {

    const lists = rLists.json.lead_lists;
    const listNameById = new Map(lists.map(l => [l.id, l.name || l.id]));

    let leads24 = r2.json.leads;
    let leads7d = r7.json.leads;

    if (FLAG_MAURITIUS_DAY && windowStartUtc && windowEndUtc) {
      // Filter to yesterday's MUT day window
      leads24 = leads24.filter(l => inWindow(l.created_at, windowStartUtc, windowEndUtc));
      // For 7d baseline, use last 7 full MUT days ending at windowEndUtc
      const start7 = new Date(windowEndUtc.getTime() - 7*24*3600*1000);
      leads7d = leads7d.filter(l => inWindow(l.created_at, start7, windowEndUtc));
    }

    const n24 = new Map();
    const n7 = new Map();
    let unknownList24 = 0;

    for (const l of leads24) {
      const id = l.lead_list_id || '(unknown)';
      if (id === '(unknown)') unknownList24++;
      n24.set(id, (n24.get(id) || 0) + 1);
    }
    for (const l of leads7d) {
      const id = l.lead_list_id || '(unknown)';
      n7.set(id, (n7.get(id) || 0) + 1);
    }

    // Active definition: has at least 1 lead in last 7 days
    const activeIds = new Set([...n7.keys()].filter(id => id !== '(unknown)' && (n7.get(id) || 0) > 0));

    const top = [...n24.entries()]
      .filter(([id]) => id !== '(unknown)')
      .sort((a,b)=>b[1]-a[1])
      .slice(0, 12)
      .map(([id,c]) => ({id, name: listNameById.get(id) || id, leads: c}));

    const zero24 = [...activeIds]
      .filter(id => !n24.has(id))
      .map(id => ({id, name: listNameById.get(id) || id, leads7d: n7.get(id) || 0}))
      .sort((a,b)=> (b.leads7d - a.leads7d));

    // Top drops: compare 24h to 7d daily average
    const drops = [...activeIds]
      .map(id => {
        const c24 = n24.get(id) || 0;
        const c7 = n7.get(id) || 0;
        const avg = c7 / 7;
        const delta = c24 - avg;
        const pct = avg > 0 ? (delta / avg) : null;
        return {id, name: listNameById.get(id) || id, c24, avg, delta, pct, c7};
      })
      .filter(x => x.avg >= 1) // ignore tiny averages
      .sort((a,b)=> a.delta - b.delta) // most negative first
      .slice(0, 10);

    lines.push(`\nMedia Buyer (24h): ${leads24.length} leads | listes actives (7j): ${activeIds.size}${unknownList24?` | unknown lead_list_id: ${unknownList24}`:''}`);
    lines.push('Top listes (24h):');
    for (const t of top) lines.push(`- ${t.name}: ${t.leads}`);

    if (drops.length) {
      lines.push('Top chutes (24h vs moyenne/j 7j):');
      for (const d of drops) {
        const avg = d.avg.toFixed(1);
        const pct = d.pct == null ? '' : ` (${(d.pct*100).toFixed(0)}%)`;
        lines.push(`- ${d.name}: ${d.c24} vs ${avg}${pct}`);
      }
    }

    if (zero24.length) {
      lines.push(`Listes actives (7j) mais 0 lead (24h): ${zero24.length}`);
      // full list (sorted by 7d volume)
      for (const z of zero24) lines.push(`- ${z.name} (7j: ${z.leads7d})`);
    }
  }

  console.log(lines.join('\n'));
})();
