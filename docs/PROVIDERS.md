# Provider 가이드

Loom은 어떤 CLI 에이전트든 `Provider`로 등록할 수 있다. 이 문서는 신규 Provider를 추가하는 절차와 각 필드의 의미·기본값·체크리스트를 정리한다.

전체 PTY 강화 항목(완료 감지 / 에러 복구 / 출력 캡 / settle window)은 Phase 5에서 도입됐다. 아래 필드는 모두 후방 호환을 가지며, 신규 필드를 비워두면 안전한 기본값이 적용된다.

## 1. providers.toml 형식

`~/.loom/providers.toml`에 다음 구조로 정의한다. 첫 실행 시 `loom init` 또는 데스크톱 앱이 기본 템플릿을 생성한다.

```toml
[[providers]]
name = "claude-code"
type = "pty"
command = "claude"
args = ["--permission-mode", "bypassPermissions"]
input_mode = "append-arg"

# 1) 완료 감지
completion_pattern = "(?m)(Task complete|Done|Finished|>\\s*$)"

# 2) 에러 감지 (선택)
error_pattern = "(?i)(rate.?limit|429 too many|usage limit|quota exceeded|context length exceeded)"

# 3) 타이밍
completion_timeout_ms = 1800000   # 전체 작업 상한 (30분)
idle_timeout_ms       = 300000    # 출력 정지 후 idle 상한 (5분)
settle_ms             = 1200      # 완료 패턴 매치 후 안정화 대기

# 4) 출력 관리
max_output_bytes = 2097152        # 최대 2 MiB까지 보관 (이후 FIFO 회전)

# 5) 터미널 형상
cols = 220
rows = 50

# 6) 환경 변수
env = { FORCE_COLOR = "0", NO_COLOR = "1", TERM = "xterm-256color" }
```

## 2. 필드 레퍼런스

### `name` (필수)
Provider 식별자. 노드 설정의 `provider` 필드와 매칭된다. 동일한 이름은 마지막 정의가 이긴다.

### `type` (필수)
현재는 `"pty"`만 의미가 있다. 향후 `"http"` / `"shell"` 등이 추가될 예정.

### `command` / `args`
실행할 바이너리와 인자. PATH에서 찾는다.

> **금지**: `claude --print` (또는 `-p`)는 Loom이 강제로 거부한다. PTY interactive 모드만 허용.

### `input_mode`
- `append-arg`: 프롬프트를 마지막 args로 추가. (예: `claude --xxx "프롬프트"`)
- `stdin`: spawn 후 stdin에 `<prompt>\n` 작성.

### `completion_pattern` (정규식)
출력 tail에서 매치되면 완료로 간주. **항상 `settle_ms` 안정화 후 실제 종료한다** — Phase 5 false positive 방어.

권장:
- `(?m)` (multiline) 플래그로 라인 단위 매치
- CLI가 종료 시 출력하는 고유 마커를 사용
- 너무 일반적인 단어는 피한다 (예: `OK`, `Done` 단독은 위험 — 모델이 본문에 echo할 수 있음)

### `error_pattern` (선택, 정규식)
출력에 매치되면 즉시 실패로 마킹한다. 매치된 chunk를 보고 `error_class`를 분류한다:
- `rate-limit` — rate limit, 429, quota, usage limit, context length 관련 단어
- `provider-error` — 그 외 모든 매치

빈 문자열이면 비활성.

### `settle_ms` (기본 800ms)
완료 패턴 매치 후 **추가 출력 없이** 이 시간을 더 기다린다. 이전에 완료처럼 보이는 문구가 본문에 등장하더라도 후속 출력이 이어지면 false positive로 무시한다. shell처럼 결정적인 완료 마커(`LOOM_EXIT:0`)를 쓰는 경우 200ms 정도면 충분.

### `completion_timeout_ms` / `idle_timeout_ms`
- `completion_timeout_ms`: 전체 작업 상한. 초과 시 강제 종료 (`timed_out=true`).
- `idle_timeout_ms`: 마지막 출력 이후 정적 시간 상한. PTY가 멈춘 채 대기하는 상황 감지용.

### `max_output_bytes` (기본 1 MiB)
PTY raw 출력을 최대 N 바이트까지 보관한다. 초과 시 head FIFO로 폐기하고 outcome에 `truncated=true` 마킹. 장기 세션에서 메모리 누수를 막는다.

### `cols` / `rows`
PTY 형상. 작업 환경에 맞춰 결정 (대형 모델은 220x50 권장).

### `env`
CLI에 전달할 환경 변수. ANSI 노이즈를 줄이려면 항상 `FORCE_COLOR=0`, `NO_COLOR=1`을 설정.

## 3. 추가 체크리스트

1. `~/.loom/providers.toml`에 항목 추가
2. 데스크톱 앱 또는 `pnpm loom providers`로 인식 여부 확인
3. `pnpm loom run "echo hi" --provider <name>` 또는 `loom plan` 으로 실제 PTY 동작 확인
4. `completion_pattern`이 매치되지 않으면 `--timeout` 또는 `idle_timeout_ms` fallback이 발동하는지 관찰
5. Rate limit 시 `error_class=rate-limit`이 emit되는지 노드 상태 패널에서 확인

## 4. 플러그인 Provider (실험적)

`~/.loom/plugins/providers/*.toml`은 자동으로 머지된다 (이름 충돌 시 사용자 설정이 우선). 향후 JS/TS 플러그인은 esbuild 런타임 번들링으로 지원할 예정 — Phase 4 인프라 참고.

## 5. 디버깅 팁

- **완료 감지가 false positive인 경우** → `settle_ms`를 늘리거나 `completion_pattern`을 더 특이하게.
- **완료 감지가 안 됨** → `idle_timeout_ms`만 짧게 두면 idle fallback으로 종료된다.
- **ANSI 잔여 노이즈** → `env`에 `FORCE_COLOR=0`, `NO_COLOR=1`, `TERM=xterm-256color` 모두 설정.
- **출력이 잘림** → `max_output_bytes` 증가 (단, 큰 값은 메모리 부담).

자세한 PTY 엣지케이스는 [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) 참고.
