'use strict';

// In-memory fake of the slice of the S3 API the R2 driver uses. NOT named
// *.test.js, so the `node --test test/*.test.js` glob won't run it. Inject it
// as `client` into storage.createR2Driver — tests must never construct a real
// S3Client or touch the network. Dispatches on the REAL @aws-sdk/client-s3
// command class names (cmd.constructor.name) and records every call.

const crypto = require('node:crypto');

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest();
}

function awsError(name, status, message) {
  return Object.assign(new Error(message || name), { name, Code: name, $metadata: { httpStatusCode: status } });
}

/**
 * @param {{ pageSize?: number }} opts
 * @returns {{ send, objects: Map, calls: Array, failNext, seed, hooks, callsOf }}
 *   hooks.beforeList: optional async () => void — awaited inside each List call
 *     (after it is recorded), e.g. to hold a refresh open on a deferred promise.
 *   hooks.listEtag: optional (key, etag) => etag — rewrite ETags in List output.
 */
function createFakeS3({ pageSize = 1000 } = {}) {
  const objects = new Map(); // key -> { body: Buffer, etag: '"hex"', lastModified: Date }
  const calls = [];
  const failures = new Map(); // op -> [err, ...]
  const hooks = { beforeList: null, listEtag: null };

  function seed(key, data) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    objects.set(key, { body, etag: `"${md5(body).toString('hex')}"`, lastModified: new Date() });
  }

  function failNext(op, err) {
    if (!failures.has(op)) failures.set(op, []);
    failures.get(op).push(err || new Error(`${op} failed`));
  }

  async function send(cmd) {
    const op = cmd && cmd.constructor && cmd.constructor.name;
    const input = (cmd && cmd.input) || {};
    calls.push({ op, input });
    const queued = failures.get(op);
    if (queued && queued.length) throw queued.shift();

    switch (op) {
      case 'PutObjectCommand': {
        const body = Buffer.isBuffer(input.Body) ? input.Body : Buffer.from(input.Body || '');
        const digest = md5(body);
        if (input.ContentMD5 && input.ContentMD5 !== digest.toString('base64')) {
          throw awsError('BadDigest', 400, 'The Content-MD5 you specified did not match what we received.');
        }
        const etag = `"${digest.toString('hex')}"`;
        objects.set(input.Key, { body: Buffer.from(body), etag, lastModified: new Date() });
        return { ETag: etag };
      }
      case 'GetObjectCommand': {
        const o = objects.get(input.Key);
        if (!o) throw awsError('NoSuchKey', 404, 'The specified key does not exist.');
        return {
          Body: { transformToByteArray: async () => new Uint8Array(o.body) },
          ContentLength: o.body.length,
          ETag: o.etag,
        };
      }
      case 'HeadObjectCommand': {
        const o = objects.get(input.Key);
        if (!o) throw awsError('NotFound', 404, 'Not Found');
        return { ContentLength: o.body.length, ETag: o.etag };
      }
      case 'DeleteObjectCommand': {
        objects.delete(input.Key);
        return {};
      }
      case 'ListObjectsV2Command': {
        if (hooks.beforeList) await hooks.beforeList();
        const prefix = input.Prefix || '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
        const page = keys.slice(start, start + pageSize);
        const next = start + page.length;
        const truncated = next < keys.length;
        return {
          Contents: page.map((Key) => {
            const o = objects.get(Key);
            const etag = hooks.listEtag ? hooks.listEtag(Key, o.etag) : o.etag;
            return { Key, Size: o.body.length, ETag: etag, LastModified: o.lastModified };
          }),
          IsTruncated: truncated,
          NextContinuationToken: truncated ? String(next) : undefined,
        };
      }
      default:
        throw new Error(`fake-s3: unsupported command ${op}`);
    }
  }

  const callsOf = (op) => calls.filter((c) => c.op === op);

  return { send, objects, calls, failNext, seed, hooks, callsOf };
}

module.exports = { createFakeS3 };
