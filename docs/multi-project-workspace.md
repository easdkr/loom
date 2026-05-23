# 멀티 프로젝트(워크스페이스) — 상세 기획안

> 버전 1.0 · 작성일 2026-05-23 · 적용 Phase 6

---

## 0. 요약

현재 Loom은 그래프·실행 상태가 글로벌 싱글톤이고 워크스페이스 파일이 `~/.loom/workspace.json` 1슬롯이다.
여러 프로젝트(=루트 디렉토리)를 탭으로 띄우고, 각 탭이 자기 그래프·실행 상태를 독립적으로 유지하며 **백그라운드에서도 PTY가 계속 돌도록** 한다.

핵심 원칙
- **디렉토리는 입력이 아니라 픽한다.** (모든 root, 모든 workdir Browse)
- 탭 백그라운드에서 실행이 살아 있어야 하므로 store는 **dump/restore가 아닌 인스턴스 분리**.
- Rust `PtyManager`는 거의 그대로 두고, **node_id 네임스페이싱**으로 충돌만 차단.

### 굳혀진 결정 (검토 항목 1~4)

| # | 결정 | 비고 |
|---|---|---|
| 1 | **Map-of-stores 방식** 채택 | Context provider가 아닌 `Map<projectId, StoreApi>` |
| 2 | **node_id prefix는 Rust 통과**(opaque key) | Rust 코드 변경 없음. ProjectId 도메인은 도입하지 않음 |
| 3 | **탭 순서는 수동(DnD)**, MRU 자동정렬 안 함 | `openTabs: string[]`이 곧 시각 순서 |
| 4 | **백그라운드 status dot만 표시**, 자동 탭 전환 X | 사용자가 결정 |

---

## 1. 도메인 모델

### 1.1 Project (TS shared type)
```ts
interface Project {
  id: string;                 // ULID — 디렉토리 이동 후에도 동일하게 유지
  root: string;               // realpath() 처리된 절대 경로
  name: string;               // 기본 basename(root), 사용자 rename 가능
  providersOverride?: string; // 절대 경로, 옵션
  lastOpenedAt: number;       // epoch ms
}
```

### 1.2 Workspace registry (글로벌)
파일: `~/.loom/workspace.json` (v2)
```ts
{
  version: 2,
  projects: Project[],
  openTabs: string[],      // projectId 순서 (= 탭 시각 순서, 수동 DnD)
  activeTabId: string | null
}
```

### 1.3 Project graph snapshot (프로젝트별)
파일: `<root>/.loom/graph.json`

현재 `src/modes/plan/workspace.ts`의 `WorkspacePayload({version, nodes, edges})`를 그대로 이식.
**스키마 변경 없음**, 저장 위치만 프로젝트 루트로 이동.

---

## 2. 스토리지 마이그레이션

`~/.loom/workspace.json`을 열어 `version` 분기:

- **`version === 1`** → 현재 글로벌 그래프가 들어있는 상태.
  온보딩 다이얼로그: *"이전 워크스페이스를 어느 프로젝트 루트에 연결할까요?"* → 디렉토리 픽 →
  - 해당 root의 `.loom/graph.json`으로 노드·엣지 이동
  - 새 Project 객체 생성(id=ULID, name=basename, root=픽한 경로)
  - `~/.loom/workspace.json`을 v2 registry로 덮어쓰기
- **`version === 2`** → 그대로 로드.
- **파일 없음** → 빈 registry, 빈 상태 화면.

마이그레이션 실패 시 원본은 `~/.loom/workspace.v1.bak.json`으로 백업.

---

## 3. 스토어 멀티 인스턴스화

### 3.1 결정: factory + `Map<projectId, StoreApi>`

탭 전환 시 dump/restore 방식은 백그라운드 PTY가 살아 있어야 한다는 요구와 어긋남.

```ts
// src/stores/graphStore.ts
const createGraphStore = () => create<GraphState>(/* 기존 본문 그대로 */);
const stores = new Map<string, ReturnType<typeof createGraphStore>>();

export function getGraphStore(projectId: string) {
  let store = stores.get(projectId);
  if (!store) {
    store = createGraphStore();
    stores.set(projectId, store);
  }
  return store;
}
export function disposeGraphStore(projectId: string) {
  stores.delete(projectId);
}
```

### 3.2 active-aware hook
```ts
export function useGraphStore<T>(selector: (s: GraphState) => T): T {
  const activeId = useWorkspaceStore(s => s.activeTabId);
  const store = activeId ? getGraphStore(activeId) : EMPTY_STORE;
  return store(selector);
}
useGraphStore.getState = () =>
  getGraphStore(useWorkspaceStore.getState().activeTabId!).getState();
```
- `useGraphStore.getState()` 같은 정적 호출은 active를 직접 참조하는 shim 제공.
- 비-React 함수(`usePlanExecution.runPlan` 내부 등)에서는 **호출 시점의 projectId를 명시 인자로** 받게 리팩토링.

### 3.3 executionStore 동일 패턴

### 3.4 settingsStore는 글로벌 유지
- 모드(Single/Plan/Auto)는 전역.
- 프로젝트별 마지막 모드 기억은 **비-스코프**.

---

## 4. workspaceStore (신규, 글로벌 메타)

```ts
interface WorkspaceState {
  projects: Project[];
  openTabs: string[];
  activeTabId: string | null;
  ready: boolean;

  pickAndAddProject(): Promise<Project | null>; // 디렉토리 픽 → realpath dedup → add
  removeProject(id: string): void;
  renameProject(id: string, name: string): void;
  openTab(id: string): void;
  closeTab(id: string): Promise<void>; // 실행 중이면 confirm
  setActiveTab(id: string): void;
  reorderTabs(nextOrder: string[]): void;
}
```
- 모든 mutation 후 `~/.loom/workspace.json` 300ms 디바운스 저장.
- 같은 root 중복 추가는 `realpath` dedup → 기존 프로젝트 활성화.
- `closeTab`은 디스크 graph는 건드리지 않음 (close = "탭에서 닫기"). 완전 삭제는 `removeProject`.

---

## 5. 디렉토리 선택 UX (핵심 제약)

**텍스트 입력 X, 픽 O.**

- `@tauri-apps/plugin-dialog`의 `open({ directory: true, multiple: false, defaultPath: home })`.
- 프로젝트 추가: 탭 바의 `[+]` → 디렉토리 픽 → `pickAndAddProject()`.
- Inspector / SingleMode의 workdir 필드:
  - placeholder: `(프로젝트 루트: <basename>)` — hover 시 full path tooltip
  - 텍스트 필드는 **read-only**, 옆에 `Browse…` 버튼만 → 디렉토리 픽
  - `Clear` 버튼으로 `null` 복귀 (= 프로젝트 루트 사용)

---

## 6. UI

### 6.1 탭 바 (App 최상단, 28px 높이)
```
┌────────────────────────────────────────────────────────────────┐
│ Loom │ [● proj A] [  proj B  ✕] [+]            [Single|Plan|Auto] │
└────────────────────────────────────────────────────────────────┘
```
- 위치: 기존 `loom-app-topbar` 안, 브랜드 우측 / 모드 토글버 좌측.
- 신규 컴포넌트: `src/design/components/TabBar.tsx`.
- 활성 탭: 좌측 stripe 2px (`fg/primary`).
- 좌측 status dot: 백그라운드 탭의 `idle / running / error / complete` 표시 — **자동 전환은 안 함**.
- 우클릭: Rename / Close / Close Others / Reveal in Finder / Remove from Workspace.
- 단축키: ⌘1~⌘9 전환, ⌘T 새 프로젝트(픽), ⌘W 현재 탭 닫기, ⌘⇧] / ⌘⇧[ 인접 탭.
- HTML5 DnD로 순서 변경, 결과는 `reorderTabs()` — **수동 순서만, MRU 자동정렬 없음**.

### 6.2 빈 상태 (등록 프로젝트 0개)
- 모드 토글바·메인 영역 전체 비활성.
- 가운데 큰 버튼 1개: *"프로젝트 폴더 선택"* → 디렉토리 픽.
- 그 아래 "최근 프로젝트" 리스트 (`projects[]`에 있지만 `openTabs[]`에 없는 항목, `lastOpenedAt` 내림차순 5개).

### 6.3 상태바
- 모든 모드 좌측에 `[…/proj-root-name]` 표시 (가장 마지막 2 segment).

### 6.4 Inspector / SingleMode workdir 변경 (§5 참고)

---

## 7. Workdir 해석 체인

**TS 쪽에서 절대 경로로 변환해 Rust에 보낸다. Rust는 그대로 사용.**

해석 순서:
1. `node.workdir`가 절대 경로 → 그대로
2. `node.workdir`가 상대 경로 → `activeProject.root` 기준 resolve
3. `node.workdir`가 null/undefined → `activeProject.root`
4. (TUI에서 프로젝트 컨텍스트 없을 때) → `process.cwd()`

신규 유틸: `src/core/workdir.ts::resolveWorkdir(node, project)`.

`usePlanExecution.runPlan`과 `SingleMode.runTask`에서 PTY 요청 빌드 직전에 적용.

### 7.1 TUI
- `--project <name|id>` 또는 `--project-root <path>` 플래그.
- 우선순위: CLI flag > `LOOM_PROJECT` > `LOOM_PROJECT_ROOT` > 등록 안 함(=cwd).
- 등록되지 않은 root는 in-memory ad-hoc Project — `~/.loom/workspace.json`에 쓰지 않음.

---

## 8. 노드 ID 네임스페이싱

### 8.1 결정: `<projectId>:<localNodeId>` (Rust는 opaque key로 통과)
- 프론트 store 내부에서는 **localNodeId만 유지** (현재 동작 그대로).
- Tauri로 보낼 때만 prefix → `${projectId}:${localNodeId}`.
- Rust는 prefix를 그냥 HashMap key로 사용 — **코드 변경 없음**.

### 8.2 이벤트 라우팅
- 글로벌 `pty:*` / `graph:*` listener는 페이로드 `node_id`에서 `projectId`를 split.
- 해당 projectId의 executionStore로 dispatch: `getExecutionStore(projectId).setStatus(local, …)`.
- `terminalListeners` Map의 키를 풀 `proj:local` ID로 통일.

### 8.3 단순 ID 호환
- `single-${Date.now()}` 등 prefix 없는 ID는 송신 직전 active project로 prefix.

### 8.4 ProjectId 정규화
- ULID(26자) 사용 → `:`을 안 쓰는 알파벳만이라 split 안전.
- splitNodeId 유틸:
  ```ts
  export function splitNodeId(full: string): { projectId: string; localId: string } {
    const idx = full.indexOf(':');
    if (idx <= 0) return { projectId: '', localId: full };
    return { projectId: full.slice(0, idx), localId: full.slice(idx + 1) };
  }
  ```

---

## 9. 멀티탭 실행 동시성

| 영역 | 변경 |
|---|---|
| `PtyManager` (Rust) | 변경 없음. HashMap key가 prefix로 unique. |
| `HumanReviewRegistry` (Rust) | 변경 없음. |
| Provider rate limit | provider-global Token Bucket 그대로. 두 탭이 같은 provider를 쓰면 한 버킷에서 양보 — 의도된 동작. |
| 실행 중 탭 닫기 | confirm 모달: *"실행 중 N개 노드가 있습니다. 모두 종료하고 닫을까요?"* → kill all `proj:local` IDs → store dispose. |

---

## 10. Tauri 명령 변경

| 명령 | 변경 |
|---|---|
| `workspace_save` / `workspace_load` | v2 registry만 다룸 (글로벌). |
| **신규** `project_graph_save({ root, payload })` | `<root>/.loom/graph.json` 저장 |
| **신규** `project_graph_load({ root })` | 동일 |
| `list_providers` | 옵션 `override_path?: string` 추가. `Project.providersOverride` 우선. |
| `execute_single` / `graph_execute` / `node_*` | 페이로드 변경 없음 (node_id가 이미 prefix됨). |

의존성:
- `tauri-plugin-dialog` 추가 + `capabilities/default.json`에 `dialog:allow-open` 권한.

---

## 11. 파일 변경 목록

### Frontend
**신규**
- `src/stores/workspaceStore.ts`
- `src/design/components/TabBar.tsx`
- `src/design/components/EmptyWorkspace.tsx`
- `src/core/workdir.ts`
- `src/core/projectId.ts`
- `src/modes/plan/projectGraph.ts` (옛 `workspace.ts` 대체)

**수정**
- `src/stores/graphStore.ts` (factory 패턴)
- `src/stores/executionStore.ts` (factory 패턴)
- `src/stores/index.ts` (export + active-aware hook)
- `src/App.tsx` (탭 바, 빈 상태 분기)
- `src/modes/PlanMode.tsx`, `src/modes/SingleMode.tsx`, `src/modes/AutoMode.tsx`
- `src/modes/plan/Inspector.tsx` (Browse 버튼, placeholder)
- `src/modes/plan/usePlanExecution.ts` (node_id prefix, workdir resolve)
- `src/design/components/index.ts`

### Backend
- `src-tauri/src/workspace/mod.rs` (v2 registry + project_graph_save/load)
- `src-tauri/src/lib.rs` (새 commands 등록)
- `src-tauri/Cargo.toml` (`tauri-plugin-dialog`)
- `src-tauri/capabilities/default.json` (dialog permission)

### TUI
- `tui/bin/loom.ts` (`--project`, `--project-root` 플래그)
- `tui/src/cli/render.tsx` (project resolution helper)

---

## 12. 단계별 PR

| PR | 내용 | 검증 기준 |
|---|---|---|
| **6.1** 백본 | Project 타입, workspaceStore, v1→v2 마이그레이션, project_graph_save/load command, dialog plugin 추가. UI 없음(=첫 실행 시 디렉토리 픽 1회 → 단일 프로젝트로 동작) | 기존 동작 회귀 없음. typecheck + cargo check + node:test. |
| **6.2** 스토어 인스턴스화 | graphStore/executionStore factory, node_id prefix, usePlanExecution/SingleMode 리팩토링 | 동일 프로세스에 active project 1개일 때 100% 회귀 없음. |
| **6.3** TabBar + 빈 상태 + 단축키 | TabBar 컴포넌트, ⌘1~⌘9/⌘T/⌘W, DnD, 우클릭 메뉴, 빈 상태 화면 | 탭 5개 + 즉시 전환 시 캔버스가 정확히 스왑됨. |
| **6.4** 닫기 정책 + workdir Browse + 상태바 | 실행 중 탭 닫기 confirm, Inspector/Single의 Browse 버튼, 상태바 프로젝트 표시, 탭 status dot | 한 탭 실행 중 다른 탭으로 전환해도 PTY 안 멈춤. |
| **6.5** TUI 통합 | `--project*` 플래그, env vars, ad-hoc project | `pnpm loom run … --project foo`가 foo.root에서 동작. |

각 PR마다 `pnpm typecheck` + `cargo check --manifest-path src-tauri/Cargo.toml` + `pnpm tui:test` 통과 필수.

---

## 13. 엣지 케이스

1. **같은 root 중복 추가**: `realpath` dedup → 기존 프로젝트 활성화.
2. **root 디렉토리 부재**: 탭 라벨에 `(missing)` + 회색, 실행 시도 시 에러.
3. **`<root>/.loom/graph.json` 쓰기 실패**: 상태바 에러, 인메모리는 유지.
4. **providersOverride 상대경로**: addProject 시점에 absolute로 정규화.
5. **백그라운드 탭 실행 종료 알림**: 탭 좌측 dot 색으로 표시. 자동 활성 전환 없음. 토스트는 비-스코프.
6. **templates 디렉토리**: `~/.loom/templates/` 글로벌 그대로 — 프로젝트 간 공유가 자연스러움.
7. **첫 실행 마이그레이션 도중 픽 취소**: registry는 빈 상태로 v2로 마이그레이션 완료, 원본은 `workspace.v1.bak.json`으로 보존.

---

## 14. 비-스코프

- 프로젝트별 환경변수/시크릿 별도 보관
- 프로젝트별 모드(Single/Plan/Auto) 기본값 기억
- 외부 워크스페이스(원격) 지원
- 프로젝트별 rate limit 분리 (provider-global 그대로)
- 백그라운드 실행 완료 시 OS 토스트/배지

---

## 15. 측정 / 확인

- **PR 6.2 끝났을 때**: 두 탭에서 동일 그래프 실행 → 각 탭 store가 독립적으로 진행률 표시.
- **PR 6.3 끝났을 때**: 탭 5개 열고 ⌘1~⌘5로 전환 — 그래프 캔버스가 즉시 바뀜.
- **PR 6.4 끝났을 때**: 한 탭에서 실행 중인 상태로 다른 탭 활성화 → 백그라운드 탭의 PTY가 멈추지 않고 계속 진행.
- **PR 6.5 끝났을 때**: TUI에서 `--project` 플래그로 실행 시 해당 root가 cwd로 적용.
