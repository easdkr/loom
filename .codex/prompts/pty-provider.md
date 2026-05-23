# Adding a new PTY Provider

새 CLI 에이전트를 PTY Provider로 추가할 때 따라야 할 절차.

1. **CLI 동작 관찰**
   - 비대화형으로 띄울 수 있는 옵션 찾기 (`--yes`, `--no-prompt`, `--full-auto` 등)
   - `NO_COLOR=1 FORCE_COLOR=0` 환경에서도 색이 새는지 확인
   - 완료 신호: 프롬프트 복귀, 특정 마커, exit code 중 무엇이 가장 안정적인지

2. **`src/providers/<name>.ts` 작성**
   ```ts
   export const myProvider: PtyProvider = {
     name: '<name>',
     spawn(opts) { /* portable-pty 호출 */ },
     detectCompletion(buf) { return /패턴/.test(buf) },
     extractResult(buf) { return stripAnsi(buf).trim() },
   }
   ```

3. **타임아웃 fallback 반드시 명시**
   - 정규식이 실패하면 N초 후 강제 종료
   - 사용자에게 "감지 실패로 종료됨" 표시

4. **테스트**
   - 짧은 작업("echo hello") 1건
   - 긴 작업(파일 수정) 1건
   - 의도적 에러(잘못된 명령) 1건

5. **문서**
   - `docs/providers/<name>.md` 작성
   - `~/.loom/providers.toml` 기본값 예시 추가
