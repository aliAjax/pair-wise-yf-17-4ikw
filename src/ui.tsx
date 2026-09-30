import { Batch } from "./types";

export function Badge({
  tone = "gray",
  children,
}: {
  tone?: "gray" | "green" | "red" | "amber" | "blue" | "brown";
  children: React.ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function batchTag(b: Batch): string {
  return `${b.deviceId}#${b.seq}`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function describeEntry(e: import("./types").EntryData): string {
  switch (e.kind) {
    case "pipe":
      return `音管 ${e.pipeId}（${e.stopId}）· ${fieldName(e.field)} = ${e.value}`;
    case "abnormal":
      return `音管 ${e.pipeId} ${e.abnormal ? "标记异常" : "申请解除异常"}${e.reason ? `：${e.reason}` : ""}`;
    case "stop":
      return `音栓 ${e.stopId}${e.recheckDone ? " · 复检完成" : ""}${e.name ? `（${e.name}）` : ""}`;
    case "climate":
      return `温湿度 ${e.temperature}°C / ${e.humidity}%${e.note ? ` · ${e.note}` : ""}`;
  }
}

function fieldName(f: string): string {
  return { pitch: "音高", cent: "音分偏差", reed: "簧片状态", note: "维修备注" }[f] ?? f;
}
