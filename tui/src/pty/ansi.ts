import baseStripAnsi from "strip-ansi";

export function stripAnsi(input: string): string {
  return baseStripAnsi(input);
}

const PRIVATE_USE =
  /[-\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;
const REPLACEMENT_CHARACTER = /�/g;

export function normalizeDisplayText(input: string): string {
  return input.replace(PRIVATE_USE, "").replace(REPLACEMENT_CHARACTER, "?");
}

export function cleanForDisplay(input: string): string {
  return normalizeDisplayText(stripAnsi(input));
}
