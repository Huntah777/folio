const fs = require('fs');
const content = fs.readFileSync('./index.html', 'utf8');
const scriptStart = content.indexOf('<script type="text/babel">');
const scriptEnd = content.lastIndexOf('</script>');
const script = content.substring(scriptStart, scriptEnd);
const lines = script.split('\n');
const bs = String.fromCharCode(92); // backslash

lines.forEach((line, lineIdx) => {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

  // Scan char by char looking for single-quoted strings
  let inSingleQuote = false;
  let i = 0;
  let quoteStart = -1;
  while (i < line.length) {
    const ch = line[i];
    if (ch === bs) { i += 2; continue; }
    if (!inSingleQuote && ch === '"') {
      // Skip double-quoted strings
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === bs) i++;
        i++;
      }
      i++;
      continue;
    }
    if (!inSingleQuote && ch === '`') {
      // Skip template literals (simplified)
      i++;
      while (i < line.length && line[i] !== '`') {
        if (line[i] === bs) i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      if (inSingleQuote) {
        inSingleQuote = false;
        quoteStart = -1;
      } else {
        inSingleQuote = true;
        quoteStart = i;
      }
    } else if (inSingleQuote && ch === "'") {
      // apostrophe inside single-quoted string!
      console.log('Line ' + (lineIdx+1) + ': ' + line.trim().substring(0, 120));
      inSingleQuote = false;
      break;
    }
    i++;
  }
});
console.log('Done');
