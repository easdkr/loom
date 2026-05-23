# Troubleshooting

Phase 5 안정화 작업에서 강화한 항목 + 알려진 엣지 케이스를 모은다. 동작이 이상하면 여기서 먼저 확인.

## 1. PTY 완료 감지 (Completion Pattern)

### 증상: 작업이 끝났는데 노드가 종료되지 않는다
- **원인**: `completion_pattern`이 출력 tail에 매치되지 않음.
- **확인**: 노드 출력 패널 마지막 줄에 패턴이 실제로 등장하는지 확인.
- **조치**:
  1. `idle_timeout_ms`을 짧게 (예: 60_000) 두면 `idle-timeout-fallback`이 발동하여 자동 종료된다.
  2. `completion_pattern`을 더 일반적으로 (예: `(?m)Done|Finished|>\s*$`).
  3. CLI 종료 후 prompt가 다시 그려진다면 `(?m)>\s*$` 같이 prompt 모양을 매치.

### 증상: 작업이 너무 일찍 끝난다 (false positive)
- **원인**: 모델이 본문에서 "Task complete" 같은 단어를 echo했다.
- **방어**: Phase 5 부터 **settle window** 도입. 패턴 매치 후 `settle_ms`동안 추가 출력이 없을 때만 finalize한다.
- **조치**:
  1. `settle_ms`를 늘린다 (claude/codex 기본 1200ms).
  2. `completion_pattern`을 CLI 종료 시에만 나오는 특이 문구로 좁힌다 (예: shell의 `LOOM_EXIT:\d+`).

### 증상: 완료 패턴은 매치됐는데 process가 살아있다
- Phase 5 부터 settle 도달 시 `requestFinish` → grace 1500ms → kill 호출. process가 SIGTERM을 무시하면 더 강제하지 않는다.
- **조치**: provider의 `command`에 `--no-interactive` 등 종료 보장 옵션이 있는지 확인.

## 2. ANSI 노이즈

### 증상: 출력에 ESC 시퀀스 / 깨진 글자가 보인다
- Loom은 raw PTY 출력은 그대로 스트리밍하되, **결과 텍스트**에는 `strip-ansi` + private-use codepoint 제거를 적용한다.
- 일부 CLI는 `NO_COLOR=1`을 무시한다. provider env에 다음을 모두 설정:
  - `FORCE_COLOR=0`
  - `NO_COLOR=1`
  - `TERM=xterm-256color`
- 그래도 새면 provider별로 `--no-color`, `--plain`, `--color never` 등 옵션을 args에 추가.

### 증상: 한글이 깨진다 (`?` 또는 사각형)
- Loom의 UTF-8 stream decoder가 chunk 경계에서 한글을 보존한다. 그래도 깨지면:
  - terminal/font가 한글을 못 그리는 경우 — JetBrains Mono / D2Coding 등 한글 지원 폰트 사용
  - PTY 형상이 너무 좁아 wrap이 깨질 때 — `cols`을 220 이상으로

## 3. 컨텍스트 오염

### 증상: 후속 작업 결과가 이상하다 (이전 작업 영향이 남는다)
- Loom은 **작업 단위 PTY 세션 재시작**이 기본값. 같은 노드에서 여러 작업을 연속 실행하지 않는다.
- 노드를 재사용해 여러 task를 던지지 않는다 — Plan/Auto 모드는 매번 새 PTY를 띄운다.
- 그래도 영향이 보이면: workdir이 이전 결과를 가지고 있을 수 있다. provider env에 `--workdir` 격리 옵션 추가.

## 4. Rate Limit / 에러 복구

### 증상: 429나 quota 에러가 났는데 노드가 success로 기록됐다
- Phase 5에서 **error_pattern**을 도입. 빈 문자열이면 비활성이므로, provider에 다음과 같이 추가:
  ```toml
  error_pattern = "(?i)(rate.?limit|429 too many|usage limit|quota exceeded|context length exceeded)"
  ```
- 매치되면 outcome에 `error_class: "rate-limit" | "provider-error"`가 마킹된다.
- 그래프 실행 시 `isSuccessfulOutcome()`이 false를 반환하여 후속 노드가 차단된다.

### 증상: rate limit 후 자동 재시도가 안 된다
- 현재 Loom은 retry/backoff을 빌트인하지 않는다 (의도적: 사용자가 다음 행동을 결정).
- Plan Review에서 실패 노드 우클릭 → "Replace Provider" 또는 "Edit Prompt" 후 재실행.

## 5. 출력 버퍼

### 증상: 매우 긴 세션에서 메모리 사용량이 계속 늘어난다
- Phase 5 이전에는 raw output이 무한 누적됐다. 이제 **`max_output_bytes`** (기본 1 MiB / claude 2 MiB) 까지만 보관하고 FIFO 회전한다.
- outcome.truncated=true가 마킹된다.

### 증상: 결과 텍스트가 잘려있다
- truncated가 true이면 head 출력이 폐기됐다는 뜻.
- `max_output_bytes`를 늘리거나, 노드가 청크 단위로 결과를 emit하도록 CLI 옵션 조정.

## 6. 타임아웃

| 옵션 | 의미 | 권장값 |
|------|------|--------|
| `completion_timeout_ms` | 전체 작업 상한 | 30분 (claude/codex), 2분 (shell) |
| `idle_timeout_ms` | 마지막 출력 후 정적 상한 | 5분 (claude/codex), 30초 (shell) |
| `settle_ms` | 완료 패턴 안정화 | 1200ms (claude/codex), 200ms (shell) |
| `EXIT_GRACE_MS` | finalize 직전 kill grace | 1500ms (전역) |

settle_ms × 1.5 < idle_timeout_ms 가 안전.

## 7. Plan 실행 중 노드 실패 처리

- 한 노드가 실패하면 현재 batch가 끝난 후 다음 batch는 실행하지 않는다 (fail-fast).
- 실패 노드를 건너뛰고 진행하려면 Plan Review에서 해당 노드를 `s` (skip)로 마킹.

## 8. Windows / Linux

- Phase 5 기준 macOS 우선, Linux best-effort.
- Windows ConPTY 경로는 Phase 5+에서 추가 검증 예정.
- 알려진 Windows 한계: portable-pty의 ConPTY는 컬러 시퀀스 정규화가 다르다 — ANSI 패턴 매치가 다르게 동작할 수 있음.

## 9. 진단 명령

```bash
# Provider 등록 확인
pnpm loom providers

# Single 노드로 빠르게 PTY 동작 확인
pnpm loom run "echo hi" --provider shell

# Plan 모드 dry run
pnpm loom plan "test" --template single --yes

# Rust 측 PTY 유닛 테스트
cargo test --manifest-path src-tauri/Cargo.toml --lib pty

# TUI 통합 테스트 (실제 PTY spawn 포함)
pnpm tui:test
```

## 10. 자주 묻는 질문

**Q. `claude --print`는 왜 막혀 있나요?**
A. `--print` 모드는 stdin에 입력을 던지면 응답을 한 번에 stdout에 출력하고 종료하는 비-인터랙티브 모드입니다. Loom의 PTY 오케스트레이션은 interactive 세션을 전제로 합니다 (스트리밍, 컨텍스트 유지, 조기 종료 등). 오용 방지를 위해 코드 레벨에서 강제 거부합니다.

**Q. 모든 Provider에 `error_pattern`을 똑같이 써도 되나요?**
A. 기본 `RATE_LIMIT_PATTERN`은 일반화돼 있어 대부분 그대로 사용해도 됩니다. 다만 CLI마다 에러 형식이 다르므로, 특정 CLI에만 등장하는 에러 단어(예: `Cursor: aborted`)를 추가하면 정확도가 올라갑니다.

**Q. `settle_ms`를 너무 크게 잡으면 어떻게 되나요?**
A. 작업 종료 후 `settle_ms` 만큼 idle 대기 후 finalize됩니다. 사용자 체감 지연이 증가합니다. 단, `completion_timeout_ms`나 `idle_timeout_ms`에는 영향을 주지 않습니다.
