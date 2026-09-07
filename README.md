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
- **macOS:** open the `.dmg` and drag the app to Applications. Without an Apple Developer ID
  certificate the app is unsigned, so Gatekeeper refuses to open it the first time. Either
  right-click the app → **Open** → **Open**, or run
  `xattr -dr com.apple.quarantine "/Applications/Interview Copilot.app"`. To ship a signed +
  notarized build, add `CSC_LINK` (base64 `.p12`) and `CSC_KEY_PASSWORD` as repository secrets;
  the workflow picks them up. On first Start, macOS asks for **Microphone** access (covers both your
  mic and the virtual audio device); re-enable it under System Settings → Privacy & Security →
  Microphone if you denied it.
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

Click the **⚙** in the panel (or the tray icon → Setup) and fill in:

- **Resume**, **job description**, **custom prompt**, answer style, language.
- **Provider + model**, and the **API keys** (Anthropic / OpenAI / Gemini, plus **Deepgram** for
  transcription).

Keys can instead go in **`config/keys.json`** next to the app (a `keys.example.json` is included).
Keys in that file override the UI fields and lock them — the same behaviour as the extension.

## Using it

1. Start your meeting in Zoom / Teams / Meet (desktop app or web — all work now).
2. Press **Start** in the panel.
   - **Windows:** on first run Windows asks to share a screen — that grant is what lets the app read
     **system audio** (what you hear = the interviewer). Only the audio is used; the video is dropped
     immediately.
   - **macOS:** the app reads the meeting audio from a **virtual audio device** (BlackHole) — see
     [Platform notes](#platform-notes-on-system-audio) for the one-time setup.
   - **Linux:** the app creates a temporary audio source mirroring your default output and captures
     it. Nothing to click.
3. The interviewer's words collect in the **Question to send** box. Edit if needed, then **Enter**
   or **Send**. The answer streams in; code goes to the docked code panel.

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

## Platform notes on system audio

Electron's built-in loopback capture is Windows-only, so each platform gets the interviewer's audio
a different way. The same **Setup → Capture → System audio source** picker exists everywhere for
people who route audio through a virtual cable; make sure **Microphone (you)** stays your real mic.

### Windows 10 2004+

System-audio loopback works out of the box via the app's `getDisplayMedia` handler
(`audio: 'loopback'`). Leave the picker on **Automatic**.

### macOS

The app captures a **virtual audio device** as if it were a microphone. One-time setup with the
free, open-source [BlackHole](https://existential.audio/blackhole/):

1. `brew install blackhole-2ch` (or the installer from the site), then reboot if asked.
2. Open **Audio MIDI Setup** → **+** → **Create Multi-Output Device**; tick your speakers /
   headphones **and** BlackHole 2ch.
3. During the call, select that Multi-Output Device as the Mac's **sound output** (Control Centre →
   Sound). You still hear everything; BlackHole gets a copy.
4. In the app's Setup → **Capture** → **System audio source**, leave **Automatic** (it picks the
   first BlackHole / Loopback / Soundflower device) or choose BlackHole explicitly.

Any other virtual driver (Loopback, Soundflower, VB-Cable) works the same way.

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
    preload.js     the only renderer <-> main bridge (contextBridge)
    settings.js    JSON settings in userData + config/keys.json override
  assets/        tray icons (tray.png for Windows / Linux, trayTemplate.png for the macOS menu bar)
  renderer/      the panel window (frameless, transparent, always-on-top)
    index.html · renderer.js   glue
    ui.js          panel DOM (header, transcript, question box, answer + code split)
    audio.js       system audio (Windows loopback / Linux monitor source / macOS virtual device)
                   + mic capture -> Deepgram -> detector -> AnswerEngine
    panel.css
    settings.html · settings.js · settings.css   setup window
  shared/        framework-independent logic, shared with the extension in spirit
    deepgram.js · question-detector.js · prompt.js · audio-worklet.js
    render.js      renderRich / renderCodeOnly / resize + split math (unit-tested)
    constants.js · settings-util.js
    llm/           anthropic · openai · gemini behind one streaming interface, with
                   the per-interview conversation session
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
