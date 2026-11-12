import {
  getUnsyncedVisits,
  markVisitsSynced,
  saveVisitToDexie,
} from './db.js';

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

let listenerAttached = false;
let syncInFlight = false;
const subscribers = new Set();

function notifySubscribers(payload) {
  subscribers.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error('Sync subscriber error:', err);
    }
  });
}

export async function getPendingSyncCount() {
  const pending = await getUnsyncedVisits();
  return pending.length;
}

export async function queueOfflineVisit(visitData) {
  const saved = await saveVisitToDexie(visitData, 0);
  const pendingCount = await getPendingSyncCount();
  notifySubscribers({
    status: 'queued',
    pendingCount,
    lastMessage: `Saved "${saved.patientName}" offline. ${pendingCount} visit(s) waiting to sync.`,
  });
  return saved;
}

export async function syncPendingVisits() {
  if (syncInFlight) {
    return { status: 'busy', syncedCount: 0 };
  }
  if (!navigator.onLine) {
    const pendingCount = await getPendingSyncCount();
    return { status: 'offline', syncedCount: 0, pendingCount };
  }

  const unsynced = await getUnsyncedVisits();
  if (unsynced.length === 0) {
    notifySubscribers({ status: 'idle', pendingCount: 0 });
    return { status: 'empty', syncedCount: 0, pendingCount: 0 };
  }

  syncInFlight = true;
  notifySubscribers({
    status: 'syncing',
    pendingCount: unsynced.length,
    lastMessage: `Syncing ${unsynced.length} offline visit(s)...`,
  });

  try {
    const payload = {
      visits: unsynced.map((v) => ({
        local_id: v.localId,
        visit_id: v.visitId,
        patient_id: v.patientId,
        patient_name: v.patientName,
        age: v.age,
        symptoms: v.symptoms,
        vitals: v.vitals,
        triage_result: v.triageResult,
        status: v.status || 'triaged',
        created_at: v.createdAt,
      })),
    };

    const response = await fetch(`${API_BASE_URL}/visits/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Sync failed with HTTP ${response.status}`);
    }

    const result = await response.json();
    const syncedLocalIds = unsynced.map((v) => v.localId);
    await markVisitsSynced(syncedLocalIds);

    const remaining = await getPendingSyncCount();
    notifySubscribers({
      status: 'synced',
      pendingCount: remaining,
      lastSyncedAt: new Date().toISOString(),
      lastMessage: `Synced ${result.synced_count ?? syncedLocalIds.length} visit(s) to cloud (${result.storage || 'firestore'}).`,
    });

    return {
      status: 'synced',
      syncedCount: result.synced_count ?? syncedLocalIds.length,
      pendingCount: remaining,
      result,
    };
  } catch (error) {
    const remaining = await getPendingSyncCount();
    notifySubscribers({
      status: 'error',
      pendingCount: remaining,
      lastMessage: `Sync paused: ${error.message}`,
    });
    return { status: 'error', error: error.message, pendingCount: remaining };
  } finally {
    syncInFlight = false;
  }
}

export function initSyncManager(onUpdate) {
  if (onUpdate) {
    subscribers.add(onUpdate);
  }

  if (!listenerAttached && typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      syncPendingVisits();
    });
    window.addEventListener('offline', async () => {
      const pendingCount = await getPendingSyncCount();
      notifySubscribers({
        status: 'offline',
        pendingCount,
        lastMessage: 'Network offline — visits will queue locally in IndexedDB.',
      });
    });
    listenerAttached = true;
  }

  // Attempt immediate sync if already online with queued records.
  if (typeof navigator !== 'undefined' && navigator.onLine) {
    syncPendingVisits();
  }

  return () => {
    if (onUpdate) subscribers.delete(onUpdate);
  };
}

