---
description: "새 PtyProvider를 추가하는 절차를 안내한다"
---

새 PTY Provider를 추가하려 한다. 다음 순서대로 작업하라.

1. `src/providers/{{provider_name}}.ts` 파일 생성. `PtyProvider` 인터페이스 구현.
   - `spawn(options)`: `portable-pty` 호출 형태로 PTY 세션 생성
   - `detectCompletion(buffer)`: 정규식 패턴 매칭 + 안전한 fallback
   - `extractResult(buffer)`: ANSI 제거 후 결과 영역만 잘라냄 (반드시 `strip-ansi` 사용)
   - `parseProgress?` `detectError?` 는 선택

2. `src/providers/index.ts`의 builtin 레지스트리에 등록.

3. `docs/providers/{{provider_name}}.md` 작성:
   - 어떤 CLI인지, 어떤 작업에 강한지
   - 완료 신호 정규식 결정 근거
   - 알려진 엣지케이스 (Rate limit, false-positive 완료 등)

4. `src-tauri/src/pty/providers.rs`의 default config 예시에 추가.

5. 토큰은 절대 컴포넌트 직접 값으로 쓰지 말고 `src/design/tokens/*` 참조.

검증:
- `cargo check --manifest-path src-tauri/Cargo.toml` 통과
- `pnpm typecheck` 통과 (없으면 `tsc --noEmit`)
- 새 Provider 등록 후 Single 모드로 "echo hello" 같은 사소한 작업 실행해 PTY 출력이 흐르는지 수동 확인 안내
