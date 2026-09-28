# Netlify public demo deployment

The browser app is deployed at <https://newway-hvac-report-demo-2026.netlify.app>. Netlify publishes `dist/netlify/` and proxies `/api/*`, `/session-bootstrap`, and `/report-download/*` to the local Node API through a Cloudflare Quick Tunnel. The API listens on `127.0.0.1:4311` on this Mac. Whisper Base and Ollama `qwen3:4b-instruct` also run locally.

This is a single-operator hackathon demo. Public access to the site shows an operator sign-in form. The API requires a password-derived operator session for report routes, validates the expected frontend origin and tunnel host, and handles audio in a persisted asynchronous queue so Netlify's proxy timeout does not interrupt transcription. Sessions, artifacts, queued audio, and reports remain on this Mac. The frontend does not contain secrets or report data.

## Start and recovery

The user LaunchAgent `com.newway.hvac-public-demo` runs `scripts/public-demo-supervisor.js` through `caffeinate -i`. It starts the Quick Tunnel and API, waits for API readiness, updates Netlify's `NETLIFY_API_ORIGIN`, builds the frontend, and deploys production. It repeats that sequence when either process exits. Ollama runs as the Homebrew service `ollama`. Both start at user login. Keep the Mac awake, logged in, online, and connected to power. Closing a MacBook lid may still suspend it.

The Quick Tunnel hostname changes on restart. The supervisor redeploys Netlify with the new hostname, which creates a brief interruption. Quick Tunnels are intended for testing and have no uptime guarantee. A stable deployment should later use a reserved tunnel hostname or hosted backend.

```sh
launchctl print gui/$(id -u)/com.newway.hvac-public-demo
brew services list | grep ollama
tail -f data/logs/public-demo.log
npm run public-demo:verify
npm run public-demo:verify -- --smoke
```

The local operator credential is stored only in `data/settings/public-demo-operator.txt` with mode 0600. Configuration and session secret are in `data/settings/public-demo.json` with mode 0600. These paths are gitignored. The verification script uses a synthetic WAV and creates a test report in local data.

To reinstall the LaunchAgent after moving the checkout, run `npm run public-demo:install`. To create a fresh configuration in a different checkout, use `npm run public-demo:configure -- <frontend-origin> <site-id> [ollama-model]` once. `npm run build:netlify` requires `NETLIFY_API_ORIGIN` to be an HTTPS origin. The supervisor supplies it and deploys with Netlify CLI credentials already authenticated on this Mac.

## Operational limits

- The user LaunchAgent starts after login, so the API is unavailable while this Mac is shut down, logged out, offline, or asleep.
- This is one operator account and one local file store. It is suitable for a demo, not multi-user production or confidential customer records.
- The Quick Tunnel public hostname is temporary. The supervisor updates the site automatically when it changes, subject to Cloudflare and Netlify availability.
- Back up the `data/` directory for report durability. Do not publish or commit its credentials, report files, or logs.

## References

- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Netlify proxy rewrites](https://docs.netlify.com/manage/routing/redirects/rewrites-proxies/)
