export type Reading = {
  origin: string;
  seq: number;
  gps_time: number | null;
  uptime_s: number;
  lat: number | null;
  lon: number | null;
  water_c: number | null;
  air_c: number | null;
  pressure_hpa: number | null;
  wave_rms_g: number | null;
  wave_peak_g: number | null;
  pitch: number | null;
  roll: number | null;
  tilt: number | null;
  sats: number;
  flags: number;
  received_at: number;
  t: number; // estimated sample time, unix s
};

export type Pos = { lat: number; lon: number; source: "gps" | "last_fix" | "pinned" | "default"; fix_t?: number };

export type Status = "online" | "stale" | "offline" | "unknown";

export type NodeInfo = {
  id: string;
  name: string;
  kind: "buoy";
  virtual: boolean;
  sim: boolean;
  status: Status;
  direct: boolean;
  age_s: number | null;
  interval_s: number;
  latest: Reading | null;
  pos: Pos;
  attitude: [number, number, number] | null;
  spark: Record<string, (number | null)[]>;
  records?: number;
  first_seen?: number;
};

export type Collector = {
  id: string;
  name: string;
  kind: "collector";
  pos: Pos;
  receiving: boolean;
  activity_age_s: number | null;
  serial: string | null;
};

export type Alert = {
  id: string;
  t: number;
  level: "info" | "warning" | "critical";
  node: string;
  name: string;
  kind: string;
  title: string;
  detail: string;
};

export const F = { BMP: 1, IMU: 2, WATER: 4, GPS_FIX: 8, GPS_TIME: 16, SIM: 128 };
