// escapeHtml.js — escaping for values interpolated into PDF templates.
//
// Five lines rather than a dependency: this runs on buyer-supplied names that
// end up inside an HTML document we then print.
const escapeHtml = (str) => String(str ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#x27;');

module.exports = { escapeHtml };
