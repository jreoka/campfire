// Prove the LIVE app can read and write through its configured storage backend,
// using the app's own storage module (not a hand-rolled client), so this tests
// the real code path and the real credentials.
//
// It writes one throwaway object under a temp/ prefix and deletes it again.
const storage = require('/app/storage');

(async () => {
  console.log('storage mode   :', storage.s3Enabled() ? 's3' : 'local (!! not s3)');
  console.log('bucket         :', storage.S3_BUCKET);

  const key = `temp/migration-selftest-${Date.now()}.txt`;
  const body = Buffer.from(`campfire storage self-test ${new Date().toISOString()}\n`);

  let failed = 0;

  try {
    await storage.s3Put(key, body, 'text/plain');
    console.log('PUT  ok  ->', key);
  } catch (e) {
    failed++;
    console.log('PUT  FAIL:', String(e.message || e).slice(0, 200));
  }

  try {
    const h = await storage.s3Head(key);
    console.log('HEAD ok  -> size', h.ContentLength, 'type', h.ContentType);
    if (Number(h.ContentLength) !== body.length) {
      failed++;
      console.log('      size mismatch!');
    }
  } catch (e) {
    failed++;
    console.log('HEAD FAIL:', String(e.message || e).slice(0, 200));
  }

  try {
    const g = await storage.s3Get(key);
    const chunks = [];
    for await (const c of g.Body) chunks.push(c);
    const got = Buffer.concat(chunks);
    const ok = got.length === body.length && got.equals(body);
    console.log('GET  ', ok ? 'ok  -> bytes round-trip identical' : 'FAIL: bytes differ');
    if (!ok) failed++;
  } catch (e) {
    failed++;
    console.log('GET  FAIL:', String(e.message || e).slice(0, 200));
  }

  try {
    await storage.s3DeleteNow(key);
    console.log('DEL  ok  ->', key);
  } catch (e) {
    failed++;
    console.log('DEL  FAIL:', String(e.message || e).slice(0, 200));
  }

  // List through the app's own listing helper, so the admin panel's storage
  // numbers and bucket-scan's ledger keep working.
  try {
    const objs = await storage.s3List('', { maxPages: 2 });
    console.log('LIST ok  ->', objs.length, 'objects visible to the app');
  } catch (e) {
    failed++;
    console.log('LIST FAIL:', String(e.message || e).slice(0, 200));
  }

  console.log('');
  console.log(failed === 0 ? 'STORAGE SELF-TEST PASSED' : `STORAGE SELF-TEST FAILED (${failed} step(s))`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.log('crashed:', e && e.message); process.exit(1); });
