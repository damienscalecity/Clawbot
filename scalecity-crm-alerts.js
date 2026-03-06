#!/usr/bin/env node
/**
 * ScaleCity CRM Alerts (Media Buyer)
 *
 * Alerts when a lead list is "active" (>=threshold leads in last 7d)
 * but has 0 leads today (Mauritius day).
 *
 * Output: prints nothing if no alerts (exit 0).
 */

const https = require('https');

const BASE = 'https://abzscorgyedhyhlxzzkc.supabase.co/functions/v1/crm-read-api';
const apiKey = process.env.SCALECITY_CRM_API_KEY;
if (!apiKey) {
  console.error('Missing SCALECITY_CRM_API_KEY');
  process.exit(2);
}

const args = process.argv.slice(2);
const threshold = Number((args.find(a=>a.startsWith('--active7d='))||'').split('=')[1] || '5');
const orgId = (args.find(a=>a.startsWith('--org='))||'').split('=')[1] || null;

function mauritiusDayWindowUtc(refDate = new Date()){
  const offsetMs = 4 * 3600 * 1000;
  const mutNow = new Date(refDate.getTime() + offsetMs);
  const y = mutNow.getUTCFullYear();
  const m = mutNow.getUTCMonth();
  const d = mutNow.getUTCDate();
  const startMut = new Date(Date.UTC(y, m, d)); // today 00:00 MUT in MUT-clock
  const startUtc = new Date(startMut.getTime() - offsetMs);
  const endUtc = new Date(startUtc.getTime() + 24*3600*1000);
  return {startUtc, endUtc};
}
function inWindow(iso, startUtc, endUtc){
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= startUtc.getTime() && t < endUtc.getTime();
}

function getJson(url){
  return new Promise((resolve,reject)=>{
    https.get(url, {headers:{'x-api-key':apiKey,'Accept':'application/json'}}, res=>{
      let data='';
      res.on('data',c=>data+=c);
      res.on('end',()=>{
        let json=null;
        try{json=JSON.parse(data);}catch(e){}
        resolve({status:res.statusCode,json,text:data});
      });
    }).on('error',reject);
  });
}

(async function main(){
  const {startUtc, endUtc} = mauritiusDayWindowUtc(new Date());
  const start7 = new Date(startUtc.getTime() - 7*24*3600*1000);

  const uLists = new URL(BASE);
  uLists.searchParams.set('sections','lead_lists');
  uLists.searchParams.set('since', start7.toISOString());
  uLists.searchParams.set('limit','500');
  if (orgId) uLists.searchParams.set('organization_id', orgId);

  const uLeads = new URL(BASE);
  uLeads.searchParams.set('sections','leads');
  uLeads.searchParams.set('since', start7.toISOString());
  uLeads.searchParams.set('limit','5000');
  if (orgId) uLeads.searchParams.set('organization_id', orgId);

  const [rLists, rLeads] = await Promise.all([getJson(uLists), getJson(uLeads)]);
  if (rLists.status !== 200 || rLeads.status !== 200 || !rLists.json || !rLeads.json) {
    console.log(`CRM alert error (${rLists.status}/${rLeads.status})`);
    process.exit(1);
  }

  const listNameById = new Map((rLists.json.lead_lists||[]).map(l=>[l.id, l.name||l.id]));
  const leads = rLeads.json.leads || [];

  const c7 = new Map();
  const cToday = new Map();

  for (const l of leads) {
    const id = l.lead_list_id;
    if (!id) continue;
    c7.set(id, (c7.get(id)||0) + 1);
    if (inWindow(l.created_at, startUtc, endUtc)) {
      cToday.set(id, (cToday.get(id)||0) + 1);
    }
  }

  const alerts = [];
  for (const [id,count7] of c7.entries()) {
    if (count7 < threshold) continue;
    if ((cToday.get(id)||0) === 0) {
      alerts.push({name: listNameById.get(id)||id, leads7d: count7});
    }
  }

  if (!alerts.length) process.exit(0);

  alerts.sort((a,b)=>b.leads7d-a.leads7d);

  const lines=[];
  lines.push(`ALERTE Media Buyer — 0 lead aujourd'hui (MUT) — seuil actif 7j ≥ ${threshold}`);
  for (const a of alerts) lines.push(`- ${a.name} (7j: ${a.leads7d})`);
  console.log(lines.join('\n'));
})();
