# Download

**Windows installer:** [Telestrator-Setup-1.0.0.exe](Telestrator-Setup-1.0.0.exe)

Click the file above, then press the **Download** button (or the download icon) on
the file page. Run it to install — it includes everything needed, so no Node.js
or other downloads are required on the target machine.

Windows SmartScreen may warn that the publisher is unknown, because the app is
not code-signed. Click **More info → Run anyway**.

## After installing

1. Launch **Telestrator** — it opens the **Settings** window. Nothing takes over a
   screen until you say so.
2. The **Diagnostics** panel lists every camera Windows can see.
3. Plug in the capture source, click **Rescan Cameras**, select it, **Start Capture**.
4. Under **Output Window**, pick the display the switcher captures and press
   **Open Output**. Uncheck fullscreen if you only have one monitor.
5. Menu (press **Alt**) → **Show iPad URL** for the address to share.

## Sharing the feed

Watchers get their own port. Hand out:

```
http://<computer-ip>:3001
```

That port serves the feed and nothing else — no drawing page, no settings, no
control API, and its connections are read-only at the server. A watcher cannot
change what is on air even with developer tools open.

Port `3000` is the control side: it opens a page offering **Telestrate** or
**Watch Only**, and hosts settings and the output.

## Frame rate

Settings → **Frame Rate** controls three things:

- **Capture rate** — what the iPad sees. Costs CPU on this computer, because
  every frame is encoded. Cannot exceed what the camera delivers.
- **Preview size** — fewer pixels is the cheapest way to afford 60 fps.
- **Watcher rate** — costs bandwidth per viewer but no CPU, since watchers
  receive frames that were already encoded for the drawer.

None of these affect the on-air output, which is drawn directly by the output
window and is always smooth.

**Esc** leaves fullscreen on the output window and **F11** toggles it, so you are
never stuck with it covering the desktop.

Feed the output window's display into the ATEM and set up a **luma key** (black
drops out). Green/chroma is selectable in Settings instead.

## Hotkeys

These work anywhere on the computer, even when Telestrator is not focused:

| Key | Action |
| --- | --- |
| `Ctrl + Alt + C` | Clear drawings (instant cut) |
| `Ctrl + Alt + H` | Hide / show the output on air |
| `Ctrl + Alt + Z` | Undo last stroke |

`Ctrl + Alt + H` is the one to reach for mid-show: it pulls the telestration off
air instantly but keeps the strokes, so the same press brings them back.

## Running from source

If you would rather not install, the app can be run directly:

```
npm install
npm run app
```
