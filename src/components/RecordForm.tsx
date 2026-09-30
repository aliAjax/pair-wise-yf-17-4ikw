import { useState } from "react";
import { Btn, Field } from "./bits";

const STOP_TYPES = ["主音栓", "簧片音栓", "混合音栓", "低音管"];
const REED_HINTS = ["正常", "需微调", "簧片需微调", "簧片需更换", "标记复检"];

export default function RecordForm({
  onSave,
  defaultVenue,
}: {
  onSave: (input: {
    venue: string;
    stopName: string;
    stopType: string;
    pipeId: string;
    pitch: string;
    cent: string;
    reed: string;
    note: string;
    abnormal: boolean;
    temp: string;
    humidity: string;
  }) => { ok: boolean; reason?: string };
  defaultVenue: string;
}) {
  const [venue, setVenue] = useState(defaultVenue);
  const [stopName, setStopName] = useState("");
  const [stopType, setStopType] = useState(STOP_TYPES[1]);
  const [pipeId, setPipeId] = useState("");
  const [pitch, setPitch] = useState("");
  const [cent, setCent] = useState("");
  const [reed, setReed] = useState("正常");
  const [note, setNote] = useState("");
  const [abnormal, setAbnormal] = useState(false);
  const [temp, setTemp] = useState("");
  const [humidity, setHumidity] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = () => {
    const res = onSave({
      venue,
      stopName,
      stopType,
      pipeId,
      pitch,
      cent,
      reed,
      note,
      abnormal,
      temp,
      humidity,
    });
    setMsg(res.ok ? { ok: true, text: "已写入离线工单，网络恢复后按音管+字段合并" } : { ok: false, text: res.reason ?? "保存失败" });
    if (res.ok) {
      setPipeId("");
      setPitch("");
      setCent("");
      setNote("");
      setAbnormal(false);
    }
  };

  return (
    <div className="panel">
      <div className="heading">
        <div>
          <p>现场补记</p>
          <h2>新增音管维护记录</h2>
        </div>
        <Btn primary onClick={submit}>
          保存到离线工单
        </Btn>
      </div>
      <div className="form-grid">
        <Field label="场馆名称">
          <input value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="如 St.Mary's Church" />
        </Field>
        <Field label="音栓名称">
          <input value={stopName} onChange={(e) => setStopName(e.target.value)} placeholder="如 Trumpet 8'" />
        </Field>
        <Field label="音栓类型">
          <select value={stopType} onChange={(e) => setStopType(e.target.value)}>
            {STOP_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="音管编号">
          <input value={pipeId} onChange={(e) => setPipeId(e.target.value)} placeholder="如 C#4" />
        </Field>
        <Field label="音高">
          <input value={pitch} onChange={(e) => setPitch(e.target.value)} placeholder="如 C#4" />
        </Field>
        <Field label="音分偏差（cent）">
          <input value={cent} onChange={(e) => setCent(e.target.value)} placeholder="如 -12" inputMode="numeric" />
        </Field>
        <Field label="簧片状态">
          <input value={reed} onChange={(e) => setReed(e.target.value)} list="reed-hints" />
          <datalist id="reed-hints">
            {REED_HINTS.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </Field>
        <Field label="维修备注">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="维修情况备注" />
        </Field>
        <Field label="温度（°C，选填）">
          <input value={temp} onChange={(e) => setTemp(e.target.value)} placeholder="如 20" inputMode="decimal" />
        </Field>
        <Field label="湿度（%，选填）">
          <input value={humidity} onChange={(e) => setHumidity(e.target.value)} placeholder="如 50" inputMode="decimal" />
        </Field>
        <label className="field field-check">
          <input type="checkbox" checked={abnormal} onChange={(e) => setAbnormal(e.target.checked)} />
          <span>标记为异常音管（需音栓复检后才能解除）</span>
        </label>
      </div>
      {msg && (
        <div className={msg.ok ? "form-msg form-msg-ok" : "form-msg form-msg-err"}>{msg.text}</div>
      )}
    </div>
  );
}
