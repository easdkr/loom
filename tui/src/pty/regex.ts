const INLINE_FLAGS = /^\(\?([a-zA-Z]+)\)/;

const FLAG_TRANSLATION: Record<string, string> = {
  i: "i",
  m: "m",
  s: "s",
  u: "u",
};

export function compileRegex(pattern: string): RegExp | null {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const match = trimmed.match(INLINE_FLAGS);
  if (!match) {
    return new RegExp(trimmed);
  }

  const flagChars = Array.from(match[1] ?? "");
  const flags = new Set<string>();
  for (const flag of flagChars) {
    const mapped = FLAG_TRANSLATION[flag];
    if (mapped) {
      flags.add(mapped);
    }
  }

  const source = trimmed.slice(match[0].length);
  return new RegExp(source, Array.from(flags).join(""));
}
