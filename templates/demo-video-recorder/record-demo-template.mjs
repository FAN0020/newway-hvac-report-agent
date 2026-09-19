import { chromium } from 'playwright';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Generic Product Demo Video Recorder
 *
 * What this template does:
 * 1. Opens a local web app with Playwright.
 * 2. Records the browser.
 * 3. Generates English narration with macOS `say`.
 * 4. Records the real timestamp of each demo stage.
 * 5. Keeps each visual stage on-screen until its narration finishes.
 * 6. Uses ffmpeg to align narration automatically and export MP4.
 *
 * Requirements:
 *   npm install --no-save playwright
 *   npx playwright install chromium
 *   ffmpeg / ffprobe available on PATH
 *   macOS `say` command
 *
 * Copy this file into another project and edit only the CONFIG section and
 * the per-step actions below.
 */

// ============================================================
// CONFIG — EDIT THIS SECTION FOR EACH PRODUCT
// ============================================================

const CONFIG = {
  appUrl: 'http://127.0.0.1:3000/',
  outputPrefix: 'product-demo',
  viewport: { width: 1440, height: 900 },

  voices: {
    narrator: { name: 'Samantha', rate: 165 },
    actor: { name: 'Daniel', rate: 175 },
  },

  steps: [
    {
      id: 'intro',
      role: 'narrator',
      overlayTitle: 'Product Name',
      overlayBody: 'One-sentence description of the product.',
      narration:
        'Welcome to our product demo. This short walkthrough shows the complete user workflow.',
    },
    {
      id: 'input',
      role: 'actor',
      overlayTitle: '01 · Input',
      overlayBody: 'Show what the user provides to the system.',
      narration:
        'This is the example user input used for the demonstration.',
    },
    {
      id: 'process',
      role: 'narrator',
      overlayTitle: '02 · Process',
      overlayBody: 'Explain what the system does next.',
      narration:
        'The system now processes the input and prepares a structured result.',
    },
    {
      id: 'review',
      role: 'narrator',
      overlayTitle: '03 · Review',
      overlayBody: 'Show human review, validation, or approval.',
      narration:
        'The user reviews the result before it can be finalized.',
    },
    {
      id: 'ending',
      role: 'narrator',
      overlayTitle: 'Workflow Complete',
      overlayBody: 'Summarize the final outcome.',
      narration:
        'The workflow is complete and the final output is ready.',
    },
  ],
};

// ============================================================
// PROJECT-SPECIFIC ACTIONS — EDIT THESE
// ============================================================

/**
 * Put the real Playwright actions for each stage here.
 *
 * Examples:
 *   await page.fill('#prompt', 'demo input');
 *   await page.click('#submit');
 *   await page.waitForSelector('#result', { state: 'visible' });
 *   await page.locator('#result').scrollIntoViewIfNeeded();
 *
 * Keep the step ids synchronized with CONFIG.steps.
 */
const ACTIONS = {
  async intro({ page, pause }) {
    await page.waitForTimeout(1000);
  },

  async input({ page, pause }) {
    // Example:
    // await page.locator('#input').scrollIntoViewIfNeeded();
    // await page.fill('#input', 'Synthetic demo input');
    await pause(1000);
  },

  async process({ page, pause }) {
    // Example:
    // await page.click('#run');
    // await page.waitForSelector('#result', { state: 'visible', timeout: 60000 });
    await pause(1000);
  },

  async review({ page, pause }) {
    // Example:
    // await page.click('#approve');
    await pause(1000);
  },

  async ending({ page, pause }) {
    await pause(1000);
  },
};

// ============================================================
// GENERIC ENGINE — NORMALLY DO NOT EDIT BELOW THIS LINE
// ============================================================

const ROOT = process.cwd();
const VOICE_DIR = path.join(ROOT, '.demo-voice');
const VIDEO_TEMP_DIR = path.join(ROOT, '.demo-video-temp');
const RAW_VIDEO = path.join(ROOT, `${CONFIG.outputPrefix}-raw.webm`);
const FINAL_VIDEO = path.join(ROOT, `${CONFIG.outputPrefix}.mp4`);
const TIMELINE_FILE = path.join(ROOT, `${CONFIG.outputPrefix}-timeline.json`);

fs.mkdirSync(VOICE_DIR, { recursive: true });
fs.mkdirSync(VIDEO_TEMP_DIR, { recursive: true });

function requireCommand(name) {
  const result = spawnSync('which', [name], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${name} is required but was not found.`);
}

for (const command of ['ffmpeg', 'ffprobe', 'say']) requireCommand(command);

function audioDuration(file) {
  const result = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      file,
    ],
    { encoding: 'utf8' },
  );
  return Number(result.trim()) * 1000;
}

console.log('\nGenerating narration...');

for (const step of CONFIG.steps) {
  const voice = CONFIG.voices[step.role] || CONFIG.voices.narrator;
  const file = path.join(VOICE_DIR, `${step.id}.aiff`);

  execFileSync(
    'say',
    ['-v', voice.name, '-r', String(voice.rate), '-o', file, step.narration],
    { stdio: 'inherit' },
  );

  step.audioPath = file;
  step.audioDurationMs = audioDuration(file);
  console.log(`  ✓ ${step.id}: ${(step.audioDurationMs / 1000).toFixed(1)}s`);
}

const browser = await chromium.launch({ headless: true });

const context = await browser.newContext({
  viewport: CONFIG.viewport,
  recordVideo: {
    dir: VIDEO_TEMP_DIR,
    size: CONFIG.viewport,
  },
});

const page = await context.newPage();
const startedAt = Date.now();
const timeline = {};
const pause = (ms) => page.waitForTimeout(ms);

function nowMs() {
  return Date.now() - startedAt;
}

async function overlay(title, body, type = 'normal') {
  await page.evaluate(
    ({ title, body, type }) => {
      document.getElementById('__demo_overlay__')?.remove();

      const box = document.createElement('div');
      box.id = '__demo_overlay__';

      Object.assign(box.style, {
        position: 'fixed',
        right: '32px',
        top: '32px',
        width: '420px',
        padding: '20px 22px',
        zIndex: '999999',
        borderRadius: '16px',
        background:
          type === 'success'
            ? 'rgba(237,248,240,.97)'
            : 'rgba(255,255,255,.97)',
        border:
          type === 'success'
            ? '1px solid #abd8b6'
            : '1px solid #d8dee8',
        boxShadow: '0 14px 42px rgba(20,30,50,.18)',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif',
        color: '#182033',
      });

      const heading = document.createElement('div');
      heading.textContent = title;
      Object.assign(heading.style, {
        fontWeight: '800',
        fontSize: '18px',
        marginBottom: '8px',
      });

      const content = document.createElement('div');
      content.textContent = body;
      Object.assign(content.style, {
        fontSize: '14px',
        lineHeight: '1.55',
        color: '#596579',
      });

      box.append(heading, content);
      document.body.appendChild(box);
    },
    { title, body, type },
  );
}

async function removeOverlay() {
  await page.evaluate(() => document.getElementById('__demo_overlay__')?.remove());
}

async function waitForNarration(step, extraMs = 500) {
  const elapsed = nowMs() - timeline[step.id];
  const required = step.audioDurationMs + extraMs;
  if (elapsed < required) await pause(required - elapsed);
}

console.log(`\nOpening ${CONFIG.appUrl}`);
await page.goto(CONFIG.appUrl, {
  waitUntil: 'networkidle',
  timeout: 30000,
});

for (const step of CONFIG.steps) {
  console.log(`▶ ${step.id}`);

  timeline[step.id] = nowMs();
  console.log(`   narration @ ${(timeline[step.id] / 1000).toFixed(1)}s`);

  await overlay(
    step.overlayTitle,
    step.overlayBody,
    step.id === 'ending' ? 'success' : 'normal',
  );

  const action = ACTIONS[step.id];
  if (!action) throw new Error(`No ACTIONS handler defined for step: ${step.id}`);

  await action({ page, pause, step, CONFIG });
  await waitForNarration(step);
  await removeOverlay();
}

await pause(700);

const video = page.video();
await context.close();
const recordedPath = await video.path();
fs.copyFileSync(recordedPath, RAW_VIDEO);
await browser.close();

fs.writeFileSync(
  TIMELINE_FILE,
  JSON.stringify(
    {
      app_url: CONFIG.appUrl,
      timeline_ms: timeline,
      narration_durations_ms: Object.fromEntries(
        CONFIG.steps.map((step) => [step.id, Math.round(step.audioDurationMs)]),
      ),
    },
    null,
    2,
  ),
);

const filters = [];

CONFIG.steps.forEach((step, index) => {
  const input = index + 1;
  const delay = Math.max(0, Math.round(timeline[step.id]));
  filters.push(`[${input}:a]adelay=${delay}:all=1[a${index}]`);
});

const mixInputs = CONFIG.steps.map((_, index) => `[a${index}]`).join('');
filters.push(
  `${mixInputs}amix=inputs=${CONFIG.steps.length}:normalize=0[aout]`,
);

const ffmpegArgs = ['-y', '-i', RAW_VIDEO];

for (const step of CONFIG.steps) {
  ffmpegArgs.push('-i', step.audioPath);
}

ffmpegArgs.push(
  '-filter_complex',
  filters.join(';'),
  '-map',
  '0:v:0',
  '-map',
  '[aout]',
  '-c:v',
  'libx264',
  '-preset',
  'medium',
  '-crf',
  '20',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-b:a',
  '192k',
  '-movflags',
  '+faststart',
  FINAL_VIDEO,
);

console.log('\nAligning narration and exporting MP4...');

const ffmpeg = spawnSync('ffmpeg', ffmpegArgs, { stdio: 'inherit' });

if (ffmpeg.status !== 0) {
  throw new Error(`FFmpeg failed with exit code ${ffmpeg.status}`);
}

console.log('\n====================================');
console.log('✅ DEMO VIDEO COMPLETE');
console.log('====================================');
console.log(`Video:    ${FINAL_VIDEO}`);
console.log(`Timeline: ${TIMELINE_FILE}`);
