'use strict';
// Offline tests for the safety behaviour added after the independent review: overwrite protection, id sanitising, scheme
// normalising, ffmpeg path handling, clean-up of the uploaded file, and the whole run driven end to end with fakes.
// No network, no API key. Run with: node --test   (Node 18+)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vt = require('../video-transcribe.js');
process.env.GEMINI_API_KEY = 'dummy-key-for-offline-test';   // run() resolves a key before it calls the (faked) network functions

const FIXTURE = path.join(__dirname, '..', 'test-fixtures', 'scene-test.mp4');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vt-run-'));
const quiet = async (fn) => { const orig = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = orig; } };
const baseOpts = (over = {}) => vt.parseArgs([FIXTURE, '--no-frames'], {}) && { ...vt.parseArgs([FIXTURE], {}), noFrames: true, ...over };
const FAKE_UP = { name: 'files/abc123', fileUri: 'https://example.invalid/files/abc123', mimeType: 'video/mp4' };
const fakeDeps = (log, over = {}) => ({
  upload: async () => { log.push('upload'); return FAKE_UP; },
  generate: async (parts) => { log.push('generate'); log.parts = parts; return { text: '[00:00:01] hello', usage: { promptTokenCount: 1, candidatesTokenCount: 2 }, finish: 'STOP' }; },
  deleteUploaded: async (name) => { log.push('delete:' + name); return true; },
  checkFfmpeg: () => true,
  extractSceneFrames: () => [{ time: '00:00:06', sec: 6, file: 'f', rel: 'x-frames/frame-001.png' }],
  writeFile: (p, t) => { log.push('write'); log.written = { p, t }; },
  ...over,
});

// ---- overwrite protection ----
test('checkOverwrite: an existing output file stops the run unless --force', () => {
  const fake = { existsSync: (p) => p === 'talk-transcript.md', readdirSync: () => [] };
  assert.throws(() => vt.checkOverwrite({ input: 'talk.mp4', out: null, force: false }, false, fake), (e) => e instanceof vt.UsageError && /already exists/.test(e.message) && /--force/.test(e.message) && /Nothing was uploaded/.test(e.message));
  assert.doesNotThrow(() => vt.checkOverwrite({ input: 'talk.mp4', out: null, force: true }, false, fake));
  assert.doesNotThrow(() => vt.checkOverwrite({ input: 'talk.mp4', out: 'other.md', force: false }, false, fake));
});

test('checkOverwrite: a key-frame folder that already holds frames stops the run; an empty one or no-frames mode does not', () => {
  const withFrames = { existsSync: (p) => p === 'talk-frames', readdirSync: () => ['frame-001.png'] };
  const empty = { existsSync: (p) => p === 'talk-frames', readdirSync: () => [] };
  assert.throws(() => vt.checkOverwrite({ input: 'talk.mp4', out: null, force: false }, true, withFrames), /key-frame folder already holds frames/);
  assert.doesNotThrow(() => vt.checkOverwrite({ input: 'talk.mp4', out: null, force: false }, true, empty));
  assert.doesNotThrow(() => vt.checkOverwrite({ input: 'talk.mp4', out: null, force: false }, false, withFrames));
  assert.doesNotThrow(() => vt.checkOverwrite({ input: 'talk.mp4', out: null, force: true }, true, withFrames));
});

test('run: an existing transcript stops before any upload; --force lets it through', async () => {
  const dir = tmpDir(); const out = path.join(dir, 'exists.md'); fs.writeFileSync(out, 'old');
  try {
    const log = [];
    await assert.rejects(quiet(() => vt.run(baseOpts({ out }), fakeDeps(log))), (e) => e instanceof vt.UsageError && /already exists/.test(e.message));
    assert.deepStrictEqual(log, [], 'no upload, no API call, no write');
    const log2 = [];
    await quiet(() => vt.run(baseOpts({ out, force: true }), fakeDeps(log2)));
    assert.ok(log2.includes('write'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- YouTube handling ----
test('outputBase: a YouTube id is reduced to safe characters (no path traversal)', () => {
  assert.strictEqual(vt.outputBase('https://www.youtube.com/watch?v=../../evil'), 'yt-evil');
  assert.strictEqual(vt.outputBase('https://www.youtube.com/watch?v=a/b\\c%2F..'), 'yt-abc2F');
  assert.strictEqual(vt.outputBase('https://www.youtube.com/watch?v=....'), 'yt-video');
  assert.strictEqual(vt.outputBase('https://youtu.be/../../x?si=1'), 'yt-video');
  assert.ok(!/[\\/]/.test(vt.outputPath('https://www.youtube.com/watch?v=../../evil', null)));
  assert.strictEqual(vt.outputBase('https://www.youtube.com/watch?v=abc_DEF-123'), 'yt-abc_DEF-123');
});

test('normalizeYouTube adds https:// only when the scheme is missing', () => {
  assert.strictEqual(vt.normalizeYouTube('youtube.com/watch?v=1'), 'https://youtube.com/watch?v=1');
  assert.strictEqual(vt.normalizeYouTube('www.youtube.com/watch?v=1'), 'https://www.youtube.com/watch?v=1');
  assert.strictEqual(vt.normalizeYouTube('http://youtu.be/1'), 'http://youtu.be/1');
  assert.strictEqual(vt.normalizeYouTube('https://youtu.be/1'), 'https://youtu.be/1');
});

test('run: a YouTube URL without a scheme is sent as a full URI; nothing is uploaded or deleted', async () => {
  const dir = tmpDir();
  try {
    const log = [];
    const opts = { ...vt.parseArgs(['youtube.com/watch?v=abc123'], {}), out: path.join(dir, 't.md') };
    await quiet(() => vt.run(opts, fakeDeps(log)));
    assert.strictEqual(log.parts[0].fileData.fileUri, 'https://youtube.com/watch?v=abc123');
    assert.ok(!log.includes('upload') && !log.some((x) => String(x).startsWith('delete:')));
    assert.match(log.written.t, /Source: https:\/\/youtube\.com\/watch\?v=abc123/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- clean-up of the uploaded file on Google's side ----
test('deleteUploaded sends DELETE with the key in the header and only warns on failure', async () => {
  let seen = null;
  assert.strictEqual(await quiet(() => vt.deleteUploaded('files/abc', 'k', async (m, u, h) => { seen = { m, u, h }; return { status: 200 }; })), true);
  assert.strictEqual(seen.m, 'DELETE'); assert.match(seen.u, /\/v1beta\/files\/abc$/); assert.strictEqual(seen.h['x-goog-api-key'], 'k'); assert.ok(!/key=/.test(seen.u));
  assert.strictEqual(await quiet(() => vt.deleteUploaded('files/abc', 'k', async () => ({ status: 403 }))), false);
  assert.strictEqual(await quiet(() => vt.deleteUploaded('files/abc', 'k', async () => { throw new Error('offline'); })), false);
});

test('run: the uploaded file is deleted by default, after the transcript is written', async () => {
  const dir = tmpDir();
  try {
    const log = [];
    await quiet(() => vt.run(baseOpts({ out: path.join(dir, 'o.md') }), fakeDeps(log)));
    assert.deepStrictEqual(log.filter((x) => x === 'upload' || x === 'generate' || x === 'write' || String(x).startsWith('delete:')), ['upload', 'generate', 'write', 'delete:files/abc123']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('run: --keep-upload leaves the file on Google (no delete call)', async () => {
  const dir = tmpDir();
  try {
    const log = [];
    await quiet(() => vt.run(baseOpts({ out: path.join(dir, 'o.md'), keepUpload: true }), fakeDeps(log)));
    assert.ok(!log.some((x) => String(x).startsWith('delete:')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('run: the uploaded file is deleted even when the transcription fails', async () => {
  const log = [];
  await assert.rejects(quiet(() => vt.run(baseOpts({ out: path.join(os.tmpdir(), 'never-written.md') }), fakeDeps(log, { generate: async () => { throw new Error('Gemini: boom'); } }))), /boom/);
  assert.ok(log.includes('delete:files/abc123'));
  assert.ok(!log.includes('write'));
});

test('run: a file that was uploaded but never became ACTIVE is still deleted', async () => {
  const log = [];
  const upload = async () => { const e = new Error('File not ready: state=FAILED'); e.uploaded = FAKE_UP; throw e; };
  await assert.rejects(quiet(() => vt.run(baseOpts({ out: path.join(os.tmpdir(), 'never-written.md') }), fakeDeps(log, { upload }))), /File not ready/);
  assert.ok(log.includes('delete:files/abc123'));
});

// ---- the end-to-end run with key frames ----
test('run: key frames are appended to the transcript; a frame failure never loses the transcript', async () => {
  const dir = tmpDir();
  try {
    const log = [];
    const r = await quiet(() => vt.run(baseOpts({ out: path.join(dir, 'a.md'), noFrames: false }), fakeDeps(log)));
    assert.match(r.body, /## Key frames/); assert.match(r.body, /\*\*\[00:00:06\]\*\* !\[00:00:06\]\(x-frames\/frame-001\.png\)/);
    const log2 = [];
    const r2 = await quiet(() => vt.run(baseOpts({ out: path.join(dir, 'b.md'), noFrames: false }), fakeDeps(log2, { extractSceneFrames: () => { throw new Error('ffmpeg failed: x'); } })));
    assert.match(r2.body, /\[00:00:01\] hello/); assert.ok(!/Key frames/.test(r2.body)); assert.ok(log2.includes('write'));
    const r3 = await quiet(() => vt.run(baseOpts({ out: path.join(dir, 'c.md'), noFrames: false }), fakeDeps([], { checkFfmpeg: () => false })));
    assert.ok(!/Key frames/.test(r3.body), 'no ffmpeg and no explicit --scene: the transcript is written without frames');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('run: explicit --scene without ffmpeg stops with exit code 2 before the upload', async () => {
  const log = [];
  await assert.rejects(quiet(() => vt.run(baseOpts({ out: path.join(os.tmpdir(), 'never-written.md'), noFrames: false, sceneRequested: true }), fakeDeps(log, { checkFfmpeg: () => false }))), (e) => e instanceof vt.UsageError && e.exitCode === 2);
  assert.deepStrictEqual(log, []);
});

// ---- ffmpeg paths ----
test('extractSceneFrames passes absolute paths, doubles "%" in folder names, and clears stale frames', () => {
  const dir = tmpDir();
  const prev = process.cwd();
  try {
    process.chdir(dir);
    fs.mkdirSync('a%dx-frames'); fs.writeFileSync(path.join('a%dx-frames', 'frame-009.png'), 'stale'); fs.writeFileSync(path.join('a%dx-frames', 'keep.txt'), 'mine');
    let args = null;
    const run = (cmd, a) => { args = a; return { status: 0, stderr: '' }; };
    vt.extractSceneFrames('-weird.mp4', 'a%dx', { sceneThreshold: 0.4, framesMax: 40 }, run);
    const input = args[args.indexOf('-i') + 1]; const pattern = args[args.length - 1];
    assert.ok(path.isAbsolute(input) && input.endsWith('-weird.mp4'), 'input is an absolute path, so a leading "-" cannot be read as an option');
    assert.ok(path.isAbsolute(pattern) && pattern.includes('a%%dx-frames') && pattern.endsWith('frame-%03d.png'), pattern);
    assert.ok(args.includes('-y'));
    assert.ok(!fs.existsSync(path.join('a%dx-frames', 'frame-009.png')), 'stale frame removed');
    assert.ok(fs.existsSync(path.join('a%dx-frames', 'keep.txt')), 'unrelated files are left alone');
  } finally { process.chdir(prev); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real ffmpeg handles a file whose name starts with "-" and a folder with "%" (skipped without ffmpeg)', (t) => {
  if (!vt.checkFfmpeg()) return t.skip('ffmpeg not installed');
  const dir = tmpDir(); const prev = process.cwd();
  try {
    process.chdir(dir);
    fs.copyFileSync(FIXTURE, '-odd.mp4');
    const frames = vt.extractSceneFrames('-odd.mp4', 'p%dq', { sceneThreshold: 0.4, framesMax: 40 });
    assert.ok(frames.length >= 1, 'frames were extracted from the dash-named file into the percent-named folder');
    assert.ok(frames.every((f) => fs.existsSync(f.file)));
  } finally { process.chdir(prev); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- API error hint ----
test('explainApiError points to --thinking-level when the API complains about thinking', () => {
  assert.match(vt.explainApiError('Gemini: Thinking level "minimal" is not supported for this model'), /--thinking-level/);
  assert.strictEqual(vt.explainApiError('Gemini: quota exceeded'), 'Gemini: quota exceeded');
});

// ---- repository hygiene ----
test('.gitignore keeps key files out without swallowing ordinary names', () => {
  const g = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(g.includes('.env') && g.includes('*.key') && g.includes('*credentials*'));
  assert.ok(!g.includes('*key*.txt'), 'the over-broad *key*.txt pattern (it would also hide monkey.txt) is gone');
  assert.ok(g.some((l) => /api.*key.*\.txt/.test(l)), 'a narrower API-key pattern is present');
});
