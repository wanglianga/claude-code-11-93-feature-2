// IndexedDB 持久层（idb 封装）：全部业务状态落库，可一键重置重放
import { openDB, type IDBPDatabase } from 'idb';
import type {
  Booking, Closure, DumpSite, EventLog, Instruction, NotificationDoc, Receipt, Road,
  RouteVersion, Station, TransferStation, Vehicle,
} from '../types';
import * as seed from './seed';

const DB_NAME = 'sanitation-workbench';
const DB_VERSION = 2;

export interface Snapshot {
  nowMin: number;
  vehicles: Vehicle[];
  stations: Station[];
  roads: Road[];
  closures: Closure[];
  dumps: DumpSite[];
  notifications: NotificationDoc[];
  routeVersions: RouteVersion[];
  receipts: Receipt[];
  outbox: Receipt[];
  events: EventLog[];
  transferStations: TransferStation[];
  bookings: Booking[];
  instructions: Instruction[];
}

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const ensure = (name: string, opts?: IDBObjectStoreParameters) => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts);
        };
        ensure('meta');
        ensure('vehicles', { keyPath: 'id' });
        ensure('stations', { keyPath: 'id' });
        ensure('roads', { keyPath: 'id' });
        ensure('closures', { keyPath: 'id' });
        ensure('dumps', { keyPath: 'id' });
        ensure('notifications', { keyPath: 'id' });
        ensure('routeVersions', { keyPath: 'id' });
        ensure('receipts', { keyPath: 'id' });
        ensure('outbox', { keyPath: 'id' });
        ensure('events', { keyPath: 'id', autoIncrement: true });
        ensure('transferStations', { keyPath: 'id' });
        ensure('bookings', { keyPath: 'id' });
        ensure('instructions', { keyPath: 'id' });
      },
    });
  }
  return dbPromise;
}

export async function loadSnapshot(): Promise<Snapshot> {
  const db = await getDb();
  const [nowMin, vehicles, stations, roads, closures, dumps, notifications, routeVersions, receipts, outbox, events, transferStations, bookings, instructions] =
    await Promise.all([
      db.get('meta', 'nowMin'),
      db.getAll('vehicles'),
      db.getAll('stations'),
      db.getAll('roads'),
      db.getAll('closures'),
      db.getAll('dumps'),
      db.getAll('notifications'),
      db.getAll('routeVersions'),
      db.getAll('receipts'),
      db.getAll('outbox'),
      db.getAll('events'),
      db.getAll('transferStations'),
      db.getAll('bookings'),
      db.getAll('instructions'),
    ]);
  return {
    nowMin: nowMin ?? seed.START_MIN,
    vehicles, stations, roads, closures, dumps, notifications, routeVersions, receipts, outbox,
    events: (events as EventLog[]).sort((a, b) => (a.id ?? 0) - (b.id ?? 0)),
    transferStations, bookings, instructions,
  };
}

/** 重置并重放：清空全部仓库，写入随题固定的虚构数据。 */
export async function resetAndSeed(): Promise<void> {
  const db = await getDb();
  const stores = [
    'meta', 'vehicles', 'stations', 'roads', 'closures', 'dumps',
    'notifications', 'routeVersions', 'receipts', 'outbox', 'events',
    'transferStations', 'bookings', 'instructions',
  ];
  const tx = db.transaction(stores, 'readwrite');
  for (const s of stores) await tx.objectStore(s).clear();
  await tx.objectStore('meta').put(seed.START_MIN, 'nowMin');
  for (const v of seed.VEHICLES) await tx.objectStore('vehicles').put(v);
  for (const s of seed.STATIONS) await tx.objectStore('stations').put(s);
  for (const r of seed.ROADS) await tx.objectStore('roads').put(r);
  for (const c of seed.CLOSURES) await tx.objectStore('closures').put(c);
  for (const d of seed.DUMPS) await tx.objectStore('dumps').put(d);
  for (const n of seed.NOTIFICATIONS) await tx.objectStore('notifications').put(n);
  for (const rv of seed.ROUTE_VERSIONS) await tx.objectStore('routeVersions').put(rv);
  for (const e of seed.SEED_EVENTS) await tx.objectStore('events').add(e);
  for (const t of seed.TRANSFER_STATIONS) await tx.objectStore('transferStations').put(t);
  for (const b of seed.BOOKINGS) await tx.objectStore('bookings').put(b);
  await tx.done;
}

export async function isSeeded(): Promise<boolean> {
  const db = await getDb();
  const count = await db.count('vehicles');
  const transferCount = await db.count('transferStations');
  return count > 0 && transferCount > 0;
}
