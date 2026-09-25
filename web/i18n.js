import en from './locales/en.js';
import zhCN from './locales/zh-CN.js';
import developerOverrides from './locales/overrides.js';

export const LOCALE_STORAGE_KEY = 'newway_ui_locale';
export const DEFAULT_LOCALE = 'en';
export const SUPPORTED_LOCALES = Object.freeze(['en', 'zh-CN']);

export const baseResources = Object.freeze({ en, 'zh-CN': zhCN });

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeCatalog(base, overrides) {
  const result = {};
  for (const key of new Set([...Object.keys(base || {}), ...Object.keys(overrides || {})])) {
    const baseValue = base?.[key];
    const overrideValue = overrides?.[key];
    if (isRecord(baseValue) || isRecord(overrideValue)) {
      result[key] = mergeCatalog(isRecord(baseValue) ? baseValue : {}, isRecord(overrideValue) ? overrideValue : {});
    } else {
      result[key] = overrideValue === undefined ? baseValue : overrideValue;
    }
  }
  return result;
}

export function applyResourceOverrides(sourceResources, overrides = {}) {
  return Object.freeze(Object.fromEntries(SUPPORTED_LOCALES.map((locale) => [
    locale,
    mergeCatalog(sourceResources?.[locale] || {}, overrides?.[locale] || {}),
  ])));
}

export const resources = applyResourceOverrides(baseResources, developerOverrides);

function readPath(source, key) {
  return key.split('.').reduce((value, segment) => value?.[segment], source);
}

function humanizeKey(key) {
  const tail = String(key).split('.').at(-1) || 'message';
  const words = tail
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Message';
}

function interpolate(message, variables = {}) {
  return String(message).replace(/\{([^{}]+)\}/g, (match, name) => (
    Object.hasOwn(variables, name) ? String(variables[name]) : match
  ));
}

function browserStorage() {
  return globalThis.window?.localStorage || null;
}

function browserDocument() {
  return globalThis.window?.document || null;
}

export function createI18n(options = {}) {
  const catalog = options.overrides
    ? applyResourceOverrides(options.resources || resources, options.overrides)
    : (options.resources || resources);
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const documentRef = options.documentRef === undefined ? browserDocument() : options.documentRef;
  const logger = options.logger || console;
  const savedLocale = storage?.getItem?.(LOCALE_STORAGE_KEY);
  let locale = SUPPORTED_LOCALES.includes(options.locale)
    ? options.locale
    : (SUPPORTED_LOCALES.includes(savedLocale) ? savedLocale : DEFAULT_LOCALE);
  const missingKeys = new Set();
  const listeners = new Set();

  function markMissing(key) {
    if (missingKeys.has(key)) return;
    missingKeys.add(key);
    logger?.warn?.(`[i18n] Missing ${locale} translation for "${key}"; using a safe fallback.`);
  }

  function t(key, variables) {
    let value = readPath(catalog[locale], key);
    if (typeof value !== 'string') {
      markMissing(key);
      value = readPath(catalog[DEFAULT_LOCALE], key);
    }
    if (typeof value !== 'string') value = humanizeKey(key);
    return interpolate(value, variables);
  }

  function translateDom(root = documentRef) {
    if (!root?.querySelectorAll) return;
    for (const item of root.querySelectorAll('[data-i18n]')) {
      item.textContent = t(item.getAttribute('data-i18n'));
    }
    for (const item of root.querySelectorAll('[data-i18n-placeholder]')) {
      item.placeholder = t(item.getAttribute('data-i18n-placeholder'));
    }
    for (const item of root.querySelectorAll('[data-i18n-title]')) {
      item.title = t(item.getAttribute('data-i18n-title'));
    }
    for (const item of root.querySelectorAll('[data-i18n-aria-label]')) {
      item.setAttribute('aria-label', t(item.getAttribute('data-i18n-aria-label')));
    }
  }

  function setLocale(nextLocale) {
    locale = SUPPORTED_LOCALES.includes(nextLocale) ? nextLocale : DEFAULT_LOCALE;
    storage?.setItem?.(LOCALE_STORAGE_KEY, locale);
    if (documentRef?.documentElement) documentRef.documentElement.lang = locale;
    translateDom(documentRef);
    for (const listener of listeners) listener(locale);
    return locale;
  }

  if (documentRef?.documentElement) documentRef.documentElement.lang = locale;

  return {
    t,
    setLocale,
    getLocale: () => locale,
    getMissingKeys: () => [...missingKeys],
    translateDom,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const i18n = createI18n();
export const t = (...args) => i18n.t(...args);
