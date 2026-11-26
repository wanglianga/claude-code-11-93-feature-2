// ===================== 领域类型定义 =====================
// 时间统一使用“自当日 00:00 起的分钟数”（如 09:20 = 560）

export type ID = string;
export type Role = 'dispatcher' | 'driver' | 'cs' | 'master';

export interface Account {
  id: ID;
  username: string;
  password: string;
  name: string;
  role: Role;
  vehicleId?: ID; // 司机账号绑定车辆
}

export interface Vehicle {
  id: ID;
  name: string;
  plate: string;
  capacityTon: number;
  loadTon: number;
  heightM: number;
  widthM: number;
  posNodeId: string;
  driverId: string;
  driverName: string;
}

export type StationStatus = 'pending' | 'arrived' | 'scanned' | 'completed' | 'rejected';

export interface Station {
  id: ID;
  name: string;
  nodeId: string;
  estTon: number;          // 估重（吨）——不是实称
  actualTon?: number;      // 实称（吨），称重后才有
  deadlineMin: number;     // 服务截止时刻
  serviceMin: number;      // 到站作业时长（分钟）
  status: StationStatus;
  assignedVehicleId: ID;
  completedBy?: string;
  completedAtMin?: number;
  overflowReported?: boolean;
  rejectReason?: string;
}

export interface Road {
  id: ID;
  group: string;           // 同一物理道路（双向）归为一组，封闭按组生效
  name?: string;
  from: string;
  to: string;
  minutes: number;
  heightLimitM?: number;   // 限高（米）
  widthLimitM?: number;    // 限宽（米）
}

export interface Closure {
  id: ID;
  roadGroup: string;
  label: string;
  fromMin: number;
  toMin: number;
  reason: string;
}

export interface DumpSite {
  id: ID;
  name: string;
  nodeId: string;
  windows: { startMin: number; endMin: number }[]; // 开放时段
  unloadMin: number;                                // 卸载作业时长
}

export interface NodeDef {
  id: string;
  name: string;
  x: number;
  y: number;
  kind: 'depot' | 'station' | 'dump' | 'transfer' | 'point';
}

// ===================== 转运站窗口预约 =====================
// 容量模式：lock = 按预计吨位先锁窗；queue = 到场排队、过磅后才扣实际容量
export type CapacityMode = 'lock' | 'queue';

export interface TransferWindow {
  id: ID;
  startMin: number;
  endMin: number;
  capacityTon: number;      // 本窗口可接收吨位上限（任何模式下实收都不得超过）
  suspended: boolean;       // 临时停收
  suspendReason?: string;
}

export interface TransferStation {
  id: ID;
  name: string;
  nodeId: string;
  mode: CapacityMode;       // 站长可切换
  weighMin: number;         // 过磅作业时长（分钟）
  windows: TransferWindow[];
}

export type BookingStatus =
  | 'booked'    // 排队模式：已登记未到场（不锁量）
  | 'locked'    // 锁量模式：已锁定窗口容量（按估重）
  | 'blocked'   // 锁量模式：剩余锁量不足，暂未锁入（等释放/改道）
  | 'queued'    // 排队模式：已到场，在队列中等候过磅
  | 'weighed'   // 已过磅，实称计入“已卸实收”
  | 'diverted'; // 已改道他站/他窗口

export interface Booking {
  id: ID;
  stationId: ID;
  windowId: ID;
  vehicleId: ID;
  estTon: number;           // 预约估重（锁量依据）——估重不是实收
  actualTon?: number;       // 过磅实称——只有它计入已卸实收
  status: BookingStatus;
  createdAtMin: number;
  arrivedAtMin?: number;
  weighedAtMin?: number;    // 过磅时刻：锁量释放 / 实收扣减发生的时刻
  queueNo?: number;         // 排队序号（到场先后）
  note?: string;
}

// 调度员发给司机的转运安排（等待 / 改道）
export interface Instruction {
  id: ID;
  vehicleId: ID;
  kind: 'wait' | 'divert';
  stationId: ID;            // 受阻预约所在转运站
  windowId?: ID;            // divert：改道目标窗口
  targetStationId?: ID;     // divert：改道目标转运站
  message: string;
  createdAtMin: number;
  by: string;
  acked: boolean;
}

export type NotificationStatus = 'valid' | 'needs-resend' | 'fulfilled' | 'invalid';

export interface NotificationDoc {
  id: ID;
  stationId: ID;
  resident: string;
  slotText: string;             // 居民预约时段文案
  notifiedVehicleId: ID;        // 通知时依据的车辆
  notifiedEtaMin: number;       // 通知时告知的预计到达
  notifiedSeq: number;          // 通知时在该车线路中的序号
  notifiedRouteVersionId: ID;   // 通知依据的线路版本
  status: NotificationStatus;
  resendReasons: string[];      // 需重发的原因
}

export type RouteStrategy = 'initial' | 'insert' | 'global' | 'manual';

export interface RouteVersion {
  id: ID;
  vehicleId: ID;
  versionNo: number;
  stopIds: ID[];                // 该版本下完整的站点顺序（含已完成）
  strategy: RouteStrategy;
  reason: string;
  createdAtMin: number;
  basedOnVersionId?: ID;
}

export type ReceiptAction = 'arrive' | 'scan' | 'weigh' | 'overflow' | 'closure';
export type ReceiptStatus = 'accepted' | 'duplicate' | 'conflict';

export interface Receipt {
  id: ID;                       // 回执凭证号（客户端生成，幂等键）
  credentialId: string;         // 扫码凭证内容（同一二维码重传只计一次）
  stationId?: ID;
  vehicleId: ID;
  routeVersionId: ID;           // 执行人操作时依据的线路版本
  executorId: string;
  executorName: string;
  action: ReceiptAction;
  payload?: string;             // 如称重吨数、说明
  deviceTimeMin: number;        // 设备端发生时间（离线时早于上传时间）
  uploadedAtMin: number;
  status: ReceiptStatus;
  note?: string;
}

export interface EventLog {
  id?: number;
  tsMin: number;
  actor: string;
  type: string;
  message: string;
}

// ===================== 时间工具 =====================

export function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function parseMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
