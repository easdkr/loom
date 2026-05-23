# AGENTS.md

이 파일은 Codex CLI, Cursor, OpenHands 등 코딩 에이전트가 이 저장소를 작업할 때 읽는다. Claude Code는 같은 내용을 `CLAUDE.md`에서 읽는다.

## 프로젝트

**Loom** — PTY 기반 로컬 AI 에이전트 오케스트레이터. 어떤 CLI 에이전트든 노드로 등록해 그래프로 짜고, 분배·실행·리뷰한다.

- 기획서: [`docs/PRD.md`](docs/PRD.md)
- 상태: 초기 스캐폴드 (Phase 1 시작 전)

## 기술 스택

- Tauri 2.0 (Rust) + React 19 + TypeScript + Vite
- ReactFlow v12 (그래프), xterm.js (터미널), Zustand (상태)
- Tailwind CSS v4 (`@tailwindcss/vite` 플러그인)
- PTY: `portable-pty` (Rust)

## 디렉토리

```
src/             React 프론트엔드
  core/          AgentNode·TaskGraph 타입
  providers/     PtyProvider 구현체
  design/        토큰 + 컴포넌트
  modes/         Single/Plan/Auto 화면
  stores/        Zustand
src-tauri/src/   Rust 코어
  pty/  graph/  plugin/
docs/            기획·디자인
.claude/         Claude Code 설정
.codex/          Codex 설정
```

## 작업할 때 지켜야 할 것

1. **디자인 토큰만 참조** — raw 색/사이즈 값을 컴포넌트에 직접 쓰지 않는다. `src/design/tokens/*`의 CSS variable을 쓴다.
2. **다크 테마 퍼스트** — 라이트는 보조.
3. **노드 구조 통일** — 헤더(28px) + 본문 + 푸터(24px) + 좌측 4px 카테고리 스트라이프.
4. **PTY 완료 감지** — 정규식 + 타임아웃 fallback 항상 같이.
5. **ANSI 후처리** — `strip-ansi` 필수.
6. **컨텍스트 오염 방지** — PTY 세션은 작업 단위로 재시작이 기본.
7. **Rust↔JS 이벤트 네임스페이스** — `pty:*`, `graph:*`, `node:*`.

## 명령어

```bash
pnpm install
pnpm tauri dev                                       # 데스크톱 앱 개발
pnpm dev                                             # 프론트만 (브라우저)
pnpm build && cargo check --manifest-path src-tauri/Cargo.toml
pnpm tauri build                                     # 프로덕션 번들
```

## 커밋 규칙

Conventional Commits. 한 커밋은 한 일만. 첫 줄 70자 이내. 본문은 "왜"를 적는다.

```
feat(graph): add topological sort to TaskGraph engine
fix(pty): handle ANSI cursor-up sequences in claude-code provider
docs(prd): clarify Auto mode complexity heuristics
```

## 시야 밖의 것들

- **Windows 지원**: Phase 5 이후. 지금은 macOS 우선, Linux는 best-effort.
- **iOS/Android**: 스캐폴드만 있고 지원 계획 없음.
- **외부 서비스 의존**: 추가하지 않는다. 모든 실행은 로컬.

## 더 읽을거리

- [`docs/PRD.md`](docs/PRD.md) — 전체 기획서
- [`CLAUDE.md`](CLAUDE.md) — Claude Code 전용 동일 컨텍스트 + 슬래시 커맨드 참고
