#!/usr/bin/env node
// scripts/infra-check.js
//
// Read-only preflight for the Civo -> Hetzner migration. Verifies every
// credential in .env.migrate and reports what is actually out there: the fresh
// VPS and its region, the Civo object store holding the media, and the R2
// buckets. It creates, changes and deletes NOTHING, and it never prints a
// secret value.
//
//   node scripts/infra-check.js
//
// Exit code is 0 if every credential authenticated, 1 otherwise — so it is
// safe to run as a gate before any real work.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env.migrate');

function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v && !process.env[k]) process.env[k] = v;
  }
  return true;
}
if (!loadEnvFile(ENV_FILE)) {
  console.error(`infra-check: no ${path.relative(ROOT, ENV_FILE)} — copy .env.migrate.example and fill it in`);
  process.exit(2);
}

// Never let a secret reach stdout: any object key holding one is masked.
const SECRET_KEY_RE = /(secret|access_?key|api_?key|password|token|credential)/i;
function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redact(val);
    return out;
  }
  return v;
}

async function j(url, init) {
  try {
    const r = await fetch(url, init);
    let body = null;
    try { body = await r.json(); } catch { /* not json */ }
    return { status: r.status, ok: r.ok, body };
  } catch (e) {
    return { status: 0, ok: false, body: null, err: String((e && e.message) || e) };
  }
}

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); };

const line = (s) => console.log(s);
const h = (s) => { line(''); line(`== ${s} ${'='.repeat(Math.max(0, 66 - s.length))}`); };

// ---------- Hetzner Cloud ----------
async function checkHetzner() {
  h('Hetzner Cloud');
  const token = process.env.HCLOUD_TOKEN;
  if (!token) return record('hetzner', false, 'HCLOUD_TOKEN missing');
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  const servers = await j('https://api.hetzner.cloud/v1/servers', auth);
  if (!servers.ok) {
    line(`  servers: HTTP ${servers.status} ${servers.err || ''} ${servers.body ? JSON.stringify(redact(servers.body)) : ''}`);
    return record('hetzner', false, `servers HTTP ${servers.status}`);
  }
  const list = (servers.body && servers.body.servers) || [];
  line(`  servers: ${list.length}`);
  for (const s of list) {
    const ip4 = (s.public_net && s.public_net.ipv4 && s.public_net.ipv4.ip) || '(none)';
    const ip6 = (s.public_net && s.public_net.ipv6 && s.public_net.ipv6.ip) || '(none)';
    const loc = (s.datacenter && s.datacenter.location && s.datacenter.location.name) || '?';
    const dc = (s.datacenter && s.datacenter.name) || '?';
    const type = s.server_type || {};
    line(`    #${s.id} ${s.name}`);
    line(`       status=${s.status}  ipv4=${ip4}  ipv6=${ip6}`);
    line(`       datacenter=${dc} location=${loc}  type=${type.name} (${type.cores} vCPU / ${type.memory} GB / ${type.disk} GB)  image=${(s.image && s.image.name) || '?'}`);
    if (type.architecture) line(`       arch=${type.architecture}`);
  }
  const ready = list.filter((s) => s.status === 'running');
  record('hetzner', true, `${list.length} server(s), ${ready.length} running`);

  // The list response can return datacenter as an id; resolve it so the object
  // storage bucket is created in the SAME location as the VPS.
  for (const s of list) {
    const detail = await j(`https://api.hetzner.cloud/v1/servers/${s.id}`, auth);
    const d = (detail.body && detail.body.server) || {};
    const dc = d.datacenter || {};
    const loc = dc.location || {};
    const dcId = typeof s.datacenter === 'object' ? (s.datacenter && s.datacenter.id) : s.datacenter;
    line(`    datacenter id=${dcId} name=${dc.name || '?'} location=${loc.name || '?'} city=${loc.city || '?'} country=${loc.country || '?'}`);
    const s3loc = { fsn1: 'fsn1', nbg1: 'nbg1', hel1: 'hel1', ash: 'ash', hil: 'hil', sin: 'sin' }[loc.name];
    if (s3loc) line(`       -> object storage endpoint should be https://${s3loc}.your-objectstorage.com`);
  }

  const ssh = await j('https://api.hetzner.cloud/v1/ssh_keys', auth);
  if (ssh.ok) {
    const keys = (ssh.body && ssh.body.ssh_keys) || [];
    line(`  ssh keys in project: ${keys.length}`);
    for (const k of keys) line(`    ${k.name}  ${String(k.fingerprint || '').slice(0, 24)}…`);
    if (!keys.length) line('    ! no SSH key in the project — the server must be reachable another way');
  }

  const locs = await j('https://api.hetzner.cloud/v1/locations', auth);
  if (locs.ok) {
    const names = ((locs.body && locs.body.locations) || []).map((l) => `${l.name}(${l.city || l.country})`);
    line(`  locations: ${names.join(', ')}`);
  }

  // Object Storage is a separate product; the Cloud API may not expose it.
  // Probe a few plausible routes so we learn the answer rather than guess.
  const probes = ['/v1/object_storage', '/v1/object_storages', '/v1/object-storage', '/v1/s3_credentials'];
  const found = [];
  for (const p of probes) {
    const r = await j(`https://api.hetzner.cloud${p}`, auth);
    if (r.status !== 404) found.push(`${p} -> HTTP ${r.status}`);
  }
  line(`  object-storage API probes: ${found.length ? found.join('; ') : 'all 404 (not part of the Cloud API)'}`);
}

// ---------- Civo ----------
async function checkCivo() {
  h('Civo');
  const key = process.env.CIVO_API_KEY;
  if (!key) return record('civo', false, 'CIVO_API_KEY missing');
  const auth = { headers: { Authorization: `bearer ${key}` } };

  const stores = await j('https://api.civo.com/v2/objectstores', auth);
  if (!stores.ok) {
    line(`  objectstores: HTTP ${stores.status} ${stores.body ? JSON.stringify(redact(stores.body)).slice(0, 300) : ''}`);
    record('civo', false, `objectstores HTTP ${stores.status}`);
  } else {
    const list = Array.isArray(stores.body) ? stores.body : (stores.body && stores.body.items) || [];
    line(`  object stores: ${list.length}`);
    for (const s of list) {
      const gb = s.size != null ? (Number(s.size) / 1024 ** 3).toFixed(2) + ' GiB used' : 'size ?';
      line(`    ${s.name || s.id}  region=${s.region || '?'}  status=${s.status || '?'}  ${gb}` + (s.max_size ? ` / ${(Number(s.max_size) / 1024 ** 3).toFixed(0)} GiB` : ''));
      const detail = await j(`https://api.civo.com/v2/objectstores/${s.name || s.id}`, auth);
      if (detail.ok && detail.body) {
        // Deep-redacted: owner_info nests an access_key_id, so a top-level
        // key filter is not enough.
        line(`      detail: ${JSON.stringify(redact(detail.body)).slice(0, 500)}`);
      }
    }
    record('civo', true, `${list.length} object store(s)`);
  }

  const inst = await j('https://api.civo.com/v2/instances', auth);
  if (inst.ok) {
    const list = Array.isArray(inst.body) ? inst.body : (inst.body && inst.body.items) || [];
    line(`  compute instances: ${list.length}`);
  }
  const clusters = await j('https://api.civo.com/v2/kubernetes/clusters', auth);
  if (clusters.ok) {
    const list = Array.isArray(clusters.body) ? clusters.body : (clusters.body && clusters.body.items) || [];
    line(`  k8s clusters: ${list.map((c) => `${c.name}(${c.region}, ${c.status})`).join(', ') || 'none'}`);
  }
}

// ---------- Cloudflare ----------
async function checkCloudflare() {
  h('Cloudflare');
  const key = process.env.CLOUDFLARE_API_KEY;
  const email = process.env.CLOUDFLARE_EMAIL;
  if (!key) return record('cloudflare', false, 'CLOUDFLARE_API_KEY missing');

  // A prefixed key (cfk_…) is an API token -> Bearer. A legacy Global API Key is
  // used with the account email. Detect rather than assume.
  let authMode = 'bearer';
  let verify = await j('https://api.cloudflare.com/client/v4/user/tokens/verify', {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!verify.ok || !verify.body || verify.body.success !== true) {
    authMode = 'global-key';
    verify = await j('https://api.cloudflare.com/client/v4/user', {
      headers: { 'X-Auth-Email': email || '', 'X-Auth-Key': key },
    });
  }
  const good = verify.ok && verify.body && verify.body.success === true;
  line(`  auth: ${authMode} -> ${good ? 'OK' : `FAILED (HTTP ${verify.status})`}`);
  if (!good) {
    line(`  response: ${verify.body ? JSON.stringify(redact(verify.body)).slice(0, 400) : verify.err}`);
    return record('cloudflare', false, `auth failed (${authMode})`);
  }
  record('cloudflare', true, `authenticated via ${authMode}`);
  if (authMode === 'bearer' && verify.body.result) {
    line(`  token status=${verify.body.result.status} id=${String(verify.body.result.id || '').slice(0, 8)}…`);
  }

  const hdrs = authMode === 'bearer'
    ? { Authorization: `Bearer ${key}` }
    : { 'X-Auth-Email': email || '', 'X-Auth-Key': key };

  const accts = await j('https://api.cloudflare.com/client/v4/accounts', { headers: hdrs });
  const accounts = (accts.body && accts.body.result) || [];
  line(`  accounts: ${accounts.map((a) => `${a.name} (${a.id})`).join(', ') || 'none'}`);
  for (const a of accounts) {
    const buckets = await j(`https://api.cloudflare.com/client/v4/accounts/${a.id}/r2/buckets`, { headers: hdrs });
    const list = (buckets.body && buckets.body.result && buckets.body.result.buckets) || [];
    line(`  R2 buckets in ${a.name}: ${list.map((b) => b.name).join(', ') || (buckets.ok ? 'none' : `HTTP ${buckets.status}`)}`);
    for (const b of list) line(`    ${b.name}  created=${(b.creation_date || '').slice(0, 10)}  location=${b.location || 'auto'}`);
  }

  const zones = await j('https://api.cloudflare.com/client/v4/zones', { headers: hdrs });
  const zl = (zones.body && zones.body.result) || [];
  line(`  zones: ${zl.map((z) => z.name).join(', ') || 'none visible'}`);
}

(async () => {
  console.log('Campfire migration preflight (read-only)');
  await checkHetzner().catch((e) => record('hetzner', false, String(e.message || e)));
  await checkCivo().catch((e) => record('civo', false, String(e.message || e)));
  await checkCloudflare().catch((e) => record('cloudflare', false, String(e.message || e)));

  h('Summary');
  for (const r of results) line(`  ${r.ok ? 'OK  ' : 'FAIL'}  ${r.name.padEnd(12)} ${r.detail}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})();
