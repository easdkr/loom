# Loom — Claude Code Context

이 파일은 Claude Code 세션 시작 시 자동으로 로드된다. 이 프로젝트를 작업할 때 알아야 할 컨텍스트를 담는다.

## 프로젝트 한 줄 정의

PTY 기반 로컬 AI 에이전트 오케스트레이터. 어떤 CLI 에이전트든 노드로 등록해 그래프로 짜고, Single/Plan/Auto 세 가지 모드로 실행한다.

전체 기획서는 [`docs/PRD.md`](docs/PRD.md). 결정 근거가 필요하면 거기를 먼저 읽는다.

## 기술 스택

- **Desktop**: Tauri 2.0 (Rust 코어 + React WebView)
- **PTY**: `portable-pty` (Rust crate)
- **Frontend**: React 19 + TypeScript + Vite
- **Graph editor**: ReactFlow (xyflow) v12
- **Terminal**: xterm.js
- **State**: Zustand
- **Styling**: Tailwind CSS v4 (via `@tailwindcss/vite`)

## 디렉토리 규약

```
src/
  core/          AgentNode, TaskGraph, TaskContext 등 도메인 코어 타입
  providers/     PtyProvider 구현체 (claude-code, codex, cursor, shell, http)
  design/        디자인 토큰(CSS variables) + 재사용 컴포넌트
    tokens/      colors, typography, spacing, motion (CSS variables만)
    components/  Node, Edge, Panel, TerminalBlock, Button, Input, Badge 등
  modes/         Single / Plan / Auto 모드별 페이지·패널
  stores/        Zustand 스토어 (graph, execution, settings)

src-tauri/src/
  pty/           portable-pty 래퍼, 세션 관리
  graph/         실행 엔진 (topological sort, parallel/sequential)
  plugin/        플러그인 레지스트리 (esbuild 런타임 로드)
  commands.rs    Tauri command 핸들러
  lib.rs         앱 진입점

tui/               Phase 2 ink.js TUI 어댑터 (헤드리스/CI 친화)
  bin/loom.ts      CLI 엔트리 (`pnpm loom`)
  src/cli/         commander + ink 화면 (run / plan / providers / init)
  src/components/  Banner, StatusBar, StreamPanel, PlanReview, PromptForm
  src/pty/         node-pty 세션, multiplexer, ANSI/regex/prompt handoff
  src/graph/       topology + PlanExecutor (Rust 엔진과 동일한 의미)
  src/plan/        PlanDraft 스키마 + 휴리스틱 generatePlan
  scripts/         postinstall 보조 (node-pty spawn-helper exec 비트 복구)
  test/            node:test 기반 단위/통합 테스트
```

## 코드 작성 규칙

### 디자인 시스템

- **모든 색상·간격·폰트는 토큰을 참조한다.** 컴포넌트에 raw 값(`#E8A852`, `12px`)을 직접 쓰지 않는다.
- 토큰은 `src/design/tokens/*.css`에 CSS variables로 정의. Tailwind와 양립 가능하게 `bg-[var(--bg-canvas)]` 형태로 사용.
- 라이트 테마는 보조 수준만 — 다크 테마 퍼스트.
- 폰트 굵기는 `400`/`500` 두 단계만. 강조는 색(`fg/primary`)으로.

### 컴포넌트

- 노드는 모두 헤더(28px) + 본문(가변) + 푸터(24px) 3단 구조 + 좌측 4px 카테고리 스트라이프.
- 패널은 우측 360px(드래그로 조절), 하단 28px 상태바.
- 아이콘은 라인 스타일 1.5px 스트로크 (Tabler 스타일). Filled 금지.

### 상태 관리

- 그래프 상태(노드·엣지)는 Zustand `graphStore`.
- 실행 상태(PTY 출력 스트림, 노드 진행률)는 별도 `executionStore`.
- ReactFlow 자체 상태는 `useReactFlow`로 동기화하되 마스터는 Zustand.

### Rust ↔ JS IPC

| 이벤트명 | 방향 | 페이로드 |
|---------|------|---------|
| `pty:data` | Rust→JS | `{ nodeId, chunk }` |
| `pty:complete` | Rust→JS | `{ nodeId, result }` |
| `pty:error` | Rust→JS | `{ nodeId, error }` |
| `graph:execute` | JS→Rust | `{ plan }` (Tauri command) |
| `node:kill` | JS→Rust | `{ nodeId }` |
| `node:write` | JS→Rust | `{ nodeId, input }` |

새 이벤트를 추가할 땐 항상 `pty:*`, `graph:*`, `node:*` 네임스페이스를 따른다.

## 주의 사항

1. **PTY 완료 감지는 항상 타임아웃 fallback과 짝**. 정규식만 믿지 않는다.
2. **ANSI 코드는 후처리 필수** (`strip-ansi`). `NO_COLOR=1`을 줘도 새는 CLI가 있다.
3. **컨텍스트 오염 방지** — 작업 단위 PTY 세션 재시작이 기본. 재사용은 명시적 옵션으로만.
4. **Rate limit** — 동일 Provider 동시 실행은 Token Bucket으로 제한. 기본 동시 2개.
5. **Windows 지원은 Phase 5 이후**. 지금은 macOS만 우선.

## 자주 쓰는 명령

```bash
pnpm tauri dev               # 데스크톱 앱 개발
pnpm dev                     # 프론트만 (브라우저)
pnpm build                   # 프론트 빌드
pnpm tauri build             # 프로덕션 번들
cargo check --manifest-path src-tauri/Cargo.toml   # Rust 타입 체크

# TUI 어댑터 (Phase 2)
pnpm loom providers          # Provider 목록
pnpm loom init [--force]     # 기본 ~/.loom/providers.toml 작성
pnpm loom run "<prompt>" --provider shell
pnpm loom plan "<prompt>" --template default
pnpm tui:typecheck
pnpm tui:test                # node:test 기반, node-pty 실제 spawn 포함
```

## 모듈 추가 가이드

### 새 PtyProvider 추가

1. `src/providers/<name>.ts`에 `PtyProvider` 구현체 작성
2. `src/providers/index.ts`의 builtin 레지스트리에 등록
3. `~/.loom/providers.toml` 기본값 예시 추가
4. 완료 패턴 정규식과 타임아웃을 반드시 명시

### 새 NodeType 추가

1. `src/core/node-types.ts`의 `BuiltinNodeType` union에 추가
2. `src/design/components/Node/`에 렌더러 컴포넌트
3. 카테고리 색을 토큰에서 골라 스트라이프 색 지정 (`node/orchestrator` 등)
4. `src-tauri/src/graph/`에 실행 핸들러

## 커밋 / PR 컨벤션

- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- 한 커밋은 한 가지 일만. 디자인 토큰 변경과 기능 추가를 섞지 않는다.
- 첫 줄 70자 이내, 본문은 "왜"를 적는다.

## 더 읽을거리

- [`docs/PRD.md`](docs/PRD.md) — 전체 기획서 (모드 설계, 디자인 시스템, 로드맵)
- [`AGENTS.md`](AGENTS.md) — Codex/Cursor 등 다른 에이전트용 동일 컨텍스트
- [`.claude/commands/`](.claude/commands/) — Claude Code 슬래시 커맨드 정의
