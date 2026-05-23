import { Button } from "@design/components";
import { useGraphStore } from "@stores/index";
import { PALETTE, type PaletteEntry } from "./node-catalog";

let counter = 0;
function nextId(type: string) {
  counter += 1;
  const slug = type.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  return `${slug}-${Date.now().toString(36)}-${counter}`;
}

function NodePalette() {
  const nodes = useGraphStore((state) => state.nodes);
  const upsertNode = useGraphStore((state) => state.upsertNode);
  const selectNode = useGraphStore((state) => state.selectNode);

  function spawn(entry: PaletteEntry) {
    const id = nextId(entry.type);
    const offsetIndex = nodes.length;
    upsertNode({
      id,
      type: entry.type,
      meta: { ...entry.meta },
      provider: entry.defaultProvider,
      prompt: entry.defaultPrompt,
      position: {
        x: 40 + (offsetIndex % 3) * 320,
        y: 40 + Math.floor(offsetIndex / 3) * 220,
      },
    });
    selectNode(id);
  }

  return (
    <div className="plan-palette">
      {PALETTE.map((entry) => (
        <Button
          key={entry.type}
          className="plan-palette-item"
          variant="ghost"
          onClick={() => spawn(entry)}
        >
          <span className="plan-palette-name">{entry.meta.name}</span>
          <span className="plan-palette-type">{entry.type}</span>
        </Button>
      ))}
    </div>
  );
}

export default NodePalette;
