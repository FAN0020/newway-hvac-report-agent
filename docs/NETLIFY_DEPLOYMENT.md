# Netlify deployment

The browser entry point is already `web/index.html`. Netlify publishes the generated `dist/netlify/` directory; `npm run build:netlify` copies the browser assets and creates proxy rewrites for `/api/*`, `/session-bootstrap`, and `/report-download/*`.

## Required backend

This is a frontend build, not a serverless conversion of the Node application. A working deployment requires a separate, publicly reachable **HTTPS API** that implements the existing route and response contracts. Set its origin as `NETLIFY_API_ORIGIN` (for example, `https://api.example.com`). The build fails when the variable is absent or is an insecure/local URL so a broken frontend is not published by mistake.

**Do not expose `npm start` or `npm run demo` as that API.** The current server grants local session tokens only to loopback callers, uses a temporary shared token in demo mode, stores report authority in local files, and invokes local Whisper and optional Ollama runtimes. It has no production identity or authorization. Pointing Netlify's proxy at this server would either fail or weaken its security boundary.

Before using this frontend with real reports, the API deployment must provide:

1. Production user authentication and authorization, including verified technician identity. Preserve the current report confirmation and evidence contracts.
2. Durable transactional report/session storage and persistent artifact storage across processes and restarts. The current file store only serializes writes within one process.
3. Production speech/model services or an intentionally supported manual-input path. Long operations need an asynchronous job flow because Netlify proxy rewrites time out after 26 seconds. Netlify Functions are not a drop-in replacement for the existing 20 MB upload routes: buffered functions have a 6 MB request/response limit, with a lower effective limit for binary requests.
4. HTTPS, request limits, operational monitoring, backup and recovery, and a tested deployment migration.

## Build and connect the site

Once that API is available:

```sh
NETLIFY_API_ORIGIN=https://api.example.com npm run build:netlify
```

Check that `dist/netlify/index.html` and `dist/netlify/_redirects` exist. The build copies only `web/`, so server code and `data/` are not part of the site artifact.

In Netlify, choose **Add new project → Import an existing project**, select this repository and its `main` branch, set `NETLIFY_API_ORIGIN` for builds, then deploy. The root `netlify.toml` provides the build command and publish directory. Git-connected Netlify sites build and deploy after commits are pushed. Do not treat a successful static build as proof that the API, authentication, uploads, transcription, report confirmation, export, or persistence work in the deployed environment; run those flows against the actual site before giving it to users.

## References

- [Netlify build and publish directories](https://docs.netlify.com/build/configure-builds/overview/)
- [Netlify proxy rewrites and 26-second timeout](https://docs.netlify.com/manage/routing/redirects/rewrites-proxies/)
- [Netlify Functions limits](https://docs.netlify.com/build/functions/configuration/)
- [Deploy from a repository](https://docs.netlify.com/start/quickstarts/deploy-from-repository/)
