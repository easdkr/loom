# Loom

> PTY 기반 로컬 AI 에이전트 오케스트레이터. 어떤 CLI 에이전트든 노드로 등록해 그래프로 짜고, 분배·실행·리뷰까지 한 곳에서.

Loom은 직조기에서 이름을 가져왔다. 직조기가 실의 재질을 가리지 않는 것처럼, Loom은 PTY 워커든 HTTP 워커든 사람의 승인이든 — 어떤 노드든 받아서 하나의 실행 흐름으로 엮는다.

## 핵심 특징

- **Everything is a Node** — 오케스트레이터, 워커, 리뷰어, 라우터가 모두 같은 `AgentNode` 인터페이스
- **Provider 무관** — PTY로 띄울 수 있는 CLI라면 무엇이든 Provider로 등록
- **세 가지 모드** — Single(단일 실행) · Plan(사람이 그래프, 에이전트가 프롬프트) · Auto(에이전트가 그래프까지)
- **로컬 퍼스트** — 모든 실행은 로컬. 외부 서비스 의존 없음
- **Headless 코어** — UI는 교체 가능, 코어 로직은 단일 구현

## 기술 스택

| 레이어 | 기술 |
|--------|------|
| Desktop shell | Tauri 2.0 (Rust) |
| PTY 관리 | `portable-pty` |
| UI | React 19 + TypeScript |
| 그래프 에디터 | ReactFlow (xyflow) v12 |
| 터미널 | xterm.js |
| 상태 관리 | Zustand |
| 스타일 | Tailwind CSS v4 |

자세한 결정 근거는 [docs/PRD.md](docs/PRD.md) 참고.

## 개발

### 사전 요구사항

- Node.js 20+
- pnpm 10+
- Rust 1.80+
- macOS (Phase 1 기준 — Windows/Linux는 Phase 5 이후)

### 시작하기

```bash
pnpm install
pnpm tauri dev
```

### 주요 스크립트

```bash
pnpm tauri dev       # 데스크톱 앱 개발 모드
pnpm tauri build     # 프로덕션 번들 빌드
pnpm dev             # 프론트엔드만 실행 (브라우저)
pnpm build           # 프론트엔드 빌드
```

## 디렉토리

```
loom/
├── docs/              # 기획·디자인 문서
│   └── PRD.md         # 제품 기획서 (소스 오브 트루스)
├── src/               # React 프론트엔드
│   ├── core/          # AgentNode, TaskGraph 등 코어 타입
│   ├── providers/     # Provider 어댑터 (claude-code, codex, ...)
│   ├── design/        # 디자인 토큰 + 컴포넌트
│   └── modes/         # Single / Plan / Auto 모드 UI
├── src-tauri/         # Rust 코어
│   ├── src/
│   │   ├── pty/       # portable-pty 래퍼
│   │   ├── graph/     # TaskGraph 실행 엔진
│   │   └── plugin/    # 플러그인 레지스트리
│   └── Cargo.toml
├── .claude/           # Claude Code 협업 설정
├── .codex/            # Codex 협업 설정
├── CLAUDE.md          # Claude Code용 컨텍스트
└── AGENTS.md          # 범용 에이전트 컨텍스트
```

## 로드맵 요약

1. **Phase 1** — 코어 엔진 (Single 모드 + PTY + TaskGraph)
2. **Phase 2** — TUI 어댑터
3. **Phase 3** — Desktop GUI (Plan/Auto 모드)
4. **Phase 4** — 플러그인 시스템
5. **Phase 5** — 안정화 + Windows 지원

## 상태

🚧 **초기 기획 단계** — 0.1.0 스캐폴드. 코어 구현 전.

## 라이선스

MIT — [LICENSE](LICENSE)
