import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const modulePromise = import('../web/i18n.js').catch(() => null);

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function fakeElement(attributes = {}) {
  const attrs = new Map(Object.entries(attributes));
  return {
    textContent: '',
    placeholder: '',
    title: '',
    getAttribute(name) { return attrs.get(name) ?? null; },
    setAttribute(name, value) { attrs.set(name, String(value)); },
  };
}

function leafKeys(value, prefix = '') {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === 'object' ? leafKeys(child, path) : [path];
  });
}

test('English and Simplified Chinese resources expose representative product domains', async () => {
  const i18n = await modulePromise;
  assert.ok(i18n, 'expected the browser i18n module to exist');
  assert.equal(i18n.resources.en.common.save, 'Save');
  assert.equal(i18n.resources['zh-CN'].common.save, '保存');
  assert.equal(i18n.resources.en.report.generate, 'Generate report');
  assert.equal(i18n.resources['zh-CN'].report.generate, '生成报告');
  assert.equal(i18n.resources.en.agent.missingInformation, 'Missing information');
  assert.equal(i18n.resources['zh-CN'].agent.missingInformation, '缺失信息');
  assert.equal(i18n.resources.en.maintenance.workOrder, 'Work order');
  assert.equal(i18n.resources['zh-CN'].maintenance.workOrder, '工单');
});

test('both locale catalogs cover every major technician workflow surface', async () => {
  const i18n = await modulePromise;
  assert.ok(i18n, 'expected the browser i18n module to exist');
  const requiredKeys = [
    'app.title',
    'language.selectorLabel',
    'scope.selectTitle',
    'auth.title',
    'runtime.title',
    'capture.title',
    'transcript.title',
    'correction.title',
    'questions.title',
    'evidence.title',
    'report.title',
    'confirmation.title',
    'v2.demo.title',
    'v2.upload.title',
    'v2.retrieval.title',
    'v2.facts.title',
    'walkthrough.report.title',
    'status.pendingReview',
    'accessibility.exportedReport',
  ];
  const lookup = (source, key) => key.split('.').reduce((value, part) => value?.[part], source);

  for (const key of requiredKeys) {
    const english = lookup(i18n.resources.en, key);
    const chinese = lookup(i18n.resources['zh-CN'], key);
    assert.equal(typeof english, 'string', `missing English key: ${key}`);
    assert.equal(typeof chinese, 'string', `missing Chinese key: ${key}`);
    assert.notEqual(english.trim(), '', `empty English key: ${key}`);
    assert.notEqual(chinese.trim(), '', `empty Chinese key: ${key}`);
  }
});

test('locale catalogs have exact key parity and cover every static DOM binding', async () => {
  const i18n = await modulePromise;
  assert.ok(i18n, 'expected the browser i18n module to exist');
  const englishKeys = leafKeys(i18n.resources.en).sort();
  const chineseKeys = leafKeys(i18n.resources['zh-CN']).sort();
  assert.deepEqual(chineseKeys, englishKeys);

  const html = await fs.readFile('web/index.html', 'utf8');
  const bindingPattern = /data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g;
  const boundKeys = [...html.matchAll(bindingPattern)].map((match) => match[1]);
  const englishSet = new Set(englishKeys);
  for (const key of boundKeys) assert.ok(englishSet.has(key), `unresolved static translation key: ${key}`);

  const client = await fs.readFile('web/app.js', 'utf8');
  const topLevelDomains = new Set(Object.keys(i18n.resources.en));
  const literalKeyPattern = /['"]([a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)['"]/g;
  const runtimeKeys = [...client.matchAll(literalKeyPattern)]
    .map((match) => match[1])
    .filter((key) => topLevelDomains.has(key.split('.')[0]));
  for (const key of runtimeKeys) assert.ok(englishSet.has(key), `unresolved runtime translation key: ${key}`);
});

test('translator falls back to English and never exposes a missing key', async () => {
  const i18n = await modulePromise;
  assert.ok(i18n, 'expected the browser i18n module to exist');
  const loggerMessages = [];
  const translator = i18n.createI18n({
    locale: 'zh-CN',
    resources: {
      en: { common: { save: 'Save' } },
      'zh-CN': { common: {} },
    },
    logger: { warn: (message) => loggerMessages.push(message) },
  });

  assert.equal(translator.t('common.save'), 'Save');
  assert.equal(translator.t('common.unknown'), 'Unknown');
  assert.deepEqual(translator.getMissingKeys(), ['common.save', 'common.unknown']);
  assert.equal(loggerMessages.length, 2);
});

test('locale changes persist, update document language, and notify current UI subscribers', async () => {
  const i18n = await modulePromise;
  assert.ok(i18n, 'expected the browser i18n module to exist');
  const storage = memoryStorage();
  const documentRef = { documentElement: { lang: 'en' } };
  const translator = i18n.createI18n({ storage, documentRef, locale: 'en' });
  const observed = [];
  translator.subscribe((locale) => observed.push(locale));

  translator.setLocale('zh-CN');

  assert.equal(translator.getLocale(), 'zh-CN');
  assert.equal(storage.getItem(i18n.LOCALE_STORAGE_KEY), 'zh-CN');
  assert.equal(documentRef.documentElement.lang, 'zh-CN');
  assert.deepEqual(observed, ['zh-CN']);
});

test('saved locale is restored while unsupported values safely default to English', async () => {
  const i18n = await modulePromise;
  assert.ok(i18n, 'expected the browser i18n module to exist');
  const saved = i18n.createI18n({ storage: memoryStorage({ [i18n.LOCALE_STORAGE_KEY]: 'zh-CN' }) });
  const unsupported = i18n.createI18n({ storage: memoryStorage({ [i18n.LOCALE_STORAGE_KEY]: 'fr' }) });

  assert.equal(saved.getLocale(), 'zh-CN');
  assert.equal(unsupported.getLocale(), 'en');
});

test('DOM bindings localize visible text, placeholders, titles, and accessible names', async () => {
  const i18n = await modulePromise;
  assert.ok(i18n, 'expected the browser i18n module to exist');
  const text = fakeElement({ 'data-i18n': 'common.save' });
  const placeholder = fakeElement({ 'data-i18n-placeholder': 'auth.passcodePlaceholder' });
  const title = fakeElement({ 'data-i18n-title': 'language.selectorLabel' });
  const aria = fakeElement({ 'data-i18n-aria-label': 'language.selectorLabel' });
  const root = {
    querySelectorAll(selector) {
      return {
        '[data-i18n]': [text],
        '[data-i18n-placeholder]': [placeholder],
        '[data-i18n-title]': [title],
        '[data-i18n-aria-label]': [aria],
      }[selector] || [];
    },
  };
  const translator = i18n.createI18n({ locale: 'zh-CN' });

  translator.translateDom(root);

  assert.equal(text.textContent, '保存');
  assert.equal(placeholder.placeholder, '由演示人员口头提供');
  assert.equal(title.title, '语言');
  assert.equal(aria.getAttribute('aria-label'), '语言');
});

test('interpolation inserts dynamic source data without translating it', async () => {
  const i18n = await modulePromise;
  assert.ok(i18n, 'expected the browser i18n module to exist');
  const translator = i18n.createI18n({ locale: 'zh-CN' });

  assert.equal(
    translator.t('scope.current', { scope: 'SBS·Rail' }),
    '当前工作范围：SBS·Rail',
  );
});
