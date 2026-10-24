#!/usr/bin/env node
// video-transcribe.js - video -> timestamped transcript with Google Gemini.
//
// Usage:
//   node video-transcribe.js "<YouTube URL>"        # YouTube: passed straight to Gemini, nothing is downloaded
//   node video-transcribe.js "./path/to/video.mp4"  # local file: uploaded through the Gemini Files API (the file leaves your computer, see README: Privacy)
//
// Options (see README.md for details):
//   --out <file>            output path (default: ./<name>-transcript.md)
//   --force                 overwrite an existing output file / key-frame folder (without it the run stops BEFORE any API call)
//   --model <id>            Gemini model id (default: see DEFAULT_MODEL below)
//   --max <tokens>          maxOutputTokens (default: 32768)
//   --key-file <path>       read the API key from a file instead of GEMINI_API_KEY
//   --thinking-level <lvl>  optional: send generationConfig.thinkingConfig.thinkingLevel (minimal|low|medium|high); omitted by default
//   --scene [threshold]     also extract key frames at scene changes (local files, needs ffmpeg). Threshold 0..1, default 0.4.
//                           When you pass --scene explicitly and ffmpeg is missing, the run stops with an error BEFORE any API call.
//   --frames-max <n>        upper bound for the number of extracted frames (default: 40)
//   --no-frames             never extract key frames
//   --keep-upload           do not delete the uploaded file from Google's side after the run (default: it is deleted)
//
// API key: set the GEMINI_API_KEY environment variable, or use --key-file. Get a key at https://aistudio.google.com/apikey
// License: MIT

'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

// The default is a model Google lists as generally available and recommends for new projects (checked 2026-10-24):
// https://ai.google.dev/gemini-api/docs/models  and  https://ai.google.dev/gemini-api/docs/deprecations
// Change it per run with --model or for a whole shell session with GEMINI_VIDEO_MODEL.
const DEFAULT_MODEL = 'gemini-3.8-flash';
const BASE = 'https://generativelanguage.googleapis.com';
const MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.flv': 'video/x-flv',
  '.mp3': 'audio/mp3', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
};
const USAGE = 'Usage: node video-transcribe.js "<YouTube URL or local media path>" [--out file] [--force] [--model id] [--max tokens] [--key-file path] [--thinking-level level] [--scene [threshold]] [--frames-max n] [--no-frames] [--keep-upload]';
const VALUE_FLAGS = new Set(['--out', '--model', '--max', '--key-file', '--thinking-level', '--frames-max']);

class UsageError extends Error { constructor(message, code = 1) { super(message); this.exitCode = code; } }

// ---- pure helpers (unit-tested; none of them touches the network) ----

function parseArgs(argv, env = process.env) {
  const o = {
    input: null, out: null, model: env.GEMINI_VIDEO_MODEL || DEFAULT_MODEL, maxTokens: 32768, keyFile: null,
    thinkingLevel: null, sceneRequested: false, sceneThreshold: 0.4, framesMax: 40, noFrames: false, force: false, keepUpload: false,
  };
  const args = argv.slice();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--no-frames') { o.noFrames = true; continue; }
    if (a === '--force') { o.force = true; continue; }
    if (a === '--keep-upload') { o.keepUpload = true; continue; }
    if (a === '--scene') {
      o.sceneRequested = true;
      if (i + 1 < args.length && /^[0-9.]+$/.test(args[i + 1])) o.sceneThreshold = parseFloat(args[++i]);
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= args.length) throw new UsageError(`Option ${a} needs a value.\n${USAGE}`);
      const v = args[++i];
      if (a === '--out') o.out = v;
      else if (a === '--model') o.model = v;
      else if (a === '--max') o.maxTokens = parseInt(v, 10);
      else if (a === '--key-file') o.keyFile = v;
      else if (a === '--thinking-level') o.thinkingLevel = v;
      else if (a === '--frames-max') o.framesMax = parseInt(v, 10);
      continue;
    }
    if (a.startsWith('--')) throw new UsageError(`Unknown option: ${a}\n${USAGE}`);
    if (o.input === null) o.input = a; else throw new UsageError(`Unexpected extra argument: ${a}\n${USAGE}`);
  }
  if (!o.input) throw new UsageError(USAGE);
  if (!Number.isInteger(o.maxTokens) || o.maxTokens < 1) throw new UsageError('--max must be a positive integer.');
  if (!Number.isInteger(o.framesMax) || o.framesMax < 1) throw new UsageError('--frames-max must be a positive integer.');
  if (!(o.sceneThreshold > 0 && o.sceneThreshold < 1)) throw new UsageError('--scene threshold must be a number between 0 and 1 (for example 0.4).');
  if (o.thinkingLevel !== null && !['minimal', 'low', 'medium', 'high'].includes(o.thinkingLevel)) throw new UsageError('--thinking-level must be one of: minimal, low, medium, high.');
  if (o.sceneRequested && o.noFrames) throw new UsageError('--scene and --no-frames contradict each other; use only one of them.');
  return o;
}

const isYouTube = (s) => /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(s);
// Gemini needs a complete URI: add the scheme when the user typed "youtube.com/watch?v=..."
const normalizeYouTube = (s) => (/^https?:\/\//i.test(s) ? s : 'https://' + s);

// Base name used for the transcript and for the "<base>-frames" folder. The YouTube id is reduced to [A-Za-z0-9_-]
// so a crafted URL such as watch?v=../../x cannot place the output outside the current folder.
function outputBase(input) {
  if (isYouTube(input)) {
    const m = input.match(/[?&]v=([^&#]+)/) || input.match(/youtu\.be\/([^?&#/]+)/);
    const id = (m ? m[1] : '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    return 'yt-' + (id || 'video');
  }
  return path.basename(input, path.extname(input));
}
const outputPath = (input, outArg) => outArg || `${outputBase(input)}-transcript.md`;

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

// ffmpeg's showinfo filter prints one "pts_time:<seconds>" per selected frame on stderr, in frame order.
function parseSceneTimes(stderr) {
  const times = []; const re = /pts_time:([0-9.]+)/g; let m;
  while ((m = re.exec(stderr || ''))) times.push(parseFloat(m[1]));
  return times;
}

// Is ffmpeg runnable? `run` is injectable so the test can simulate a machine without ffmpeg.
function checkFfmpeg(run = spawnSync) {
  const r = run('ffmpeg', ['-version'], { encoding: 'utf8' });
  return !(r.error || r.status !== 0);
}
const FFMPEG_HELP = 'ffmpeg is required for scene-detection key frames but was not found on PATH. Install it from https://ffmpeg.org/download.html (or your package manager), or run without --scene / with --no-frames.';

function resolveKey(opts, env = process.env) {
  const fromEnv = (env.GEMINI_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  if (opts.keyFile) {
    const lines = fs.readFileSync(opts.keyFile, 'utf-8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    const k = lines.find((l) => l.startsWith('AIza') || l.startsWith('AQ.')) || lines[0];
    if (k) return k;
  }
  throw new UsageError('No API key. Set the GEMINI_API_KEY environment variable or pass --key-file. Get one at https://aistudio.google.com/apikey');
}

// Never overwrite silently: an existing transcript, or a key-frame folder that already holds frames, stops the run before any API call.
function checkOverwrite(opts, wantFrames, fsApi = fs) {
  const out = outputPath(opts.input, opts.out);
  const problems = [];
  if (fsApi.existsSync(out)) problems.push(`output file already exists: ${out}`);
  if (wantFrames) {
    const dir = `${outputBase(opts.input)}-frames`;
    if (fsApi.existsSync(dir) && fsApi.readdirSync(dir).some((f) => /^frame-\d+\.png$/.test(f))) problems.push(`key-frame folder already holds frames: ${dir}`);
  }
  if (problems.length && !opts.force) throw new UsageError(`${problems.join('\n')}\nNothing was uploaded. Use --force to overwrite, or choose another --out.`);
  return { out, problems };
}

// A raw Gemini error about thinking settings gets a pointer to the right option.
function explainApiError(message) {
  if (/thinking/i.test(message)) return `${message}\n(hint: this model may not accept the --thinking-level value you passed; "minimal" is only accepted by some models, see the README. Run without --thinking-level to use the model's default.)`;
  return message;
}

// ---- network (not covered by the offline tests, except through injected fakes) ----

const PROMPT = [
  'Transcribe this video into a timestamped transcript.',
  '1. Transcribe verbatim in the video\'s original spoken language (keep spoken/colloquial wording, do not paraphrase or omit).',
  '2. Prefix each segment (roughly each sentence or semantic chunk) with a timestamp in [HH:MM:SS] format.',
  '3. If there are multiple speakers, label them (Speaker A / B) where possible.',
  '4. After the transcript, add a short bullet summary (5-10 points), including any tool names, URLs, or numbers mentioned.',
  'Output Markdown only, no preamble.',
].join('\n');

function req(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(new URL(url), { method, headers }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}

// The key travels in the x-goog-api-key header (as in Google's REST examples), not in the URL, so it cannot end up in proxy or server logs.
async function uploadLocal(file, key) {
  const stat = fs.statSync(file);
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime) throw new Error(`Unsupported extension. Supported: ${Object.keys(MIME).join(' ')}`);
  console.error(`[upload] ${path.basename(file)}  ${(stat.size / 1048576).toFixed(1)} MB  (${mime})`);
  console.error("[upload] this file is sent to Google's servers and kept there for up to 48 hours unless deleted (see README: Privacy)");
  const start = await req('POST', `${BASE}/upload/v1beta/files`, {
    'x-goog-api-key': key, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
    'X-Goog-Upload-Header-Content-Length': String(stat.size), 'X-Goog-Upload-Header-Content-Type': mime,
    'Content-Type': 'application/json',
  }, Buffer.from(JSON.stringify({ file: { display_name: path.basename(file) } })));
  const uploadUrl = start.headers['x-goog-upload-url'];
  if (!uploadUrl) throw new Error(`Upload init failed: ${start.status} ${start.body.slice(0, 300)}`);
  const up = await req('POST', uploadUrl, { 'Content-Length': String(stat.size), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, fs.readFileSync(file));
  let f = JSON.parse(up.body).file;
  console.error(`[uploaded] ${f.name}  state=${f.state}`);
  const uploaded = { name: f.name, fileUri: f.uri, mimeType: mime };
  try {
    while (f.state === 'PROCESSING') {
      await new Promise((r) => setTimeout(r, 4000));
      f = JSON.parse((await req('GET', `${BASE}/v1beta/${f.name}`, { 'x-goog-api-key': key })).body);
      console.error(`  ...processing state=${f.state}`);
    }
    if (f.state !== 'ACTIVE') throw new Error(`File not ready: state=${f.state}`);
  } catch (e) { e.uploaded = uploaded; throw e; }
  uploaded.fileUri = f.uri;
  return uploaded;
}

// Remove the uploaded file from Google's side (Files API: DELETE /v1beta/files/<id>). A failure only warns.
async function deleteUploaded(name, key, request = req) {
  try {
    const r = await request('DELETE', `${BASE}/v1beta/${name}`, { 'x-goog-api-key': key });
    if (r.status >= 200 && r.status < 300) { console.error(`[cleanup] deleted ${name} from Google's servers`); return true; }
    console.error(`[cleanup] could not delete ${name} (HTTP ${r.status}); Google removes it automatically after 48 hours`);
  } catch (e) { console.error(`[cleanup] could not delete ${name}: ${e.message}; Google removes it automatically after 48 hours`); }
  return false;
}

async function generate(parts, opts, key) {
  const generationConfig = { temperature: 0, maxOutputTokens: opts.maxTokens };
  if (opts.thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: opts.thinkingLevel };
  const res = await req('POST', `${BASE}/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`,
    { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    Buffer.from(JSON.stringify({ contents: [{ parts }], generationConfig })));
  const json = JSON.parse(res.body);
  if (json.error) throw new Error(explainApiError(`Gemini: ${json.error.message}`));
  const cand = json.candidates && json.candidates[0];
  if (!cand) throw new Error(`No candidates (possibly safety-filtered): ${res.body.slice(0, 400)}`);
  return { text: (cand.content && cand.content.parts || []).map((p) => p.text || '').join(''), usage: json.usageMetadata, finish: cand.finishReason };
}

// ffmpeg renamed the frame-rate option: -fps_mode (ffmpeg 5.1+) replaced -vsync, which newer builds no longer accept at all.
// Try the new spelling first and fall back to the old one only when ffmpeg says the option is unknown.
const RATE_FLAGS = [['-fps_mode', 'vfr'], ['-vsync', 'vfr']];
function ffmpegFrameArgs(videoFile, pattern, opts, rateFlag) {
  return ['-hide_banner', '-nostdin', '-y', '-i', videoFile,
    '-vf', `select='gt(scene,${opts.sceneThreshold})',showinfo,scale=480:-1`,
    ...rateFlag, '-frames:v', String(opts.framesMax), pattern];
}

// Scene-detection key frames: one PNG per scene change (select='gt(scene,T)'), each with the timestamp ffmpeg reports.
// `run` is injectable for tests. spawnSync keeps stderr on success as well; showinfo writes pts_time there
// (execFileSync would lose it on success and every timestamp would become 0).
function extractSceneFrames(videoFile, base, opts, run = spawnSync) {
  const dir = `${base}-frames`;
  fs.mkdirSync(dir, { recursive: true });
  // --force: remove frames of an earlier run first, so a shorter new run cannot leave stale frames behind
  for (const f of fs.readdirSync(dir)) if (/^frame-\d+\.png$/.test(f)) fs.unlinkSync(path.join(dir, f));
  // Absolute paths: a name that starts with "-" can no longer be read as an ffmpeg option; "%" in a folder name is doubled
  // because ffmpeg treats the whole output path as a printf-style pattern.
  const absVideo = path.resolve(videoFile);
  const pattern = path.join(path.resolve(dir), 'frame-%03d.png').replace(/%(?!03d\.png$)/g, '%%');
  let r = null;
  for (const rateFlag of RATE_FLAGS) {
    r = run('ffmpeg', ffmpegFrameArgs(absVideo, pattern, opts, rateFlag), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw r.error;
    if (r.status === 0) break;
    if (!/Unrecognized option/i.test(r.stderr || '')) break;   // a real failure: do not retry with another spelling
  }
  if (r.status !== 0) {
    const last = String(r.stderr || '').trim().split(/\r?\n/).filter(Boolean).pop() || `exit code ${r.status}`;
    throw new Error(`ffmpeg failed: ${last}`);
  }
  const times = parseSceneTimes(r.stderr);
  const files = fs.readdirSync(dir).filter((f) => /^frame-\d+\.png$/.test(f)).sort();
  return files.map((f, i) => ({ time: formatTime(times[i] ?? 0), sec: times[i] ?? 0, file: path.join(dir, f), rel: path.join(path.basename(dir), f) }));
}

// The whole run, with its side effects injectable so the offline tests can drive it end to end with fakes.
async function run(opts, deps = {}) {
  const d = { upload: uploadLocal, generate, deleteUploaded, extractSceneFrames, checkFfmpeg, writeFile: (p, t) => fs.writeFileSync(p, t, 'utf-8'), ...deps };
  const youtube = isYouTube(opts.input);
  if (!youtube) {
    if (!fs.existsSync(opts.input)) throw new UsageError(`File not found: ${opts.input}`);
    if (!MIME[path.extname(opts.input).toLowerCase()]) throw new UsageError(`Unsupported extension. Supported: ${Object.keys(MIME).join(' ')}`);
  }
  const wantFrames = !youtube && !opts.noFrames;
  if (youtube && opts.sceneRequested) console.error('[frames] --scene is ignored for YouTube URLs (nothing is downloaded, so there is no local video to analyse).');
  // An explicit --scene is a promise: fail before spending any API call when ffmpeg is missing.
  if (wantFrames && opts.sceneRequested && !d.checkFfmpeg()) throw new UsageError(FFMPEG_HELP, 2);
  const { out } = checkOverwrite(opts, wantFrames);
  const key = resolveKey(opts);

  let mediaPart; let label; let uploaded = null;
  try {
    if (youtube) { const url = normalizeYouTube(opts.input); label = url; mediaPart = { fileData: { fileUri: url } }; console.error(`[youtube] ${url}`); }
    else { label = path.basename(opts.input); uploaded = await d.upload(opts.input, key); mediaPart = { fileData: { fileUri: uploaded.fileUri, mimeType: uploaded.mimeType } }; }
    console.error(`[transcribe] model=${opts.model} ...`);
    const t0 = Date.now();
    const { text, usage, finish } = await d.generate([mediaPart, { text: PROMPT }], opts, key);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const base = outputBase(opts.input);
    const header = `# Transcript: ${label}\n\n> Source: ${label}\n> Model: ${opts.model} - ${secs}s - finishReason: ${finish}\n> Tokens: in ${usage?.promptTokenCount ?? '?'} / out ${usage?.candidatesTokenCount ?? '?'}\n\n---\n\n`;
    let body = header + text;
    if (wantFrames) {
      if (!opts.sceneRequested && !d.checkFfmpeg()) {
        console.error('[frames] ffmpeg not found: skipping key frames (the transcript is not affected). Install ffmpeg, or pass --no-frames to silence this note.');
      } else {
        try {
          const frames = d.extractSceneFrames(opts.input, base, opts);
          if (frames.length) {
            body += `\n\n---\n\n## Key frames (scene detection, threshold ${opts.sceneThreshold}, ${frames.length} frames)\n\n`
              + frames.map((f) => `- **[${f.time}]** ![${f.time}](${f.rel.replace(/\\/g, '/')})`).join('\n') + '\n';
            console.error(`[frames] ${frames.length} key frames -> ${base}-frames/`);
          } else console.error('[frames] scene detection found no key frames (lower --scene to catch smaller changes)');
        } catch (e) { console.error('[frames] scene detection failed (skipped, the transcript is not affected):', e.message); }
      }
    }
    d.writeFile(out, body);
    console.error(`Done -> ${out} (${secs}s, finish=${finish})`);
    if (finish === 'MAX_TOKENS') console.error('Warning: hit maxOutputTokens; the transcript may be truncated. Increase --max or split the video.');
    return { out, body };
  } catch (e) {
    if (e.uploaded && !uploaded) uploaded = e.uploaded;   // upload finished but the file never became ACTIVE: still clean up
    throw e;
  } finally {
    if (uploaded && !opts.keepUpload) await d.deleteUploaded(uploaded.name, key);
    else if (uploaded && opts.keepUpload) console.error(`[cleanup] --keep-upload: ${uploaded.name} stays on Google's servers for up to 48 hours`);
  }
}

if (require.main === module) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error('Error:', e.message); process.exit(e.exitCode || 1); }
  run(opts).catch((e) => { console.error('Error:', e.message); process.exit(e.exitCode || 1); });
}

module.exports = {
  DEFAULT_MODEL, FFMPEG_HELP, UsageError, parseArgs, isYouTube, normalizeYouTube, outputBase, outputPath, formatTime, parseSceneTimes,
  checkFfmpeg, resolveKey, checkOverwrite, explainApiError, deleteUploaded, extractSceneFrames, ffmpegFrameArgs, RATE_FLAGS, run,
};
