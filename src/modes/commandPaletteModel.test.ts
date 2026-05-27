import test from "node:test";
import assert from "node:assert/strict";
import { filterCommandItems, type CommandPaletteItem } from "./commandPaletteModel";

const noop = () => undefined;

const items: CommandPaletteItem[] = [
  { id: "workspace:loom", group: "Workspace", label: "Loom", detail: "main", run: noop },
  {
    id: "repo:admin",
    group: "Repository",
    label: "admin-backend",
    detail: "feature/workspace-ui",
    keywords: ["/tmp/admin"],
    run: noop,
  },
  { id: "mode:plan", group: "Mode", label: "Switch to Plan", run: noop },
];

test("filterCommandItems returns all commands for an empty query", () => {
  assert.deepEqual(filterCommandItems(items, "").map((item) => item.id), [
    "workspace:loom",
    "repo:admin",
    "mode:plan",
  ]);
});

test("filterCommandItems matches group, detail, and keywords with all query tokens", () => {
  assert.deepEqual(filterCommandItems(items, "repo ui").map((item) => item.id), ["repo:admin"]);
  assert.deepEqual(filterCommandItems(items, "tmp admin").map((item) => item.id), ["repo:admin"]);
  assert.deepEqual(filterCommandItems(items, "mode plan").map((item) => item.id), ["mode:plan"]);
});
