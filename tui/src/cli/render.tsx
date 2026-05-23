import { render, type Instance } from "ink";
import type { ReactElement } from "react";

export interface RenderHandle {
  instance: Instance;
  done: Promise<void>;
}

export function renderApp(element: ReactElement): RenderHandle {
  const instance = render(element, { exitOnCtrlC: false });
  return {
    instance,
    done: instance.waitUntilExit().then(() => undefined),
  };
}
