# Design token rule

이 프로젝트의 디자인 시스템은 CSS variables 기반이다. 절대 raw 값을 컴포넌트에 직접 쓰지 않는다.

## 금지

```tsx
// ❌
<div style={{ background: '#0E0E10', padding: 12 }} />
<div className="bg-[#0E0E10]" />
```

## 허용

```tsx
// ✅
<div style={{ background: 'var(--bg-canvas)', padding: 'var(--card-padding)' }} />
<div className="bg-[var(--bg-canvas)] p-[var(--card-padding)]" />
```

## 토큰 위치

- `src/design/tokens/colors.css` — 색상
- `src/design/tokens/typography.css` — 폰트, 사이즈, 굵기
- `src/design/tokens/spacing.css` — 간격, 모서리, 노드/패널 기하
- `src/design/tokens/motion.css` — 듀레이션, 이징, keyframes

새 토큰이 필요하면 위 파일에 추가하고, PR 설명에 추가 사유를 한 줄 적는다.

## 예외

- `src/design/tokens/*.css` 안의 raw 값 — 토큰 정의 자체이므로 raw OK
- xterm.js 옵션처럼 외부 라이브러리가 hex만 받는 경우 — `getComputedStyle`로 토큰을 읽어 전달
