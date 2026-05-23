const LEADS = [
  "ㄱ",
  "ㄲ",
  "ㄴ",
  "ㄷ",
  "ㄸ",
  "ㄹ",
  "ㅁ",
  "ㅂ",
  "ㅃ",
  "ㅅ",
  "ㅆ",
  "ㅇ",
  "ㅈ",
  "ㅉ",
  "ㅊ",
  "ㅋ",
  "ㅌ",
  "ㅍ",
  "ㅎ",
];

const VOWELS = [
  "ㅏ",
  "ㅐ",
  "ㅑ",
  "ㅒ",
  "ㅓ",
  "ㅔ",
  "ㅕ",
  "ㅖ",
  "ㅗ",
  "ㅘ",
  "ㅙ",
  "ㅚ",
  "ㅛ",
  "ㅜ",
  "ㅝ",
  "ㅞ",
  "ㅟ",
  "ㅠ",
  "ㅡ",
  "ㅢ",
  "ㅣ",
];

const TAILS = [
  "",
  "ㄱ",
  "ㄲ",
  "ㄳ",
  "ㄴ",
  "ㄵ",
  "ㄶ",
  "ㄷ",
  "ㄹ",
  "ㄺ",
  "ㄻ",
  "ㄼ",
  "ㄽ",
  "ㄾ",
  "ㄿ",
  "ㅀ",
  "ㅁ",
  "ㅂ",
  "ㅄ",
  "ㅅ",
  "ㅆ",
  "ㅇ",
  "ㅈ",
  "ㅊ",
  "ㅋ",
  "ㅌ",
  "ㅍ",
  "ㅎ",
];

const LEAD_INDEX = new Map(LEADS.map((value, index) => [value, index]));
const VOWEL_INDEX = new Map(VOWELS.map((value, index) => [value, index]));
const TAIL_INDEX = new Map(TAILS.map((value, index) => [value, index]));

const DOUBLE_LEADS = new Map([
  ["ㄱㄱ", "ㄲ"],
  ["ㄷㄷ", "ㄸ"],
  ["ㅂㅂ", "ㅃ"],
  ["ㅅㅅ", "ㅆ"],
  ["ㅈㅈ", "ㅉ"],
]);

const COMPOUND_VOWELS = new Map([
  ["ㅗㅏ", "ㅘ"],
  ["ㅗㅐ", "ㅙ"],
  ["ㅗㅣ", "ㅚ"],
  ["ㅜㅓ", "ㅝ"],
  ["ㅜㅔ", "ㅞ"],
  ["ㅜㅣ", "ㅟ"],
  ["ㅡㅣ", "ㅢ"],
]);

const SPLIT_VOWELS = new Map([
  ["ㅘ", "ㅗ"],
  ["ㅙ", "ㅗ"],
  ["ㅚ", "ㅗ"],
  ["ㅝ", "ㅜ"],
  ["ㅞ", "ㅜ"],
  ["ㅟ", "ㅜ"],
  ["ㅢ", "ㅡ"],
]);

const COMPOUND_TAILS = new Map([
  ["ㄱㅅ", "ㄳ"],
  ["ㄴㅈ", "ㄵ"],
  ["ㄴㅎ", "ㄶ"],
  ["ㄹㄱ", "ㄺ"],
  ["ㄹㅁ", "ㄻ"],
  ["ㄹㅂ", "ㄼ"],
  ["ㄹㅅ", "ㄽ"],
  ["ㄹㅌ", "ㄾ"],
  ["ㄹㅍ", "ㄿ"],
  ["ㄹㅎ", "ㅀ"],
  ["ㅂㅅ", "ㅄ"],
]);

const SPLIT_TAILS = new Map([
  ["ㄳ", ["ㄱ", "ㅅ"]],
  ["ㄵ", ["ㄴ", "ㅈ"]],
  ["ㄶ", ["ㄴ", "ㅎ"]],
  ["ㄺ", ["ㄹ", "ㄱ"]],
  ["ㄻ", ["ㄹ", "ㅁ"]],
  ["ㄼ", ["ㄹ", "ㅂ"]],
  ["ㄽ", ["ㄹ", "ㅅ"]],
  ["ㄾ", ["ㄹ", "ㅌ"]],
  ["ㄿ", ["ㄹ", "ㅍ"]],
  ["ㅀ", ["ㄹ", "ㅎ"]],
  ["ㅄ", ["ㅂ", "ㅅ"]],
]);

export const HANGUL_JAMO_KEY =
  /^[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\ud7b0-\ud7ff]$/u;

export interface HangulComposerResult {
  commit: string;
  preview: string;
}

export class HangulComposer {
  private lead = "";
  private vowel = "";
  private tail = "";

  get preview() {
    if (!this.lead) {
      return "";
    }
    if (!this.vowel) {
      return this.lead;
    }
    return composeSyllable(this.lead, this.vowel, this.tail);
  }

  get isComposing() {
    return this.preview.length > 0;
  }

  input(key: string): HangulComposerResult {
    if (isVowel(key)) {
      return this.inputVowel(key);
    }
    if (isLead(key)) {
      return this.inputConsonant(key);
    }
    return this.withCommit(this.flush());
  }

  backspace(): HangulComposerResult {
    if (this.tail) {
      this.tail = "";
      return this.current();
    }
    if (SPLIT_VOWELS.has(this.vowel)) {
      this.vowel = SPLIT_VOWELS.get(this.vowel) ?? "";
      return this.current();
    }
    if (this.vowel) {
      this.vowel = "";
      return this.current();
    }
    this.lead = "";
    return this.current();
  }

  flush() {
    const output = this.preview;
    this.clear();
    return output;
  }

  clear() {
    this.lead = "";
    this.vowel = "";
    this.tail = "";
  }

  private inputConsonant(key: string): HangulComposerResult {
    if (!this.lead) {
      this.lead = key;
      return this.current();
    }

    if (!this.vowel) {
      const doubleLead = DOUBLE_LEADS.get(`${this.lead}${key}`);
      if (doubleLead) {
        this.lead = doubleLead;
        return this.current();
      }

      const commit = this.lead;
      this.lead = key;
      return this.withCommit(commit);
    }

    if (!this.tail && isTail(key)) {
      this.tail = key;
      return this.current();
    }

    if (this.tail) {
      const compoundTail = COMPOUND_TAILS.get(`${this.tail}${key}`);
      if (compoundTail) {
        this.tail = compoundTail;
        return this.current();
      }
    }

    const commit = this.flush();
    this.lead = key;
    return this.withCommit(commit);
  }

  private inputVowel(key: string): HangulComposerResult {
    if (!this.lead) {
      this.lead = "ㅇ";
      this.vowel = key;
      return this.current();
    }

    if (!this.vowel) {
      this.vowel = key;
      return this.current();
    }

    if (!this.tail) {
      const compoundVowel = COMPOUND_VOWELS.get(`${this.vowel}${key}`);
      if (compoundVowel) {
        this.vowel = compoundVowel;
        return this.current();
      }

      const commit = this.flush();
      this.lead = "ㅇ";
      this.vowel = key;
      return this.withCommit(commit);
    }

    const splitTail = SPLIT_TAILS.get(this.tail);
    if (splitTail) {
      const commit = composeSyllable(this.lead, this.vowel, splitTail[0]);
      this.lead = splitTail[1];
      this.vowel = key;
      this.tail = "";
      return this.withCommit(commit);
    } else {
      const commit = composeSyllable(this.lead, this.vowel, "");
      this.lead = this.tail;
      this.vowel = key;
      this.tail = "";
      return this.withCommit(commit);
    }
  }

  private current(): HangulComposerResult {
    return { commit: "", preview: this.preview };
  }

  private withCommit(commit: string): HangulComposerResult {
    return { commit, preview: this.preview };
  }
}

function composeSyllable(lead: string, vowel: string, tail: string) {
  const leadIndex = LEAD_INDEX.get(lead);
  const vowelIndex = VOWEL_INDEX.get(vowel);
  const tailIndex = TAIL_INDEX.get(tail);

  if (leadIndex === undefined || vowelIndex === undefined || tailIndex === undefined) {
    return `${lead}${vowel}${tail}`;
  }

  return String.fromCharCode(0xac00 + leadIndex * 588 + vowelIndex * 28 + tailIndex);
}

function isLead(key: string) {
  return LEAD_INDEX.has(key);
}

function isTail(key: string) {
  return TAIL_INDEX.has(key) && key !== "" && !["ㄸ", "ㅃ", "ㅉ"].includes(key);
}

function isVowel(key: string) {
  return VOWEL_INDEX.has(key);
}
