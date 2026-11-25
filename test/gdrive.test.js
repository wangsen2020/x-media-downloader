import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMultipartPayload,
  ensureFolderPath,
  queryResumableOffset,
  streamToDrive,
  parseRangeHeader,
  clearFolderCache,
  computeSha256Hex,
  findExistingDriveFile,
} from '../src/lib/gdrive.js';

function jsonResp(status, obj, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

test('parseRangeHeader parses last committed byte offset', () => {
  assert.equal(parseRangeHeader('bytes=0-4194303'), 4194304);
  assert.equal(parseRangeHeader('bytes=0-0'), 1);
  assert.equal(parseRangeHeader(''), 0);
});

test('buildMultipartPayload formats metadata and binary body', () => {
  const mp = buildMultipartPayload({
    boundary: 'b_test',
    metadata: { name: 'clip.mp4', mimeType: 'video/mp4' },
    mediaContentType: 'video/mp4',
    mediaBody: new Uint8Array([1, 2, 3]),
  });
  assert.equal(mp.contentType, 'multipart/related; boundary=b_test');
  const text = new TextDecoder().decode(mp.body);
  assert.ok(text.includes('--b_test\r\n'));
  assert.ok(text.includes('"name":"clip.mp4"'));
  assert.ok(text.includes('Content-Type: video/mp4'));
  assert.ok(text.endsWith('--b_test--'));
});

test('ensureFolderPath creates root and @user subfolder and deduplicates concurrent calls', async () => {
  globalThis.chrome = {
    storage: {
      local: {
        data: {},
        async get(k) {
          return { [k]: this.data[k] };
        },
        async set(obj) {
          Object.assign(this.data, obj);
        },
        async remove(k) {
          delete this.data[k];
        },
      },
    },
  };
  await clearFolderCache();

  let creates = 0;
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'GET') {
      return jsonResp(200, { files: [] });
    }
    if (init.method === 'POST') {
      creates++;
      const body = JSON.parse(init.body);
      return jsonResp(200, { id: `folder_${creates}_${body.name}`, name: body.name });
    }
    throw new Error('Unexpected fetch: ' + url);
  };

  const res = await ensureFolderPath({
    rootName: 'X Media Downloader',
    subfolder: '@NASA',
    token: 'tok_1',
    fetchImpl,
  });
  assert.equal(res.folderId, 'folder_2_@NASA');
  assert.equal(creates, 2);

  // Second call hits cache without extra API calls.
  const cached = await ensureFolderPath({
    rootName: 'X Media Downloader',
    subfolder: '@NASA',
    token: 'tok_1',
    fetchImpl,
  });
  assert.equal(cached.folderId, 'folder_2_@NASA');
  assert.equal(creates, 2);
});

test('queryResumableOffset handles 308, 200 completion, and 410 expiration', async () => {
  const r308 = await queryResumableOffset({
    sessionUrl: 'https://upload.example/s1',
    totalBytes: 1000,
    token: 'tok',
    fetchImpl: async () => new Response(null, { status: 308, headers: { Range: 'bytes=0-511' } }),
  });
  assert.equal(r308.done, false);
  assert.equal(r308.expired, false);
  assert.equal(r308.offset, 512);

  const r200 = await queryResumableOffset({
    sessionUrl: 'https://upload.example/s1',
    totalBytes: 1000,
    token: 'tok',
    fetchImpl: async () => jsonResp(200, { id: 'f_1', name: 'v.mp4' }),
  });
  assert.equal(r200.done, true);
  assert.equal(r200.file.id, 'f_1');

  const r410 = await queryResumableOffset({
    sessionUrl: 'https://upload.example/s1',
    totalBytes: 1000,
    token: 'tok',
    fetchImpl: async () => new Response(null, { status: 410 }),
  });
  assert.equal(r410.expired, true);
});

test('streamToDrive resumes from committedOffset and persists chunk checkpoints', async () => {
  globalThis.chrome = {
    storage: {
      local: {
        data: { gdriveFolderCache: { 'root::X Media Downloader': 'root_1' } },
        async get(k) {
          return { [k]: this.data[k] };
        },
        async set(obj) {
          Object.assign(this.data, obj);
        },
        async remove(k) {
          delete this.data[k];
        },
      },
    },
  };

  // 10-byte payload split into 4-byte chunks; simulate resume at byte 4.
  const payload = new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  const sentRanges = [];
  const checkpoints = [];

  const fetchImpl = async (url, init = {}) => {
    if (url === 'https://video.twimg.com/demo.mp4') {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(payload);
          c.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Length': String(payload.length) },
      });
    }
    if (url === 'https://upload.example/resume' && init.method === 'PUT') {
      const cr = init.headers['Content-Range'];
      sentRanges.push(cr);
      if (cr === 'bytes */10') {
        return new Response(null, { status: 308, headers: { Range: 'bytes=0-3' } });
      }
      if (cr === 'bytes 4-7/10') {
        assert.deepEqual([...init.body], [14, 15, 16, 17]);
        return new Response(null, { status: 308, headers: { Range: 'bytes=0-7' } });
      }
      if (cr === 'bytes 8-9/10') {
        assert.deepEqual([...init.body], [18, 19]);
        return jsonResp(200, { id: 'drive_ok_1', name: 'demo.mp4' });
      }
    }
    throw new Error(`Unexpected call: ${init.method || 'GET'} ${url}`);
  };

  const file = await streamToDrive({
    mediaUrl: 'https://video.twimg.com/demo.mp4',
    name: 'demo.mp4',
    mimeType: 'video/mp4',
    chunkSize: 4,
    multipartLimit: 4,
    task: { uploadSessionUrl: 'https://upload.example/resume' },
    token: 'tok_resume',
    fetchImpl,
    onCheckpoint: async (cp) => checkpoints.push(cp),
  });

  assert.equal(file.id, 'drive_ok_1');
  assert.deepEqual(sentRanges, ['bytes */10', 'bytes 4-7/10', 'bytes 8-9/10']);
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[0].committedOffset, 8);
  assert.equal(checkpoints[1].committedOffset, 10);
});

test('findExistingDriveFile and streamToDrive dedup by mediaKey and sha256Checksum', async () => {
  globalThis.chrome = {
    storage: {
      local: {
        data: { gdriveFolderCache: { 'root::X Media Downloader': 'root_1' } },
        async get(k) {
          return { [k]: this.data[k] };
        },
        async set(obj) {
          Object.assign(this.data, obj);
        },
        async remove(k) {
          delete this.data[k];
        },
      },
    },
  };

  // 1. Pre-fetch dedup by mediaKey / filename skips downloading media altogether.
  let mediaFetched = false;
  const hitByKey = await streamToDrive({
    mediaUrl: 'https://video.twimg.com/dup.mp4',
    mediaKey: 'video.twimg.com/dup.mp4',
    name: 'dup.mp4',
    mimeType: 'video/mp4',
    token: 'tok',
    fetchImpl: async (url) => {
      if (url.startsWith('https://video.twimg.com/')) mediaFetched = true;
      if (url.includes('drive/v3/files?q=')) {
        assert.ok(decodeURIComponent(url).includes('xmdMediaKey'));
        assert.ok(decodeURIComponent(url).includes("name='dup.mp4'"));
        return jsonResp(200, { files: [{ id: 'existing_1', name: 'dup.mp4' }] });
      }
      throw new Error('Unexpected fetch: ' + url);
    },
  });
  assert.equal(mediaFetched, false);
  assert.equal(hitByKey.id, 'existing_1');
  assert.equal(hitByKey.deduped, true);

  // 2. Hash dedup skips upload when sha256Checksum already exists on Drive.
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const expectedHash = await computeSha256Hex(payload);
  assert.equal(expectedHash.length, 64);

  let uploadCalled = false;
  const hitByHash = await streamToDrive({
    mediaUrl: 'https://pbs.twimg.com/media/new_name.jpg',
    mediaKey: 'pbs.twimg.com/media/new_name.jpg',
    name: 'new_name.jpg',
    mimeType: 'image/jpeg',
    token: 'tok',
    fetchImpl: async (url) => {
      if (url.includes('drive/v3/files?q=')) {
        if (decodeURIComponent(url).includes(expectedHash)) {
          return jsonResp(200, { files: [{ id: 'existing_hash_1', sha256Checksum: expectedHash }] });
        }
        return jsonResp(200, { files: [] });
      }
      if (url === 'https://pbs.twimg.com/media/new_name.jpg') {
        return new Response(payload, { status: 200, headers: { 'Content-Length': String(payload.length) } });
      }
      if (url.includes('upload/drive/v3/files')) uploadCalled = true;
      throw new Error('Unexpected fetch: ' + url);
    },
  });
  assert.equal(uploadCalled, false);
  assert.equal(hitByHash.id, 'existing_hash_1');
  assert.equal(hitByHash.deduped, true);

  // Verify direct findExistingDriveFile with sha256
  const direct = await findExistingDriveFile({
    sha256: expectedHash,
    token: 'tok',
    fetchImpl: async () => jsonResp(200, { files: [{ id: 'f_hash', sha256Checksum: expectedHash }] }),
  });
  assert.equal(direct.id, 'f_hash');
});
