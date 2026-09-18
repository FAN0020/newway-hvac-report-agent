# Local Whisper runtime

Git intentionally contains no Whisper binary, model, source archive, portable build tool, or generated manifest.

On macOS, run from the repository root:

```sh
TMPDIR="$PWD/.tmp" npm_config_cache="$PWD/.cache/npm" npm run stt:prepare
npm run stt:smoke
```

`stt:prepare` keeps every artifact inside this repository. It:

1. downloads official portable CMake 3.31.10 into `runtime/tools/` and verifies the SHA-256 published in Kitware's official checksum file;
2. downloads the official fixed `whisper.cpp` `b4938` source archive, verifies the recorded archive SHA-256, and builds a CPU/Accelerate `whisper-cli` with project-local CMake;
3. downloads the multilingual Base model and requires SHA-256 `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`;
4. atomically installs the binary, model, upstream MIT license, and a provenance/integrity manifest under `runtime/stt/<platform>-<arch>/`.

Failed or mismatched downloads remain incomplete `.part-*` files only while the process is running and are removed on failure. An existing runtime is replaced only after a complete new staged runtime passes its checks.

`stt:smoke` uses the official pinned `samples/jfk.wav`, verifies that sample's checksum, runs the application's real `WhisperProvider`, checks its JSON result, and removes smoke-test output. It is an English runtime test, not a Chinese HVAC accuracy claim.

On a clean clone, `/api/health` returns `STT_RUNTIME_MISSING` until preparation succeeds. With a managed runtime present, health recomputes the binary and model SHA-256 values and returns `STT_INTEGRITY_FAILED` if they do not match `manifest.json`.

All of `runtime/tools/` and generated content under `runtime/stt/` are ignored by Git. A new demo Mac must run the two commands above before voice transcription; do not commit the approximately 148 MB model or local build tools.
