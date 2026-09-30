import { useMemo, useState } from "react";
import { EntryData, PipeField, PIPE_FIELDS, FIELD_LABEL } from "./types";
import { useStore } from "./useStore";
import { Badge, describeEntry } from "./ui";

type Kind = EntryData["kind"];

export function BatchComposer() {
  const store = useStore();
  const device = store.state.devices.find((d) => d.id === store.state.currentDeviceId);
  const tech = device?.tech ?? "";
  const m = useMemo(() => store.merged(), [store.state.serverBatches]);

  const knownPipes = [...m.pipes.values()].map((p) => ({
    pipeId: p.pipeId,
    stopId: p.stopId,
  }));
  const knownStops = [...m.stops.values()].map((s) => ({
    stopId: s.stopId,
    name: s.name,
  }));

  const [kind, setKind] = useState<Kind>("pipe");
  const [stopId, setStopId] = useState(knownStops[0]?.stopId ?? "trumpet-8");
  const [pipeId, setPipeId] = useState(knownPipes[0]?.pipeId ?? "TP-Cs4");
  const [field, setField] = useState<PipeField>("cent");
  const [value, setValue] = useState("");
  const [abnormal, setAbnormal] = useState(true);
  const [reason, setReason] = useState("");
  const [stopName, setStopName] = useState("");
  const [recheckDone, setRecheckDone] = useState(false);
  const [temperature, setTemperature] = useState(m.climate?.temperature?.toString() ?? "19.5");
  const [humidity, setHumidity] = useState(m.climate?.humidity?.toString() ?? "42");
  const [climateNote, setClimateNote] = useState("");
  const [entries, setEntries] = useState<EntryData[]>([]);

  const addEntry = () => {
    let e: EntryData | null = null;
    if (kind === "pipe") {
      if (!pipeId.trim() || !stopId.trim() || !value.trim()) return;
      e = { kind: "pipe", pipeId: pipeId.trim(), stopId: stopId.trim(), field, value: value.trim() };
    } else if (kind === "abnormal") {
      if (!pipeId.trim() || !stopId.trim()) return;
      e = {
        kind: "abnormal",
        pipeId: pipeId.trim(),
        stopId: stopId.trim(),
        abnormal,
        reason: reason.trim() || undefined,
      };
    } else if (kind === "stop") {
      if (!stopId.trim()) return;
      e = {
        kind: "stop",
        stopId: stopId.trim(),
        name: stopName.trim() || undefined,
        recheckDone,
      };
    } else {
      const t = parseFloat(temperature);
      const h = parseFloat(humidity);
      if (!Number.isFinite(t) || !Number.isFinite(h)) return;
      e = {
        kind: "climate",
        at: Date.now(),
        temperature: t,
        humidity: h,
        note: climateNote.trim() || undefined,
      };
    }
    setEntries((es) => [...es, e as EntryData]);
    setValue("");
    setReason("");
  };

  const save = () => {
    if (entries.length === 0) return;
    const r = store.saveDraft(tech, entries);
    if (r.ok) setEntries([]);
  };

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>现场记录 · {tech} · {store.state.currentDeviceId}</p>
          <h2>补记一笔修改</h2>
          <small className="muted">
            本笔将占用连续记录号 #{store.currentSeq() + 1}；未确认前不进入单次维护报告。
            同笔可包含多条修改（如先记温湿度、再记音分偏差）。
          </small>
        </div>
        <Badge tone={store.state.online ? "green" : "amber"}>
          {store.state.online ? "在线" : "离线 · 本机暂存"}
        </Badge>
      </div>

      <div className="kind-tabs">
        {([
          ["pipe", "音管字段"],
          ["abnormal", "异常标记/解除"],
          ["stop", "音栓复检"],
          ["climate", "温湿度"],
        ] as [Kind, string][]).map(([k, label]) => (
          <button
            key={k}
            data-kind={k}
            className={kind === k ? "tab active" : "tab"}
            onClick={() => setKind(k)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="field-grid form-body">
        {kind !== "climate" && (
          <label>
            <span>音栓</span>
            <input list="stop-list" value={stopId} onChange={(e) => setStopId(e.target.value)} />
            <datalist id="stop-list">
              {knownStops.map((s) => (
                <option key={s.stopId} value={s.stopId}>
                  {s.name}
                </option>
              ))}
            </datalist>
          </label>
        )}
        {kind === "pipe" || kind === "abnormal" ? (
          <label>
            <span>音管编号</span>
            <input list="pipe-list" value={pipeId} onChange={(e) => setPipeId(e.target.value)} />
            <datalist id="pipe-list">
              {knownPipes.map((p) => (
                <option key={p.pipeId} value={p.pipeId} />
              ))}
            </datalist>
          </label>
        ) : null}

        {kind === "pipe" && (
          <>
            <label>
              <span>字段（合并主键之一）</span>
              <select value={field} onChange={(e) => setField(e.target.value as PipeField)}>
                {PIPE_FIELDS.map((f) => (
                  <option key={f} value={f}>
                    {FIELD_LABEL[f]}
                  </option>
                ))}
              </select>
            </label>
            <label className="wide">
              <span>{FIELD_LABEL[field]}值</span>
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={field === "cent" ? "如 +6 / -12（音分）" : "填写内容"}
              />
            </label>
          </>
        )}

        {kind === "abnormal" && (
          <>
            <label>
              <span>动作</span>
              <select value={abnormal ? "1" : "0"} onChange={(e) => setAbnormal(e.target.value === "1")}>
                <option value="1">标记为异常音管</option>
                <option value="0">申请解除异常</option>
              </select>
            </label>
            <label className="wide">
              <span>原因 / 说明</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：复检通过、偏差回到 ±5 音分内" />
            </label>
            {!abnormal && (
              <p className="hint wide">
                解除会被守卫拦截，直到所属音栓「复检完成」记录先并入工单。
              </p>
            )}
          </>
        )}

        {kind === "stop" && (
          <>
            <label>
              <span>音栓名称（可选）</span>
              <input value={stopName} onChange={(e) => setStopName(e.target.value)} placeholder="如 Trumpet 8'" />
            </label>
            <label className="check wide">
              <input
                type="checkbox"
                checked={recheckDone}
                onChange={(e) => setRecheckDone(e.target.checked)}
              />
              <span>本音栓复检完成（完成后关联异常音管才允许解除）</span>
            </label>
          </>
        )}

        {kind === "climate" && (
          <>
            <label>
              <span>温度 °C</span>
              <input value={temperature} onChange={(e) => setTemperature(e.target.value)} />
            </label>
            <label>
              <span>相对湿度 %</span>
              <input value={humidity} onChange={(e) => setHumidity(e.target.value)} />
            </label>
            <label className="wide">
              <span>备注</span>
              <input value={climateNote} onChange={(e) => setClimateNote(e.target.value)} placeholder="如：午后空调开启后" />
            </label>
            <p className="hint wide">
              温湿度变化超过 ±2°C / ±8% 时，先前绑定旧气候的音分偏差结论自动失效，已生成报告将要求重算。
            </p>
          </>
        )}
      </div>

      <div className="form-actions">
        <button onClick={addEntry}>加入本笔</button>
        <button className="primary" onClick={save} disabled={entries.length === 0}>
          暂存本笔（{entries.length} 条）
        </button>
      </div>

      {entries.length > 0 && (
        <div className="pending-entries">
          <h4>本笔待保存内容</h4>
          {entries.map((e, i) => (
            <div key={i} className="pending-entry">
              <span>{describeEntry(e)}</span>
              <button onClick={() => setEntries(entries.filter((_, j) => j !== i))}>移除</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
