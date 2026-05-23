import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

type FieldSize = "md" | "sm";

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  inputSize?: FieldSize;
}

export function Input({ className, inputSize = "md", ...rest }: InputProps) {
  return (
    <input
      className={["ds-input", className].filter(Boolean).join(" ")}
      data-size={inputSize}
      {...rest}
    />
  );
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  inputSize?: FieldSize;
}

export function Select({ className, inputSize = "md", children, ...rest }: SelectProps) {
  return (
    <select
      className={["ds-select", className].filter(Boolean).join(" ")}
      data-size={inputSize}
      {...rest}
    >
      {children}
    </select>
  );
}

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function Textarea({ className, ...rest }: TextareaProps) {
  return (
    <textarea
      className={["ds-textarea", className].filter(Boolean).join(" ")}
      spellCheck={false}
      {...rest}
    />
  );
}

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Field({ label, hint, children, className }: FieldProps) {
  return (
    <label className={["ds-field", className].filter(Boolean).join(" ")}>
      <span className="ds-field-label">{label}</span>
      {children}
      {hint}
    </label>
  );
}
