#!/bin/sh
# Builds native/bin/copilot-audio-tap: a universal (arm64 + x86_64) macOS
# binary that records the system audio output. Needs Xcode or the Command Line
# Tools with the macOS 14.2+ SDK. Run automatically by `npm run dist:mac*` and,
# on a Mac, by `npm start` when the binary is missing.
set -e
cd "$(dirname "$0")"
mkdir -p ../bin .build
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12.0" -o ".build/copilot-audio-tap-$arch" AudioTap.swift
done
lipo -create -output ../bin/copilot-audio-tap .build/copilot-audio-tap-arm64 .build/copilot-audio-tap-x86_64
# Ad-hoc sign, so Apple silicon runs it and electron-builder can re-sign it.
codesign --force --sign - ../bin/copilot-audio-tap
echo "built native/bin/copilot-audio-tap"
