# Interview Copilot — Desktop (Windows / macOS / Linux)

A native desktop version of the Interview Copilot browser extension. It transcribes the
interviewer live, lets you send a question when you decide it's complete, and streams an AI answer
grounded in your resume and the job description — in an **always-on-top panel** that floats over any
app. A **code panel** docks beside the answer for technical questions.

One codebase builds all three platforms; the only per-platform differences are how system audio is
captured (see [Platform notes](#platform-notes-on-system-audio)) and the packaging.

**Why a desktop app over the extension**

- **System-audio capture** — works with the **Zoom, Teams and Meet desktop apps**, not just their
  web clients. No tab to pick, no per-tab permission click.
- **Always-on-top over any window**, plus **global hotkeys** that work even when the meeting app has
  focus.
- No browser service-worker lifecycle to fight.

**What it deliberately does not do:** it does not hide itself from screen sharing. The panel is a
normal on-screen window — the same open stance as the extension.

---

## Run it in development

```bash
npm install          # downloads Electron (~100 MB, one time)
npm start
```

## Build the installers

The easiest way to get all three is GitHub Actions: run the **Build** workflow
([.github/workflows/build.yml](.github/workflows/build.yml)) from the Actions tab, or push a `v*`
tag. It produces three artifacts — `InterviewCopilot-Windows`, `InterviewCopilot-macOS` and
`InterviewCopilot-Linux`.

Locally, each platform builds on its own OS:

| Command | Output | Builds on |
|---|---|---|
| `npm run dist:win` | `dist/InterviewCopilot-Setup-<version>.exe` (NSIS, x64) | Windows |
| `npm run dist:mac` | `dist/InterviewCopilot-<version>-{arm64,x64}.dmg` + `.zip` | macOS only |
| `npm run dist:mac:arm64` / `dist:mac:x64` | one architecture | macOS only |
| `npm run dist:linux` | `dist/InterviewCopilot-<version>-x64.AppImage` + `.deb` | Linux |
| `npm run dist:linux:appimage` / `dist:linux:deb` | one format | Linux |
| `npm run dist:linux:arm64` | AppImage for arm64 (Raspberry Pi 5, Asahi, …) | Linux |
| `npm run dist:linux:tar` | portable `dist/InterviewCopilot-<version>-x64.tar.gz` | Windows or Linux |

A `.dmg` can only be built on macOS (Apple's tooling). The Linux AppImage and `.deb` need symlinks
and `fpm`, which Windows lacks; `dist:linux:tar` is the one Linux target that works from Windows
([make-linux-tar.js](make-linux-tar.js) packs `linux-unpacked` with real executable bits and adds a
`run.sh` launcher).

### Installing

- **Windows:** run the `.exe` installer.
- **macOS:** open the `.dmg` and drag the app to Applications. A build that is not notarized by
  Apple is refused on other Macs with *"Apple could not verify … is free of malware"* (Gatekeeper,
  not a virus) — an **Apple Development** certificate does not help, only **Developer ID** +
  notarization does. To open such a build once per Mac: on macOS 15+ double-click it (refused),
  then System Settings → Privacy & Security → **Open Anyway**; on macOS 14 and earlier
  right-click → **Open** → **Open**; or `xattr -dr com.apple.quarantine "/Applications/Interview
  Copilot.app"`. To ship a build that opens without this, join the Apple Developer Program,
  create a **Developer ID Application** certificate, and give the build (locally or as repository
  secrets) `CSC_LINK` (base64 `.p12`) + `CSC_KEY_PASSWORD` for signing and `APPLE_ID` +
  `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` for notarization (`mac.notarize` is on in
  package.json; it is skipped when those are missing). On first Start, macOS asks for **System Audio Recording** (the
  interviewer) and **Microphone** (you); re-enable either under System Settings → Privacy & Security
  if you denied it, then quit and reopen the app.
- **Linux AppImage:** `chmod +x InterviewCopilot-*.AppImage && ./InterviewCopilot-*.AppImage`. Needs
  FUSE 2 (`sudo apt install libfuse2` on Ubuntu 22.04+); or run with `--appimage-extract-and-run`.
- **Linux .deb:** `sudo apt install ./InterviewCopilot-*.deb`, then launch **Interview Copilot**
  from the app menu or run `interview-copilot`.
- **Linux tarball:** `tar xzf InterviewCopilot-*.tar.gz && cd InterviewCopilot-*-x64 && ./run.sh`.
  `run.sh` starts the app and, on kernels that block unprivileged user namespaces (Ubuntu 24.04
  defaults), adds `--no-sandbox` unless you have done the one-time
  `sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox`.

Linux requirements: PulseAudio or PipeWire with `pactl` (package `pulseaudio-utils`, present on
every mainstream desktop distro). A tray icon needs a StatusNotifier host — KDE, XFCE, Cinnamon and
MATE have one; on GNOME install the *AppIndicator and KStatusNotifierItem Support* extension.
Without a tray the app still works; use the panel's ⚙ button for Setup.

## First-time setup

Click the **⚙** in the panel (or the tray icon → Setup). Setup has three tabs: **Profile** (this
interview: the profile picker, resume, job description, custom prompt, answer style, language),
**App** (the program itself: appearance, AI provider and model, API keys, capture devices) and
**Guide** (install, setup, use and troubleshooting, for the platform it runs on — also opened by the
panel's **?** button). Fill in:

- **Resume**, **job description**, **custom prompt**, answer style, language.
- **Transcription** — **Offline** (default): press **Download** once to get the speech model
  (~670 MB); it then runs on the machine, works without internet during the call and sends no
  audio anywhere. One model (NVIDIA Parakeet v3 via sherpa-onnx) covers English, Romanian and
  Portuguese. Or **Deepgram** (cloud) with an API key. See [Transcription](#transcription).
- **Provider + model**, and the **API keys** (Anthropic / OpenAI / Gemini; **Deepgram** only if
  you chose it for transcription).
- **Theme** — Dark (default), Light, Nord, Dracula, Solarized Dark / Light, Gruvbox, Catppuccin,
  Tokyo Night, Rosé Pine or Monokai. The panel header has the same picker, and a change applies
  to both windows immediately.
- **Font** — pick one of the built-in stacks (system, Helvetica/Arial, Verdana, Georgia, monospace…)
  or type the name of any font installed on the machine. Applies to the panel and the Setup window.

### Profiles and sessions

- A **profile** is one company / role: its resume, job description, custom prompt, answer style and
  language. Create one per application in Setup (New / Duplicate / Delete) and switch with the
  **profile picker** in the panel's Interviewer bar or in Setup. API keys, theme, font and capture
  devices are global, not per profile.
- A **session** is one interview round. It starts with the first question after **Start** (or
  **New** in the Interviewer bar), and every question, answer, attachment and the spoken transcript
  is saved as it happens. For the next round — e.g. the technical interview after the intro call —
  pick the earlier session in the **session picker**: its Q&A comes back on screen and the AI
  continues the same conversation, so it already knows what was discussed. "New session" in the
  picker starts fresh with the next question. **Rename** and **Delete** next to the picker act on
  the selected session. **PDF** exports the session that is open, named after the session.
- Everything is stored locally in SQLite (`copilot.sqlite` in the app data folder, screenshots as
  files next to it). Deleting a profile deletes its sessions.
- **Earlier rounds** (Profile tab): notes about previous interviews with the same company, or the
  text of a file you import — the PDF report this app saved, or any PDF / text / Markdown file.
  It goes to the AI together with the resume and job description, so the next round stays
  consistent with what was already said even if the session itself is gone.

### Proxy (blocked regions)

If the provider endpoints are unreachable where you are (mainland China, Hong Kong…), set a
**proxy** under Setup → Network: the address of your VPN / proxy client, e.g. `http://127.0.0.1:7890`
or `socks5://127.0.0.1:1080` (credentials as `http://user:pass@host:port`). It routes all of the
app's API traffic — OpenAI, Anthropic, Gemini and the Deepgram audio stream — and takes effect
immediately. **Check proxy** tests the address you typed against all four services and shows the
round-trip time for each; leave the field empty to use the system proxy settings.

A proxy that needs a username / password is handled through a loopback relay the app runs on
127.0.0.1: the relay adds the login to every tunnel, because Chromium can answer the proxy's
challenge for ordinary requests but not for a WebSocket handshake, and the Deepgram audio stream
is a WebSocket (that is what "Deepgram socket error" right after Start meant). Both http(s) and
socks5 proxies with credentials work this way; the check uses the same path as the app.

Keys can instead go in **`config/keys.json`** next to the app (a `keys.example.json` is included).
Keys in that file pre-fill any field you have left empty; a key typed in Setup overrides the file,
and Remove falls back to the file again. Fields show only the first and last 5 characters of a
key and never reveal it; to replace a key, click the field and paste the new one.

## Using it

1. Start your meeting in Zoom / Teams / Meet (desktop app or web — all work now).
2. Press **Start** in the panel.
   - **Windows:** on first run Windows asks to share a screen — that grant is what lets the app read
     **system audio** (what you hear = the interviewer). Only the audio is used; the video is dropped
     immediately.
   - **macOS 14.2+:** the app records the Mac's **system audio output** directly — whatever you
     hear, through any speaker or headphones. macOS asks once for *System Audio Recording*
     permission. Older macOS uses a virtual audio device (BlackHole) — see
     [Platform notes](#platform-notes-on-system-audio).
   - **Linux:** the app creates a temporary audio source mirroring your default output and captures
     it. Nothing to click.
3. The interviewer's words appear in the **Question to send** box as they are heard (the live
   guess at the end is corrected as the sentence completes). Edit if needed, then **Enter** or
   **Send**. The answer streams in; code goes to the docked code panel. If the network drops and
   an answer fails, stalls or comes back cut off, press **Retry** in the Answer bar: the question
   on screen is asked again and the new answer replaces the old one, on screen and in the saved
   session, without duplicating the question.
4. For technical rounds, **attach what is on screen**: **Snap** grabs a screenshot of the display
   the panel is on (the panel itself is never in the shot), **Attach** picks files, and you can
   also **paste** a screenshot (`Win+Shift+S` / `⌘⇧4`, then `Ctrl+V` in the box) or **drop** files
   onto the panel. Images, PDFs and text/code files are supported, up to 8 per question. Sending
   with only an attachment asks the model to solve whatever the attachment shows. Attachments are
   sent to the AI provider with the question and are kept for the two most recent questions so
   follow-ups like "explain line 3" still see the screenshot. On macOS, Snap needs *Screen
   Recording* permission for Interview Copilot (System Settings → Privacy & Security).
5. After the interview, press **PDF** in the Answer bar to save a report. For every question it
   shows three things: what the **interviewer asked** (with attachments), what the **AI suggested**,
   and what **you answered** — your own words as heard by the microphone between that question and
   the next. A full transcript of both sides, in order, follows at the end. Your side is captured
   while *Also transcribe my microphone* (Setup → App → Capture) is on, which it is by default. Your
   words are saved silently — the panel only ever shows the interviewer. The file opens in a Save
   dialog (Documents folder by default) and is revealed in the file manager once written.

| Windows / Linux (global) | macOS (global) | Action |
|---|---|---|
| `Alt+Shift+I` | `⌥⇧I` | Show / hide the panel |
| `Alt+Shift+A` | `⌥⇧A` | Send the question box now |
| `Alt+Shift+S` | `⌥⇧S` | Start / stop the session |
| `Alt+Shift+↑` / `↓` | `⌥⇧↑` / `↓` | Bigger / smaller answer text |

On macOS the app also has a menu-bar icon and an app menu (Setup is `⌘,`, quit is `⌘Q`).

The audio-link **dot** in the header is green when connected, pulsing green while it hears the
interviewer, red if disconnected. One interview = one AI conversation session, so follow-ups like
"give me the diagram" resolve against what was just discussed. Prev / Next flip through earlier Q&A.

---

## Transcription

Speech-to-text runs **offline by default**: the main process starts a utility process
([src/main/stt/worker.js](src/main/stt/worker.js)) that loads a downloaded model with
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (`sherpa-onnx-node`, prebuilt for Windows x64,
macOS arm64 / x64 and Linux x64 / arm64) and transcribes both audio channels. The renderer talks
to it through [src/renderer/offline-stt.js](src/renderer/offline-stt.js), which has the same shape
as the Deepgram client, so the rest of the panel does not care which engine is on.

- **Models** ([src/main/stt/models.js](src/main/stt/models.js)), downloaded from Setup → App →
  Transcription into `<userData>/stt-models/`, file by file (a stopped download resumes), through
  the app's proxy setting if one is set:
  - **Parakeet v3** (`parakeet-tdt-0.6b-v3-int8`, default) — NVIDIA Parakeet-TDT 0.6B v3, int8:
    ~670 MB, ~1.3 GB of RAM while running, 25 European languages including en / ro / pt, detects
    the language itself. On an M-series Mac a 7 s utterance decodes in well under a second.
  - **Whisper small** (`whisper-small-int8`) — ~375 MB download but ~1.8 GB of RAM, slower and
    less accurate; transcribes in the Meeting language. For machines where the bigger download is
    the problem, not the memory.
  - **Silero VAD** (`silero_vad.onnx`) splits the audio into utterances for both.
- **Live behaviour:** the models are non-streaming, so the VAD closes an utterance after 0.5 s of
  silence (or 20 s of continuous speech) and that utterance becomes a *final* result; while the
  speaker is still talking, the audio heard so far is decoded every ~1.2 s as an *interim* result,
  so the question box fills in live as it did with Deepgram. Pressing **Send** mid-utterance cuts
  the audio at that point: the part before it is saved to the transcript only, the rest starts the
  next question (same rule as the Deepgram path, see `cut()` in both clients).
- **Packaging:** the native addon and its shared libraries are `asarUnpack`ed. A macOS build for
  the other CPU architecture fetches that architecture's addon first
  ([scripts/ensure-sherpa-arch.js](scripts/ensure-sherpa-arch.js), run by `dist:mac*`). If the
  addon is missing for a platform the app says so and Deepgram can be selected instead.
- Set `STT_DEBUG=1` to see the worker's stderr.

## Platform notes on system audio

Electron's built-in loopback capture is Windows-only, so each platform gets the interviewer's audio
a different way. The same **Setup → Capture → System audio source** picker exists everywhere for
people who route audio through a virtual cable; make sure **Microphone (you)** stays your real mic.

### Windows 10 2004+

System-audio loopback works out of the box via the app's `getDisplayMedia` handler
(`audio: 'loopback'`). Leave the picker on **Automatic**.

### macOS

**macOS 14.2 and later — nothing to install.** On Start, the main process runs
`copilot-audio-tap` ([native/mac-audio-tap/AudioTap.swift](native/mac-audio-tap/AudioTap.swift)), a
small Swift helper that creates a Core Audio **process tap** on the whole system mix and writes it to
stdout as 16 kHz mono PCM; [src/main/mac-audio-tap.js](src/main/mac-audio-tap.js) streams the chunks
to the renderer, which sends them to Deepgram. Because it taps the system mix rather than a device,
the meeting app can play through any speaker, headphones or AirPods, and switching outputs mid-call
keeps working. The panel shows what it listens to (e.g. *Mac system audio output (MacBook Pro
Speakers)*).

- **Permission:** macOS asks once, *"Interview Copilot" would like to record system audio* (the
  text is `NSAudioCaptureUsageDescription`). Until it is answered the capture waits and the panel
  says so. A denied permission gives silence, not an error — turn it on under System Settings →
  Privacy & Security → Screen & System Audio Recording → *System Audio Recording Only*, quit and
  reopen the app.
- **Building:** `npm run dist:mac*` builds the universal helper first (`npm run build:mac-tap`,
  needs Xcode or the Command Line Tools with the macOS 14.2+ SDK) and ships it in
  `Contents/Resources/bin`. For `npm start` on a Mac, run `npm run build:mac-tap` once; without the
  helper the app falls back to a virtual device.

**Older macOS, or to capture a specific device:** pick it in Setup → **Capture** → **System audio
source** (a device picked there always wins over Automatic). One-time setup with the free, open-source
[BlackHole](https://existential.audio/blackhole/):

1. `brew install --cask blackhole-2ch` (or the `.pkg` installer from the site). The driver is only
   picked up after the audio daemon restarts: reboot, or run `sudo killall coreaudiod`, then reopen
   Audio MIDI Setup. If **BlackHole 2ch** is still missing from the device list, check that
   `/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver` exists.
2. Open **Audio MIDI Setup** → **+** → **Create Multi-Output Device**; tick your speakers /
   headphones **and** BlackHole 2ch (leave any Teams / Zoom virtual device unticked).
3. During the call, select that Multi-Output Device as the Mac's **sound output** (Control Centre →
   Sound), and set **Speaker** to it inside the meeting app too (Teams: Settings → Devices → Speaker;
   Zoom: Settings → Audio). You still hear everything; BlackHole gets a copy.
4. On macOS before 14.2, **Automatic** picks the first BlackHole / Loopback / Soundflower device;
   on 14.2+ choose BlackHole explicitly.

**Started, but nothing is transcribed?** The panel says which source it listens on when you press
Start, and warns after a few seconds of silence. With the system-output capture that means nothing
audible is playing or the permission is off; with BlackHole it almost always means the meeting is not
playing through the Multi-Output Device.

### Linux

Chromium hides PulseAudio's "Monitor of …" sources from apps, so on **Start** the main process runs

```bash
pactl load-module module-remap-source master=<default-sink>.monitor \
  source_name=interview_copilot_monitor source_properties=device.description=InterviewCopilotMonitor
```

which makes a normal input called **InterviewCopilotMonitor** that carries a copy of everything
playing on your default output. The renderer captures it (raw — no echo cancellation or noise
suppression) and the module is unloaded again on Stop / Quit. This works with PulseAudio and with
PipeWire's PulseAudio layer (`pipewire-pulse`), which every current desktop distro ships.

If the output device changes mid-call (e.g. you plug in headphones), press Stop and Start again so
the mirror follows the new default sink.

**If Automatic fails** (no `pactl`, or the source never appears):

- Make a source yourself with the command above (or `pw-loopback` on PipeWire) and pick it in Setup →
  **Capture** → **System audio source**. Any input whose name contains "Monitor" or "Copilot" is
  auto-detected on the next Start.
- Or start a session on any input, open **pavucontrol** → *Recording*, and switch the Interview
  Copilot stream to *Monitor of <your output>*.

**Desktop environment notes**

- **Wayland (GNOME, KDE Plasma 6):** Electron runs through XWayland by default, which keeps the
  always-on-top panel working. Global shortcuts are an X11 feature: under Wayland they only fire
  while another XWayland window (e.g. the Zoom or Teams desktop app) has focus, and not while a
  native Wayland app is focused. The panel's own buttons always work.
- **Transparent panel shows a black box:** some NVIDIA drivers on X11 lack an ARGB visual. Run with
  `COPILOT_DISABLE_GPU=1 interview-copilot` (the app already passes `--enable-transparent-visuals`).
- **Content protection** (hiding the panel from screen capture) is a Windows / macOS window-manager
  feature and has no Linux equivalent, so the panel is visible in screen shares there.

## Architecture

```
src/
  main/          Electron main process
    main.js        windows, tray, global shortcuts, IPC; Windows loopback handler, macOS menu +
                   mic permission, Linux pactl monitor source
    mac-audio-tap.js  runs the macOS system-audio helper and streams its PCM to the panel
    stt/           offline speech-to-text: models.js (catalogue), index.js (download, worker
                   lifecycle, IPC), worker.js (sherpa-onnx + VAD in a utility process)
    preload.js     the only renderer <-> main bridge (contextBridge)
    settings.js    JSON settings in userData + config/keys.json override
  assets/        tray icons (tray.png for Windows / Linux, trayTemplate.png for the macOS menu bar)
  renderer/      the panel window (frameless, transparent, always-on-top)
    index.html · renderer.js   glue
    ui.js          panel DOM (header, transcript, question box, answer + code split)
    audio.js       system audio (Windows loopback / Linux monitor source / macOS system output
                   or virtual device) + mic capture -> offline STT or Deepgram -> detector -> AnswerEngine
    offline-stt.js the offline speech-to-text channel (same interface as shared/deepgram.js)

    panel.css
    settings.html · settings.js · settings.css   setup window
  shared/        framework-independent logic, shared with the extension in spirit
    deepgram.js · question-detector.js · prompt.js · audio-worklet.js
    render.js      renderRich / renderCodeOnly / resize + split math (unit-tested)
    constants.js · settings-util.js
    llm/           anthropic · openai · gemini behind one streaming interface, with
                   the per-interview conversation session
native/
  mac-audio-tap/ AudioTap.swift + build.sh -> native/bin/copilot-audio-tap (universal macOS helper)
build/
  entitlements.mac.plist   hardened-runtime entitlements for the macOS build
make-linux-tar.js          portable Linux tarball packer (works from Windows)
.github/workflows/build.yml  CI matrix: Windows / macOS / Linux installers
```

The `shared/` modules are the same logic proven in the extension (session memory, question
detection, safe markdown/code rendering); only the platform glue (main/preload/renderer) is new.

## Notes

- API keys are stored in plain text in the app's user-data folder (`%APPDATA%\Interview Copilot`,
  `~/Library/Application Support/Interview Copilot`, `~/.config/Interview Copilot`) — appropriate
  for your own machine.
- `webSecurity` is disabled on the panel window so the renderer can call the LLM and Deepgram APIs
  directly; that's standard for a local API client and the CSP still restricts connections to those
  four hosts.
- Transcribing or recording a call may require the other participants' consent depending on where
  you are.
