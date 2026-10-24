'use strict';
// Offline tests: no network, no API key needed. Run with: node --test test/   (Node 18+)
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const vt = require('../video-transcribe.js');

const SCRIPT = path.join(__dirname, '..', 'video-transcribe.js');
const FIXTURE = path.join(__dirname, '..', 'test-fixtures', 'scene-test.mp4');

test('parseArgs: defaults', () => {
  const o = vt.parseArgs(['talk.mp4'], {});
  assert.strictEqual(o.input, 'talk.mp4');
  assert.strictEqual(o.model, vt.DEFAULT_MODEL);
  assert.strictEqual(o.maxTokens, 32768);
  assert.strictEqual(o.sceneThreshold, 0.4);
  assert.strictEqual(o.framesMax, 40);
  assert.strictEqual(o.sceneRequested, false);
  assert.strictEqual(o.noFrames, false);
  assert.strictEqual(o.thinkingLevel, null);
});

test('default model is not one of the retired models', () => {
  const retired = ['gemini-2.0-flash', 'gemini-2.0-flash-001', 'gemini-2.0-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro', 'gemini-2.5-flash-preview-05-20'];
  assert.ok(/^gemini-[0-9.]+-flash/.test(vt.DEFAULT_MODEL), vt.DEFAULT_MODEL);
  assert.ok(!retired.includes(vt.DEFAULT_MODEL), 'default model is retired: ' + vt.DEFAULT_MODEL);
});

test('parseArgs: environment variable and flags override the default model; flags win', () => {
  assert.strictEqual(vt.parseArgs(['a.mp4'], { GEMINI_VIDEO_MODEL: 'env-model' }).model, 'env-model');
  assert.strictEqual(vt.parseArgs(['a.mp4', '--model', 'cli-model'], { GEMINI_VIDEO_MODEL: 'env-model' }).model, 'cli-model');
});

test('parseArgs: every option', () => {
  const o = vt.parseArgs(['--out', 'x.md', 'v.mp4', '--max', '1000', '--key-file', 'k.txt', '--thinking-level', 'low', '--scene', '0.3', '--frames-max', '5'], {});
  assert.strictEqual(o.out, 'x.md'); assert.strictEqual(o.input, 'v.mp4'); assert.strictEqual(o.maxTokens, 1000);
  assert.strictEqual(o.keyFile, 'k.txt'); assert.strictEqual(o.thinkingLevel, 'low');
  assert.strictEqual(o.sceneRequested, true); assert.strictEqual(o.sceneThreshold, 0.3); assert.strictEqual(o.framesMax, 5);
});

test('parseArgs: bare --scene keeps the default threshold and still counts as explicit', () => {
  const o = vt.parseArgs(['v.mp4', '--scene'], {});
  assert.strictEqual(o.sceneRequested, true); assert.strictEqual(o.sceneThreshold, 0.4);
});

test('parseArgs: bad input is rejected with a usage error', () => {
  for (const argv of [[], ['--model', 'm'], ['a.mp4', '--bogus'], ['a.mp4', 'b.mp4'], ['a.mp4', '--max'], ['a.mp4', '--max', 'x'], ['a.mp4', '--scene', '1.5'],
    ['a.mp4', '--thinking-level', 'extreme'], ['a.mp4', '--frames-max', '0'], ['a.mp4', '--scene', '--no-frames']]) {
    assert.throws(() => vt.parseArgs(argv, {}), (e) => e instanceof vt.UsageError, 'should reject: ' + argv.join(' '));
  }
});

test('parseArgs: an unknown option is reported as such, even when it is the only argument', () => {
  assert.throws(() => vt.parseArgs(['--bogus'], {}), (e) => e instanceof vt.UsageError && /Unknown option: --bogus/.test(e.message));
  assert.throws(() => vt.parseArgs(['a.mp4', '--bogus'], {}), (e) => e instanceof vt.UsageError && /Unknown option/.test(e.message));
});

test('output file names', () => {
  assert.strictEqual(vt.outputPath('talk.mp4', null), 'talk-transcript.md');
  assert.strictEqual(vt.outputPath(path.join('dir', 'My Talk.final.mov'), null), 'My Talk.final-transcript.md');
  assert.strictEqual(vt.outputPath('https://www.youtube.com/watch?v=abc123&t=5', null), 'yt-abc123-transcript.md');
  assert.strictEqual(vt.outputPath('https://youtu.be/xyz789?si=q', null), 'yt-xyz789-transcript.md');
  assert.strictEqual(vt.outputPath('https://youtube.com/watch', null), 'yt-video-transcript.md');
  assert.strictEqual(vt.outputPath('talk.mp4', 'custom.md'), 'custom.md');
  assert.strictEqual(vt.outputBase('talk.mp4'), 'talk');
});

test('YouTube detection', () => {
  assert.ok(vt.isYouTube('https://www.youtube.com/watch?v=1'));
  assert.ok(vt.isYouTube('http://youtu.be/1'));
  assert.ok(!vt.isYouTube('./youtube.com/video.mp4'));
  assert.ok(!vt.isYouTube('https://vimeo.com/1'));
});

test('formatTime and scene time parsing', () => {
  assert.strictEqual(vt.formatTime(0), '00:00:00');
  assert.strictEqual(vt.formatTime(61.9), '00:01:01');
  assert.strictEqual(vt.formatTime(3725), '01:02:05');
  const stderr = '[Parsed_showinfo_1 @ 0x1] n:   0 pts:  24 pts_time:1.0 pos: 1\n[Parsed_showinfo_1 @ 0x1] n:   1 pts: 120 pts_time:5.25 pos: 2\n';
  assert.deepStrictEqual(vt.parseSceneTimes(stderr), [1.0, 5.25]);
  assert.deepStrictEqual(vt.parseSceneTimes(''), []);
});

test('checkFfmpeg uses the injected runner', () => {
  assert.strictEqual(vt.checkFfmpeg(() => ({ status: 0 })), true);
  assert.strictEqual(vt.checkFfmpeg(() => ({ error: new Error('ENOENT') })), false);
  assert.strictEqual(vt.checkFfmpeg(() => ({ status: 1 })), false);
});

test('API key resolution', () => {
  assert.strictEqual(vt.resolveKey({ keyFile: null }, { GEMINI_API_KEY: ' k-from-env ' }), 'k-from-env');
  assert.throws(() => vt.resolveKey({ keyFile: null }, {}), (e) => e instanceof vt.UsageError && /GEMINI_API_KEY/.test(e.message));
});

test('scene detection extracts timestamped key frames from the bundled fixture (skipped when ffmpeg is not installed)', (t) => {
  if (!vt.checkFfmpeg()) return t.skip('ffmpeg not installed');
  const os = require('os'); const fs = require('fs');
  const base = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vt-frames-')), 'scene-test');
  try {
    const frames = vt.extractSceneFrames(FIXTURE, base, { sceneThreshold: 0.4, framesMax: 40 });
    assert.ok(frames.length >= 1, 'expected at least one scene change in the colour-bar fixture');
    assert.ok(frames.every((f) => fs.existsSync(f.file)), 'every reported frame file exists');
    assert.ok(frames.every((f, i) => i === 0 || f.sec >= frames[i - 1].sec), 'timestamps never go backwards');
    assert.ok(frames.some((f) => f.sec > 0), 'timestamps are real (not all zero)');
  } finally { fs.rmSync(path.dirname(base), { recursive: true, force: true }); }
});

test('ffmpeg frame-rate option: prefers -fps_mode, falls back to -vsync only on "Unrecognized option", surfaces real failures', () => {
  const fs = require('fs'); const os = require('os');
  const base = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vt-args-')), 'x');
  const opts = { sceneThreshold: 0.4, framesMax: 40 };
  try {
    const calls = [];
    vt.extractSceneFrames('v.mp4', base, opts, (cmd, args) => { calls.push(args); return { status: 0, stderr: '' }; });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].includes('-fps_mode') && !calls[0].includes('-vsync'));
    const calls2 = [];
    vt.extractSceneFrames('v.mp4', base, opts, (cmd, args) => { calls2.push(args); return calls2.length === 1 ? { status: 1, stderr: "Unrecognized option 'fps_mode'.\nError splitting the argument list: Option not found" } : { status: 0, stderr: '' }; });
    assert.strictEqual(calls2.length, 2);
    assert.ok(calls2[1].includes('-vsync') && !calls2[1].includes('-fps_mode'));
    assert.throws(() => vt.extractSceneFrames('v.mp4', base, opts, () => ({ status: 1, stderr: 'v.mp4: No such file or directory' })), /ffmpeg failed: v\.mp4: No such file/);
    assert.throws(() => vt.extractSceneFrames('v.mp4', base, opts, () => ({ error: new Error('spawn ffmpeg ENOENT') })), /ENOENT/);
  } finally { fs.rmSync(path.dirname(base), { recursive: true, force: true }); }
});

// ---- the CLI itself (still offline: every case below stops before any network call) ----
const run = (args, env) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...env } });
// a PATH that contains node's own folder only, so ffmpeg cannot be found even if it is installed
const noFfmpegEnv = () => ({ PATH: path.dirname(process.execPath), SystemRoot: process.env.SystemRoot || '', GEMINI_API_KEY: 'dummy-key-for-offline-test', ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}) });

test('CLI: --scene without ffmpeg stops with a clear error (exit 2) before any upload', () => {
  const r = run([FIXTURE, '--scene'], noFfmpegEnv());
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /ffmpeg is required/);
  assert.match(r.stderr, /https:\/\/ffmpeg\.org/);
  assert.doesNotMatch(r.stderr, /\[upload\]/);
});

test('CLI: --scene with an explicit threshold behaves the same', () => {
  const r = run([FIXTURE, '--scene', '0.3'], noFfmpegEnv());
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /ffmpeg is required/);
});

test('CLI: missing file, unsupported extension and missing key fail early with exit 1', () => {
  let r = run(['no-such-file.mp4'], noFfmpegEnv());
  assert.strictEqual(r.status, 1); assert.match(r.stderr, /File not found/);
  r = run([path.join(__dirname, '..', 'package.json')], noFfmpegEnv());
  assert.strictEqual(r.status, 1); assert.match(r.stderr, /Unsupported extension/);
  const env = noFfmpegEnv(); delete env.GEMINI_API_KEY;
  r = run([FIXTURE, '--no-frames'], env);
  assert.strictEqual(r.status, 1); assert.match(r.stderr, /No API key/);
  assert.doesNotMatch(r.stderr, /\[upload\]/);
});

test('CLI: usage error prints the usage line', () => {
  const r = run([], noFfmpegEnv());
  assert.strictEqual(r.status, 1); assert.match(r.stderr, /Usage: node video-transcribe\.js/);
});
