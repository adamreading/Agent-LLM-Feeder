// Trigger a catalog refresh from the terminal: `npm run sync` (run from server/).
//
// This hits the RUNNING server's POST /api/catalog/sync?wait=1 rather than
// importing runCatalogSync directly, on purpose: the live process holds the
// re-entrancy guard (catalogSync.ts `running`) and has the search config
// injected into env at boot (loadSearchConfigIntoEnv), so going through the
// endpoint can't collide with the in-process daily scheduler or spin up a
// second concurrent sync with a half-configured env. Localhost-only endpoint,
// so this only works on the box feeder runs on.
//
// Pipeline it runs: DISCOVER (GET /models, free) -> ADD unseen -> CLASSIFY
// (free) -> RETIRE delisted -> ENABLE (bounded liveness) -> RESEARCH. See
// services/catalogSync.ts. To list every provider's models WITHOUT mutating
// anything (zero tokens), use `npm run discover` instead.
import '../env.js';

const PORT = process.env.PORT ?? 3001;
const url = `http://localhost:${PORT}/api/catalog/sync?wait=1`;

async function main() {
  console.log(`Triggering catalog sync at ${url} (this can take a few minutes)…\n`);

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  } catch (e: any) {
    if (e?.cause?.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(e?.message ?? '')) {
      console.error(`Could not reach feeder on :${PORT} — is the server running? Start it with \`npm start\` (or check PORT in .env), then retry.`);
    } else {
      console.error(`Request failed: ${e?.message ?? e}`);
    }
    process.exit(1);
  }

  const body: any = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`Sync request returned HTTP ${res.status}: ${JSON.stringify(body)}`);
    process.exit(1);
  }

  if (body?.note) console.log(`note: ${body.note}\n`);

  const p = body?.platforms ?? {};
  const names = Object.keys(p).sort();
  if (names.length) {
    console.log('Per-provider poll (GET /models):');
    for (const name of names) {
      const d = p[name];
      const flag = d.trustworthy ? 'ok ' : '   ';
      console.log(`  ${flag} ${name.padEnd(14)} HTTP ${String(d.status).padStart(3)} — ${String(d.live).padStart(4)} models${d.err ? '  ERR: ' + d.err : ''}`);
    }
    console.log('');
  }

  console.log('Catalog changes this run:');
  console.log(`  added                ${body?.added ?? 0}`);
  console.log(`  reappeared           ${body?.reappeared ?? 0}`);
  console.log(`  enabled (went live)  ${body?.enabled ?? 0}`);
  console.log(`  retired (delisted)   ${body?.retired ?? 0}`);
  console.log(`  reclassified paid    ${body?.reclassifiedPaid ?? 0}`);
  console.log(`  reclassified non-chat ${body?.reclassifiedNonChat ?? 0}`);
  console.log(`  canonicals created   ${body?.canonicalsCreated ?? 0}`);
  console.log(`  researched           ${body?.researched ?? 0}`);
  console.log(`\nDone (${body?.startedAt} → ${body?.finishedAt}). The usable list is GET /v1/models.`);
}

main();
