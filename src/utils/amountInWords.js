// amountInWords.js — "2500000" → "Two Million, Five Hundred Thousand Naira Only".
//
// Not decoration. A Nigerian receipt states the amount in words as well as in
// figures, and the words are what settles an argument when a figure has been
// altered: "₦5,000,000" becomes "₦15,000,000" with one stroke of a pen, while
// "Five Million Naira Only" does not.
//
// Works in kobo internally so 0.1 + 0.2 never becomes 0.30000000000000004 and
// prints as "Thirty Kobo" when it should be "Thirty Kobo".

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen'];

const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

// Short scale, which is what Nigerian commercial writing uses.
const SCALES = [
  { value: 1_000_000_000_000, name: 'Trillion' },
  { value: 1_000_000_000, name: 'Billion' },
  { value: 1_000_000, name: 'Million' },
  { value: 1_000, name: 'Thousand' },
];

// 0–999. "One Hundred and Five", with the "and" Nigerian usage keeps.
function underThousand(n) {
  if (n === 0) return '';
  if (n < 20) return ONES[n];
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)];
    const rest = n % 10;
    return rest ? `${tens}-${ONES[rest]}` : tens;
  }
  const hundreds = `${ONES[Math.floor(n / 100)]} Hundred`;
  const rest = n % 100;
  return rest ? `${hundreds} and ${underThousand(rest)}` : hundreds;
}

function wholeNumberInWords(n) {
  if (n === 0) return 'Zero';

  const parts = [];
  let remaining = n;

  for (const scale of SCALES) {
    if (remaining >= scale.value) {
      const count = Math.floor(remaining / scale.value);
      parts.push(`${wholeNumberInWords(count)} ${scale.name}`);
      remaining %= scale.value;
    }
  }

  if (remaining > 0) parts.push(underThousand(remaining));
  return parts.join(', ');
}

// The public one. `currency` is a pair so the same function can print a
// non-Naira figure if a developer ever sells in dollars.
function amountInWords(amount, { major = 'Naira', minor = 'Kobo' } = {}) {
  const kobo = Math.round(Math.abs(Number(amount) || 0) * 100);
  const whole = Math.floor(kobo / 100);
  const fraction = kobo % 100;

  const negative = Number(amount) < 0 ? 'Minus ' : '';
  const majorPart = `${wholeNumberInWords(whole)} ${major}`;

  // "Only" is the standard terminator and means "and nothing further" — it is
  // what stops someone appending to the line.
  if (!fraction) return `${negative}${majorPart} Only`;
  return `${negative}${majorPart} and ${wholeNumberInWords(fraction)} ${minor} Only`;
}

module.exports = { amountInWords, wholeNumberInWords };
