# video-transcribe

Turn any video into a **timestamped transcript** with Google Gemini. It works with **YouTube URLs** (nothing is downloaded) and **local files** (mp4, mov, webm, mkv, mp3, wav and more).

The output is a Markdown transcript with `[HH:MM:SS]` timestamps in the video's original language and a short bullet summary. For local videos it can also save **key frames** found by scene detection. One script, no npm dependencies (it uses Node's built-in `https`).

> **Privacy first:** a local file is uploaded to Google in full, and on the free tier Google may let people read your inputs and outputs. Do not use this tool on confidential or personal material unless you have read the [Privacy](#privacy) section.
>
> **Maintenance:** this project is maintained on a best-effort basis. Issues and pull requests are welcome, but there is no promise of response time or of support for any particular Gemini model.
>
> 繁體中文說明：[README.zh-TW.md](README.zh-TW.md)

## Install

Requires **Node.js 18 or newer**. No `npm install`.

```bash
git clone https://github.com/tianjige-lab/video-transcribe.git
cd video-transcribe
```

Get a Gemini API key at <https://aistudio.google.com/apikey>, then:

```bash
export GEMINI_API_KEY="your-key-here"      # Windows PowerShell: $env:GEMINI_API_KEY="your-key"
```

## Usage

```bash
# YouTube (passed straight to Gemini, public videos only)
node video-transcribe.js "https://www.youtube.com/watch?v=VIDEO_ID"

# Local file (uploaded through the Gemini Files API; key frames are added when ffmpeg is installed)
node video-transcribe.js "./talk.mp4"
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--out <file>` | `./<name>-transcript.md` | Output path. YouTube inputs are named `yt-<video id>-transcript.md` (the id is reduced to letters, digits, `_` and `-`). |
| `--force` | off | Overwrite an existing output file or key-frame folder. Without it the run stops **before** the upload and any API call. |
| `--model <id>` | `gemini-3.8-flash` | Gemini model id. You can also set the `GEMINI_VIDEO_MODEL` environment variable; `--model` wins. |
| `--max <tokens>` | `32768` | `maxOutputTokens`. Raise it for long videos. |
| `--key-file <path>` | none | Read the API key from a file instead of `GEMINI_API_KEY` (one key per line, `#` comments allowed). |
| `--thinking-level <level>` | not sent | Optional: `minimal`, `low`, `medium` or `high`, sent as `generationConfig.thinkingConfig.thinkingLevel`. Not every model accepts every level: for example `minimal` is rejected by `gemini-3.8-flash` (see [Google's thinking page](https://ai.google.dev/gemini-api/docs/thinking)); the error message then points back to this option. |
| `--scene [threshold]` | `0.4` | Scene-detection key frames (local files only, needs **ffmpeg**). The threshold is between 0 and 1: raise it to get fewer frames, lower it to catch smaller changes. |
| `--frames-max <n>` | `40` | Upper bound for the number of key frames. |
| `--no-frames` | off | Never extract key frames. |
| `--keep-upload` | off | Keep the uploaded file on Google's side. By default it is deleted when the run ends, also when the run fails. |

### Scene detection and ffmpeg

For a local video the script runs `ffmpeg` with the `scene` filter and saves one PNG at every scene change into `<name>-frames/`. The transcript then ends with a **Key frames** section that lists each frame with its timestamp.

- **ffmpeg is required** for this part: <https://ffmpeg.org/download.html> (or install it with your package manager).
- If you do **not** pass `--scene` and ffmpeg is missing, the transcript is still produced and a one-line note says that key frames were skipped.
- If you **do** pass `--scene` and ffmpeg is missing, the script stops **before** uploading anything or calling the API, prints a clear error and exits with code 2.
- The script uses `-fps_mode vfr` and falls back to the older `-vsync vfr` only for ffmpeg builds that do not know the new option.
- Frame extraction never changes the transcript text; if ffmpeg fails, the transcript is written anyway.

### Example output

```markdown
# Transcript: https://www.youtube.com/watch?v=jNQXAC9IVRw

> Source: https://www.youtube.com/watch?v=jNQXAC9IVRw
> Model: gemini-3.8-flash - 4.5s - finishReason: STOP

---

[00:00:00] All right, so here we are, one of the elephants.
[00:00:09] And the cool thing about these guys is that they have really, really long trunks.

Summary:
- A young man at a zoo with elephants behind him.
- Mentions the elephants have long trunks.
```

## Choosing a model

The default is `gemini-3.8-flash`. When this version was prepared (2026-10-24) Google's model list showed it as generally available and recommended for new projects, and the deprecation page showed the older `gemini-2.5-flash` as legacy with access limited to existing users, and `gemini-2.0-flash` as shut down. Model availability changes often, so check Google's pages before you rely on a model:

- Models: <https://ai.google.dev/gemini-api/docs/models>
- Deprecations and shutdown dates: <https://ai.google.dev/gemini-api/docs/deprecations>
- Thinking settings: <https://ai.google.dev/gemini-api/docs/thinking>

To use another model, pass it with `--model`:

```bash
node video-transcribe.js "./talk.mp4" --model gemini-3.5-flash-lite     # cheaper, lighter
GEMINI_VIDEO_MODEL=gemini-3.6-flash node video-transcribe.js "./talk.mp4"
```

The previous version always sent `thinkingBudget: 0`, which belongs to the 2.5 generation. This version sends no thinking setting unless you ask for one with `--thinking-level`.

## Privacy

- **A local file leaves your computer.** The whole file is uploaded to Google's servers through the Gemini Files API. Google keeps uploaded files for 48 hours and then deletes them automatically; this tool deletes the file as soon as the run ends (use `--keep-upload` to skip that). See <https://ai.google.dev/gemini-api/docs/files>.
- **A YouTube URL is handed to Google**, which fetches the video itself.
- **Free tier: your inputs and outputs may be reviewed by people.** Under the Gemini API terms, content you send on the free tier can be used to improve Google's products and may be read by human reviewers; the terms ask you not to submit sensitive, confidential or personal information there. Paid usage is treated differently. Read the current terms before you decide: <https://ai.google.dev/gemini-api/terms>.
- **Do not send sensitive content**: recordings of private meetings, medical, legal or financial material, other people's personal data, or anything you are not allowed to share with a third party.
- The transcript and key frames are written only to your own disk. The tool has no telemetry and sends nothing anywhere except to `generativelanguage.googleapis.com`.

## Status and limits

- **Live-tested once on 2026-10-24** against the free tier with `gemini-3.8-flash`: a public YouTube video, a small local file (upload, transcript, automatic deletion of the uploaded file) and a local file with `--scene`. Google's API changes often and the model can answer with a temporary "high demand" error; if that happens, wait and run again. The offline tests (below) cover argument parsing, output names, ffmpeg handling and key-frame extraction.
- The API key is sent in the `x-goog-api-key` header, as in Google's examples, not in the URL.
- Local files are read into memory for upload, so very large files need enough RAM.
- Google labels the `generateContent` method used here as *legacy* and recommends its newer Interactions API for new projects, while stating that `generateContent` remains fully supported (<https://ai.google.dev/gemini-api/docs/interactions>). This tool keeps using `generateContent`.
- **Cost:** every run is a Gemini API call, billed under Google's pricing. Run it by hand; do not put it in an unattended loop without a spending cap.
- YouTube input: only public videos; Google documents daily limits for the free tier.
- If you see `Warning: hit maxOutputTokens`, raise `--max` or split the video.
- The script never stores your key; it reads it at run time from the environment or `--key-file`.

## Tests

```bash
npm test        # same as: node --test
```

The tests run offline and need no API key. They also run the real scene detection on the bundled `test-fixtures/scene-test.mp4` (a 9-second, 320x240 test pattern generated with ffmpeg) when ffmpeg is installed, and skip that one test otherwise.

## License

MIT. See `LICENSE`. Maintained by Tianjige Lab.
