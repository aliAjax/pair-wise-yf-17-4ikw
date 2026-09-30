import type { ReactNode } from "react";

export function Btn({
  children,
  onClick,
  primary,
  danger,
  disabled,
  small,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  small?: boolean;
  title?: string;
}) {
  const cls = ["btn", primary ? "btn-primary" : "", danger ? "btn-danger" : "", small ? "btn-small" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={cls} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: "gray" | "green" | "amber" | "red" | "blue" }) {
  return <span className={`badge badge-${tone ?? "gray"}`}>{children}</span>;
}

export function Banner({ children, tone }: { children: ReactNode; tone?: "amber" | "red" | "green" | "blue" }) {
  return <div className={`banner banner-${tone ?? "amber"}`}>{children}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
