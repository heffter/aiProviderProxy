/**
 * Dashboard HTML shell (epic AIPP-11, subtask 11.1).
 *
 * A self-contained, dependency-free page (rebranded aiproviderproxy) that polls
 * the local dashboard API. No external resources are loaded and no analytics
 * ping is sent (the legacy dashboard telemetry is deleted).
 */

/** The dashboard page HTML. Static and self-contained. */
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>aiproviderproxy dashboard</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem; background: #0f1115; color: #e6e6e6; }
  h1 { font-size: 1.25rem; } h2 { font-size: 1rem; margin-top: 1.5rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; }
  .card { background: #171a21; border: 1px solid #262b36; border-radius: 8px; padding: 0.75rem 1rem; }
  .card .n { font-size: 1.5rem; font-weight: 600; } .card .l { color: #8b93a1; font-size: 0.8rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #262b36; }
  .ok { color: #4ade80; } .bad { color: #f87171; }
</style>
</head>
<body>
<h1>aiproviderproxy &mdash; local dashboard</h1>
<div class="grid" id="summary"></div>
<h2>Exporter health</h2>
<div class="grid" id="exporter"></div>
<h2>Recent requests</h2>
<table id="runs"><thead><tr><th>time</th><th>provider</th><th>model</th><th>outcome</th><th>tokens</th><th>cost</th></tr></thead><tbody></tbody></table>
<script>
async function j(u){ const r = await fetch(u); if(!r.ok) throw new Error(u+': '+r.status); return r.json(); }
function card(l,n){ return '<div class="card"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'; }
async function refresh(){
  try {
    const s = await j('/api/summary');
    document.getElementById('summary').innerHTML =
      card('requests', s.totalRequests) +
      card('success', (s.successRate*100).toFixed(0)+'%') +
      card('cost (USD)', s.totalCostUsd.toFixed(4)) +
      card('in tokens', s.totalInputTokens) +
      card('out tokens', s.totalOutputTokens);
    const e = await j('/api/exporter');
    document.getElementById('exporter').innerHTML =
      card('queue depth', e.pending) +
      card('exported', e.exported) +
      card('dead-lettered', e.dead) +
      '<div class="card"><div class="n '+(e.healthy?'ok':'bad')+'">'+(e.healthy?'healthy':'degraded')+'</div><div class="l">status</div></div>';
    const runs = await j('/api/runs');
    document.querySelector('#runs tbody').innerHTML = runs.map(function(r){
      return '<tr><td>'+r.timestamp+'</td><td>'+r.provider+'</td><td>'+r.routedModel+'</td>'+
        '<td class="'+(r.success?'ok':'bad')+'">'+r.outcome+'</td>'+
        '<td>'+r.inputTokens+'/'+r.outputTokens+'</td><td>'+((r.costEstimateUsd||0).toFixed(4))+'</td></tr>';
    }).join('');
  } catch (err) { console.error(err); }
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}
