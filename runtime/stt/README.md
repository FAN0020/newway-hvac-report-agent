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

Additional compatible models can be installed from Settings or with:

```sh
npm run stt:install -- small
npm run stt:install -- medium
npm run stt:install -- large-v3
```

The centralized registry also includes `tiny` and `large-v3-turbo`. Every entry pins the official Hugging Face repository revision, expected byte size, SHA-256, and compatible `whisper.cpp` version. The installer writes a unique partial file, checks disk space, validates it before activation, and coalesces concurrent requests for the same model.

On a clean clone, `/api/health` returns `STT_RUNTIME_MISSING` until preparation succeeds. With a managed runtime present, health verifies the binary manifest and the selected model's registry digest. It distinguishes missing, corrupt, incompatible, installing, and ready states and never silently substitutes a different model.

For a same-fixture comparison across all installed models:

```sh
npm run stt:benchmark
```

The command reports audio/transcription duration, real-time factor, success/failure, and the real transcript. It does not invent results for models that are not installed.

All of `runtime/tools/` and generated content under `runtime/stt/` are ignored by Git. A new demo Mac must prepare the runtime before voice transcription; do not commit models or local build tools.
