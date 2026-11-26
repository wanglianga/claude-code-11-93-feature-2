// 锁量 vs 到场排队：同一组固定数据下的对比模拟（纯函数， deterministic）
// 题目数据：转运站只剩 10:00–10:30 窗口、可接收 4 吨；
// T1 预计 2.5 吨（过磅实际 1.8 吨）、T2 预计 2.0 吨（实际 2.0 吨）。
import type { CapacityMode } from '../types';
import { fmtMin, round2 } from '../types';

export interface SimVehicle {
  id: string;
  estTon: number;     // 预约估重
  actualTon: number;  // 过磅实称
  arriveMin: number;  // 到场时刻
}

export interface SimScenario {
  capacityTon: number;
  windowStartMin: number;
  windowEndMin: number;
  bookedAtMin: number; // 锁量模式：预约锁窗时刻
  weighMin: number;    // 过磅作业时长
  vehicles: SimVehicle[];
}

/** 本题固定数据组。 */
export const FIXED_SCENARIO: SimScenario = {
  capacityTon: 4.0,
  windowStartMin: 600, // 10:00
  windowEndMin: 630,   // 10:30
  bookedAtMin: 560,    // 09:20 调度按随车清单预约
  weighMin: 4,
  vehicles: [
    { id: 'T1', estTon: 2.5, actualTon: 1.8, arriveMin: 602 }, // 10:02 到场
    { id: 'T2', estTon: 2.0, actualTon: 2.0, arriveMin: 604 }, // 10:04 到场
  ],
};

export interface SimEvent {
  min: number;
  text: string;
}

export interface ModeSimResult {
  mode: CapacityMode;
  events: SimEvent[];
  accepted: string[];      // 最终完成过磅（被接纳）的车辆
  turnedAway: string[];    // 未能接纳（被挡到底/过磅超售被拒）的车辆
  serviceOrder: string[];  // 实际过磅顺序（等待顺序的结果）
  releaseEvents: { min: number; ton: number; text: string }[]; // 容量释放时刻（仅锁量模式有）
  receivedTon: number;     // 已卸实收合计（只含实称）
  capacityTon: number;
  oversold: boolean;       // 不变量校验：必须恒为 false
}

/** 锁量模式：预约时按估重锁窗；过磅时释放估重、按实称扣减；释放后按预约先后补锁被挡车辆。 */
export function simulateLock(sc: SimScenario): ModeSimResult {
  const events: SimEvent[] = [];
  const releaseEvents: ModeSimResult['releaseEvents'] = [];
  const locked = new Map<string, number>(); // vehicleId -> estTon
  const blocked: SimVehicle[] = [];
  const serviceOrder: string[] = [];
  const turnedAway: string[] = [];
  let received = 0;

  const avail = () => round2(sc.capacityTon - [...locked.values()].reduce((a, b) => a + b, 0) - received);

  // 预约时刻：按顺序锁窗
  for (const v of sc.vehicles) {
    if (v.estTon <= avail() + 1e-6) {
      locked.set(v.id, v.estTon);
      events.push({ min: sc.bookedAtMin, text: `${v.id} 按估重 ${v.estTon.toFixed(1)} 吨锁窗成功 → 剩余可锁 ${avail().toFixed(1)} 吨` });
    } else {
      blocked.push(v);
      events.push({ min: sc.bookedAtMin, text: `${v.id} 估重 ${v.estTon.toFixed(1)} 吨 > 剩余可锁 ${avail().toFixed(1)} 吨 → 锁定失败被挡（等释放或改道）` });
    }
  }

  // 待过磅队列：已锁车辆按到场时刻进入过磅流程
  const pending = sc.vehicles
    .filter((v) => locked.has(v.id))
    .map((v) => ({ v, weighStart: Math.max(v.arriveMin, sc.windowStartMin) }))
    .sort((a, b) => a.weighStart - b.weighStart || a.v.id.localeCompare(b.v.id));

  while (pending.length > 0) {
    const { v, weighStart } = pending.shift()!;
    const doneMin = weighStart + sc.weighMin;
    const est = locked.get(v.id)!;
    locked.delete(v.id);
    received = round2(received + v.actualTon);
    serviceOrder.push(v.id);
    events.push({
      min: doneMin,
      text: `${v.id} 过磅完成：实收 ${v.actualTon.toFixed(1)} 吨（估 ${est.toFixed(1)} 吨）→ 窗口实收 ${received.toFixed(1)}/${sc.capacityTon.toFixed(1)} 吨`,
    });
    if (v.actualTon < est) {
      const released = round2(est - v.actualTon);
      releaseEvents.push({
        min: doneMin,
        ton: released,
        text: `${fmtMin(doneMin)} ${v.id} 实称少于估重，释放锁量 ${released.toFixed(1)} 吨`,
      });
      events.push({ min: doneMin, text: `释放 ${v.id} 的估重差 ${released.toFixed(1)} 吨 → 剩余可锁 ${avail().toFixed(1)} 吨` });
    }
    // 促活被挡车辆（按预约先后）
    for (let i = 0; i < blocked.length; i++) {
      const b = blocked[i];
      if (b.estTon <= avail() + 1e-6) {
        blocked.splice(i, 1);
        i--;
        locked.set(b.id, b.estTon);
        events.push({ min: doneMin, text: `容量释放：${b.id} 补锁成功（估 ${b.estTon.toFixed(1)} 吨）→ 剩余可锁 ${avail().toFixed(1)} 吨` });
        const start = Math.max(b.arriveMin, doneMin);
        pending.push({ v: b, weighStart: start });
        pending.sort((x, y) => x.weighStart - y.weighStart || x.v.id.localeCompare(y.v.id));
      }
    }
  }
  for (const b of blocked) turnedAway.push(b.id);

  return {
    mode: 'lock',
    events: events.sort((a, b) => a.min - b.min),
    accepted: serviceOrder,
    turnedAway,
    serviceOrder,
    releaseEvents,
    receivedTon: received,
    capacityTon: sc.capacityTon,
    oversold: received > sc.capacityTon + 1e-6,
  };
}

/** 排队模式：不锁量；到场先后排队，过磅时才按实称扣容量；剩余不足则拒收（不超售）。 */
export function simulateQueue(sc: SimScenario): ModeSimResult {
  const events: SimEvent[] = [];
  const serviceOrder: string[] = [];
  const turnedAway: string[] = [];
  let received = 0;

  const arrivals = sc.vehicles.slice().sort((a, b) => a.arriveMin - b.arriveMin || a.id.localeCompare(b.id));
  arrivals.forEach((v, i) => {
    events.push({ min: v.arriveMin, text: `${v.id} ${fmtMin(v.arriveMin)} 到场排队（第 ${i + 1} 位；等多久取决于前车过磅，事前不可知）` });
  });

  let busyUntil = sc.windowStartMin;
  const queue = arrivals.slice();
  while (queue.length > 0) {
    const v = queue.shift()!;
    const start = Math.max(v.arriveMin, busyUntil);
    const doneMin = start + sc.weighMin;
    if (start > v.arriveMin) {
      events.push({ min: start, text: `${v.id} 等到前车过磅完成，${fmtMin(start)} 才上过磅台（${fmtMin(v.arriveMin)} 到场，等了 ${start - v.arriveMin} 分钟）` });
    }
    if (v.actualTon > round2(sc.capacityTon - received) + 1e-6) {
      turnedAway.push(v.id);
      events.push({
        min: doneMin,
        text: `${v.id} 实称 ${v.actualTon.toFixed(1)} 吨 > 窗口剩余可接收 ${round2(sc.capacityTon - received).toFixed(1)} 吨 → 拒收（不超售），只能等下一窗口或改道`,
      });
      busyUntil = doneMin;
      continue;
    }
    received = round2(received + v.actualTon);
    serviceOrder.push(v.id);
    events.push({
      min: doneMin,
      text: `${v.id} 过磅完成：实收 ${v.actualTon.toFixed(1)} 吨 → 窗口实收 ${received.toFixed(1)}/${sc.capacityTon.toFixed(1)} 吨（此刻才知剩余 ${round2(sc.capacityTon - received).toFixed(1)} 吨）`,
    });
    busyUntil = doneMin;
  }

  return {
    mode: 'queue',
    events: events.sort((a, b) => a.min - b.min),
    accepted: serviceOrder,
    turnedAway,
    serviceOrder,
    releaseEvents: [], // 无锁量，自然没有“释放”：容量只在过磅时按实称扣减
    receivedTon: received,
    capacityTon: sc.capacityTon,
    oversold: received > sc.capacityTon + 1e-6,
  };
}

export interface CompareRow {
  dimension: string;
  lock: string;
  queue: string;
}

export interface CompareResult {
  scenario: SimScenario;
  lock: ModeSimResult;
  queue: ModeSimResult;
  rows: CompareRow[];
}

/** 同一组数据下两种模式的并列对比：可接车辆、等待顺序、容量释放时刻。 */
export function compareTransferModes(sc: SimScenario = FIXED_SCENARIO): CompareResult {
  const lock = simulateLock(sc);
  const queue = simulateQueue(sc);
  const fmtList = (xs: string[]) => (xs.length ? xs.join('、') : '无');
  const releaseText = lock.releaseEvents.length
    ? lock.releaseEvents.map((r) => `${fmtMin(r.min)} 释放 ${r.ton.toFixed(1)} 吨（过磅时刻）`).join('；')
    : '无释放';
  const rows: CompareRow[] = [
    {
      dimension: '可接车辆',
      lock: `${lock.accepted.length} 辆（${fmtList(lock.accepted)}）${lock.turnedAway.length ? `；${fmtList(lock.turnedAway)} 始终未锁入` : '；但 T2 一度被挡，直到容量释放才锁入（等不及就会改道，窗口余量空置）'}`,
      queue: `${queue.accepted.length} 辆（${fmtList(queue.accepted)}）${queue.turnedAway.length ? `；${fmtList(queue.turnedAway)} 过磅时被拒` : '；按到场顺序全部接纳，估高不占坑'}`,
    },
    {
      dimension: '等待顺序',
      lock: `按预约锁定先后：${fmtList(lock.serviceOrder)}；被挡车辆等的是“容量释放”而非车队`,
      queue: `按到场先后：${fmtList(queue.serviceOrder)}；后车等的是“前车过磅完成”`,
    },
    {
      dimension: '容量释放时刻',
      lock: releaseText,
      queue: '无锁量可释放：容量只在过磅时按实称即扣即得，剩余量随每次过磅才确定',
    },
    {
      dimension: '司机可预期性',
      lock: '预约即知有无窗口；被挡时不知何时释放、能否补锁',
      queue: '到场前不知要排多久、轮到时剩余容量够不够',
    },
    {
      dimension: '不得超售核验',
      lock: `已锁(估)+实收 ≤ ${sc.capacityTon.toFixed(1)} 吨恒成立；实收 ${lock.receivedTon.toFixed(1)} 吨`,
      queue: `实收 ≤ ${sc.capacityTon.toFixed(1)} 吨恒成立（过磅时才扣）；实收 ${queue.receivedTon.toFixed(1)} 吨`,
    },
    {
      dimension: '估重≠实收',
      lock: `实收只含过磅实称（${lock.receivedTon.toFixed(1)} 吨）；估重 ${sc.vehicles.map((v) => v.estTon.toFixed(1)).join('+')} 吨仅用于锁窗，不登记为实收`,
      queue: `实收只含过磅实称（${queue.receivedTon.toFixed(1)} 吨）；估重不登记、不占用容量`,
    },
  ];
  return { scenario: sc, lock, queue, rows };
}
