// 调音偏差模型：音分偏差随温湿度漂移。
// 管风琴音管频率随温度升高而升高（约 0.6 音分/°C），湿度影响较小。
// 基准条件：20°C、50%。

export const REF_TEMP = 20;
export const REF_HUMIDITY = 50;
export const CENT_PER_DEG = 0.6;
export const CENT_PER_HUM = 0.05;
export const LIMIT_CENT = 10;

export function adjustedCent(cent: number, temp: number, humidity: number): number {
  const v = cent + (temp - REF_TEMP) * CENT_PER_DEG + (humidity - REF_HUMIDITY) * CENT_PER_HUM;
  return Math.round(v * 10) / 10;
}

export function centStatus(adjusted: number): "正常" | "偏差超限" {
  return Math.abs(adjusted) > LIMIT_CENT ? "偏差超限" : "正常";
}
