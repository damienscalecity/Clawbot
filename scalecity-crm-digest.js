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

function sinceIso(hoursBack){
  return new Date(Date.now() - hoursBack*3600*1000).toISOString();
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
  const since = sinceIso(hours);
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
  lines.push(`CRM Digest (${hours}h) — leads: ${totalLeads}, CA: ${revenue}€`);
  lines.push(`Conv RDV: ${fmtPct(crRdv)} | Conv vendu: ${fmtPct(crVendu)}`);

  // Key alerts
  const alerts = [];
  if (toAssign > 0) alerts.push(`À attribuer: ${toAssign}`);
  if (newLeads > 0) alerts.push(`Nouveaux: ${newLeads}`);
  if (nrp > 0) alerts.push(`NRP: ${nrp}`);
  if (setting > 0) alerts.push(`Setting: ${setting}`);
  if (negoc > 0) alerts.push(`Négociation: ${negoc}`);
  if (alerts.length) lines.push('Focus: ' + alerts.join(' | '));

  // Media-buyer view: campaigns with leads (24h) + campaigns that dropped to 0 vs last 7d
  const u2 = new URL(BASE);
  u2.searchParams.set('sections', 'leads');
  u2.searchParams.set('since', since);
  u2.searchParams.set('limit', '500');
  if (orgId) u2.searchParams.set('organization_id', orgId);
  const r2 = await getJson(u2);

  const u7 = new URL(BASE);
  u7.searchParams.set('sections', 'leads');
  u7.searchParams.set('since', sinceIso(24*7));
  u7.searchParams.set('limit', '2000');
  if (orgId) u7.searchParams.set('organization_id', orgId);
  const r7 = await getJson(u7);

  if (r2.status === 200 && r2.json && Array.isArray(r2.json.leads) && r7.status === 200 && r7.json && Array.isArray(r7.json.leads)) {
    const leads24 = r2.json.leads;
    const leads7d = r7.json.leads;

    const c24 = new Map();
    const c7 = new Set();
    let unknown24 = 0;

    for (const l of leads24) {
      const k = canonicalCampaignKey(l.campaign_name);
      if (k === '(unknown)') unknown24++;
      c24.set(k, (c24.get(k) || 0) + 1);
    }
    for (const l of leads7d) {
      const k = canonicalCampaignKey(l.campaign_name);
      c7.add(k);
    }

    const top = [...c24.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 12);
    const zeros = [...c7].filter(k => k !== '(unknown)' && !c24.has(k)).sort();

    lines.push(`\nMedia Buyer (24h): ${leads24.length} leads | campagnes: ${c24.size}${unknown24?` | unknown: ${unknown24}`:''}`);
    lines.push('Top campagnes (clé normalisée):');
    for (const [k,v] of top) lines.push(`- ${k}: ${v}`);

    if (zeros.length) {
      lines.push(`Campagnes actives 7j mais 0 lead (24h): ${zeros.length}`);
      for (const k of zeros.slice(0, 20)) lines.push(`- ${k}`);
      if (zeros.length > 20) lines.push(`- (+${zeros.length-20} autres)`);
    }
  }

  console.log(lines.join('\n'));
})();
