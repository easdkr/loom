import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { HangulComposer, HANGUL_JAMO_KEY } from "./hangulComposer";

export interface TerminalOutputHandle {
  focus(): void;
  reset(): void;
  size(): TerminalSize | null;
  write(data: string): void;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

interface TerminalOutputProps {
  active: boolean;
  onInput(input: string): void;
  onResize(size: TerminalSize): void;
}

const TERMINAL_SCROLLBACK_LINES = 300;
const CLAUDE_CODE_RECORD_MARKER = /\u23fa(?!\ufe0e)/gu;
const HANGUL_TEXT =
  /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af\ua960-\ua97f\ud7b0-\ud7ff]/u;
const HANGUL_SYLLABLE = /^[\uac00-\ud7af]$/u;
const DELETE_PREVIOUS_CHARACTER = "\x7f";

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function cssPx(name: string) {
  const value = Number.parseFloat(cssVar(name));
  return Number.isFinite(value) ? value : 0;
}

function forceTextPresentation(data: string) {
  return data.replace(CLAUDE_CODE_RECORD_MARKER, "\u23fa\ufe0e");
}

function hasHangulText(data: string) {
  return HANGUL_TEXT.test(data);
}

function erasePreviousText(text: string) {
  return DELETE_PREVIOUS_CHARACTER.repeat(Array.from(text).length);
}

function isHangulJamoText(text: string) {
  return HANGUL_JAMO_KEY.test(text);
}

function isHangulSyllable(text: string) {
  return HANGUL_SYLLABLE.test(text);
}

const TerminalOutput = forwardRef<TerminalOutputHandle, TerminalOutputProps>(
  ({ active, onInput, onResize }, ref) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const onInputRef = useRef(onInput);
    const onResizeRef = useRef(onResize);
    const activeRef = useRef(active);
    const sizeRef = useRef<TerminalSize | null>(null);
    const hangulComposerRef = useRef(new HangulComposer());
    const displayedHangulPreviewRef = useRef("");

    useEffect(() => {
      onInputRef.current = onInput;
    }, [onInput]);

    useEffect(() => {
      onResizeRef.current = onResize;
    }, [onResize]);

    useEffect(() => {
      activeRef.current = active;
    }, [active]);

    useImperativeHandle(ref, () => ({
      focus() {
        terminalRef.current?.focus();
      },
      reset() {
        terminalRef.current?.reset();
        terminalRef.current?.clear();
        hangulComposerRef.current.clear();
        displayedHangulPreviewRef.current = "";
      },
      size() {
        return sizeRef.current;
      },
      write(data: string) {
        terminalRef.current?.write(forceTextPresentation(data));
      },
    }));

    useEffect(() => {
      if (!containerRef.current) {
        return;
      }

      const fitAddon = new FitAddon();
      const fontSize = cssPx("--text-terminal");
      const lineHeight = fontSize > 0 ? cssPx("--leading-terminal") / fontSize : 1;
      const terminal = new Terminal({
        convertEol: false,
        cursorBlink: true,
        fontFamily: cssVar("--font-terminal"),
        fontSize,
        lineHeight,
        scrollback: TERMINAL_SCROLLBACK_LINES,
        theme: {
          background: cssVar("--terminal-bg"),
          cursor: cssVar("--terminal-cursor"),
          foreground: cssVar("--terminal-fg"),
          selectionBackground: cssVar("--terminal-selection"),
        },
      });
      const sendHangulPatch = (commit: string, preview: string) => {
        if (!activeRef.current) {
          displayedHangulPreviewRef.current = preview;
          return;
        }

        const previousPreview = displayedHangulPreviewRef.current;
        onInputRef.current(`${erasePreviousText(previousPreview)}${commit}${preview}`);
        displayedHangulPreviewRef.current = preview;
      };
      const sendHangulCommit = (commit: string) => {
        if (!activeRef.current) {
          displayedHangulPreviewRef.current = "";
          return;
        }

        const previousPreview = displayedHangulPreviewRef.current;
        onInputRef.current(`${erasePreviousText(previousPreview)}${commit}`);
        displayedHangulPreviewRef.current = "";
      };
      const commitComposedHangul = () => {
        const composer = hangulComposerRef.current;
        if (composer.isComposing) {
          sendHangulCommit(composer.flush());
          return;
        }

        displayedHangulPreviewRef.current = "";
      };
      const handleHangulData = (data: string) => {
        const chars = Array.from(data);
        const syllableText = chars.filter(isHangulSyllable).join("");
        if (syllableText.length > 0) {
          hangulComposerRef.current.clear();
          sendHangulCommit(syllableText);
          return;
        }

        for (const char of chars) {
          const composer = hangulComposerRef.current;
          if (isHangulJamoText(char)) {
            const result = composer.input(char);
            sendHangulPatch(result.commit, result.preview);
            continue;
          }

          if (isHangulSyllable(char)) {
            composer.clear();
            sendHangulPatch("", char);
            continue;
          }

          commitComposedHangul();
          if (activeRef.current) {
            onInputRef.current(char);
          }
        }
      };

      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") {
          return true;
        }

        const composer = hangulComposerRef.current;
        if (!composer.isComposing && displayedHangulPreviewRef.current.length === 0) {
          return true;
        }

        if (event.key === "Backspace") {
          event.preventDefault();
          if (composer.isComposing) {
            const result = composer.backspace();
            sendHangulPatch(result.commit, result.preview);
          } else {
            const previous = Array.from(displayedHangulPreviewRef.current);
            sendHangulPatch("", previous.slice(0, -1).join(""));
          }
          return false;
        }

        if (event.key === "Escape") {
          event.preventDefault();
          composer.clear();
          sendHangulPatch("", "");
          return false;
        }

        if (composer.isComposing) {
          sendHangulCommit(composer.flush());
        } else {
          displayedHangulPreviewRef.current = "";
        }

        if (event.key === "Enter") {
          event.preventDefault();
          if (activeRef.current) {
            onInputRef.current("\r");
          }
          return false;
        }

        return true;
      });

      function publishSize(size: TerminalSize) {
        if (size.cols < 1 || size.rows < 1) {
          return;
        }
        if (sizeRef.current?.cols === size.cols && sizeRef.current.rows === size.rows) {
          return;
        }
        sizeRef.current = size;
        onResizeRef.current(size);
      }

      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current);
      fitAddon.fit();
      publishSize({ cols: terminal.cols, rows: terminal.rows });

      const handlePaste = (event: ClipboardEvent) => {
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (!hasHangulText(text)) {
          return;
        }

        event.preventDefault();
        hangulComposerRef.current.clear();
        sendHangulPatch(text, "");
      };
      terminal.textarea?.addEventListener("paste", handlePaste);

      const dataDisposable = terminal.onData((data) => {
        if (!activeRef.current) {
          return;
        }
        if (hasHangulText(data)) {
          handleHangulData(data);
          return;
        }
        commitComposedHangul();
        onInputRef.current(data);
      });
      const resizeDisposable = terminal.onResize(publishSize);
      const resizeObserver = new ResizeObserver(() => fitAddon.fit());
      resizeObserver.observe(containerRef.current);
      terminalRef.current = terminal;

      return () => {
        dataDisposable.dispose();
        resizeDisposable.dispose();
        resizeObserver.disconnect();
        terminal.textarea?.removeEventListener("paste", handlePaste);
        hangulComposerRef.current.clear();
        displayedHangulPreviewRef.current = "";
        terminal.dispose();
        terminalRef.current = null;
      };
    }, []);

    return <div ref={containerRef} className="terminal-output" />;
  },
);

TerminalOutput.displayName = "TerminalOutput";

export default TerminalOutput;
