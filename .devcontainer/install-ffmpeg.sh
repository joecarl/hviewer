#!/bin/bash
set -e

# This script is intended for development environments (DevContainer).
# Production installation is handled directly in the Dockerfile.

FF_BIN=/usr/local/bin/ffmpeg
FF_PROBE=/usr/local/bin/ffprobe

if command -v ffmpeg &>/dev/null; then
	echo "ffmpeg already available: $(ffmpeg -version 2>&1 | head -1)"
	exit 0
fi

echo "Downloading ffmpeg static binary..."

ARCH=$(uname -m)
if [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
	FF_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz"
else
	FF_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

wget -q "$FF_URL" -O "$TMP_DIR/ffmpeg.tar.xz"
tar -xf "$TMP_DIR/ffmpeg.tar.xz" -C "$TMP_DIR" --strip-components=1

sudo install -m 0755 "$TMP_DIR/ffmpeg"  "$FF_BIN"
sudo install -m 0755 "$TMP_DIR/ffprobe" "$FF_PROBE"

echo "Installed: $(ffmpeg -version 2>&1 | head -1)"
