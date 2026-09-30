import {
  Batch,
  ClimateEntryData,
  EntryData,
  FIELD_LABEL,
  PipeField,
  Resolution,
  VersionVector,
  versionKey,
  vvDominates,
  vvMerge,
} from "./types";

/** 字段版本：一个设备某连续记录号上写入的值 */
export interface FieldVersion {
  deviceId: string;
  seq: number;
  at: number;
  tech: string;
  value: string;
  /** 记录该值时的温湿度（仅音分偏差字段） */
  climate?: { temperature: number; humidity: number; at: number };
}

export interface Conflict {
  pipeId: string;
  stopId: string;
  field: PipeField;
  versions: FieldVersion[];
  resolution?: Resolution;
}

interface AbnMeta {
  reason?: string;
  deviceId: string;
  seq: number;
  at: number;
}

export interface PipeMerged {
  pipeId: string;
  stopId: string;
  fields: Partial<Record<PipeField, FieldVersion>>;
  conflicts: PipeField[];
  /** 最终是否仍为异常音管 */
  abnormal: boolean;
  abnormalReason?: string;
  /** 解除请求被「音栓未复检」守卫拦截 */
  releaseBlocked?: AbnMeta;
  /** 已合法解除 */
  released?: AbnMeta;
  // 合并内部使用
  lastMark?: AbnMeta;
  lastRelease?: AbnMeta;
}

export interface StopMerged {
  stopId: string;
  name?: string;
  category?: string;
  recheckDone: boolean;
  recheckAt?: number;
  pipeIds: Set<string>;
}

/** 合并后的工单视图 */
export interface MergeResult {
  pipes: Map<string, PipeMerged>;
  stops: Map<string, StopMerged>;
  conflicts: Conflict[];
  climate: ClimateEntryData | null;
  /** 全局版本向量：所有已并入记录包的并集 */
  vv: VersionVector;
  batches: Batch[];
}

interface FieldCell {
  versions: FieldVersion[];
  order: { deviceId: string; seq: number; vv: VersionVector; at: number }[];
}

/**
 * 网络恢复后合并：按音管和字段归并所有记录包中的条目。
 * - 后写版本的版本向量已覆盖先写版本：因果覆盖，保留新版本
 * - 两版本向量不可比较（两名技师在同一基线上同时保存、同一字段两边都改过）：两版都保留 => 冲突
 */
/** 动作先后：先按时间；同毫秒时同设备按连续记录号，跨设备按设备序号兜底（全序，避免并列） */
function actionAfter(a: AbnMeta, b: AbnMeta): boolean {
  if (a.at !== b.at) return a.at > b.at;
  if (a.deviceId === b.deviceId) return a.seq > b.seq;
  return a.deviceId > b.deviceId;
}

export function mergeBatches(input: Batch[], resolutions: Resolution[] = []): MergeResult {
  // 全局按发生时间排序：跨设备的标记/解除动作必须按真实先后归约
  const batches = [...input].sort((a, z) => {
    if (a.at !== z.at) return a.at - z.at;
    if (a.deviceId === z.deviceId) return a.seq - z.seq;
    return a.deviceId.localeCompare(z.deviceId);
  });

  const pipes = new Map<string, PipeMerged>();
  const stops = new Map<string, StopMerged>();
  const cells = new Map<string, FieldCell>();
  let climate: ClimateEntryData | null = null;
  let climateSrc = { device: "", seq: 0 };
  let globalVV: VersionVector = {};

  const ensurePipe = (pipeId: string, stopId: string): PipeMerged => {
    let p = pipes.get(pipeId);
    if (!p) {
      p = { pipeId, stopId, fields: {}, conflicts: [], abnormal: false };
      pipes.set(pipeId, p);
    }
    if (!stops.has(stopId)) {
      stops.set(stopId, { stopId, recheckDone: false, pipeIds: new Set() });
    }
    stops.get(stopId)!.pipeIds.add(pipeId);
    return p;
  };

  for (const b of batches) {
    globalVV = vvMerge(globalVV, { [b.deviceId]: b.seq });
    for (const e of b.entries) {
      switch (e.kind) {
        case "pipe": {
          const p = ensurePipe(e.pipeId, e.stopId);
          const key = `${e.pipeId}${e.field}`;
          let cell = cells.get(key);
          if (!cell) {
            cell = { versions: [], order: [] };
            cells.set(key, cell);
          }
          cell.versions.push({
            deviceId: b.deviceId,
            seq: b.seq,
            at: b.at,
            tech: b.tech,
            value: e.value,
            climate: e.field === "cent" ? b.climate : undefined,
          });
          cell.order.push({ deviceId: b.deviceId, seq: b.seq, vv: b.vv, at: b.at });
          p.stopId = e.stopId;
          break;
        }
        case "abnormal": {
          const p = ensurePipe(e.pipeId, e.stopId);
          const meta: AbnMeta = {
            reason: e.reason,
            deviceId: b.deviceId,
            seq: b.seq,
            at: b.at,
          };
          // 批次已按时间全局排序，最新的标记/解除动作即生效动作
          if (e.abnormal) p.lastMark = meta;
          else p.lastRelease = meta;
          break;
        }
        case "stop": {
          let s = stops.get(e.stopId);
          if (!s) {
            s = { stopId: e.stopId, recheckDone: false, pipeIds: new Set() };
            stops.set(e.stopId, s);
          }
          if (e.name !== undefined) s.name = e.name;
          if (e.category !== undefined) s.category = e.category;
          if (e.recheckDone && !s.recheckDone) {
            s.recheckDone = true;
            s.recheckAt = b.at;
          }
          break;
        }
        case "climate": {
          // 批次已按时间排序，后者为最新测量
          climate = e;
          climateSrc = { device: b.deviceId, seq: b.seq };
          break;
        }
      }
    }
  }

  // —— 逐字段做因果归约 ——
  const conflicts: Conflict[] = [];
  for (const [key, cell] of cells) {
    const [pipeId, field] = key.split("") as [string, PipeField];
    const p = pipes.get(pipeId)!;
    const metas = [...cell.order].sort((a, z) => a.at - z.at);

    const live: FieldVersion[] = [];
    for (const m of metas) {
      const v = cell.versions.find(
        (x) => x.deviceId === m.deviceId && x.seq === m.seq
      )!;
      // 新版本因果覆盖的旧版本剔除
      for (let i = live.length - 1; i >= 0; i--) {
        const old = metas.find(
          (mm) => mm.deviceId === live[i].deviceId && mm.seq === live[i].seq
        )!;
        if (vvDominates(m.vv, old.vv)) live.splice(i, 1);
      }
      // 新版本已被存活旧版本覆盖 => 丢弃
      const dominated = live.some((lv) => {
        const lm = metas.find(
          (mm) => mm.deviceId === lv.deviceId && mm.seq === lv.seq
        )!;
        return vvDominates(lm.vv, m.vv);
      });
      if (!dominated) live.push(v);
    }

    if (live.length >= 2) {
      p.conflicts.push(field);
      const resolution = latestResolution(resolutions, pipeId, field);
      conflicts.push({ pipeId, stopId: p.stopId, field, versions: live, resolution });
    }

    let chosen: FieldVersion | undefined;
    const r = latestResolution(resolutions, pipeId, field);
    if (r) {
      chosen = live.find((v) => versionKey(v.deviceId, v.seq) === r.chosenVersion);
    }
    if (!chosen) chosen = [...live].sort((a, z) => z.at - a.at)[0];
    if (chosen) p.fields[field] = chosen;
  }

  // —— 音栓复检守卫：复检完成前，关联异常音管的解除一律无效 ——
  for (const p of pipes.values()) {
    const stop = stops.get(p.stopId);
    const marked = p.lastMark;
    const releasedAfterMark =
      p.lastRelease && (!marked || actionAfter(p.lastRelease, marked));
    if (releasedAfterMark) {
      if (stop && stop.recheckDone) {
        // 音栓复检已完成：解除生效
        p.released = p.lastRelease;
        p.abnormal = false;
      } else {
        // 解除被拦截：异常保持，等待音栓复检
        p.abnormal = true;
        p.abnormalReason = marked?.reason;
        p.releaseBlocked = p.lastRelease;
      }
    } else if (marked) {
      p.abnormal = true;
      p.abnormalReason = marked.reason;
    }
  }

  return { pipes, stops, conflicts, climate, vv: globalVV, batches };
}

function latestResolution(
  resolutions: Resolution[],
  pipeId: string,
  field: PipeField
): Resolution | undefined {
  return [...resolutions]
    .filter((r) => r.pipeId === pipeId && r.field === field)
    .sort((a, z) => z.at - a.at)[0];
}

/**
 * 温湿度失效判定：记录音分偏差结论时的气候与当前气候差距过大 => 结论失效。
 * 阈值采用管风琴现场常用容差：温度 ±2°C、相对湿度 ±8%。
 */
export const CLIMATE_TEMP_TOL = 2;
export const CLIMATE_HUM_TOL = 8;

export function climateStale(
  snapshot: { temperature: number; humidity: number } | undefined,
  current: { temperature: number; humidity: number } | null
): boolean {
  if (!snapshot || !current) return false;
  return (
    Math.abs(snapshot.temperature - current.temperature) > CLIMATE_TEMP_TOL ||
    Math.abs(snapshot.humidity - current.humidity) > CLIMATE_HUM_TOL
  );
}

/** 报告内容签名：已确认包 + 冲突裁决 + 当前气候。任一变化 => 旧报告需重算 */
export function reportSignature(
  confirmedBatches: Batch[],
  resolutions: Resolution[],
  climate: ClimateEntryData | null
): string {
  const parts = confirmedBatches
    .slice()
    .sort((a, z) =>
      a.deviceId === z.deviceId ? a.seq - z.seq : a.deviceId.localeCompare(z.deviceId)
    )
    .map(
      (b) =>
        `${b.deviceId}#${b.seq}:${b.entries
          .map((e) => JSON.stringify(e))
          .join("|")}`
    );
  const r = resolutions
    .slice()
    .sort((a, z) => a.at - z.at)
    .map((x) => `${x.pipeId}.${x.field}=${x.chosenVersion}`)
    .join(";");
  const c = climate ? `${climate.at}:${climate.temperature}:${climate.humidity}` : "none";
  return hash(`${parts.join("||")}##${r}##${c}`);
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return "sig" + (h >>> 0).toString(36);
}

export const fieldLabel = (f: PipeField) => FIELD_LABEL[f];
