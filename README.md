# ditch

[中文版](README.zh-TW.md)

A live-stream downloader that runs as a web server: paste a page URL, the server uses a headless browser to detect downloadable streams/media items on the page, and once you pick one, the server fetches it and saves it to local disk. A single-user, self-hosted tool with no account system.

## Features

- **Detection**: Spins up a headless browser (Playwright) for any page URL and finds HLS (`.m3u8`) manifests, DASH (`.mpd`) manifests, or direct audio/video files that appear while the page loads, streaming them as a candidate list in real time (SSE). DRM-protected items are flagged but cannot be downloaded.
- **Download**: Pure JS/Node implementation, no ffmpeg involved. Automatically parses manifest segments, handles AES-128 decryption and fMP4 init segments, downloads segments sequentially and stitches them into a single file, with real-time progress reporting.
- **Transcode (optional)**: When enabled in Settings, every download is re-encoded to AV1/MKV (`ffmpeg` + `libsvtav1`) after it finishes downloading, replacing whatever format the source used — audio is copied through untouched. Off by default; requires `ffmpeg` in the runtime image. Runs on its own separate concurrency limit from downloads, since it's a CPU-bound step rather than a network one, and can be cancelled mid-encode. See [`docs/adr/0012`](docs/adr/0012-ffmpeg-transcode-to-mkv-av1.md) and [`docs/adr/0013`](docs/adr/0013-separate-transcode-concurrency-limit.md).
- **Two-phase landing**: Downloads are first written to a local cache (an SSD is recommended), then moved as a whole to the final destination (which can be a high-latency mount like NFS) once complete — avoiding I/O against a slow mount for the entire duration of the download. See [`docs/adr/0005`](docs/adr/0005-ssd-cache-before-nfs-destination.md) for details.
- **Filename suggestion**: Each detected candidate's filename box is pre-filled from the page title, with the usual boilerplate suffix (`… - Channel - YouTube`) stripped off and an optional character cap applied (Settings, default 80). It's only a suggestion — edit it freely. See [`docs/adr/0014`](docs/adr/0014-suggested-filename-cleanup-and-length.md).
- **Collision protection**: The destination directory is a flat structure, and the filename is whatever you typed; if a file with the same name already exists at the destination, the download is blocked beforehand so you can choose to overwrite or cancel — it never silently renames or overwrites. An over-long name is trimmed to stay within the filesystem's limit.
- **Anti-detection**: Both detection and download apply basic anti-bot measures (overriding `navigator.webdriver`, using a standard desktop Chrome UA); when a CDN blocks the Node-side fetch, it falls back to refetching through the same already-verified browser context.

## Quick Start (Docker)

### Using the prebuilt image

No need to clone the repo — a `docker-compose.yml` referencing the published image is enough:

```yaml
services:
  ditch:
    image: ghcr.io/vup4m3/ditch:latest
    user: "${PUID:-1000}:${PGID:-1000}"
    ports:
      - "3000:3000"
    volumes:
      - ./cache:/data/cache
      - ./downloads:/data/downloads
      - ./data:/data/db
    restart: unless-stopped
```

```bash
docker compose up -d
```

### Building from source

```bash
git clone git@github.com:vup4m3/ditch.git
cd ditch
docker compose build
docker compose up -d
```

Open `http://localhost:3000` and paste a page URL to get started.

The default `docker-compose.yml` (and the snippet above) binds `cache`, `downloads`, and `data` to local paths under the project directory. For an actual deployment, point `downloads` at your real final destination (which can be an NFS mount), and keep `cache` on a local SSD.

### Configuring the container's UID/GID

The container runs as `1000:1000` by default (non-root — Playwright's sandbox requires non-root to take effect), so files it writes will be owned by that UID/GID. If the bind-mounted host directory (especially `DOWNLOADS_DIR` on NFS) belongs to a different user, create a `.env` file next to your `docker-compose.yml` beforehand to specify:

```bash
echo "PUID=$(id -u)" >> .env
echo "PGID=$(id -g)" >> .env
```

And make sure the `cache`, `downloads`, and `data` host directories are themselves writable by that UID/GID (the container will not `chown` automatically — `downloads` in particular often points to NFS, where a recursive chown over a media library would be slow and unnecessary). See [`docs/adr/0006`](docs/adr/0006-configurable-uid-gid-via-run-as-user.md) for details.

## Environment Variables

Besides the in-container environment variables below, `docker-compose.yml` also reads `PUID`/`PGID` (see the previous section) to decide which identity the container runs as — these two are not environment variables consumed by the Node process; they're purely used by the compose file to build the `user:` field.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `CACHE_DIR` | `./cache` | Staging location during download; an SSD is recommended |
| `DOWNLOADS_DIR` | `./downloads` | Final storage location once complete; can be a network mount like NFS |
| `DB_PATH` | `./data/ditch.sqlite` | Path to the SQLite file used for job records |

## Local Development

Requires Node.js ≥ 24 (for native `node:sqlite` support).

```bash
npm install
npm run dev         # start the dev server with node --watch
npm run typecheck   # tsc --noEmit
npm test            # node:test, runs all *.test.ts under src
npm run build       # compile to dist/, used by npm start
```

## Architecture Overview

1. `POST /api/detections` starts a Detection Session (loading the page in a headless browser) and pushes found Candidates in real time via SSE.
2. `POST /api/downloads` creates a Download Job from the selected Candidate: parses manifest segments → writes to `CACHE_DIR` → (if Transcode is enabled) re-encodes to AV1/MKV → moves to `DOWNLOADS_DIR` → marks it complete. Job status (`pending` → `downloading` → [`transcodeQueued` → `transcoding` →] `moving` → `completed`/`failed`) and progress are persisted in SQLite and pushed to the frontend in real time via SSE.
3. `GET /api/downloads/:id/file` serves the completed file for download.

The project's domain vocabulary (Candidate / Detection Session / Download Job) is defined in [`CONTEXT.md`](CONTEXT.md); key architecture decisions are recorded in [`docs/adr/`](docs/adr/).

## Notes

This tool has no authentication, and `docker-compose.yml` binds the port to `0.0.0.0` by default (reachable from anywhere on the LAN). It's designed for self-use in a trusted LAN environment only — **do not** expose it directly to the public internet; if you need to offer it externally, add your own authentication or reverse proxy.

## License

MIT
