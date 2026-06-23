'use strict';

const { t } = require('./hmsI18n');

function titleSlug(title) {
  return String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function roleLabel(code, defaultTitle, lang) {
  const c = String(code ?? '').trim();
  if (c) {
    const byCode = t(`roles.names.${c}`, lang, { ns: 'superAdmin', defaultValue: '' });
    if (byCode) return byCode;
  }
  const title = String(defaultTitle || '').trim();
  if (!title) return c;
  const slug = titleSlug(title);
  if (slug) {
    const byTitle = t(`roles.names_title.${slug}`, lang, { ns: 'superAdmin', defaultValue: '' });
    if (byTitle) return byTitle;
  }
  return title;
}

module.exports = {
  titleSlug,
  roleLabel,
};
