const fs = require('fs');
const content = fs.readFileSync('./index.html', 'utf8');
const mStart = content.indexOf('const PROMPTS_MORNING');
const dStart = content.indexOf('const PROMPTS_DEEP');
const dEnd = content.indexOf('];', dStart) + 2;
const section = content.substring(mStart, dEnd);
const lines = section.split('\n');
lines.forEach((line, idx) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("'")) return;
  let count = 0, i = 0;
  const bs = String.fromCharCode(92);
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === bs) { i += 2; continue; }
    if (ch === "'") count++;
    i++;
  }
  if (count % 2 !== 0) console.log('ODD line', idx+1, ':', trimmed.substring(0, 120));
});
console.log('Done');
