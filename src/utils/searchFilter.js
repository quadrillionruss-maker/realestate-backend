// searchFilter.js — safely embedding user input into a PostgREST combined
// `.or()` filter expression.
//
// `.or('full_name.ilike.%term%,phone.ilike.%term%')` builds a raw filter
// string, and PostgREST's filter language treats `,` as the separator
// between conditions and `()` as grouping — a search term containing either
// injects additional filter clauses rather than being matched literally
// (e.g. `x,id.neq.<uuid>`). `%`/`_`/`\` are escaped separately because they
// are ILIKE wildcards, not PostgREST filter syntax — a search for "100%"
// must look for "100%", not treat % as "anything".
//
// Structural characters are stripped outright rather than quoted per
// PostgREST's escaping rules: a name/phone/email search has no real use for
// a literal comma or parenthesis, and losing the ability to search for one
// is a small price for a filter string that is provably safe to build by
// concatenation, with no quoting rule to get subtly wrong.
function sanitizeSearchTerm(term) {
  return String(term || '')
    .replace(/[,()]/g, '')
    .replace(/[%_\\]/g, (c) => `\\${c}`);
}

module.exports = { sanitizeSearchTerm };
