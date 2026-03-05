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

  // Optional: pull a small sample of new/unassigned leads (no phone/email)
  const needSample = (toAssign > 0 || newLeads > 0) && leadSampleLimit > 0;
  if (needSample) {
    const u2 = new URL(BASE);
    u2.searchParams.set('sections', 'leads');
    u2.searchParams.set('since', since);
    u2.searchParams.set('limit', String(Math.min(100, leadSampleLimit)));
    if (orgId) u2.searchParams.set('organization_id', orgId);

    const r2 = await getJson(u2);
    if (r2.status === 200 && r2.json && Array.isArray(r2.json.leads)) {
      const sample = r2.json.leads
        .filter(l => ['a_attribuer','nouveau'].includes(l.status))
        .slice(0, leadSampleLimit)
        .map(l => ({
          id: l.id,
          status: l.status,
          source: l.source || null,
          form: l.form_name || null,
          created_at: l.created_at || null,
        }));
      if (sample.length) {
        lines.push(`Exemples à traiter (sans PII): ${sample.length}`);
        for (const s of sample) {
          lines.push(`- ${s.status} | ${s.source||'?'} | ${s.form||'?'} | ${String(s.id).slice(0,8)}`);
        }
      }
    }
  }

  console.log(lines.join('\n'));
})();
