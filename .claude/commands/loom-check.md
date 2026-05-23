---
description: "타입체크 + Rust 체크 + 포맷을 한꺼번에 돌린다"
---

모든 체크를 순서대로 실행하라. 첫 실패에서 중단하고 원인을 보고하라.

```bash
pnpm typecheck 2>/dev/null || pnpm tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

실패하면 무엇이 어디서 깨졌는지 한 단락으로 정리한 뒤, 고칠 위치(파일:라인)와 수정안을 제시하라.
