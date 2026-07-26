// escapeHtml.js — vendored copy of FlowDesk's src/utils/escapeHtml.js.
//
// Duplicated rather than imported so this module stays a self-contained folder
// you can drop into any FlowDesk checkout. Five lines is a cheaper dependency
// than a require path that breaks depending on where the module was copied.
const escapeHtml = (str) => String(str ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#x27;');

module.exports = { escapeHtml };
