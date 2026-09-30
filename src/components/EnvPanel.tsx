import { useState } from "react";
import type { State } from "../engine/types";
import { deviceName } from "../engine/store";
import { Badge, Btn, Field } from "./bits";

export default function EnvPanel({
  state,
  onSave,
  defaultVenue,
}: {
  state: State;
  onSave: (input: { venue: string; temp: number; humidity: number }) => void;
  defaultVenue: string;
}) {
  const [venue, setVenue] = useState(defaultVenue);
  const [temp, setTemp] = useState("");
  const [humidity, setHumidity] = useState("");

  const pendingEnv = state.outbox.filter((o) => o.kind === "env");

  return (
    <div className="panel">
      <div className="heading">
        <div>
          <p>温湿度记录</p>
          <h2>环境读数</h2>
        </div>
        <Badge tone="blue">偏差结论随温湿度失效需重算</Badge>
      </div>
      <div className="form-grid env-form">
        <Field label="场馆名称">
          <input value={venue} onChange={(e) => setVenue(e.target.value)} />
        </Field>
        <Field label="温度（°C）">
          <input value={temp} onChange={(e) => setTemp(e.target.value)} placeholder="如 20" inputMode="decimal" />
        </Field>
        <Field label="湿度（%）">
          <input value={humidity} onChange={(e) => setHumidity(e.target.value)} placeholder="如 50" inputMode="decimal" />
        </Field>
        <div className="env-submit">
          <Btn
            primary
            onClick={() => {
              const t = Number(temp);
              const h = Number(humidity);
              if (!venue.trim() || Number.isNaN(t) || Number.isNaN(h)) return;
              onSave({ venue: venue.trim(), temp: t, humidity: h });
              setTemp("");
              setHumidity("");
            }}
          >
            记录温湿度
          </Btn>
        </div>
      </div>

      <h3 className="sub-title">已合并记录</h3>
      <div className="env-list">
        {[...state.envRecords]
          .sort((a, b) => b.ts - a.ts)
          .map((rec) => (
            <article key={rec.id} className="env-row">
              <Badge tone="green">已确认</Badge>
              <div>
                <strong>{rec.venue}</strong>
                <p>
                  {rec.temp}°C · {rec.humidity}% · {deviceName(state, rec.deviceId)} 记录 #{rec.seq}
                </p>
              </div>
              <span className="env-time">{new Date(rec.ts).toLocaleString("zh-CN")}</span>
            </article>
          ))}
        {state.envRecords.length === 0 && <p className="empty">暂无温湿度记录。</p>}
      </div>

      {pendingEnv.length > 0 && (
        <>
          <h3 className="sub-title">离线待合并</h3>
          <div className="env-list">
            {pendingEnv.map((op) => (
              <article key={op.opId} className="env-row pending">
                <Badge tone="amber">待合并</Badge>
                <div>
                  <strong>{op.venue}</strong>
                  <p>
                    {op.env!.temp}°C · {op.env!.humidity}% · {deviceName(state, op.deviceId)} 记录 #{op.seq}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
