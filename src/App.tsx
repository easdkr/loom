import "./styles/global.css";
import "./styles/app.css";
import { Toolbar } from "@design/components";
import { useSettingsStore, type LoomMode } from "@stores/index";
import SingleMode from "@modes/SingleMode";
import PlanMode from "@modes/PlanMode";
import AutoMode from "@modes/AutoMode";

const MODE_ITEMS: { id: LoomMode; label: string }[] = [
  { id: "single", label: "Single" },
  { id: "plan", label: "Plan" },
  { id: "auto", label: "Auto" },
];

function App() {
  const mode = useSettingsStore((state) => state.mode);
  const setMode = useSettingsStore((state) => state.setMode);

  return (
    <div className="loom-app">
      <header className="loom-app-topbar">
        <div className="loom-brand">Loom</div>
        <Toolbar items={MODE_ITEMS} value={mode} onChange={setMode} />
      </header>
      <div className="loom-app-body">
        {mode === "single" && <SingleMode />}
        {mode === "plan" && <PlanMode />}
        {mode === "auto" && <AutoMode />}
      </div>
    </div>
  );
}

export default App;
