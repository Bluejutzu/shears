# Shears

A fast, lightweight video cutter for Windows. Open a clip in a second, cut out what you don't need and export it, without waiting for a full editor to start up.

- Split, trim and remove parts with the usual shortcuts, mark a range and keep only that
- Fast lossless export that just copies the video, or re-encode with GPU encoders, a size limit or a lower resolution
- Several audio tracks with volume, mute and solo, plus added audio files
- Image overlays, metadata editing (title, date, location, device) and a media pool of watched folders
- Two themes: the default Shears look and Material 3

## Install

Download `Shears_x.y.z_x64-setup.exe` from the [latest release](https://github.com/Bluejutzu/shears/releases/latest). Shears checks for updates on startup and installs them when you say so.

Shears needs [ffmpeg](https://ffmpeg.org) for exporting:

```
winget install Gyan.FFmpeg
```

## Develop

You need [Bun](https://bun.sh), [Rust](https://rustup.rs) and ffmpeg.

```
bun install
bun run tauri dev
```

`bun run tauri build` makes an installer in `src-tauri/target/release/bundle/nsis`. Local builds are **Shears Dev**: they install next to the public Shears, keep their own settings and history, show a DEV badge and never update themselves.

Checks that CI runs:

```
bun run fmt:check
bun run build
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

The export tests run against real clips when `SHEARS_TEST_DIR` points at a folder with `test-clip.mp4`, `obs-style.mkv` and `beep.mp3`.

## Release

1. `bun run bump patch` (or `minor`, `major`, `1.2.3`) sets the version everywhere.
2. Commit, tag and push: `git commit -am "release v1.2.3" && git tag v1.2.3 && git push && git push --tags`.
3. The Release workflow builds the public **Shears** installer and the signed update files into a draft release. Fill in the notes and publish it; installed copies pick it up on their next start.

Updates are signed. The workflow needs two repository secrets: `TAURI_SIGNING_PRIVATE_KEY` (the contents of the private key) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The matching public key is in `src-tauri/tauri.conf.json`. Losing the private key means existing installs can't verify new updates, so keep a backup.

To build the public version locally, set those two variables and run `bun run build:release`.
