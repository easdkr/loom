import "./styles/global.css";

function App() {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-4 p-8">
      <h1
        className="font-medium"
        style={{
          fontSize: "var(--text-2xl)",
          lineHeight: "var(--leading-2xl)",
          letterSpacing: "var(--tracking-emphasis)",
          color: "var(--fg-primary)",
        }}
      >
        Loom
      </h1>
      <p
        style={{
          color: "var(--fg-secondary)",
          fontSize: "var(--text-md)",
        }}
      >
        PTY-based local AI agent orchestrator
      </p>
      <p
        style={{
          color: "var(--fg-tertiary)",
          fontSize: "var(--text-sm)",
        }}
      >
        Scaffold ready · Phase 1 not yet started
      </p>
    </main>
  );
}

export default App;
