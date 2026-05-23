# `.codex/` — Codex CLI 설정

Codex CLI(또는 Codex Claude Code 플러그인)가 이 저장소에서 작업할 때 사용한다.

## 파일

- `config.toml` — 프로젝트 메타, 명령 alias, 컨벤션, 금지 사항
- `prompts/` — 작업 유형별 시작 프롬프트
  - `pty-provider.md` — 새 PTY Provider 추가
  - `design-token.md` — 디자인 토큰 규칙

## 컨텍스트

- `../AGENTS.md` — 모든 코딩 에이전트가 읽는 공용 컨텍스트
- `../docs/PRD.md` — 전체 기획서

## Claude Code와 차이

Claude Code 전용 설정은 `../.claude/`에 있다. 두 곳에 같은 내용을 두 번 쓰지 않는다 — 공용 규칙은 `AGENTS.md`/`CLAUDE.md`에, 도구 전용 설정만 각자 폴더에.
