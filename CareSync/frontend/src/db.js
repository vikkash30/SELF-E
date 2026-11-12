import Dexie from 'dexie';

export const db = new Dexie('CareSyncDB');

// Use numeric 0/1 for `synced` because IndexedDB indexes numbers reliably across browsers.
db.version(1).stores({
  patients: '++id, &patientKey, name, age, updatedAt',
  visits: '++localId, patientId, patientName, severity, synced, createdAt',
  facilities: 'id, severity, name, distance_km',
});

export async function saveLocalPatient({ name, age }) {
  const normalizedName = (name || '').trim();
  const patientKey = `${normalizedName.toLowerCase()}-${age}`;
  const updatedAt = new Date().toISOString();

  const existing = await db.patients.where('patientKey').equals(patientKey).first();
  if (existing) {
    await db.patients.update(existing.id, { name: normalizedName, age: Number(age), updatedAt });
    return { id: existing.id, patientKey };
  }

  const id = await db.patients.add({
    patientKey,
    name: normalizedName,
    age: Number(age),
    updatedAt,
  });
  return { id, patientKey };
}

export async function saveVisitToDexie(visitData, synced = 0) {
  const { patientKey } = await saveLocalPatient({
    name: visitData.patientName,
    age: visitData.age,
  });

  const record = {
    visitId: visitData.visitId || null,
    patientId: visitData.patientId || patientKey,
    patientName: visitData.patientName,
    age: Number(visitData.age),
    symptoms: visitData.symptoms,
    vitals: visitData.vitals,
    triageResult: visitData.triageResult || null,
    severity: visitData.triageResult?.severity || visitData.severity || 'Pending',
    status: visitData.status || 'triaged',
    synced: synced ? 1 : 0,
    createdAt: visitData.createdAt || new Date().toISOString(),
  };

  const localId = await db.visits.add(record);
  return { ...record, localId };
}

export async function updateLocalVisitStatus(localId, status) {
  if (!localId) return;
  await db.visits.update(localId, { status });
}

export async function getUnsyncedVisits() {
  return db.visits.where('synced').equals(0).toArray();
}

export async function markVisitsSynced(localIds) {
  if (!localIds?.length) return;
  await db.visits.where('localId').anyOf(localIds).modify({ synced: 1 });
}

export async function getRecentVisits(limit = 10) {
  const all = await db.visits.orderBy('createdAt').reverse().toArray();
  return all.slice(0, limit);
}

export async function cacheFacilitiesForSeverity(severity, facilities) {
  if (!Array.isArray(facilities) || facilities.length === 0) return;
  await db.facilities.bulkPut(
    facilities.map((facility) => ({
      ...facility,
      severity,
    }))
  );
}

export async function getCachedFacilitiesBySeverity(severity) {
  return db.facilities.where('severity').equals(severity).toArray();
}

export default db;
