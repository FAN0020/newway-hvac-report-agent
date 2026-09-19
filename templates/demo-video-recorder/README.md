# Reusable Product Demo Video Template

This folder contains a reusable Playwright-based template for generating narrated product demo videos.

It was extracted from the ServiceScribe hackathon workflow so the same recording approach can be reused for other products, agents, dashboards, or prototypes.

## What it automates

The template can:

1. open a local web application;
2. operate the UI with Playwright;
3. record the browser automatically;
4. generate separate narrator / user voice tracks with macOS `say`;
5. measure the real duration of each narration track;
6. record the real timestamp at which every demo stage begins;
7. keep each visual stage on-screen until its narration is finished;
8. align all narration automatically with `ffmpeg`;
9. export a final H.264/AAC MP4;
10. save a JSON timeline for debugging or manual fine-tuning.

## Requirements

- Node.js
- Playwright
- Chromium for Playwright
- macOS `say`
- `ffmpeg` and `ffprobe`

Install Playwright:

```bash
npm install --no-save playwright
npx playwright install chromium
```

Install ffmpeg with Homebrew if needed:

```bash
brew install ffmpeg
```

## Use it in another project

Copy:

```text
record-demo-template.mjs
```

into the target project.

Normally you only edit two areas.

### 1. CONFIG

Change:

- `appUrl`
- output name
- narration
- overlay text
- step names
- voices / speaking rates

Example:

```js
const CONFIG = {
  appUrl: 'http://127.0.0.1:3000/',
  outputPrefix: 'my-product-demo',
  steps: [
    {
      id: 'intro',
      role: 'narrator',
      overlayTitle: 'My Product',
      overlayBody: 'What the product does.',
      narration: 'Welcome to the product demo...',
    },
  ],
};
```

### 2. ACTIONS

Add the real UI workflow for each step.

Example:

```js
const ACTIONS = {
  async input({ page }) {
    await page.fill('#prompt', 'Synthetic test input');
  },

  async process({ page }) {
    await page.click('#run');
    await page.waitForSelector('#result', { state: 'visible' });
  },

  async review({ page }) {
    await page.click('#approve');
  },
};
```

The generic recording, timing, narration alignment, ffmpeg export, and timeline logic should normally remain unchanged.

## Run

Keep the target local application running, then:

```bash
node record-demo-template.mjs
```

Outputs:

```text
<output-prefix>-raw.webm
<output-prefix>.mp4
<output-prefix>-timeline.json
```

## Recommended demo structure

For product demos, a useful default sequence is:

```text
Introduction
→ User input / scenario
→ System processing
→ AI / automation result
→ Human review or validation
→ Final output
```

For an agent workflow, a stronger version is:

```text
User action
→ Agent interprets
→ Agent uses tools / data
→ Intermediate evidence appears
→ Agent produces result
→ Validator / human confirms
```

## Design principle

Do not make the video a slideshow of finished results.

Prefer showing the real interaction:

```text
user acts
→ system responds
→ intermediate state appears
→ next action happens
```

Narration should explain *why each step exists*, while the screen shows *what the system is actually doing*.

## Security notes

The template does not require a real browser profile and should not be configured to load your personal Chrome profile, cookies, passwords, or saved sessions.

For coursework demos:

- use synthetic or anonymised test data;
- keep the target application on localhost when possible;
- avoid putting API keys or secrets in narration/config;
- do not commit generated videos, temporary browser data, or voice scratch files unless intentionally needed.

## Origin

This template was generalized from the automated ServiceScribe demo recorder used in the Newway HVAC Report Agent hackathon MVP.
