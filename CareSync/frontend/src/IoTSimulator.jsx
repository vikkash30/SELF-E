import { useEffect, useState } from 'react';
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import {
  Activity,
  CheckCircle2,
  Cpu,
  HeartPulse,
  Lock,
  Radio,
  Send,
  Thermometer,
  UserCheck,
} from 'lucide-react';
import { firestoreDb, isFirebaseConfigured } from './firebase.js';
import { API_BASE_URL } from './syncManager.js';

export const IOT_CHANNEL_NAME = 'caresync-iot';
export const IOT_STORAGE_KEY = 'caresync_latest_iot';
export const SESSION_CHANNEL_NAME = 'caresync-session';
export const SESSION_STORAGE_KEY = 'caresync_active_session';

const VITAL_PRESETS = [
  {
    label: 'Normal Vitals',
    temperature: '98.6',
    spo2: '98',
    heartRate: '76',
  },
  {
    label: 'Moderate Fever',
    temperature: '101.4',
    spo2: '96',
    heartRate: '98',
  },
  {
    label: 'Critical Hypoxia (Red)',
    temperature: '103.6',
    spo2: '88',
    heartRate: '118',
  },
];

export default function IoTSimulator() {
  const [activeSession, setActiveSession] = useState(null);
  const [temperature, setTemperature] = useState('98.6');
  const [spo2, setSpo2] = useState('98');
  const [heartRate, setHeartRate] = useState('76');

  const [isSending, setIsSending] = useState(false);
  const [statusNotice, setStatusNotice] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');

  // Listen to `active_sessions/current` via Firestore onSnapshot + local real-time bridge.
  useEffect(() => {
    let unsubscribeSnapshot = () => {};

    if (isFirebaseConfigured) {
      const sessionDocRef = doc(firestoreDb, 'active_sessions', 'current');
      unsubscribeSnapshot = onSnapshot(
        sessionDocRef,
        (snapshot) => {
          if (snapshot.exists()) {
            const data = snapshot.data();
            setActiveSession(data?.name || data?.gender ? data : null);
          } else {
            setActiveSession(null);
            setStatusNotice(null);
          }
        },
        (error) => {
          console.error('Firestore active_sessions listener error:', error);
        }
      );
    }

    const loadCachedSession = () => {
      try {
        const raw = localStorage.getItem(SESSION_STORAGE_KEY);
        if (!raw) {
          setActiveSession(null);
          return;
        }
        const parsed = JSON.parse(raw);
        setActiveSession(parsed?.name || parsed?.gender ? parsed : null);
      } catch {
        // Ignore parse errors.
      }
    };

    loadCachedSession();

    let channel;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(SESSION_CHANNEL_NAME);
      channel.onmessage = (event) => {
        if (event.data?.type === 'SESSION_UPDATE') {
          const s = event.data.session;
          setActiveSession(s?.name || s?.gender ? s : null);
        } else if (event.data?.type === 'SESSION_CLEARED') {
          setActiveSession(null);
          setStatusNotice(null);
          setErrorMsg('');
        }
      };
    }

    const handleStorage = (event) => {
      if (event.key === SESSION_STORAGE_KEY) {
        loadCachedSession();
        if (!event.newValue) {
          setStatusNotice(null);
        }
      }
    };
    window.addEventListener('storage', handleStorage);

    let pollTimer;
    if (!isFirebaseConfigured) {
      const pollSession = async () => {
        if (!navigator.onLine) return;
        try {
          const res = await fetch(`${API_BASE_URL}/session/current`);
          if (res.ok) {
            const data = await res.json();
            const s = data?.session;
            if (s && (s.name || s.gender)) {
              setActiveSession(s);
            } else if (!localStorage.getItem(SESSION_STORAGE_KEY)) {
              setActiveSession(null);
            }
          }
        } catch {
          // Backend unreachable; rely on BroadcastChannel / localStorage.
        }
      };
      pollSession();
      pollTimer = setInterval(pollSession, 1500);
    }

    return () => {
      unsubscribeSnapshot();
      if (channel) channel.close();
      window.removeEventListener('storage', handleStorage);
      if (pollTimer) clearInterval(pollTimer);
    };
  }, []);

  function applyVitalPreset(preset) {
    setTemperature(preset.temperature);
    setSpo2(preset.spo2);
    setHeartRate(preset.heartRate);
    setStatusNotice(null);
    setErrorMsg('');
  }

  async function handleSendReadings(e) {
    e.preventDefault();
    setErrorMsg('');
    setStatusNotice(null);

    if (!activeSession || !activeSession.name?.trim()) {
      setErrorMsg('Waiting for Operator to enter Patient Name on /operator before sending vitals.');
      return;
    }

    const activeId = activeSession.patientId ?? 1;
    const visitDocId = String(activeId);
    const vitals = {
      temperature: temperature === '' ? null : Number(temperature),
      spo2: spo2 === '' ? null : Number(spo2),
      heart_rate: heartRate === '' ? null : Number(heartRate),
    };

    const readingPayload = {
      visit_id: visitDocId,
      patient_id: activeId,
      patient_name: activeSession.name.trim(),
      gender: activeSession.gender || '',
      country: activeSession.country || 'India',
      state: activeSession.state || 'Tamil Nadu',
      city: activeSession.city || 'Coimbatore',
      vitals,
      status: 'iot_ready',
      source: 'iot_simulator',
      device_id: 'IOT-BLE-KIT-01',
      created_at: new Date().toISOString(),
    };

    setIsSending(true);
    let deliveryTarget = 'local_bridge';

    try {
      if (isFirebaseConfigured) {
        await setDoc(
          doc(firestoreDb, 'visits', visitDocId),
          {
            ...readingPayload,
            updated_at: serverTimestamp(),
          },
          { merge: true }
        );
        deliveryTarget = 'firestore';
      } else {
        const response = await fetch(`${API_BASE_URL}/iot/readings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            patient_id: activeId,
            patient_name: readingPayload.patient_name,
            gender: readingPayload.gender,
            vitals,
            device_id: readingPayload.device_id,
          }),
        });
        if (response.ok) {
          deliveryTarget = 'backend_bridge';
        }
      }
    } catch (err) {
      console.warn('Primary IoT transmission fallback triggered:', err);
    } finally {
      try {
        localStorage.setItem(IOT_STORAGE_KEY, JSON.stringify(readingPayload));
        if (typeof BroadcastChannel !== 'undefined') {
          const channel = new BroadcastChannel(IOT_CHANNEL_NAME);
          channel.postMessage({ type: 'IOT_READING', reading: readingPayload });
          channel.close();
        }
      } catch {
        // Ignore storage quota errors.
      }

      setIsSending(false);
      setStatusNotice({ ...readingPayload, deliveryTarget });
    }
  }

  const activeName = activeSession?.name?.trim();
  const activePatientId = activeSession?.patientId;
  const activeGender = activeSession?.gender;

  return (
    <div className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/20 text-indigo-300">
              <Cpu className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white">CareSync IoT Device Terminal</h1>
              <p className="text-xs text-slate-400">
                Read-Only Patient Identity • Sensor Telemetry Sender • Route: <code>/iot</code>
              </p>
            </div>
          </div>

          <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/15 px-3 py-1 text-xs font-semibold text-indigo-300 ring-1 ring-indigo-400/30">
            <Radio className="h-3.5 w-3.5 animate-pulse" />
            {isFirebaseConfigured ? 'Firestore Live Sync' : 'Live Session Bridge'}
          </span>
        </header>

        {/* Read-Only Active Patient Display (Synced from Operator) */}
        <section className="rounded-2xl border border-indigo-500/30 bg-slate-900 p-5 shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-indigo-300">
              <Lock className="h-3.5 w-3.5" />
              Active Session (Locked to Operator)
            </span>
            {activePatientId != null && (
              <span className="rounded-full bg-indigo-500/20 px-3 py-0.5 font-mono text-xs font-bold text-indigo-200">
                Patient ID: #{activePatientId}
              </span>
            )}
          </div>

          <div className="mt-3 flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-800 text-indigo-300">
              <UserCheck className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">
                Current Patient: {activeName || 'Waiting for Operator...'}
              </h2>
              <p className="text-xs text-slate-400">
                Gender: {activeGender || '--'} • Identity cannot be edited on the IoT sensor unit
              </p>
            </div>
          </div>
        </section>

        {/* Sensor Controls */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl sm:p-6">
          <div className="mb-5">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
              Simulate Sensor Presets
            </p>
            <div className="flex flex-wrap gap-2">
              {VITAL_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => applyVitalPreset(preset)}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-indigo-400 hover:bg-indigo-500/20"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <form onSubmit={handleSendReadings} className="space-y-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3.5">
                <label
                  htmlFor="iot-temp"
                  className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-orange-300"
                >
                  <Thermometer className="h-4 w-4" />
                  Temperature (°F)
                </label>
                <input
                  id="iot-temp"
                  type="number"
                  step="0.1"
                  min="85"
                  max="115"
                  required
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-lg font-bold text-white focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3.5">
                <label
                  htmlFor="iot-spo2"
                  className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-sky-300"
                >
                  <Activity className="h-4 w-4" />
                  SpO2 (%)
                </label>
                <input
                  id="iot-spo2"
                  type="number"
                  min="50"
                  max="100"
                  required
                  value={spo2}
                  onChange={(e) => setSpo2(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-lg font-bold text-white focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3.5">
                <label
                  htmlFor="iot-hr"
                  className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-rose-300"
                >
                  <HeartPulse className="h-4 w-4" />
                  Heart Rate (bpm)
                </label>
                <input
                  id="iot-hr"
                  type="number"
                  min="25"
                  max="240"
                  required
                  value={heartRate}
                  onChange={(e) => setHeartRate(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-lg font-bold text-white focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>

            {errorMsg && (
              <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-200">
                {errorMsg}
              </div>
            )}

            <button
              type="submit"
              disabled={isSending || !activeName}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-4 text-base font-bold text-white shadow-lg transition hover:bg-indigo-500 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-5 w-5" />
              {isSending
                ? 'Sending Readings...'
                : activeName
                  ? `Send Readings for #${activePatientId} (${activeName})`
                  : 'Waiting for Operator to Set Patient...'}
            </button>
          </form>

          {statusNotice && (
            <div className="mt-5 flex items-start gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-emerald-200">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
              <div className="text-sm">
                <p className="font-bold text-emerald-100">
                  Vitals sent for #{statusNotice.patient_id} — {statusNotice.patient_name}
                </p>
                <p className="mt-0.5 text-xs text-emerald-300">
                  Temp {statusNotice.vitals.temperature}°F • SpO2 {statusNotice.vitals.spo2}% • HR{' '}
                  {statusNotice.vitals.heart_rate} bpm • Channel: {statusNotice.deliveryTarget}
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
