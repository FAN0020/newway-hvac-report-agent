# Interface localization developer guide

The English/Simplified Chinese structure is part of the application, not a branch-only development setting. After this feature branch is merged, the normal server entry point serves the locale modules and `web/app.js` initializes them automatically. Restart the server after merging, then reload the browser.

## Change project terminology or existing text

Keep reusable base translations in `web/locales/en.js` and `web/locales/zh-CN.js`. Put installation- or project-specific wording in `web/locales/overrides.js`. Overrides are deep-merged without modifying the base catalogs, so a developer can change one label without copying its whole section.

```js
export default {
  en: {
    capture: { start: 'Begin recording' },
    fieldLabels: { assetBusModel: 'Fleet model' },
  },
  'zh-CN': {
    capture: { start: '开始录制' },
    fieldLabels: { assetBusModel: '车队车型' },
  },
};
```

This example changes an existing button and a displayed field term. Canonical backend fields such as `asset.bus_model`, API values, hashes, IDs, user input, uploaded content, and official report/template content remain unchanged.

## Add a new button or static text

Add the same semantic key to both locales in `web/locales/overrides.js`:

```js
export default {
  en: { custom: { dispatch: 'Dispatch technician' } },
  'zh-CN': { custom: { dispatch: '派遣技术人员' } },
};
```

Bind it in HTML. The active language and all later language switches are handled automatically:

```html
<button type="button" data-i18n="custom.dispatch">Dispatch technician</button>
```

The same pattern supports other controlled attributes:

```html
<input
  data-i18n-placeholder="custom.searchPlaceholder"
  data-i18n-title="custom.searchHelp"
  data-i18n-aria-label="custom.searchLabel"
>
```

Keep readable English fallback text inside static HTML. It is useful before JavaScript initializes and makes the source understandable.

## Add dynamic text in `web/app.js`

Use semantic keys rather than checking the selected language:

```js
setLocalizedText(statusElement, 'custom.saved', { filename });
const action = localizedNode('button', 'secondary', 'custom.dispatch');
const message = t('custom.confirmation', { technician: technicianName });
```

`setLocalizedText` and `localizedNode` retain their key and variables, so existing dynamic UI is translated again immediately when the user changes languages. Use `t()` for a value that does not remain on screen or will be rendered again by its owning component.

Do not add `locale === 'zh-CN'` branches or translate business/source data. Keep UI wording in locale resources and keep canonical values in application logic.

## Validation before commit

Run:

```sh
TMPDIR="$PWD/.tmp" npm_config_cache="$PWD/.cache/npm" npm run check
```

The localization tests enforce:

- identical English and Chinese key sets, including developer overrides;
- resolution of static `data-i18n` bindings;
- resolution of literal runtime translation keys;
- English fallback and safe missing-key behavior;
- override behavior without mutation of the base catalogs;
- persistence and document-language updates.

If a new key exists in only one locale, or a bound key is misspelled, the check fails before the change is committed.
