import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import {
  Activity,
  CheckCircle2,
  Cpu,
  Gauge,
  HeartPulse,
  Lock,
  Pause,
  Play,
  Radio,
  Send,
  Sparkles,
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
    bloodPressure: '120/80',
    type: 'normal',
  },
  {
    label: 'Moderate Fever',
    temperature: '101.4',
    spo2: '96',
    heartRate: '98',
    bloodPressure: '125/82',
    type: 'warning',
  },
  {
    label: 'Critical Hypoxia (Red)',
    temperature: '103.6',
    spo2: '88',
    heartRate: '118',
    bloodPressure: '145/95',
    type: 'critical',
  },
  {
    label: 'Tachycardia',
    temperature: '99.0',
    spo2: '95',
    heartRate: '138',
    bloodPressure: '130/85',
    type: 'warning',
  },
  {
    label: 'Hypertensive Crisis',
    temperature: '98.4',
    spo2: '97',
    heartRate: '104',
    bloodPressure: '180/110',
    type: 'critical',
  },
];

export default function IoTSimulator() {
  const [activeSession, setActiveSession] = useState(null);
  const [temperature, setTemperature] = useState('98.6');
  const [spo2, setSpo2] = useState('98');
  const [heartRate, setHeartRate] = useState('76');
  const [bloodPressure, setBloodPressure] = useState('120/80');

  const [isLiveLooping, setIsLiveLooping] = useState(true);
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

  // Helper to broadcast vitals across local channel and localStorage
  const broadcastTelemetry = (tVal, sVal, hrVal, bpVal) => {
    const activeId = activeSession?.patientId ?? 1;
    const visitDocId = String(activeId);
    const vitals = {
      temperature: tVal === '' ? null : Number(tVal),
      spo2: sVal === '' ? null : Number(sVal),
      heart_rate: hrVal === '' ? null : Number(hrVal),
      blood_pressure: bpVal || '120/80',
    };

    const readingPayload = {
      visit_id: visitDocId,
      patient_id: activeId,
      patient_name: activeSession?.name?.trim() || 'Patient Session',
      gender: activeSession?.gender || '',
      country: activeSession?.country || 'India',
      state: activeSession?.state || 'Tamil Nadu',
      city: activeSession?.city || 'Coimbatore',
      vitals,
      status: 'iot_ready',
      source: 'iot_simulator',
      device_id: 'IOT-BLE-KIT-01',
      created_at: new Date().toISOString(),
    };

    try {
      localStorage.setItem(IOT_STORAGE_KEY, JSON.stringify(readingPayload));
      if (typeof BroadcastChannel !== 'undefined') {
        const ch = new BroadcastChannel(IOT_CHANNEL_NAME);
        ch.postMessage({
          type: 'NEW_READINGS',
          readings: readingPayload,
          reading: readingPayload,
        });
        ch.postMessage({
          type: 'IOT_READING',
          readings: readingPayload,
          reading: readingPayload,
        });
        ch.close();
      }
    } catch {
      // Ignore quota error
    }

    return readingPayload;
  };

  // Real-time simulator loop (Physiological micro-fluctuations)
  useEffect(() => {
    if (!isLiveLooping) return;

    const interval = setInterval(() => {
      setHeartRate((prev) => {
        const num = Number(prev) || 76;
        const delta = Math.round((Math.random() - 0.5) * 2);
        const updated = Math.max(50, Math.min(180, num + delta));
        return String(updated);
      });

      setSpo2((prev) => {
        const num = Number(prev) || 98;
        if (Math.random() > 0.75) {
          const delta = Math.random() > 0.5 ? 1 : -1;
          const updated = Math.max(70, Math.min(100, num + delta));
          return String(updated);
        }
        return prev;
      });
    }, 2600);

    return () => clearInterval(interval);
  }, [isLiveLooping]);

  // Sync to channel and storage whenever values change
  useEffect(() => {
    if (activeSession?.name?.trim()) {
      broadcastTelemetry(temperature, spo2, heartRate, bloodPressure);
    }
  }, [temperature, spo2, heartRate, bloodPressure, activeSession]);

  function applyVitalPreset(preset) {
    setTemperature(preset.temperature);
    setSpo2(preset.spo2);
    setHeartRate(preset.heartRate);
    if (preset.bloodPressure) {
      setBloodPressure(preset.bloodPressure);
    }
    setStatusNotice(null);
    setErrorMsg('');

    broadcastTelemetry(
      preset.temperature,
      preset.spo2,
      preset.heartRate,
      preset.bloodPressure || bloodPressure
    );
  }

  async function handleSendReadings(e) {
    if (e && e.preventDefault) e.preventDefault();
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
      blood_pressure: bloodPressure || '120/80',
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
      broadcastTelemetry(temperature, spo2, heartRate, bloodPressure);
      setIsSending(false);
      setStatusNotice({ ...readingPayload, deliveryTarget });
    }
  }

  const activeName = activeSession?.name?.trim();
  const activePatientId = activeSession?.patientId;
  const activeGender = activeSession?.gender;

  const currentHR = Math.max(30, Math.min(220, Number(heartRate) || 76));
  const currentSpO2 = Number(spo2) || 98;
  const beatDuration = 60 / currentHR;

  const isFever = Number(temperature) > 100.4;
  const isHypoxic = currentSpO2 < 94;
  const isTachycardic = currentHR > 100;
  const isHeartAlert = isTachycardic || isHypoxic;

  const bpParts = (bloodPressure || '120/80').split('/');
  const isHypertensive = Number(bpParts[0]) >= 140 || Number(bpParts[1]) >= 90;

  return (
    <div className="min-h-screen bg-[#F6F9F8] text-slate-900 antialiased">
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {/* Header Bar */}
        <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200/80 bg-white px-6 py-4 shadow-xs">
          <div className="flex items-center gap-3.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-teal-50 text-teal-600 border border-teal-100">
              <Cpu className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-black text-slate-900">CareSync IoT Sensor Terminal</h1>
                <span className="rounded-md bg-teal-100/70 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-teal-800">
                  Hardware Sim
                </span>
              </div>
              <p className="text-xs text-slate-500 font-medium">
                Visual Anatomy Sensor Map &bull; Live Telemetry Feed &bull; <code>/iot</code>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setIsLiveLooping(!isLiveLooping)}
              className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-bold transition shadow-2xs ${
                isLiveLooping
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-slate-200 bg-slate-50 text-slate-600'
              }`}
              title="Toggle continuous physiological micro-fluctuations"
            >
              {isLiveLooping ? (
                <>
                  <Pause className="h-3.5 w-3.5" /> Live Stream Active
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5" /> Stream Paused
                </>
              )}
            </button>

            <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-50 px-3.5 py-1 text-xs font-bold text-teal-700 border border-teal-200/60 shadow-2xs">
              <Radio className="h-3.5 w-3.5 animate-pulse text-teal-600" />
              {isFirebaseConfigured ? 'Cloud Live Sync' : 'Kiosk Local Bridge'}
            </span>
          </div>
        </header>

        {/* Read-Only Active Patient Identity Display */}
        <section className="mt-6 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-teal-700">
              <Lock className="h-3.5 w-3.5" />
              Active Screening Session
            </span>
            {activePatientId != null && (
              <span className="rounded-full bg-slate-100 px-3 py-0.5 font-mono text-xs font-black text-slate-700 border border-slate-200">
                Patient #{activePatientId}
              </span>
            )}
          </div>

          <div className="mt-3 flex items-center gap-3.5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-teal-50 text-teal-600 border border-teal-100">
              <UserCheck className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-xl font-black text-slate-900">
                Current Patient: {activeName || 'Waiting for Operator at /operator...'}
              </h2>
              <p className="text-xs text-slate-500 font-medium">
                Gender: {activeGender || '--'} &bull; Identity locked to kiosk intake &bull; Vitals transmit directly to operator
              </p>
            </div>
          </div>
        </section>

        {/* Main Visual Anatomy Sensor Map (Phase 1 & 3) */}
        <section className="mt-6 rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xs">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <h3 className="text-base font-black text-slate-900 flex items-center gap-2">
                <Activity className="h-4 w-4 text-teal-600" />
                Interactive Visual Anatomy Sensor Map
              </h3>
              <p className="text-xs text-slate-500 font-medium mt-0.5">
                Vitals are pinned to physiological sensor nodes on the body diagram with live bidirectional telemetry.
              </p>
            </div>
            <span className="text-xs font-bold text-slate-400 hidden sm:inline-block">
              Click values or presets below to adjust
            </span>
          </div>

          {/* Body Anatomy Container with Floating Glassmorphism Cards */}
          <div className="relative w-full max-w-2xl mx-auto my-8 select-none py-6">
            {/* Phase 1: Subtle Ambient Glow Breathes with Heart Rate Duration, Tinted Red on Alert */}
            <motion.div
              className={`pointer-events-none absolute inset-0 -m-4 sm:-m-6 rounded-3xl blur-2xl transition-colors duration-700 ${
                isHeartAlert ? 'bg-red-500/25' : 'bg-teal-400/20'
              }`}
              animate={{
                scale: [0.97, 1.04, 0.97],
                opacity: isHeartAlert ? [0.35, 0.65, 0.35] : [0.18, 0.38, 0.18],
              }}
              transition={{
                duration: beatDuration,
                repeat: Infinity,
                ease: 'easeInOut',
              }}
            />

            <img
              src="/image_0d8be3.jpg"
              alt="Anatomy Sensor Map"
              className="relative w-full h-auto object-contain rounded-2xl bg-white border border-slate-100 shadow-xs mx-auto max-h-[640px] z-1"
            />

            {/* CARD 1: Temperature Sensor near Head */}
            <div className="absolute top-[10%] left-[50%] -translate-x-1/2 -translate-y-full z-20 backdrop-blur-md bg-white/90 shadow-xl rounded-xl p-3 border border-amber-200 min-w-[210px] transition-all hover:scale-105">
              <div className="flex items-center justify-between gap-2 border-b border-amber-100 pb-1.5 mb-2">
                <span className="flex items-center gap-1.5 text-xs font-black text-amber-900">
                  <Thermometer className="h-4 w-4 text-amber-500" />
                  Head Temp Sensor
                </span>
                <span
                  className={`text-[10px] font-extrabold px-1.5 py-0.5 rounded-full ${
                    isFever ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
                  }`}
                >
                  {isFever ? 'Fever' : 'Normal'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="temp-input" className="text-xs font-semibold text-slate-600">
                  Infrared:
                </label>
                <div className="flex items-center gap-1">
                  <input
                    id="temp-input"
                    type="number"
                    step="0.1"
                    min="85"
                    max="115"
                    value={temperature}
                    onChange={(e) => setTemperature(e.target.value)}
                    className="w-20 rounded-md border border-amber-200 bg-amber-50/60 px-2 py-0.5 text-sm font-black text-slate-800 text-center focus:outline-none focus:ring-2 focus:ring-amber-400"
                  />
                  <span className="text-xs font-bold text-slate-500">°F</span>
                </div>
              </div>
            </div>

            {/* Connector Line 1: From Temperature Card down to Head */}
            <div className="absolute left-[50%] top-[10%] -translate-x-1/2 flex flex-col items-center pointer-events-none z-10">
              <div className="w-0.5 h-6 sm:h-8 bg-gradient-to-b from-amber-400 to-amber-500"></div>
              <div className="relative flex items-center justify-center">
                <span className="absolute h-3.5 w-3.5 rounded-full bg-amber-400 animate-ping"></span>
                <span className="h-2.5 w-2.5 rounded-full bg-amber-600 ring-2 ring-white"></span>
              </div>
            </div>

            {/* CARD 2: Heart Rate & SpO2 near Chest/Heart (Phase 1: Framer Motion Pulse Sync) */}
            <motion.div
              className={`absolute top-[40%] left-[65%] z-20 backdrop-blur-md bg-white/90 shadow-xl rounded-xl p-3 min-w-[210px] transition-all hover:scale-105 border ${
                isHeartAlert ? 'border-red-300 ring-2 ring-red-400/40' : 'border-sky-200'
              }`}
              animate={{ scale: [1, 1.05, 1] }}
              transition={{
                duration: beatDuration,
                repeat: Infinity,
                ease: 'easeInOut',
              }}
            >
              <div className="flex items-center justify-between gap-2 border-b border-sky-100 pb-1.5 mb-2">
                <span className="flex items-center gap-1.5 text-xs font-black text-sky-900">
                  <HeartPulse className="h-4 w-4 text-rose-500" />
                  Chest & SpO2
                </span>
                <span
                  className={`text-[10px] font-extrabold px-1.5 py-0.5 rounded-full ${
                    isHeartAlert
                      ? 'bg-red-100 text-red-700'
                      : 'bg-emerald-100 text-emerald-700'
                  }`}
                >
                  {isHypoxic ? 'Hypoxia' : isTachycardic ? 'High HR' : 'Stable'}
                </span>
              </div>

              {/* SpO2 */}
              <div className="flex items-center justify-between gap-2 mb-2">
                <label htmlFor="spo2-input" className="text-xs font-semibold text-slate-600 flex items-center gap-1">
                  <Activity className="h-3.5 w-3.5 text-sky-500" /> SpO2:
                </label>
                <div className="flex items-center gap-1">
                  <input
                    id="spo2-input"
                    type="number"
                    min="50"
                    max="100"
                    value={spo2}
                    onChange={(e) => setSpo2(e.target.value)}
                    className="w-16 rounded-md border border-sky-200 bg-sky-50/60 px-2 py-0.5 text-sm font-black text-slate-800 text-center focus:outline-none focus:ring-2 focus:ring-sky-400"
                  />
                  <span className="text-xs font-bold text-slate-500">%</span>
                </div>
              </div>

              {/* Heart Rate */}
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="hr-input" className="text-xs font-semibold text-slate-600 flex items-center gap-1">
                  <HeartPulse className="h-3.5 w-3.5 text-rose-500" /> Pulse:
                </label>
                <div className="flex items-center gap-1">
                  <input
                    id="hr-input"
                    type="number"
                    min="25"
                    max="240"
                    value={heartRate}
                    onChange={(e) => setHeartRate(e.target.value)}
                    className="w-16 rounded-md border border-rose-200 bg-rose-50/60 px-2 py-0.5 text-sm font-black text-slate-800 text-center focus:outline-none focus:ring-2 focus:ring-rose-400"
                  />
                  <span className="text-xs font-bold text-slate-500">bpm</span>
                </div>
              </div>
            </motion.div>

            {/* Connector Line 2: Pointing from Card to Chest */}
            <div className="absolute top-[44%] right-[35%] flex items-center pointer-events-none z-10">
              <div className="relative flex items-center justify-center">
                <span className="absolute h-3.5 w-3.5 rounded-full bg-rose-500 animate-ping"></span>
                <span className="h-2.5 w-2.5 rounded-full bg-rose-600 ring-2 ring-white"></span>
              </div>
              <div className="w-8 sm:w-14 h-0.5 bg-gradient-to-r from-rose-500 to-sky-400"></div>
            </div>

            {/* CARD 3: Blood Pressure near Arm */}
            <div className="absolute top-[50%] left-[10%] z-20 backdrop-blur-md bg-white/90 shadow-xl rounded-xl p-3 border border-indigo-200 min-w-[210px] transition-all hover:scale-105">
              <div className="flex items-center justify-between gap-2 border-b border-indigo-100 pb-1.5 mb-2">
                <span className="flex items-center gap-1.5 text-xs font-black text-indigo-900">
                  <Gauge className="h-4 w-4 text-indigo-500" />
                  Arm BP Cuff
                </span>
                <span
                  className={`text-[10px] font-extrabold px-1.5 py-0.5 rounded-full ${
                    isHypertensive ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
                  }`}
                >
                  {isHypertensive ? 'Elevated' : 'Normal'}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <label htmlFor="bp-input" className="text-xs font-semibold text-slate-600">
                  NIBP:
                </label>
                <div className="flex items-center gap-1">
                  <input
                    id="bp-input"
                    type="text"
                    value={bloodPressure}
                    onChange={(e) => setBloodPressure(e.target.value)}
                    placeholder="120/80"
                    className="w-20 rounded-md border border-indigo-200 bg-indigo-50/60 px-2 py-0.5 text-sm font-black text-slate-800 text-center focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  />
                  <span className="text-[11px] font-bold text-slate-500">mmHg</span>
                </div>
              </div>
            </div>

            {/* Connector Line 3: Pointing from BP Card to Arm */}
            <div className="absolute top-[54%] left-[calc(10%+195px)] sm:left-[calc(10%+210px)] flex items-center pointer-events-none z-10">
              <div className="w-8 sm:w-14 h-0.5 bg-gradient-to-r from-indigo-500 to-indigo-400"></div>
              <div className="relative flex items-center justify-center">
                <span className="absolute h-3.5 w-3.5 rounded-full bg-indigo-500 animate-ping"></span>
                <span className="h-2.5 w-2.5 rounded-full bg-indigo-600 ring-2 ring-white"></span>
              </div>
            </div>
          </div>

          {/* Action Trigger & Delivery Notice */}
          <div className="mt-6 flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-slate-100 pt-5">
            <div className="text-xs text-slate-500 font-medium">
              Sensor Node: <span className="font-bold text-slate-700">IOT-BLE-KIT-01</span> &bull; Telemetry syncs live to Operator Kiosk
            </div>

            <button
              type="button"
              onClick={handleSendReadings}
              disabled={isSending || !activeName}
              className="flex items-center justify-center gap-2 rounded-xl bg-teal-600 px-6 py-3 text-sm font-bold text-white shadow-md transition hover:bg-teal-500 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              {isSending
                ? 'Transmitting Vitals...'
                : activeName
                ? `Broadcast Telemetry for #${activePatientId} (${activeName})`
                : 'Waiting for Operator to Set Patient...'}
            </button>
          </div>

          {errorMsg && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-xs font-semibold text-red-700">
              {errorMsg}
            </div>
          )}

          {statusNotice && (
            <div className="mt-4 flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-800">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              <div className="text-sm">
                <p className="font-bold text-emerald-950">
                  Telemetry Broadcast Successful for #{statusNotice.patient_id} — {statusNotice.patient_name}
                </p>
                <p className="mt-0.5 text-xs text-emerald-700">
                  Temp {statusNotice.vitals.temperature}°F &bull; SpO2 {statusNotice.vitals.spo2}% &bull; HR{' '}
                  {statusNotice.vitals.heart_rate} bpm &bull; BP {statusNotice.vitals.blood_pressure} &bull; Channel: {statusNotice.deliveryTarget}
                </p>
              </div>
            </div>
          )}
        </section>

        {/* Retained Simulation Presets at Bottom of Screen */}
        <section className="mt-6 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between mb-3.5">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-teal-600" />
              Simulation Presets
            </h3>
            <span className="text-xs text-slate-500 font-medium">
              Click a preset to instantly load and stream clinical vitals
            </span>
          </div>

          <div className="flex flex-wrap gap-2.5">
            {VITAL_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => applyVitalPreset(preset)}
                className={`rounded-xl border px-4 py-2.5 text-xs font-bold transition shadow-2xs hover:scale-[1.02] active:scale-[0.98] ${
                  preset.type === 'critical'
                    ? 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
                    : preset.type === 'warning'
                    ? 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-teal-50 hover:text-teal-800'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
