import type { HTMLAttributes, ReactNode } from "react";

interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  bodyFlush?: boolean;
  children: ReactNode;
}

export function Panel({
  title,
  actions,
  flush,
  bodyFlush,
  className,
  children,
  ...rest
}: PanelProps) {
  return (
    <section
      className={["ds-panel", className].filter(Boolean).join(" ")}
      data-flush={flush ? "true" : "false"}
      {...rest}
    >
      {(title || actions) && (
        <header className="ds-panel-header">
          <span>{title}</span>
          <span style={{ marginLeft: "auto" }}>{actions}</span>
        </header>
      )}
      <div className="ds-panel-body" data-flush={bodyFlush ? "true" : "false"}>
        {children}
      </div>
    </section>
  );
}
