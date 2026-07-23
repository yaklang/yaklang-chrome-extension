export function parseFunctionParameterNames(source: string, limit = 16): string[] {
  const arrow = source.indexOf('=>');
  const start = source.indexOf('(');
  let content = '';

  if (start >= 0 && (arrow < 0 || start < arrow)) {
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote) {
        if (character === '\\') escaped = true;
        else if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'" || character === '`') {
        quote = character;
        continue;
      }
      if (character === '(') depth += 1;
      else if (character === ')') {
        depth -= 1;
        if (depth === 0) {
          content = source.slice(start + 1, index);
          break;
        }
      }
    }
  } else if (arrow > 0) {
    content = source.slice(0, arrow).replace(/^\s*async\s+/, '').trim();
  }

  if (!content.trim()) return [];
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (const character of content) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote) {
      current += character;
      if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      current += character;
      continue;
    }
    if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth = Math.max(0, depth - 1);
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  parts.push(current);

  return parts.slice(0, Math.max(0, limit)).map((part, index) => {
    const candidate = part.trim().replace(/^\.\.\./, '').split('=', 1)[0].trim();
    return /^[A-Za-z_$][\w$]*$/.test(candidate) ? candidate : `arg${index}`;
  });
}
