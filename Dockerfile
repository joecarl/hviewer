# ────────────────────────────────────────────────────────────────────────────
# Stage 1: Build Frontend
# ────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS frontend-builder

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm install

COPY frontend/ ./
COPY app-manifest.json ../
RUN npm run build

# ────────────────────────────────────────────────────────────────────────────
# Stage 2: Build Backend
# ────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS backend-builder

WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm install

COPY backend/ ./
COPY app-manifest.json ../
RUN npm run build

# ────────────────────────────────────────────────────────────────────────────
# Stage 3: FFmpeg static binary (separate stage to keep layers clean)
# ────────────────────────────────────────────────────────────────────────────
FROM alpine:3.19 AS ffmpeg-downloader

RUN apk add --no-cache wget xz

RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then \
        FF_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz"; \
    else \
        FF_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"; \
    fi && \
    wget -v "$FF_URL" -O /tmp/ffmpeg.tar.xz && \
    mkdir /tmp/ff && \
    tar -xf /tmp/ffmpeg.tar.xz -C /tmp/ff --strip-components=1 && \
    install -m 0755 /tmp/ff/ffmpeg  /usr/local/bin/ffmpeg && \
    install -m 0755 /tmp/ff/ffprobe /usr/local/bin/ffprobe

# ────────────────────────────────────────────────────────────────────────────
# Stage 4: Production image
# ────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine

WORKDIR /app

# Copy ffmpeg/ffprobe from downloader stage
COPY --from=ffmpeg-downloader /usr/local/bin/ffmpeg  /usr/local/bin/ffmpeg
COPY --from=ffmpeg-downloader /usr/local/bin/ffprobe /usr/local/bin/ffprobe

# Install only production backend deps (no native addons needed anymore)
COPY backend/package*.json ./backend/
RUN cd backend && npm install --omit=dev

# Copy build artefacts
COPY --from=backend-builder  /app/backend/dist     ./backend/dist
COPY --from=frontend-builder /app/frontend/dist    ./backend/public
COPY app-manifest.json ./

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Directory where videos are mounted
VOLUME /videos

# Optional: directory for HLS temp sessions (can also use /tmp)
VOLUME /tmp/hviewer-hls

ENV PORT=8945
ENV NODE_ENV=production
ENV VIDEO_PATH=/videos

USER node

EXPOSE 8945

ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "backend/dist/index.js"]
