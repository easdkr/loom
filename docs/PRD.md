# Loom — 제품 기획서

> 버전 0.5 · 작성일 2026-05-23

---

## 목차

1. [제품 개요](#1-제품-개요)
2. [실행 모드 개요](#2-실행-모드-개요)
3. [핵심 개념](#3-핵심-개념)
4. [Provider 확장 시스템](#4-provider-확장-시스템)
5. [Single 모드](#5-single-모드)
6. [Plan 모드](#6-plan-모드)
7. [Auto 모드 — 에이전트 주도 그래프 구성](#7-auto-모드--에이전트-주도-그래프-구성)
8. [기술 스택 결정](#8-기술-스택-결정)
9. [아키텍처](#9-아키텍처)
10. [UI/UX 설계](#10-uiux-설계)
11. [디자인 시스템](#11-디자인-시스템)
12. [구현 로드맵](#12-구현-로드맵)
13. [미결 사항 및 리스크](#13-미결-사항-및-리스크)

> Phase 6의 멀티 프로젝트 워크스페이스 상세 설계는 [`docs/multi-project-workspace.md`](multi-project-workspace.md) 참고.

---

## 1. 제품 개요

### 1.1 한 줄 정의

Loom은 PTY 기반의 로컬 AI 에이전트 오케스트레이터다. 어떤 CLI 에이전트든 노드로 등록해 그래프로 구성하고, 오케스트레이터가 작업을 분배·실행·리뷰한다. 지금은 AI 코딩 에이전트에 집중하지만, 어떤 자동화 워커든 실(thread)처럼 받아 패브릭을 짜는 로컬 런타임으로 확장한다.

### 1.2 해결하는 문제

- AI 코딩 에이전트들(Claude Code, Codex, Cursor 등)은 각자 독립적으로 실행되며 협업 구조가 없다.
- 복잡한 작업을 병렬·직렬로 분배하고 결과를 통합하는 데 수동 조작이 필요하다.
- 새로운 에이전트 도구가 계속 등장하고 있지만, 기존 워크플로를 파괴하지 않고 추가·교체할 방법이 없다.

### 1.3 핵심 원칙

| 원칙 | 설명 |
|------|------|
| **Everything is a Node** | 오케스트레이터, 워커, 리뷰어, 라우터 모두 동일한 `AgentNode` 인터페이스 |
| **Provider 무관** | PTY로 실행 가능한 CLI라면 모두 Provider로 등록 가능 |
| **세 가지 모드** | Single(단일) → Plan(사람이 그래프 구성, 에이전트가 프롬프트 작성) → Auto(에이전트가 그래프 구성까지) |
| **로컬 퍼스트** | 모든 실행은 로컬. 외부 서비스 의존 없음 |
| **Headless 코어** | UI는 교체 가능한 어댑터. 코어 로직은 단일 구현 |


### 1.4 네이밍 근거

제품명 **Loom**은 직조기(베틀)에서 가져왔다.

> 직조기는 실의 재질을 가리지 않는다. 어떤 실이든 받아서 하나의 패브릭으로 엮는다.

이것이 이 제품이 하는 일이다. PTY 워커든, HTTP 워커든, 사람의 승인 단계든 — 어떤 노드든 받아서 하나의 실행 흐름으로 엮는다. 지금은 AI 코딩 에이전트에 집중하지만, 이름은 그 이상을 담는다.

```
loom run "OAuth 전환해줘"
loom plan
loom add claude-code
```

---

## 2. 실행 모드 개요

세 가지 모드는 복잡도와 자동화 수준에 따라 선택한다. 같은 UI에서 모드 전환이 가능하며, 어떤 모드로 시작해도 다른 모드로 업그레이드/다운그레이드할 수 있다.

```
─────────────────────────────────────────────────────────────────
  Single                 Plan                    Auto
  ──────                 ────                    ────
  단일 노드 직접 실행     사람이 그래프 구성       에이전트가 그래프까지 구성
  오케스트레이션 없음     에이전트가 프롬프트 작성  에이전트가 모든 것 결정
  가장 빠른 진입          사람이 검토·수정         사람은 최종 승인만
─────────────────────────────────────────────────────────────────
```

| 모드 | 그래프 구성 주체 | 프롬프트 작성 주체 | 사람 개입 |
|------|----------------|------------------|-----------|
| **Single** | 없음 (노드 1개) | 사람이 직접 입력 | 전체 |
| **Plan** | 사람 (드래그앤드롭) | 오케스트레이터 에이전트 | 검토·수정 |
| **Auto** | 오케스트레이터 에이전트 | 오케스트레이터 에이전트 | 승인만 |

세 모드는 독립적이지 않다. Auto 모드로 생성된 그래프는 Plan 모드로 전환해 노드를 수동 수정할 수 있고, Plan 모드 결과를 Single 노드로 축소하는 것도 가능하다.

---

## 3. 핵심 개념

### 3.1 AgentNode 인터페이스

모든 참여자(오케스트레이터, 워커, 리뷰어 등)가 구현하는 단일 인터페이스.

```typescript
interface AgentNode {
  id: string
  type: NodeType                    // 무한 확장 가능한 string union
  meta: NodeMeta                    // 이름, 아이콘, 색상 등 UI 정보

  receive(task: Task): Promise<TaskResult>

  // 자신이 내부에서 다른 AgentNode를 보유할 수 있음 → 재귀 중첩 허용
  children?: AgentNode[]

  // 노드 수명 주기
  onInit?(): Promise<void>
  onDestroy?(): Promise<void>
}
```

`AgentNode`를 구현하면 어떤 것이든 노드가 될 수 있다.

- 오케스트레이터 노드가 다른 오케스트레이터를 자식으로 보유 가능
- 단순 HTTP 호출, 쉘 스크립트, Python 스크립트도 노드로 등록 가능
- 사람이 개입하는 `HumanReviewNode`도 동일한 인터페이스

### 3.2 NodeType 레지스트리

```typescript
// 내장 타입 (확장 가능)
type BuiltinNodeType =
  | 'orchestrator:sequential'
  | 'orchestrator:parallel'
  | 'orchestrator:supervisor'
  | 'orchestrator:pipeline'
  | 'worker:pty'          // PTY 기반 CLI 워커 (Provider 지정)
  | 'worker:http'         // REST API 호출
  | 'worker:shell'        // 쉘 스크립트 실행
  | 'collector:result'    // 여러 결과 병합
  | 'reviewer:llm'        // LLM API 직접 호출로 품질 검토
  | 'reviewer:human'      // 사람 승인 대기
  | 'router:condition'    // 조건 기반 분기
  | 'trigger:webhook'     // 외부 이벤트 수신

// 플러그인이 확장
type NodeType = BuiltinNodeType | string
```

### 3.3 TaskContext

작업 단위의 컨텍스트. 노드 체인을 따라 흐르며 누적된다.

```typescript
interface TaskContext {
  id: string
  origin: Task                  // 원본 작업
  artifacts: Artifact[]         // 생성된 파일, diff, 코드 등
  history: ExecutionRecord[]    // 어떤 노드가 무엇을 했는지
  metadata: {
    startedAt: Date
    workdir: string
    env?: Record<string, string>
  }
}
```

`ResultCollector` 노드는 여러 `TaskContext`를 병합해 다음 노드(리뷰어 등)에 단일 컨텍스트로 전달한다.

### 3.4 Project (멀티 워크스페이스, Phase 6)

Loom은 여러 프로젝트(=루트 디렉토리)를 탭으로 동시에 다룬다. 한 프로세스 안에서 그래프·실행 상태는 프로젝트별로 격리되며, 백그라운드 탭의 PTY는 활성 탭 전환 후에도 계속 돈다.

```typescript
interface Project {
  id: string                  // ULID — 디렉토리 이동 후에도 동일하게 유지
  root: string                // realpath() 처리된 절대 경로
  name: string                // 기본 basename(root)
  providersOverride?: string  // 프로젝트별 providers.toml (선택)
  lastOpenedAt: number
}
```

핵심 결정:

- **디렉토리는 입력이 아니라 픽한다.** 모든 root와 노드 workdir은 OS 디렉토리 다이얼로그로 선택한다.
- 그래프·실행 상태 store는 `Map<projectId, StoreApi>`로 프로젝트별 인스턴스화한다 (dump/restore가 아닌 인스턴스 분리).
- 노드 ID는 Tauri 경계를 넘을 때만 `<projectId>:<localId>`로 prefix를 붙여 PTY 충돌을 막는다 — Rust는 opaque key로 통과시킨다.
- 탭 순서는 사용자가 DnD로 조정하는 수동 순서이며, MRU 자동정렬은 하지 않는다.
- 백그라운드 탭의 실행 상태는 탭 좌측 status dot으로 표시하되, 완료 시 자동 활성 전환은 하지 않는다.

상세 데이터 모델·스토리지 마이그레이션·PR 분할은 [`docs/multi-project-workspace.md`](multi-project-workspace.md).

### 3.5 PtyProvider 인터페이스

PTY 워커 노드가 참조하는 CLI 연결 어댑터.

```typescript
interface PtyProvider {
  name: string
  version?: string

  // PTY 세션 생성
  spawn(options: SpawnOptions): PtySession

  // CLI마다 다른 완료 신호 감지
  detectCompletion(buffer: string): boolean

  // 결과 추출 (ANSI 제거 포함)
  extractResult(buffer: string): string

  // 스트리밍 진행률 (선택)
  parseProgress?(chunk: string): ProgressUpdate | null

  // Rate limit 등 에러 감지 (선택)
  detectError?(buffer: string): ProviderError | null
}
```

---

## 4. Provider 확장 시스템

### 4.1 기본 제공 Provider

| Provider | CLI 도구 | 특성 | 최적 작업 유형 |
|----------|---------|------|--------------|
| `claude-code` | `claude` | PTY 인터랙티브 | 복잡한 설계, 파일시스템 조작, 아키텍처 판단 |
| `codex` | `codex` | PTY full-auto | 단순 코드 생성, 반복 작업 |
| `cursor` | `cursor` | PTY agent mode | IDE 컨텍스트 필요한 리팩토링 |
| `shell` | `bash/zsh` | 쉘 스크립트 | 빌드, 테스트 실행, 파일 조작 |
| `http` | — | HTTP 클라이언트 | 외부 LLM API, 내부 서비스 호출 |

### 4.2 Provider 등록 방식

#### A. 내장 등록 (config 파일)

```toml
# ~/.loom/providers.toml

[[providers]]
name = "claude-code"
type = "pty"
command = "claude"
args = ["--dangerously-skip-permissions"]
env = { FORCE_COLOR = "0", NO_COLOR = "1" }
completion_pattern = "✓|Task complete|>\\s*$"
cols = 220
rows = 50

[[providers]]
name = "aider"
type = "pty"
command = "aider"
args = ["--yes-always", "--no-pretty"]
completion_pattern = "^aider>\\s*$"

[[providers]]
name = "opendevin"
type = "pty"
command = "python"
args = ["-m", "opendevin.main"]
completion_pattern = "\\[DONE\\]|Finished"
```

#### B. 플러그인 등록 (TypeScript/JavaScript)

```typescript
// ~/.loom/plugins/my-provider.ts
import { defineProvider } from '@loom/sdk'

export default defineProvider({
  name: 'my-custom-agent',
  type: 'pty',

  spawn(options) {
    return pty.spawn('my-agent', ['--auto'], options)
  },

  detectCompletion(buffer) {
    return /AGENT_DONE/.test(buffer)
  },

  extractResult(buffer) {
    const match = buffer.match(/RESULT_START([\s\S]+?)RESULT_END/)
    return match?.[1]?.trim() ?? buffer
  }
})
```

#### C. 런타임 교체

노드가 실행 중이 아닐 때 동적으로 Provider를 교체할 수 있다.

```
현재 작업은 현재 Provider로 완료
→ 다음 작업부터 새 Provider 적용
→ 그래프 에디터에서 노드 우클릭 → "Replace Provider" 메뉴
→ 단축키 R 로도 가능
```

### 4.3 Provider 선택 전략

오케스트레이터가 작업을 분배할 때 Provider를 선택하는 기준.

```typescript
interface RoutingStrategy {
  // 기본: 작업 메타데이터 기반
  byTaskType?: Record<string, string>   // { 'architecture': 'claude-code', 'codegen': 'codex' }

  // 성능 기반 자동 라우팅
  byPerformance?: {
    metric: 'latency' | 'quality_score' | 'token_efficiency'
    fallbackProvider: string
  }

  // 커스텀 함수
  custom?: (task: Task, available: Provider[]) => Provider
}
```

---

## 5. Single 모드

### 5.1 개요

그래프 구성 없이 노드 하나로 바로 실행하는 모드. 작업 분배가 필요 없거나 빠르게 특정 Provider에 작업을 던질 때 사용한다. 오케스트레이터 레이어가 개입하지 않으며, PTY 워커 노드와 직접 통신한다.

```
사용자 입력 → [Provider 선택] → PTY 워커 노드 → 결과
```

### 5.2 동작 방식

- 화면 상단 또는 커맨드 팔레트(`⌘K`)에서 Provider를 선택하고 프롬프트를 입력한다.
- 그래프 캔버스에는 노드가 1개만 표시된다.
- AI Provider는 agent run/conversation view를 기본으로 사용하고, shell/debug Provider는 xterm.js terminal view를 사용한다.
- PTY transport는 동일하게 유지되며 raw 출력은 Raw 탭에서 확인할 수 있다.
- 작업 완료 후 "이 결과를 기반으로 그래프 구성" 버튼으로 Plan/Auto 모드로 전환할 수 있다.

### 5.3 Single → Plan/Auto 업그레이드

Single 모드 실행 결과(artifact, diff 등)를 컨텍스트로 담아 더 복잡한 후속 작업을 진행할 수 있다.

```
Single 실행 완료
  → "계속 작업하기" 선택
  → 결과물을 첫 번째 노드의 출력으로 간주
  → Plan 또는 Auto 모드로 그래프 확장
```

---

## 6. Plan 모드

### 6.1 개요

Plan 모드는 실행 전에 오케스트레이터가 전체 작업 계획을 생성하고, 사용자가 검토·수정 후 확정하는 단계다.

```
사용자 입력
    ↓
Orchestrator가 전체 태스크 분석
    ↓
각 노드에 할당할 작업 프롬프트 자동 생성
    ↓
Plan Review 패널 표시 (수정 가능)
    ↓
사용자 승인 (전체 or 개별)
    ↓
실행
```

### 6.2 Plan 생성 방식

오케스트레이터 노드는 두 가지 방식으로 플랜을 생성한다.

#### A. LLM 기반 (기본)

오케스트레이터 노드의 내부 LLM(API 직접 호출)이 입력 작업을 분석해 서브태스크로 분해하고, 각 워커 노드에 적합한 프롬프트를 작성한다.

```
입력: "사용자 인증 시스템을 OAuth 2.0으로 전환해줘"

오케스트레이터가 생성하는 플랜:
  Node-1 (claude-code) → "현재 auth 코드 분석 및 OAuth 전환 설계 문서 작성"
  Node-2 (codex)       → "설계 문서 기반으로 AuthService 클래스 구현"
  Node-3 (claude-code) → "구현된 코드 리뷰 및 보안 취약점 점검"
  Node-4 (shell)       → "테스트 실행: npm test -- --grep auth"
```

#### B. 템플릿 기반

자주 쓰는 그래프 패턴(예: "구현 → 리뷰 → 픽스 → 테스트")을 템플릿으로 저장하고, 태스크만 바꿔서 실행.

### 6.3 Plan Review UI

Plan 생성 후 표시되는 검토 패널의 동작.

```
┌─────────────────────────────────────────────────────┐
│  📋 실행 계획  (승인 전 수정 가능)              [승인] │
├─────────────────────────────────────────────────────┤
│  ✓ Node-1  claude-code                              │
│  ┌──────────────────────────────────────────────┐   │
│  │ 현재 auth 코드 분석 및 OAuth 전환 설계 문서  │   │
│  │ 작성. JWT 기반 현행 구조를 파악하고 OAuth    │   │
│  │ 2.0 authorization code flow 적용 방안을 ...  │   │
│  └──────────────────────────────────────────────┘   │
│  [편집]  [이 노드 건너뜀]  [다른 Provider로 교체]    │
│                                                     │
│  ✓ Node-2  codex                                    │
│  ┌──────────────────────────────────────────────┐   │
│  │ Node-1의 설계 문서를 기반으로 AuthService    │   │
│  │ 클래스를 구현...                             │   │
│  └──────────────────────────────────────────────┘   │
│  [편집]  [이 노드 건너뜀]  [다른 Provider로 교체]    │
└─────────────────────────────────────────────────────┘
```

#### 수정 가능한 항목

- 각 노드에 할당된 프롬프트 텍스트 (인라인 편집)
- 노드 실행 순서 (드래그)
- 노드에 배정된 Provider (드롭다운)
- 특정 노드 건너뜀 처리
- 새 노드 삽입 (플랜 중간에 노드 추가)

#### 단축키

| 키 | 동작 |
|----|------|
| `⌘↵` | 전체 플랜 승인 및 실행 |
| `Tab` | 다음 노드로 포커스 이동 |
| `E` | 포커스된 노드 프롬프트 편집 모드 |
| `Esc` | 편집 취소 |
| `R` | 포커스된 노드의 Provider 교체 |
| `S` | 포커스된 노드 건너뜀 토글 |
| `⌘Z` | 플랜 수정 Undo |

### 6.4 실행 중 Plan 변경

실행이 시작된 이후에도 **아직 시작되지 않은 노드**의 프롬프트는 수정할 수 있다. 이미 실행 중인 노드는 완료를 기다리거나 중단(`⌘.`)할 수 있다.

---

## 7. Auto 모드 — 에이전트 주도 그래프 구성

### 7.1 개요

Plan 모드가 "사람이 그래프를 만들면 에이전트가 프롬프트를 채운다"라면, Auto 모드는 **에이전트가 그래프 토폴로지 자체를 결정**한다. 사람은 작업을 입력하고, 에이전트가 제안한 그래프를 검토·수정한 뒤 승인하면 된다.

```
사용자: "결제 시스템을 PG사 2곳을 지원하도록 확장해줘"

오케스트레이터 에이전트가 판단:
  → 이 작업은 병렬 구현 + 통합 리뷰 구조가 적합
  → 노드 5개, Provider 배정, 실행 순서까지 자동 생성
  → 사용자에게 그래프 + 프롬프트 초안 제시
  → 승인 or 수정 후 실행
```

### 7.2 에이전트의 그래프 구성 판단 기준

오케스트레이터 에이전트(LLM API 직접 호출)가 작업을 분석해 다음을 결정한다.

| 판단 항목 | 예시 |
|-----------|------|
| **노드 수** | 단순 작업이면 1개, 복잡하면 N개 |
| **토폴로지** | 순차 / 병렬 / 다이아몬드(fan-out → collect) / 파이프라인 |
| **Provider 배정** | 작업 특성에 따라 각 노드에 적합한 Provider 선택 |
| **리뷰 노드 필요 여부** | 결과물 통합이나 품질 검토가 필요한지 판단 |
| **Human Review 삽입** | 위험도가 높은 변경(DB 스키마, 결제 로직 등)이면 자동 삽입 |

### 7.3 그래프 생성 프롬프트 구조

오케스트레이터 에이전트에게 전달되는 시스템 프롬프트의 핵심 구조.

```
시스템:
  당신은 소프트웨어 작업을 AI 에이전트 그래프로 분해하는 설계자입니다.
  사용 가능한 Provider: [claude-code, codex, cursor, shell, ...]
  사용 가능한 NodeType: [worker:pty, collector:result, reviewer:llm, reviewer:human, ...]

  작업을 분석해 다음을 JSON으로 반환하세요:
  {
    "reasoning": "왜 이 구조를 선택했는지",
    "complexity": "single | simple | complex",
    "graph": {
      "nodes": [...],
      "edges": [...],
      "topology": "sequential | parallel | diamond | pipeline"
    }
  }

  규칙:
  - 단순 작업(파일 1-2개 수정, 명확한 요구사항)은 single 노드로 판단
  - 독립적으로 병렬화 가능한 서브태스크가 있을 때만 병렬 노드 생성
  - 리스크가 큰 변경에는 reviewer:human 노드를 마지막에 배치
  - Provider는 작업 특성에 따라 배정 (설계/분석 → claude-code, 단순 구현 → codex)
```

### 7.4 Auto 모드 UX 흐름

```
1. 사용자가 자연어로 작업 입력
   "결제 시스템을 PG사 2곳 지원하도록 확장해줘"

2. 오케스트레이터가 complexity 판단
   → "single"  : Single 모드로 즉시 전환 제안
                 "단순 작업이라 노드 1개로 실행합니다. 바로 실행할까요?"
   → "complex" : 그래프 생성 후 Auto Review 패널 표시

3. Auto Review 패널 (complex인 경우)
   ┌──────────────────────────────────────────────────────────┐
   │  🤖 에이전트가 구성한 그래프                              │
   │  "병렬 구현 후 통합 리뷰가 적합하다고 판단했습니다."     │
   │  ─────────────────────────────────────────────────────  │
   │  Node-1 (claude-code) "Toss 결제 모듈 구현"             │
   │  Node-2 (codex)       "PortOne 결제 모듈 구현"          │
   │  Node-3 (collect)     "두 모듈 결과 병합"               │
   │  Node-4 (claude-code) "통합 코드 리뷰 및 공통화"        │
   │  ─────────────────────────────────────────────────────  │
   │  [그래프 수정]  [프롬프트 수정]  [승인 및 실행 ⌘↵]      │
   └──────────────────────────────────────────────────────────┘

4. 수정 가능한 항목
   - 노드 삭제/추가
   - Provider 교체
   - 각 노드 프롬프트 인라인 편집
   - 토폴로지 변경 (순차 ↔ 병렬)
   - 캔버스에서 직접 드래그앤드롭으로 재구성

5. 승인 후 실행
```

### 7.5 Complexity 판단 기준

오케스트레이터 에이전트가 `single`을 반환하면 Auto 모드가 Single 모드로 자동 축소된다. 이 판단이 이 모드의 핵심 가치다.

```
single 판단 조건 (하나라도 해당):
  - 변경 파일 수 ≤ 3개로 예상
  - 요구사항이 명확하고 분해 불필요
  - 단일 기술 도메인 (프론트만, DB만 등)
  - "빠르게", "간단히" 등 경량화 의도 표현

complex 판단 조건 (하나라도 해당):
  - 독립 구현 가능한 서브태스크 2개 이상
  - 구현 후 별도 리뷰/검증 단계 필요
  - 여러 기술 도메인 동시 변경
  - 결과물 통합이 필요한 경우
```

### 7.6 Auto → Plan 전환

Auto로 생성된 그래프는 언제든 Plan 모드로 전환해 세부 수정이 가능하다. 내부적으로 같은 데이터 구조를 사용하기 때문에 전환 비용이 없다.

---

## 8. 기술 스택 결정

### 8.1 UI 프레임워크: React vs Svelte

#### 비교

| 항목 | React | Svelte |
|------|-------|--------|
| 그래프 에디터 라이브러리 | **ReactFlow (xyflow)** — 성숙도 최고, 커뮤니티 최대 | Svelte Flow — 동일 팀 제작이나 훨씬 미성숙 |
| 실시간 PTY 스트림 반응성 | Zustand/Jotai 조합으로 충분 | 컴파일타임 반응성으로 이론상 유리 |
| 팀 친숙도 | Next.js 기반 코드베이스와 동일 생태계 | 러닝커브 있음 |
| 번들 크기 | Tauri WebView 내이므로 번들 크기 큰 의미 없음 | 동일 |
| 에코시스템 (xterm.js 연동 등) | 레퍼런스 풍부 | 제한적 |

#### 결론: **React**

그래프 에디터가 이 프로젝트의 핵심 UI 컴포넌트이며, ReactFlow는 노드 커스터마이징·엣지 라우팅·미니맵·단축키 시스템이 이미 구축되어 있다. Svelte Flow는 같은 팀이 만들었지만 API 불안정성 리스크가 있다.

---

### 8.2 데스크톱 프레임워크: Tauri vs iced

#### Tauri

- **구조**: Rust 백엔드 + 시스템 WebView (macOS: WKWebView, Windows: WebView2, Linux: WebKitGTK)
- **UI 작성**: React/Vue/Svelte 등 웹 기술 그대로 사용
- **PTY 처리**: `portable-pty` Rust crate — 검증된 구현
- **번들 크기**: ~5–15 MB (Electron 대비 1/10)

#### iced

- **구조**: 순수 Rust GUI 프레임워크, Elm 아키텍처 기반
- **UI 작성**: Rust 코드로 UI 선언
- **렌더링**: wgpu 기반 네이티브 렌더링 (WebView 없음)
- **번들 크기**: 가장 작음

#### 비교

| 항목 | Tauri | iced |
|------|-------|------|
| 그래프 에디터 구현 | ReactFlow 그대로 사용 | 직접 구현 (수개월 공수) |
| xterm.js PTY 출력 표시 | 그대로 사용 | 직접 구현 (VTE 바인딩 등) |
| 드래그앤드롭 | dnd-kit 등 즉시 사용 가능 | 직접 구현 |
| 개발 속도 | 빠름 | 느림 |
| 네이티브 성능 | WebView 오버헤드 있음 (실용상 무의미) | 우수 |
| macOS/Windows/Linux | 지원 | 지원 |
| 생태계 성숙도 | Tauri 2.0 — 안정 | iced 0.13 — 아직 RC 수준 |
| 학습 비용 | Rust 백엔드 + 웹 프론트 | Rust + iced 전용 패턴 |

#### 결론: **Tauri**

이 프로젝트의 핵심 난이도는 PTY 관리, 그래프 에디터, 실시간 터미널 출력이다. 세 가지 모두 웹 생태계에 이미 구현체가 있다(`portable-pty`, `ReactFlow`, `xterm.js`). iced를 선택하면 이것들을 모두 Rust로 재구현해야 하며, 이는 핵심 제품 가치와 무관한 공수다.

iced는 UI가 단순한 네이티브 유틸리티 앱에 적합하다. 이 프로젝트처럼 복잡한 그래프 에디터와 터미널 에뮬레이터가 필요한 경우는 Tauri가 압도적으로 유리하다.

---

### 8.3 최종 기술 스택

| 레이어 | 기술 | 역할 |
|--------|------|------|
| **데스크톱 셸** | Tauri 2.0 (Rust) | 앱 프레임워크, 윈도우 관리, 시스템 API |
| **PTY 관리** | `portable-pty` (Rust crate) | 크로스플랫폼 PTY 생성·관리 |
| **IPC** | Tauri 이벤트 버스 (Rust ↔ JS) | PTY 스트림, 실행 상태 전달 |
| **UI 프레임워크** | React 19 + TypeScript | 컴포넌트 트리 |
| **그래프 에디터** | ReactFlow (xyflow) v12 | 노드·엣지 편집, 미니맵, 단축키 |
| **터미널 출력** | xterm.js + xterm-addon-fit | PTY 출력 렌더링 |
| **상태 관리** | Zustand | 그래프 상태, 실행 상태 |
| **스타일링** | Tailwind CSS v4 | UI 스타일 |
| **플러그인 로더** | esbuild 런타임 번들링 | 외부 Provider 플러그인 로드 |
| **TUI (선택)** | ink.js | 헤드리스/CI 환경 |

---

## 9. 아키텍처

### 9.1 전체 구조

```
┌───────────────────────────────────────────────────────┐
│                    Tauri App                          │
│  ┌─────────────────────────────────────────────────┐  │
│  │              React Frontend                      │  │
│  │  ┌──────────────┐  ┌──────────────────────────┐ │  │
│  │  │ Graph Editor │  │  Plan Review Panel       │ │  │
│  │  │ (ReactFlow)  │  │  (노드별 프롬프트 편집)   │ │  │
│  │  └──────────────┘  └──────────────────────────┘ │  │
│  │  ┌──────────────────────────────────────────────┐│  │
│  │  │ Agent Run Views + Raw PTY Panels             ││  │
│  │  └──────────────────────────────────────────────┘│  │
│  └─────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────┐  │
│  │              Rust Core                           │  │
│  │  ┌────────────┐  ┌───────────┐  ┌────────────┐ │  │
│  │  │ PTY Manager│  │Task Graph │  │Plugin      │ │  │
│  │  │(portable-  │  │  Engine   │  │Registry    │ │  │
│  │  │   pty)     │  │           │  │            │ │  │
│  │  └────────────┘  └───────────┘  └────────────┘ │  │
│  └─────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────┘
```

### 9.2 Rust ↔ React IPC 이벤트

| 이벤트 | 방향 | 페이로드 |
|--------|------|---------|
| `pty:data` | Rust → React | `{ nodeId, chunk: string }` |
| `pty:complete` | Rust → React | `{ nodeId, result: string }` |
| `pty:error` | Rust → React | `{ nodeId, error: string }` |
| `graph:execute` | React → Rust | `{ plan: ExecutionPlan }` |
| `node:kill` | React → Rust | `{ nodeId }` |
| `node:write` | React → Rust | `{ nodeId, input: string }` |

### 9.3 TaskGraph 실행 엔진

```
ExecutionPlan {
  nodes: NodeConfig[]         // 정렬된 실행 순서
  edges: Edge[]               // 의존성 관계
  mode: 'sequential' | 'parallel' | 'dag'
}

실행 흐름:
  1. 위상 정렬(topological sort)으로 실행 순서 결정
  2. 의존성 없는 노드는 동시 실행 (Parallel)
  3. 각 노드 완료 시 다음 노드에 TaskContext 전달
  4. ResultCollector 노드: 여러 입력 대기 후 병합
```

### 9.4 디스크 레이아웃 (Phase 6 이후)

```
~/.loom/
  providers.toml          ← 기본 Provider 설정
  plugins/
    my-provider.ts        ← 커스텀 Provider 플러그인
    my-node-type.ts       ← 커스텀 NodeType 플러그인
  templates/
    review-pipeline.json  ← 저장된 그래프 템플릿 (프로젝트 간 공유)
  workspace.json          ← v2 글로벌 레지스트리: { projects, openTabs, activeTabId }

<project-root>/.loom/
  graph.json              ← 해당 프로젝트의 그래프(노드·엣지) 스냅샷
```

- 글로벌 `~/.loom/workspace.json`은 v1(단일 그래프 직접 저장)에서 v2(레지스트리만 저장)로 마이그레이션된다. v1 본문은 `workspace.v1.bak.json`으로 백업하고, 첫 실행 시 사용자가 root를 픽하면 해당 root의 `.loom/graph.json`으로 이식한다.
- 앱 시작 시 `~/.loom/plugins/`를 스캔해 esbuild로 번들링 후 동적 로드.

---

## 10. UI/UX 설계

(전체 디자인 시스템과 단축키, 노드 상태 등은 본문 11장 참고)

---

## 11. 디자인 시스템

핵심 토큰만 발췌. 전체 토큰 표는 `src/design/tokens/`에 CSS variables로 구현한다.

```
배경       bg/canvas #0E0E10  bg/surface #161618  bg/elevated #1F1F23
전경       fg/primary #E8E8EC  fg/secondary #A8A8B0  fg/tertiary #6E6E78
액센트     accent/default #4EC9B0 (차분한 청록 — 다크 위에서 튀지 않는 실 색)
의미       success #6FCF8E  warning #E8B85C  danger #E87878  info #7CA8E0
노드 카테고리  orchestrator #8478A8  worker #7898B8  collector #7EAA98
              reviewer #B89884  router #909098
타이포      sans (Inter)  mono (JetBrains Mono)  사이즈 11/12/13/14/16/20/24px
간격        4px 베이스 그리드
```

---

## 12. 구현 로드맵

### Phase 1 — 코어 엔진 (4–6주)
- AgentNode 인터페이스, Single 모드, PtyProvider (Claude/Codex/Cursor), portable-pty, TaskGraph 엔진, providers.toml, Tauri IPC

### Phase 2 — TUI 어댑터 (2주)
- ink.js TUI, PTY 멀티플렉싱, 기본 Plan Review

### Phase 3 — Desktop GUI (6–8주)
- 디자인 토큰, 컴포넌트 라이브러리, ReactFlow 에디터, agent run view, xterm.js raw fallback, Plan Review, 단축키, 그래프 저장/불러오기, Auto 모드, 모드 전환

### Phase 4 — 확장성 (4주)
- 플러그인 레지스트리, Supervisor/Pipeline, ResultCollector/Reviewer, 그래프 템플릿, Provider 런타임 교체

### Phase 5 — 안정화 (2주)
- PTY 완료 감지 엣지케이스, 에러 복구, 성능 최적화, 문서화

**Phase 5 1차 진행** (✓ 반영, ◔ 부분, ✗ 미착수):
- ✓ Sliding tail-window 완료 감지 (Rust + TUI 양쪽 `CompletionDetector`)
- ✓ Settle window — 완료 패턴 false positive 방어 (`settle_ms` per-provider)
- ✓ `error_pattern` + `error_class` (rate-limit / provider-error) 분류
- ✓ `BoundedBuffer` 출력 캡 (FIFO 회전 + `truncated` 플래그)
- ✓ 완료 패턴 매치 후 process 조기 종료 시에도 `completion-pattern` 유지
- ✓ 문서: [`docs/PROVIDERS.md`](PROVIDERS.md), [`docs/TROUBLESHOOTING.md`](TROUBLESHOOTING.md)
- ◔ Rate limit retry/backoff — 자동 재시도는 의도적 보류 (사용자가 다음 행동 결정)
- ✗ Windows ConPTY 경로 검증

### Phase 6 — 멀티 프로젝트 워크스페이스 (3주)
- v2 `~/.loom/workspace.json` 레지스트리 + 프로젝트별 `<root>/.loom/graph.json`
- 글로벌 싱글톤 store → `Map<projectId, StoreApi>` factory 패턴
- 노드 ID `<projectId>:<localId>` 네임스페이싱 (Rust 변경 없음)
- 상단 탭 바: DnD 정렬, ⌘1~⌘9 / ⌘T / ⌘W 단축키, 우클릭 컨텍스트 메뉴
- 빈 상태 화면 + 디렉토리 픽 온보딩 (텍스트 입력 없음)
- workdir Browse 버튼, 상태바 프로젝트 표시, 백그라운드 status dot
- 실행 중 탭 닫기 confirm 모달 — 활성 PTY 중단 후 닫기
- TUI `--project / --project-root` 플래그 + `LOOM_PROJECT*` 환경변수
- 의존성: `tauri-plugin-dialog`, capabilities 갱신

상세 PR 분할(6.1 ~ 6.5)과 데이터 모델은 [`docs/multi-project-workspace.md`](multi-project-workspace.md).

---

## 13. 미결 사항 및 리스크

- **PTY 완료 감지** (Phase 5에서 완화): tail-window 매칭 + `settle_ms` settle window + `idle_timeout_ms` fallback으로 false positive 방어. 그래도 새 CLI를 등록할 때는 `docs/PROVIDERS.md` 체크리스트 권장.
- **ANSI 코드 노이즈**: `NO_COLOR=1`로도 색이 새는 CLI 존재. `strip-ansi` 후처리 필수. (구현됨)
- **컨텍스트 오염**: 장시간 PTY 세션은 결과 품질 저하. 작업 단위 재시작이 기본값. (구현됨)
- **Rate Limit** (Phase 5에서 완화): `error_pattern`으로 감지 후 outcome `error_class=rate-limit`로 분류, 그래프 실행기가 fail-fast. 자동 재시도는 의도적 보류.
- **출력 버퍼 무한 증가** (Phase 5에서 완화): `max_output_bytes` FIFO 회전으로 메모리 상한 보장.
- **Windows 지원**: `portable-pty` ConPTY 경로 별도 검증. Phase 5+ 미해결.

---

*이 문서는 초기 기획 단계의 스냅샷이며, 구현 중 발견되는 제약에 따라 수정될 수 있습니다.*
