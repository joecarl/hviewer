# hViewer

Online video player that streams any video file over HLS with multi-audio track and subtitle support.

## How it works

- The backend scans a configurable folder for video files and transcodes them on demand using **FFmpeg** into HLS segments.
- The frontend (Chispa + HLS.js) presents a video list and a player with audio track and subtitle selectors.

## Quick start with Docker

```bash
cp docker-compose.example.yml docker-compose.yml
# Edit docker-compose.yml — set the path to your video folder
docker compose up -d
```

Then open `http://localhost:8945`.

## Environment variables

| Variable       | Default   | Description                                         |
| -------------- | --------- | --------------------------------------------------- |
| `VIDEO_PATH`   | `/videos` | Folder containing video files (scanned recursively) |
| `PORT`         | `8945`    | Port the backend listens on                         |
| `FFMPEG_PATH`  | `ffmpeg`  | Path to the ffmpeg binary                           |
| `FFPROBE_PATH` | `ffprobe` | Path to the ffprobe binary                          |
| `TRANSCODE_MAX_HEIGHT` | `1080` | Cap on output height when re-encoding (`0` = keep source resolution) |
| `TRANSCODE_PRESET` | `veryfast` | x264 preset used when re-encoding |

## Codec handling

H.264 is streamed as-is. HEVC is only copied when the browser reports that it can
decode it (`MediaSource.isTypeSupported`) — Safari can, Firefox generally cannot,
and Chrome only can where the machine has a hardware decoder — otherwise the
backend re-encodes to H.264 on the fly. Anything else is re-encoded too, as are
10-bit H.264 and 10-bit HEVC on clients without Main 10 support. The player's
info bar (ⓘ) shows which path a file took for the browser you are using.

## Supported formats

`mp4`, `mkv`, `avi`, `mov`, `wmv`, `flv`, `webm`, `m4v`, `ts`, `m2ts`, `mpg`, `mpeg`, `ogv`, `3gp`

## Development

```bash
# Open in VS Code with the Dev Containers extension — reopen in container when prompted

# Backend (port 8945)
cd backend && npm run dev

# Frontend (port 5173, separate terminal)
cd frontend && npm run dev
```

## Build docker image locally

```bash
docker build -t hviewer .
```
