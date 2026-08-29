# Download

**Windows installer:** [Telestrator-Setup-1.0.0.exe](Telestrator-Setup-1.0.0.exe)

Click the file above, then press the **Download** button (or the download icon) on
the file page. Run it to install — it includes everything needed, so no Node.js
or other downloads are required on the target machine.

Windows SmartScreen may warn that the publisher is unknown, because the app is
not code-signed. Click **More info → Run anyway**.

## After installing

1. Launch **Telestrator** — the black output window opens fullscreen.
2. Press **Alt** for the menu → **Settings**.
3. The **Diagnostics** panel lists every camera Windows can see.
4. Plug in the capture source, click **Rescan Cameras**, select it, **Start Capture**.
5. Menu → **Show iPad URL** for the address to open on the iPad.

Feed the output window's display into the ATEM and set up a **luma key** (black
drops out). Green/chroma is selectable in Settings instead.

## Hotkeys

These work anywhere on the computer, even when Telestrator is not focused:

| Key | Action |
| --- | --- |
| `Ctrl + Alt + C` | Clear drawings (fades out) |
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
