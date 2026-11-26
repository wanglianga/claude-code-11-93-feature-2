// 转运站窗口预约领域逻辑：锁量 / 到场排队两种容量模式
// 硬规则：
//  1) 任何模式都不得超售——锁量模式「已锁(估)+已卸实收 ≤ 容量」恒成立；排队模式「已卸实收 ≤ 容量」恒成立；
//  2) 估重不能登记成已卸实收——台账的“实收”只累计过磅后的 actualTon。
import type {
  Booking, CapacityMode, Instruction, Station, TransferStation, TransferWindow,
} from '../types';
import { fmtMin, round2 } from '../types';
import { getDb, loadSnapshot, type Snapshot } from './db';
import { bus, currentVersionByVehicle } from './actions';

const EPS = 1e-6;

function emitChange() {
  bus.dispatchEvent(new Event('change'));
}

async function log(db: any, tsMin: number, actor: string, type: string, message: string) {
  await db.add('events', { tsMin, actor, type, message });
}

// ===================== 纯函数：容量台账 =====================

export interface WindowLedger {
  capacityTon: number;
  lockedTon: number;    // 已锁未过磅的估重合计（锁量模式占用容量；估重不是实收）
  receivedTon: number;  // 已卸实收（只含过磅实称）
  availableTon: number; // capacity - locked - received
}

/** 窗口容量台账：实收只含过磅实称；锁量只含 locked 状态预约的估重。 */
export function windowLedger(window: TransferWindow, bookings: Booking[]): WindowLedger {
  let locked = 0;
  let received = 0;
  for (const b of bookings) {
    if (b.windowId !== window.id) continue;
    if (b.status === 'locked') locked += b.estTon;
    if (b.status === 'weighed') received += b.actualTon ?? 0;
  }
  locked = round2(locked);
  received = round2(received);
  return {
    capacityTon: window.capacityTon,
    lockedTon: locked,
    receivedTon: received,
    availableTon: round2(window.capacityTon - locked - received),
  };
}

/** 窗口内仍占用容量/在途的预约（diverted 不再占用本窗口）。 */
export function activeBookingsOf(window: TransferWindow, bookings: Booking[]): Booking[] {
  return bookings.filter((b) => b.windowId === window.id && b.status !== 'diverted');
}

/** 排队模式：窗口内的队列（按 queueNo 升序）。 */
export function queueOf(window: TransferWindow, bookings: Booking[]): Booking[] {
  return bookings
    .filter((b) => b.windowId === window.id && b.status === 'queued')
    .sort((a, b) => (a.queueNo ?? 0) - (b.queueNo ?? 0));
}

/** 排队位置（1 起）；不在队列中返回 null。 */
export function queuePosition(window: TransferWindow, bookings: Booking[], bookingId: string): number | null {
  const q = queueOf(window, bookings);
  const i = q.findIndex((b) => b.id === bookingId);
  return i < 0 ? null : i + 1;
}

// ===================== 纯函数：规则校验 =====================

export type WeighCheck = { ok: true } | { ok: false; reason: string };

/**
 * 过磅校验（不得超售的核心）：
 * - 锁量模式：预约须已锁定；实称 ≤ 容量 −（他人锁量 + 已实收）（自己的锁量在过磅时释放抵扣）；
 * - 排队模式：预约须在队首；实称 ≤ 容量 − 已实收。
 */
export function canWeigh(
  station: TransferStation,
  window: TransferWindow,
  bookings: Booking[],
  booking: Booking,
  actualTon: number,
  nowMin: number,
): WeighCheck {
  if (window.suspended) {
    return { ok: false, reason: `窗口临时停收（${window.suspendReason ?? '站点通知'}），无法过磅` };
  }
  if (nowMin < window.startMin) {
    return { ok: false, reason: `窗口 ${fmtMin(window.startMin)} 才开始，当前 ${fmtMin(nowMin)} 不能过磅` };
  }
  if (nowMin > window.endMin) {
    return { ok: false, reason: `窗口已于 ${fmtMin(window.endMin)} 结束，无法过磅` };
  }
  const ledger = windowLedger(window, bookings);
  if (station.mode === 'lock') {
    if (booking.status !== 'locked') {
      return { ok: false, reason: '本预约未锁到窗口容量（被挡），不能过磅：等释放或改道' };
    }
    // 自己那份估重锁量在过磅瞬间释放，可用于抵扣实称
    const headroom = round2(ledger.availableTon + booking.estTon);
    if (actualTon > headroom + EPS) {
      return {
        ok: false,
        reason: `实称 ${actualTon.toFixed(1)} 吨超窗口可接收余量 ${headroom.toFixed(1)} 吨（容量 ${window.capacityTon.toFixed(1)} − 他人锁量 − 已实收），过磅将超售，禁止登记`,
      };
    }
    return { ok: true };
  }
  // 排队模式
  if (booking.status !== 'queued') {
    return { ok: false, reason: '请先到场登记排队，再按顺序过磅' };
  }
  const head = queueOf(window, bookings)[0];
  if (!head || head.id !== booking.id) {
    const pos = queuePosition(window, bookings, booking.id);
    return { ok: false, reason: `到场排队按顺序过磅：当前排第 ${pos ?? '—'} 位，须等前车过磅完成` };
  }
  if (actualTon > ledger.availableTon + EPS) {
    return {
      ok: false,
      reason: `实称 ${actualTon.toFixed(1)} 吨超窗口剩余可接收 ${ledger.availableTon.toFixed(1)} 吨（容量 ${window.capacityTon.toFixed(1)} − 已实收），过磅将超售，禁止登记`,
    };
  }
  return { ok: true };
}

/**
 * 锁量模式：容量释放后，按预约先后把被挡预约补锁进窗口（不超售：est ≤ 当前可锁余量才锁）。
 * 直接修改传入的 booking 对象，返回被促活的预约 id。
 */
export function promoteBlocked(window: TransferWindow, bookings: Booking[]): string[] {
  const promoted: string[] = [];
  let avail = windowLedger(window, bookings).availableTon;
  const blocked = bookings
    .filter((b) => b.windowId === window.id && b.status === 'blocked')
    .sort((a, b) => a.createdAtMin - b.createdAtMin || a.id.localeCompare(b.id));
  for (const b of blocked) {
    if (b.estTon <= avail + EPS) {
      b.status = 'locked';
      b.note = `容量释放后补锁成功（${fmtMin(window.startMin)}–${fmtMin(window.endMin)} 窗口）`;
      avail = round2(avail - b.estTon);
      promoted.push(b.id);
    }
  }
  return promoted;
}

/** 模式切换时重算预约状态（weighed/diverted 不动）。 */
export function recomputeForMode(station: TransferStation, bookings: Booking[]): void {
  for (const w of station.windows) {
    if (station.mode === 'queue') {
      for (const b of bookings) {
        if (b.windowId !== w.id) continue;
        if (b.status === 'locked' || b.status === 'blocked') {
          b.status = 'booked';
          b.queueNo = undefined;
          b.note = '已切换为到场排队模式：不锁量，到场先后决定过磅顺序';
        }
      }
    } else {
      const waiting = bookings
        .filter((b) => b.windowId === w.id && (b.status === 'booked' || b.status === 'queued'))
        .sort((a, b) => (a.queueNo ?? 9999) - (b.queueNo ?? 9999) || a.createdAtMin - b.createdAtMin);
      for (const b of waiting) {
        b.status = 'blocked';
        b.queueNo = undefined;
        b.note = '已切换为锁量模式：按估重重新锁窗';
      }
      promoteBlocked(w, bookings);
    }
  }
}

// ===================== 快照派生：受影响车辆与站点 =====================

export interface AffectedBooking {
  booking: Booking;
  station: TransferStation;
  window: TransferWindow;
  reason: string;
  affectedStations: Station[]; // 该车当前线路中未完成的桶站（可能延误）
}

/** 调度员视角：转运受阻（被挡 / 窗口停收）的预约及其牵连的线路站点。 */
export function affectedBookings(snap: Snapshot): AffectedBooking[] {
  const versions = currentVersionByVehicle(snap);
  const out: AffectedBooking[] = [];
  for (const b of snap.bookings) {
    if (b.status === 'weighed' || b.status === 'diverted') continue;
    const station = snap.transferStations.find((s) => s.id === b.stationId);
    const window = station?.windows.find((w) => w.id === b.windowId);
    if (!station || !window) continue;
    let reason = '';
    if (window.suspended) reason = `窗口临时停收（${window.suspendReason ?? '站点通知'}），预约成为线路上的真实阻塞`;
    else if (b.status === 'blocked') reason = '锁量不足暂未锁入，等容量释放或改道';
    if (!reason) continue;
    const rv = versions[b.vehicleId];
    const affectedStations = (rv?.stopIds ?? [])
      .map((id) => snap.stations.find((s) => s.id === id))
      .filter((s): s is Station => !!s && s.status !== 'completed');
    out.push({ booking: b, station, window, reason, affectedStations });
  }
  return out;
}

// ===================== 动作：站长 =====================

/** 站长切换容量模式（锁量 ⇄ 到场排队），重算全部预约状态。 */
export async function setCapacityMode(snap: Snapshot, stationId: string, mode: CapacityMode, actor: string): Promise<void> {
  const db = await getDb();
  const station = snap.transferStations.find((s) => s.id === stationId);
  if (!station || station.mode === mode) return;
  station.mode = mode;
  const bookings = snap.bookings.map((b) => ({ ...b }));
  recomputeForMode(station, bookings);
  await db.put('transferStations', station);
  for (const b of bookings) await db.put('bookings', b);
  await log(db, snap.nowMin, actor, 'transfer',
    `${station.name} 切换为${mode === 'lock' ? '锁量模式（按预计吨位先锁窗）' : '到场排队模式（过磅后才扣实际容量）'}，预约状态已重算`);
  emitChange();
}

/** 站长调整窗口（时段/容量）。容量不得调到低于已锁+已实收（否则等同超售），拒绝并说明。 */
export async function updateWindow(
  snap: Snapshot,
  stationId: string,
  windowId: string,
  patch: { startMin: number; endMin: number; capacityTon: number },
  actor: string,
): Promise<{ ok: boolean; reason?: string }> {
  const db = await getDb();
  const station = snap.transferStations.find((s) => s.id === stationId);
  const window = station?.windows.find((w) => w.id === windowId);
  if (!station || !window) return { ok: false, reason: '窗口不存在' };
  if (!(patch.startMin < patch.endMin)) return { ok: false, reason: '开始时刻必须早于结束时刻' };
  if (!(patch.capacityTon > 0)) return { ok: false, reason: '容量必须大于 0' };
  const ledger = windowLedger(window, snap.bookings);
  const floor = station.mode === 'lock' ? round2(ledger.lockedTon + ledger.receivedTon) : ledger.receivedTon;
  if (patch.capacityTon < floor - EPS) {
    return {
      ok: false,
      reason: `不得超售：容量不能调到低于${station.mode === 'lock' ? '已锁(估)+已卸实收' : '已卸实收'} ${floor.toFixed(1)} 吨`,
    };
  }
  window.startMin = patch.startMin;
  window.endMin = patch.endMin;
  window.capacityTon = patch.capacityTon;
  await db.put('transferStations', station);
  await log(db, snap.nowMin, actor, 'transfer',
    `${station.name} ${window.id} 窗口调整为 ${fmtMin(patch.startMin)}–${fmtMin(patch.endMin)}、容量 ${patch.capacityTon.toFixed(1)} 吨`);
  // 扩容后尝试促活被挡预约
  if (station.mode === 'lock') {
    const bookings = snap.bookings.map((b) => ({ ...b }));
    const promoted = promoteBlocked(window, bookings);
    for (const b of bookings) await db.put('bookings', b);
    for (const id of promoted) {
      const b = bookings.find((x) => x.id === id)!;
      await log(db, snap.nowMin, '系统', 'transfer', `窗口扩容后 ${b.vehicleId} 的预约 ${b.id} 补锁成功（估 ${b.estTon.toFixed(1)} 吨）`);
    }
  }
  emitChange();
  return { ok: true };
}

/** 站长临时停收 / 恢复接收。停收使在途预约成为线路上的真实阻塞。 */
export async function toggleWindowSuspend(
  snap: Snapshot,
  stationId: string,
  windowId: string,
  suspend: boolean,
  reason: string,
  actor: string,
): Promise<void> {
  const db = await getDb();
  const station = snap.transferStations.find((s) => s.id === stationId);
  const window = station?.windows.find((w) => w.id === windowId);
  if (!station || !window) return;
  window.suspended = suspend;
  window.suspendReason = suspend ? reason : undefined;
  await db.put('transferStations', station);
  const affected = activeBookingsOf(window, snap.bookings).filter((b) => b.status !== 'weighed');
  if (suspend) {
    const vehicles = [...new Set(affected.map((b) => b.vehicleId))].join('、') || '无';
    await log(db, snap.nowMin, actor, 'transfer',
      `${station.name} ${window.id} 临时停收（${reason}）：${affected.length} 条预约受阻（${vehicles}），成为线路上的真实阻塞`);
  } else {
    await log(db, snap.nowMin, actor, 'transfer', `${station.name} ${window.id} 恢复接收，受阻预约可继续履约`);
  }
  emitChange();
}

// ===================== 动作：司机到场 / 过磅 =====================

/** 司机到场登记。锁量模式记录到场时刻；排队模式进入队列（到场先后决定顺序）。 */
export async function driverArriveTransfer(
  snap: Snapshot,
  bookingId: string,
  actor: string,
): Promise<{ ok: boolean; reason?: string }> {
  const db = await getDb();
  const booking = snap.bookings.find((b) => b.id === bookingId);
  if (!booking) return { ok: false, reason: '预约不存在' };
  if (booking.status === 'weighed' || booking.status === 'diverted') {
    return { ok: false, reason: '预约已完结' };
  }
  const station = snap.transferStations.find((s) => s.id === booking.stationId)!;
  const window = station.windows.find((w) => w.id === booking.windowId)!;
  if (window.suspended) {
    return { ok: false, reason: `窗口临时停收（${window.suspendReason ?? '站点通知'}），请等待调度安排` };
  }
  booking.arrivedAtMin = snap.nowMin;
  if (station.mode === 'queue') {
    if (booking.status !== 'queued') {
      const maxNo = Math.max(0, ...queueOf(window, snap.bookings).map((b) => b.queueNo ?? 0));
      booking.status = 'queued';
      booking.queueNo = maxNo + 1;
      booking.note = `${fmtMin(snap.nowMin)} 到场，排第 ${booking.queueNo} 位`;
    }
  }
  await db.put('bookings', booking);
  const vehicle = snap.vehicles.find((v) => v.id === booking.vehicleId);
  if (vehicle) {
    vehicle.posNodeId = station.nodeId;
    await db.put('vehicles', vehicle);
  }
  await log(db, snap.nowMin, actor, 'transfer',
    station.mode === 'queue'
      ? `${booking.vehicleId} 到场 ${station.name}，进入队列第 ${booking.queueNo} 位（等待时长取决于前车过磅）`
      : `${booking.vehicleId} 到场 ${station.name}（预约${booking.status === 'locked' ? '已锁窗' : '未锁入，仍被挡'}）`);
  emitChange();
  return { ok: true };
}

export interface WeighResult {
  ok: boolean;
  reason?: string;
  releasedTon?: number;   // 锁量模式：本次过磅释放的估重锁量
  promoted?: string[];    // 释放后补锁成功的预约
}

/** 司机过磅：实称入账为“已卸实收”，锁量模式同时释放估重锁量并促活被挡预约。 */
export async function driverWeighTransfer(
  snap: Snapshot,
  bookingId: string,
  actualTon: number,
  actor: string,
): Promise<WeighResult> {
  const db = await getDb();
  const booking = snap.bookings.find((b) => b.id === bookingId);
  if (!booking) return { ok: false, reason: '预约不存在' };
  if (booking.status === 'weighed') return { ok: false, reason: '本预约已过磅完成，实收已入账，不能重复过磅' };
  if (booking.status === 'diverted') return { ok: false, reason: '本预约已改道他站，不能在本窗口过磅' };
  const station = snap.transferStations.find((s) => s.id === booking.stationId)!;
  const window = station.windows.find((w) => w.id === booking.windowId)!;
  const actual = round2(actualTon);
  const check = canWeigh(station, window, snap.bookings, booking, actual, snap.nowMin);
  if (!check.ok) {
    await log(db, snap.nowMin, '系统', 'transfer', `${booking.vehicleId} 过磅被拒：${check.reason}`);
    emitChange();
    return { ok: false, reason: check.reason };
  }
  const releasedTon = station.mode === 'lock' ? round2(Math.max(0, booking.estTon - actual)) : 0;
  booking.status = 'weighed';
  booking.actualTon = actual;
  booking.weighedAtMin = snap.nowMin;
  booking.note = `实称 ${actual.toFixed(1)} 吨（估 ${booking.estTon.toFixed(1)} 吨）`;
  await db.put('bookings', booking);
  const vehicle = snap.vehicles.find((v) => v.id === booking.vehicleId);
  if (vehicle) {
    vehicle.loadTon = round2(Math.max(0, vehicle.loadTon - actual));
    await db.put('vehicles', vehicle);
  }
  const ledger = windowLedger(window, snap.bookings.map((b) => (b.id === booking.id ? booking : b)));
  await log(db, snap.nowMin, actor, 'transfer',
    `${station.name} ${window.id} 实收 ${booking.vehicleId} ${actual.toFixed(1)} 吨（估 ${booking.estTon.toFixed(1)} 吨，估重不计入实收）；窗口已卸实收 ${ledger.receivedTon.toFixed(1)}/${window.capacityTon.toFixed(1)} 吨`
    + (station.mode === 'lock' && releasedTon > 0 ? `；释放锁量 ${releasedTon.toFixed(1)} 吨` : ''));
  // 锁量模式：释放后促活被挡预约
  const promoted: string[] = [];
  if (station.mode === 'lock') {
    const bookings = (await loadSnapshot()).bookings;
    const ids = promoteBlocked(window, bookings);
    for (const b of bookings) await db.put('bookings', b);
    for (const id of ids) {
      const b = bookings.find((x) => x.id === id)!;
      promoted.push(id);
      await log(db, snap.nowMin, '系统', 'transfer',
        `容量释放：${b.vehicleId} 的预约 ${b.id} 补锁成功（估 ${b.estTon.toFixed(1)} 吨），可到场过磅`);
    }
  }
  emitChange();
  return { ok: true, releasedTon, promoted };
}

// ===================== 动作：调度员安排（等待 / 改道） =====================

let instrSeq = 0;

/** 调度员向司机发出转运安排：等待（等释放/下一窗口）或改道他站。 */
export async function issueInstruction(
  snap: Snapshot,
  input: { vehicleId: string; kind: 'wait' | 'divert'; stationId: string; targetStationId?: string; windowId?: string; message: string },
  actor: string,
): Promise<void> {
  const db = await getDb();
  instrSeq += 1;
  const instr: Instruction = {
    id: `INS-${snap.nowMin}-${instrSeq}`,
    vehicleId: input.vehicleId,
    kind: input.kind,
    stationId: input.stationId,
    targetStationId: input.targetStationId,
    windowId: input.windowId,
    message: input.message,
    createdAtMin: snap.nowMin,
    by: actor,
    acked: false,
  };
  await db.put('instructions', instr);
  await log(db, snap.nowMin, actor, 'transfer',
    `向 ${input.vehicleId} 发出${input.kind === 'wait' ? '等待' : '改道'}安排：${input.message}`);
  emitChange();
}

/** 司机确认收到安排。改道确认后：原预约记为 diverted，并在目标窗口生成新预约（按目标站模式锁量/登记）。 */
export async function ackInstruction(snap: Snapshot, instructionId: string, actor: string): Promise<void> {
  const db = await getDb();
  const instr = snap.instructions.find((i) => i.id === instructionId);
  if (!instr || instr.acked) return;
  instr.acked = true;
  await db.put('instructions', instr);
  await log(db, snap.nowMin, actor, 'transfer', `${instr.vehicleId} 确认收到${instr.kind === 'wait' ? '等待' : '改道'}安排`);
  if (instr.kind === 'divert' && instr.targetStationId && instr.windowId) {
    const target = snap.transferStations.find((s) => s.id === instr.targetStationId);
    const window = target?.windows.find((w) => w.id === instr.windowId);
    const old = snap.bookings.find(
      (b) => b.vehicleId === instr.vehicleId && b.stationId === instr.stationId
        && b.status !== 'weighed' && b.status !== 'diverted',
    );
    if (target && window && old) {
      old.status = 'diverted';
      old.note = `已改道 ${target.name}（${instr.id}）`;
      await db.put('bookings', old);
      const fresh: Booking = {
        id: `BK-${instr.vehicleId}-${instr.targetStationId}`,
        stationId: instr.targetStationId,
        windowId: instr.windowId,
        vehicleId: instr.vehicleId,
        estTon: old.estTon,
        status: 'blocked',
        createdAtMin: snap.nowMin,
        note: `自 ${instr.stationId} 改道而来`,
      };
      if (target.mode === 'queue') {
        fresh.status = 'booked';
      } else {
        const ledger = windowLedger(window, snap.bookings);
        if (fresh.estTon <= ledger.availableTon + EPS) fresh.status = 'locked';
      }
      await db.put('bookings', fresh);
      await log(db, snap.nowMin, '系统', 'transfer',
        `${instr.vehicleId} 改道 ${target.name}：新预约 ${fresh.id}（估 ${fresh.estTon.toFixed(1)} 吨，${fresh.status === 'locked' ? '已锁窗' : fresh.status === 'booked' ? '到场排队' : '暂未锁入'}）`);
    }
  }
  emitChange();
}
