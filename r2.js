// Off-site backup target: a Cloudflare R2 bucket (S3-compatible API).
//
// Deliberately independent of storage.js. That module is bound to the media
// bucket and to serving /uploads/*; this one is bound to the backup bucket and
// exists only for backup.js. Separate clients and separate credentials, so a
// misconfiguration or fault in one cannot take out the other -- which is the
// entire point of keeping the backup somewhere else.
//
// R2_* env, not S3_*: the two buckets are different vendors, and the backup
// destination must be able to be wrong without breaking media serving.
const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
  ListObjectsV2Command, HeadObjectCommand,
} = require('@aws-sdk/client-s3');

const ENDPOINT = process.env.R2_ENDPOINT || '';
const BUCKET = process.env.R2_BUCKET || '';
const REGION = process.env.R2_REGION || 'auto';

function r2Enabled() {
  return Boolean(ENDPOINT && BUCKET && process.env.R2_ACCESS_KEY && process.env.R2_SECRET_KEY);
}

let _client = null;
function client() {
  if (!_client) {
    _client = new S3Client({
      region: REGION,
      endpoint: ENDPOINT,
      // R2 also answers on <bucket>.<account>.r2.cloudflarestorage.com, but
      // path-style keeps one endpoint shape working for every bucket.
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY || '',
        secretAccessKey: process.env.R2_SECRET_KEY || '',
      },
    });
  }
  return _client;
}

// Always a Buffer, never a stream. aws-sdk v3 sends a streaming Body as a
// chunked PUT with a checksum trailer, and not every S3-compatible store
// accepts that (Civo's does not -- see scripts/migrate-s3.js). Buffering also
// pins ContentLength, so a short read can never be stored as a whole object.
async function put(key, buffer, contentType) {
  await client().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentLength: buffer.length,
    ContentType: contentType || 'application/octet-stream',
  }));
}

async function get(key) {
  return client().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
}

async function getBuffer(key) {
  const r = await get(key);
  return Buffer.from(await r.Body.transformToByteArray());
}

async function del(key) {
  await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

async function head(key) {
  return client().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
}

// Every object under a prefix, paginated.
async function list(prefix) {
  const out = [];
  let token;
  do {
    const r = await client().send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    for (const o of r.Contents || []) {
      out.push({ key: o.Key, size: o.Size || 0, modified: o.LastModified || null, etag: o.ETag || null });
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

module.exports = { r2Enabled, put, get, getBuffer, del, head, list, BUCKET, ENDPOINT };
