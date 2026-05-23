---
description: "새 NodeType (worker/orchestrator/reviewer/router/collector)을 추가한다"
---

새 NodeType을 추가한다. 다음 순서대로:

1. `src/core/node-types.ts`의 `BuiltinNodeType` union에 새 type 문자열 추가.
   - 네임스페이스 규칙: `{category}:{kind}` (예: `worker:pty`, `reviewer:llm`)

2. `src/design/components/Node/`에 카테고리에 맞는 렌더러 컴포넌트 작성.
   - 헤더 28px + 본문 가변 + 푸터 24px + 좌측 4px 카테고리 스트라이프 구조 유지
   - 카테고리 색은 토큰 `--node-{category}` 사용

3. `src-tauri/src/graph/handlers.rs`에 실행 핸들러 추가.
   - 입력: `TaskContext`
   - 출력: `TaskResult`
   - 에러는 `pty:error` 또는 `graph:error` 이벤트로 emit

4. `docs/PRD.md` §3.2 NodeType 레지스트리 표에 한 줄 추가.

검증:
- `pnpm typecheck`, `cargo check`
- ReactFlow 캔버스에 끌어다 놓아 노드가 정상 렌더되는지 확인
