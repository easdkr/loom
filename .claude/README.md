# `.claude/` — Claude Code 설정

이 폴더는 이 저장소에서 Claude Code를 쓸 때만 사용된다. 다른 에이전트(Codex, Cursor)는 `../AGENTS.md`와 `../.codex/`를 본다.

## 파일

- `settings.json` — 허용/차단 명령 + 환경변수
- `commands/` — 슬래시 커맨드
  - `/loom-pty` — 새 PtyProvider 추가 절차
  - `/loom-node` — 새 NodeType 추가 절차
  - `/loom-check` — 타입체크 + Rust 체크 + lint 한 번에

## 컨텍스트

세션 시작 시 자동 로드:
- `../CLAUDE.md` — 이 프로젝트의 Claude Code 컨텍스트
- `../docs/PRD.md` — 전체 기획서

## 새 커맨드를 추가하려면

`commands/<name>.md`로 frontmatter + 본문을 작성한다. 본문에는:
- 무엇을 해야 하는지 (절차)
- 검증 방법 (어떤 명령으로 통과 확인할지)
- 자주 빠뜨리는 함정
