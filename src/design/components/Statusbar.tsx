import type { HTMLAttributes, ReactNode } from "react";

interface StatusbarProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Statusbar({ className, children, ...rest }: StatusbarProps) {
  return (
    <div
      role="status"
      className={["ds-statusbar", className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </div>
  );
}

export function StatusbarSpacer() {
  return <div className="ds-statusbar-spacer" aria-hidden />;
}
