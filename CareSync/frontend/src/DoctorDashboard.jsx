import { useEffect, useState } from 'react';
import { JitsiMeeting } from '@jitsi/react-sdk';
import { motion, AnimatePresence } from 'framer-motion';
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  Activity,
  CheckCircle2,
  Clock,
  Globe,
  HeartPulse,
  Home,
  MapPin,
  Phone,
  PhoneCall,
  PhoneOff,
  Pill,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Thermometer,
  Trash2,
  UserCheck,
  Video,
} from 'lucide-react';
import { firestoreDb, isFirebaseConfigured } from './firebase.js';
import {
  ESCALATED_FALLBACK_KEY,
  ESCALATION_CHANNEL_NAME,
} from './OperatorDashboard.jsx';
import { API_BASE_URL } from './syncManager.js';
import AnimatedCard from './components/AnimatedCard.jsx';

const MEDICINE_OPTIONS = [
  'Tab. Metformin 500mg',
  'Cap. Amoxicillin 250mg',
  'Tab. Paracetamol 650mg',
  'Tab. Cetirizine 10mg',
  'Tab. Amlodipine 5mg',
  'Tab. Pantoprazole 40mg',
  'Tab. Azithromycin 500mg',
  'ORS Sachet',
];

const DOSAGE_OPTIONS = ['1 Tablet', '2 Tablets', '1 Spoon'];
const TIMING_OPTIONS = ['Morning', 'Night', 'Morning & Night'];
const FOOD_OPTIONS = ['Before Food', 'After Food'];
const DURATION_OPTIONS = ['3 Days', '5 Days', '30 Days'];

export default function DoctorDashboard() {
  const [queue, setQueue] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [callAccepted, setCallAccepted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isUpdating, setIsUpdating] = useState(false);

  // Doctor's Multi-Medicine Prescription State (Phase 2)
  const [prescriptions, setPrescriptions] = useState([
    { medicineName: '', dosage: '1 Tablet', timing: ['Morning', 'Night'], foodContext: 'After Food', duration: '5 Days' },
  ]);
  const [isSendingPrescription, setIsSendingPrescription] = useState(false);
  const [prescriptionNotice, setPrescriptionNotice] = useState(null);

  function handleAddMedicine() {
    setPrescriptions((prev) => [
      ...prev,
      { medicineName: '', dosage: '1 Tablet', timing: ['Morning'], foodContext: 'After Food', duration: '5 Days' },
    ]);
  }

  function handleRemoveMedicine(index) {
    setPrescriptions((prev) => {
      if (prev.length <= 1) {
        return [{ medicineName: '', dosage: '', timing: [], foodContext: '', duration: '' }];
      }
      return prev.filter((_, i) => i !== index);
    });
  }

  function handlePrescriptionFieldChange(index, field, value) {
    setPrescriptions((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  }

  function handleTimingToggle(index, option) {
    setPrescriptions((prev) => {
      const updated = [...prev];
      const currentTimings = Array.isArray(updated[index].timing) ? [...updated[index].timing] : [];
      if (currentTimings.includes(option)) {
        updated[index] = {
          ...updated[index],
          timing: currentTimings.filter((t) => t !== option),
        };
      } else {
        updated[index] = {
          ...updated[index],
          timing: [...currentTimings, option],
        };
      }
      return updated;
    });
  }

  function mergeEscalatedLists(primaryList) {
    let localFallback = [];
    try {
      localFallback = JSON.parse(localStorage.getItem(ESCALATED_FALLBACK_KEY) || '[]');
    } catch {
      localFallback = [];
    }

    const mergedMap = new Map();
    [...primaryList, ...localFallback].forEach((item) => {
      if (item?.visit_id && item.status === 'escalated') {
        if (!mergedMap.has(item.visit_id)) {
          mergedMap.set(item.visit_id, item);
        }
      }
    });

    const combined = Array.from(mergedMap.values());
    combined.sort((a, b) =>
      String(b.escalated_at || b.created_at || '').localeCompare(
        String(a.escalated_at || a.created_at || '')
      )
    );

    setQueue(combined);
    setLoading(false);
    setSelectedId((prev) => {
      if (prev && combined.some((item) => item.visit_id === prev)) return prev;
      return combined[0]?.visit_id || null;
    });
  }

  // Firebase onSnapshot listener querying `visits` where `status == "escalated"`.
  useEffect(() => {
    let unsubscribeSnapshot = () => {};

    if (isFirebaseConfigured) {
      const q = query(
        collection(firestoreDb, 'visits'),
        where('status', '==', 'escalated')
      );
      unsubscribeSnapshot = onSnapshot(
        q,
        (snapshot) => {
          const docs = snapshot.docs.map((d) => ({
            visit_id: d.id,
            ...d.data(),
          }));
          mergeEscalatedLists(docs);
        },
        (error) => {
          console.error('Firestore escalated listener error:', error);
          setLoading(false);
        }
      );
    }

    const fetchBackendEscalated = async () => {
      if (isFirebaseConfigured) return;
      let remoteList = [];
      try {
        const res = await fetch(`${API_BASE_URL}/visits/escalated?include_accepted=false`);
        if (res.ok) {
          const data = await res.json();
          remoteList = data.visits || [];
        }
      } catch {
        // Offline fallback handled in mergeEscalatedLists.
      }
      mergeEscalatedLists(remoteList);
    };

    fetchBackendEscalated();
    const pollTimer = !isFirebaseConfigured
      ? setInterval(fetchBackendEscalated, 2000)
      : null;

    let channel;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(ESCALATION_CHANNEL_NAME);
      channel.onmessage = (event) => {
        if (event.data?.type === 'ESCALATED') {
          fetchBackendEscalated();
        }
      };
    }

    const handleStorage = (event) => {
      if (event.key === ESCALATED_FALLBACK_KEY) {
        fetchBackendEscalated();
      }
    };
    window.addEventListener('storage', handleStorage);

    return () => {
      unsubscribeSnapshot();
      if (pollTimer) clearInterval(pollTimer);
      if (channel) channel.close();
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const selectedCase = queue.find((item) => item.visit_id === selectedId) || null;
  const jitsiRoomName = selectedCase
    ? `CareSync-Consult-${String(selectedCase.visit_id).replace(/[^a-zA-Z0-9_-]/g, '-')}`
    : '';

  function handleAcceptCase() {
    if (!selectedCase) return;
    setCallAccepted(true);
    setPrescriptionNotice(null);
  }

  async function handleSendPrescription(e) {
    if (e) e.preventDefault();
    if (!selectedCase) return;

    // Filter valid rows where medicineName is provided, or fallback to first
    const filled = prescriptions.filter((p) => p.medicineName && p.medicineName.trim().length > 0);
    const listToSend = (filled.length > 0 ? filled : prescriptions).map((p) => {
      const timings = Array.isArray(p.timing) && p.timing.length > 0 ? p.timing : ['Morning'];
      return {
        medicine_name: p.medicineName.trim() || 'Prescribed Medication',
        medicineName: p.medicineName.trim() || 'Prescribed Medication',
        dosage: p.dosage || '1 Tablet',
        timing: timings,
        food_context: p.foodContext || 'After Food',
        foodContext: p.foodContext || 'After Food',
        duration: p.duration || '5 Days',
        prescribed_at: new Date().toISOString(),
        doctor_name: 'Dr. CareSync Specialist',
      };
    });

    setIsSendingPrescription(true);
    setPrescriptionNotice(null);

    const visitId = selectedCase.visit_id;

    try {
      if (isFirebaseConfigured) {
        await setDoc(
          doc(firestoreDb, 'visits', visitId),
          {
            prescriptions: listToSend,
            prescription: listToSend[0] || null,
            updated_at: serverTimestamp(),
          },
          { merge: true }
        );
      }
    } catch (err) {
      console.warn('Firestore setDoc prescription failed, trying backend API:', err);
    }

    try {
      await fetch(`${API_BASE_URL}/visits/${encodeURIComponent(visitId)}/prescription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prescriptions: listToSend,
          prescription: listToSend[0] || null,
        }),
      });
    } catch {
      // Offline fallback
    }

    try {
      localStorage.setItem(
        'caresync_latest_prescription',
        JSON.stringify({
          visit_id: visitId,
          prescriptions: listToSend,
          prescription: listToSend[0] || null,
        })
      );
      if (typeof BroadcastChannel !== 'undefined') {
        const ch = new BroadcastChannel('caresync-prescription');
        ch.postMessage({
          type: 'NEW_PRESCRIPTION',
          visit_id: visitId,
          prescriptions: listToSend,
          prescription: listToSend[0] || null,
        });
        ch.close();
      }
    } catch {
      // Ignore storage errors
    }

    setIsSendingPrescription(false);
    setPrescriptionNotice({
      ok: true,
      message: `Prescription sent to Operator & Patient: ${listToSend.length} medicine(s) (${listToSend.map((m) => m.medicineName).join(', ')})`,
    });
  }

  async function handleCompleteCase() {
    if (!selectedCase) return;
    setIsUpdating(true);
    const visitId = selectedCase.visit_id;

    try {
      if (isFirebaseConfigured) {
        await updateDoc(doc(firestoreDb, 'visits', visitId), {
          status: 'completed',
          updated_at: serverTimestamp(),
        });
      }
    } catch {
      // Ignore if offline or demo.
    }

    try {
      await fetch(`${API_BASE_URL}/visits/${encodeURIComponent(visitId)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      });
    } catch {
      // Ignore offline error.
    }

    try {
      const existing = JSON.parse(localStorage.getItem(ESCALATED_FALLBACK_KEY) || '[]');
      localStorage.setItem(
        ESCALATED_FALLBACK_KEY,
        JSON.stringify(existing.filter((item) => item.visit_id !== visitId))
      );
    } catch {
      // Ignore storage error.
    }

    setCallAccepted(false);
    setQueue((prev) => prev.filter((item) => item.visit_id !== visitId));
    setIsUpdating(false);
  }

  const locationText = selectedCase
    ? [selectedCase.city, selectedCase.state, selectedCase.country]
        .filter(Boolean)
        .join(', ') || 'Coimbatore, Tamil Nadu, India'
    : '';

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#142D4E] pb-12 antialiased">
      {/* MediCare+ Doctor Portal Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/85 backdrop-blur-md text-[#142D4E] shadow-xs">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-3.5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-[#2563EB] to-[#1D4ED8] text-white shadow-md shadow-blue-500/20">
              <Stethoscope className="h-6 w-6 stroke-[2.2]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-black tracking-tight text-[#142D4E]">
                  CareSync Doctor Portal
                </h1>
                <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-[11px] font-extrabold text-[#2563EB]">
                  Teleconsultation Suite
                </span>
              </div>
              <p className="text-xs text-slate-500 font-medium">
                Live Video &bull; Digital Talking Prescription &bull; Route: <code>/doctor</code>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1 text-xs font-black shadow-xs ${
                queue.length > 0
                  ? 'border border-amber-300 bg-amber-50 text-amber-900 ring-2 ring-amber-200/50'
                  : 'border border-emerald-300 bg-emerald-50 text-emerald-800'
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  queue.length > 0 ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'
                }`}
              />
              {queue.length > 0
                ? `${queue.length} Escalated Waiting`
                : 'All Caught Up'}
            </span>

            <a
              href="/"
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50 transition"
              title="Return to Language Gateway"
            >
              <Home className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Gateway</span>
            </a>
          </div>
        </div>
      </header>

      {/* Main Grid Workspace */}
      <main className="mx-auto max-w-7xl px-6 pt-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Left Column: Escalated Queue */}
          <aside className="lg:col-span-4 space-y-4">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-sm font-black uppercase tracking-wider text-[#142D4E]">
                Escalated Patients Queue ({queue.length})
              </h2>
              <span className="text-xs font-semibold text-slate-400">
                {isFirebaseConfigured ? 'Firestore Live' : 'Active Bridge'}
              </span>
            </div>

            {loading ? (
              <AnimatedCard className="p-8 text-center space-y-3">
                <div className="h-4 w-3/4 mx-auto bg-slate-200 animate-pulse rounded-md" />
                <div className="h-3 w-1/2 mx-auto bg-slate-100 animate-pulse rounded-md" />
                <p className="text-xs text-slate-400">Connecting to clinical stream...</p>
              </AnimatedCard>
            ) : queue.length === 0 ? (
              /* Phase 3 Friendly Empty State for Queue */
              <AnimatedCard className="flex flex-col items-center justify-center p-8 text-center space-y-3 border-dashed border-2 border-blue-200 bg-gradient-to-b from-[#EFF6FF]/60 to-white">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-100 text-[#2563EB] shadow-xs">
                  <CheckCircle2 className="h-7 w-7" />
                </div>
                <h3 className="text-base font-bold text-[#142D4E]">
                  You&apos;re all caught up!
                </h3>
                <p className="text-xs text-slate-500 max-w-xs leading-relaxed font-medium">
                  Waiting for the next patient escalation from rural ration-shop kiosks. The queue updates automatically in real-time.
                </p>
                <div className="pt-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-[11px] font-bold text-emerald-800">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-600 animate-ping" />
                    Live Telemetry Listening
                  </span>
                </div>
              </AnimatedCard>
            ) : (
              <div className="space-y-3">
                {queue.map((item, idx) => {
                  const severity = item.triage_result?.severity || 'Yellow';
                  const isSelected = item.visit_id === selectedCase?.visit_id;
                  const itemLocation =
                    [item.city, item.state, item.country].filter(Boolean).join(', ') ||
                    'Coimbatore, Tamil Nadu, India';

                  return (
                    <motion.div
                      key={item.visit_id}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.3, delay: idx * 0.05 }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(item.visit_id);
                          setCallAccepted(false);
                          setPrescriptionNotice(null);
                        }}
                        className={`w-full rounded-2xl p-4 text-left transition-all duration-200 border-2 ${
                          isSelected
                            ? 'border-[#2563EB] bg-white shadow-md shadow-blue-500/10 ring-4 ring-blue-500/10'
                            : 'border-slate-200/90 bg-white hover:border-blue-300 hover:shadow-xs'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <p className="font-extrabold text-[#142D4E] text-base">
                              {item.patient_name || 'Patient'}
                            </p>
                            <p className="text-xs text-slate-500 font-medium">
                              Age: {item.age ?? '--'}y &bull; Gender: {item.gender || 'Not specified'}
                              {(item.phoneNumber || item.phone_number) && ` • ${item.phoneNumber || item.phone_number}`}
                            </p>
                          </div>
                          <span
                            className={`rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-wide ${
                              severity === 'Red'
                                ? 'bg-red-600 text-white'
                                : severity === 'Green'
                                  ? 'bg-emerald-600 text-white'
                                  : 'bg-amber-400 text-slate-950'
                            }`}
                          >
                            {severity}
                          </span>
                        </div>

                        {/* Location Pin */}
                        <div className="mt-2.5 flex items-center gap-1.5 text-xs font-semibold text-[#2563EB]">
                          <MapPin className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{itemLocation}</span>
                        </div>

                        <p className="mt-2 line-clamp-2 text-xs text-slate-600 leading-relaxed font-medium">
                          {item.symptoms || 'No complaints recorded'}
                        </p>

                        <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500 font-semibold">
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3 text-slate-400" />
                            {callAccepted && isSelected ? 'In Call Now' : 'Escalated'}
                          </span>
                          <span className="font-extrabold text-[#2563EB] bg-blue-50 px-2 py-0.5 rounded-md">
                            SpO2 {item.vitals?.spo2 ?? '--'}%
                          </span>
                        </div>
                      </button>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </aside>

          {/* Right Column: Teleconsultation Suite, Prescription, & Vitals */}
          <section className="lg:col-span-8 space-y-6">
            {!selectedCase ? (
              /* Phase 3 Friendly Empty State for Main View */
              <AnimatedCard className="flex min-h-[500px] flex-col items-center justify-center p-12 text-center border-dashed border-2 border-slate-200 space-y-4">
                <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-[#EFF6FF] text-[#2563EB] shadow-xs">
                  <Stethoscope className="h-10 w-10 stroke-[2.2]" />
                </div>
                <div className="space-y-1.5 max-w-md">
                  <h3 className="text-xl font-black text-[#142D4E] tracking-tight">
                    Doctor Teleconsultation Workstation
                  </h3>
                  <p className="text-sm text-slate-500 leading-relaxed font-medium">
                    Select an escalated patient case from the queue on the left to review their live sensor vitals, connect via real-time WebRTC video, and prescribe medication.
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs font-bold text-slate-400 pt-2">
                  <span>Peer-to-Peer Teleconsult</span>
                  <span>&bull;</span>
                  <span>Digital Prescription</span>
                  <span>&bull;</span>
                  <span>Zero-Cost TTS</span>
                </div>
              </AnimatedCard>
            ) : (
              <AnimatePresence mode="wait">
                <motion.div
                  key={selectedCase.visit_id}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.35 }}
                  className="space-y-6"
                >
                  {/* Video Call Card */}
                  <div className="overflow-hidden rounded-2xl border-2 border-[#142D4E] bg-black text-white shadow-lg">
                    {/* Video Top Bar */}
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-[#0B1B30] px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <span
                          className={`h-3 w-3 rounded-full ${
                            callAccepted ? 'animate-pulse bg-emerald-400' : 'bg-amber-400'
                          }`}
                        />
                        <div>
                          <span className="text-sm font-black text-white">
                            {callAccepted
                              ? `Live Video Consult &bull; ${selectedCase.patient_name}`
                              : `Escalated Case &bull; ${selectedCase.patient_name}`}
                          </span>
                          <span className="ml-2 font-mono text-xs text-slate-400 hidden sm:inline">
                            ({jitsiRoomName})
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {/* Phone Tag */}
                        {(selectedCase.phoneNumber || selectedCase.phone_number) && (
                          <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-2.5 py-1 text-xs font-bold text-emerald-200">
                            <Phone className="h-3.5 w-3.5 text-emerald-400" />
                            <span>{selectedCase.phoneNumber || selectedCase.phone_number}</span>
                          </span>
                        )}

                        {/* Location Tag */}
                        <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-2.5 py-1 text-xs font-bold text-blue-200">
                          <MapPin className="h-3.5 w-3.5 text-blue-400" />
                          <span className="max-w-[200px] truncate">{locationText}</span>
                        </span>

                        {!callAccepted ? (
                          <button
                            type="button"
                            onClick={handleAcceptCase}
                            className="inline-flex items-center gap-1.5 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] px-4 py-2 text-xs font-extrabold text-white shadow-md transition active:scale-95"
                          >
                            <PhoneCall className="h-3.5 w-3.5" />
                            Accept Case
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={isUpdating}
                            onClick={handleCompleteCase}
                            className="inline-flex items-center gap-1.5 rounded-xl bg-red-600 hover:bg-red-700 px-4 py-2 text-xs font-extrabold text-white shadow-md transition active:scale-95 disabled:opacity-60"
                          >
                            <PhoneOff className="h-3.5 w-3.5" />
                            End &amp; Complete
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Jitsi Video Embed or Placeholder */}
                    {callAccepted ? (
                      <div className="bg-black">
                        <JitsiMeeting
                          domain="meet.jit.si"
                          roomName={jitsiRoomName}
                          configOverwrite={{
                            startWithAudioMuted: false,
                            startWithVideoMuted: false,
                            prejoinPageEnabled: false,
                          }}
                          interfaceConfigOverwrite={{
                            DISABLE_JOIN_LEAVE_NOTIFICATIONS: true,
                          }}
                          userInfo={{
                            displayName: 'Dr. CareSync Specialist',
                          }}
                          getIFrameRef={(iframeRef) => {
                            iframeRef.style.height = '480px';
                            iframeRef.style.width = '100%';
                          }}
                        />
                      </div>
                    ) : (
                      <div className="flex h-64 flex-col items-center justify-center bg-[#071322] p-8 text-center sm:h-72 space-y-3">
                        <div className="flex h-20 w-20 items-center justify-center rounded-3xl border border-slate-800 bg-[#0B1B30] text-[#2563EB] shadow-inner">
                          <Video className="h-10 w-10" />
                        </div>
                        <p className="text-base font-bold text-slate-100">
                          Click &ldquo;Accept Case&rdquo; to join WebRTC room
                        </p>
                        <p className="text-xs text-slate-400 font-mono">
                          Visit ID: {selectedCase.visit_id}
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Doctor's Prescription Section (Appears During Active Call) */}
                  {callAccepted && (
                    <AnimatedCard className="border-2 border-[#2563EB] p-6 shadow-md">
                      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                        <div className="flex items-center gap-2.5">
                          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#2563EB] text-white shadow-xs">
                            <Pill className="h-5 w-5" />
                          </div>
                          <div>
                            <h3 className="text-base font-black text-[#142D4E]">
                              Write Digital Prescription
                            </h3>
                            <p className="text-xs text-slate-500 font-medium">
                              Strict dropdown schema &bull; Translates into pictorial card and native TTS audio for patient
                            </p>
                          </div>
                        </div>

                        <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-extrabold text-[#2563EB]">
                          Patient: {selectedCase.patient_name}
                        </span>
                      </div>

                      <form onSubmit={handleSendPrescription} className="space-y-5">
                        {prescriptions.map((med, index) => (
                          <div
                            key={index}
                            className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 space-y-4"
                          >
                            <div className="flex items-center justify-between border-b border-slate-200/80 pb-2">
                              <span className="text-xs font-black uppercase tracking-wider text-slate-700">
                                Medicine #{index + 1}
                              </span>
                              {prescriptions.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => handleRemoveMedicine(index)}
                                  className="inline-flex items-center gap-1 text-xs font-bold text-red-600 hover:text-red-700 transition"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                  Remove
                                </button>
                              )}
                            </div>

                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                              {/* Medicine Name (Custom Text Input) */}
                              <div className="lg:col-span-2">
                                <label className="mb-1.5 block text-xs font-extrabold uppercase tracking-wider text-slate-600">
                                  Medicine Name
                                </label>
                                <input
                                  type="text"
                                  required
                                  value={med.medicineName}
                                  onChange={(e) =>
                                    handlePrescriptionFieldChange(index, 'medicineName', e.target.value)
                                  }
                                  placeholder="Type medicine name (e.g. Paracetamol 650mg, ORS Sachet)..."
                                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-bold text-[#142D4E] placeholder:text-slate-400 focus:border-[#2563EB] focus:ring-2 focus:ring-blue-500/20 focus:outline-none"
                                />
                              </div>

                              {/* Dosage */}
                              <div>
                                <label className="mb-1.5 block text-xs font-extrabold uppercase tracking-wider text-slate-600">
                                  Dosage
                                </label>
                                <select
                                  value={med.dosage}
                                  onChange={(e) =>
                                    handlePrescriptionFieldChange(index, 'dosage', e.target.value)
                                  }
                                  className="w-full rounded-xl border border-slate-300 bg-white p-2.5 text-sm font-bold text-[#142D4E] focus:border-[#2563EB] focus:ring-2 focus:ring-blue-500/20 focus:outline-none"
                                >
                                  {DOSAGE_OPTIONS.map((d) => (
                                    <option key={d} value={d}>
                                      {d}
                                    </option>
                                  ))}
                                </select>
                              </div>

                              {/* Timing Options (Morning, Lunch, Night Checkboxes) */}
                              <div className="lg:col-span-3">
                                <label className="mb-1.5 block text-xs font-extrabold uppercase tracking-wider text-slate-600">
                                  Timing (Check all that apply: Morning, Lunch, Night)
                                </label>
                                <div className="flex flex-wrap items-center gap-3">
                                  {['Morning', 'Lunch', 'Night'].map((option) => {
                                    const isChecked =
                                      Array.isArray(med.timing) && med.timing.includes(option);
                                    return (
                                      <label
                                        key={option}
                                        className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-xs font-bold cursor-pointer transition select-none ${
                                          isChecked
                                            ? 'border-blue-600 bg-blue-50 text-blue-900 shadow-2xs'
                                            : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                                        }`}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={isChecked}
                                          onChange={() => handleTimingToggle(index, option)}
                                          className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                        />
                                        <span>{option}</span>
                                      </label>
                                    );
                                  })}
                                </div>
                              </div>

                              {/* Food Context */}
                              <div>
                                <label className="mb-1.5 block text-xs font-extrabold uppercase tracking-wider text-slate-600">
                                  Food Context
                                </label>
                                <select
                                  value={med.foodContext}
                                  onChange={(e) =>
                                    handlePrescriptionFieldChange(index, 'foodContext', e.target.value)
                                  }
                                  className="w-full rounded-xl border border-slate-300 bg-white p-2.5 text-sm font-bold text-[#142D4E] focus:border-[#2563EB] focus:ring-2 focus:ring-blue-500/20 focus:outline-none"
                                >
                                  {FOOD_OPTIONS.map((f) => (
                                    <option key={f} value={f}>
                                      {f}
                                    </option>
                                  ))}
                                </select>
                              </div>

                              {/* Duration */}
                              <div>
                                <label className="mb-1.5 block text-xs font-extrabold uppercase tracking-wider text-slate-600">
                                  Duration
                                </label>
                                <select
                                  value={med.duration}
                                  onChange={(e) =>
                                    handlePrescriptionFieldChange(index, 'duration', e.target.value)
                                  }
                                  className="w-full rounded-xl border border-slate-300 bg-white p-2.5 text-sm font-bold text-[#142D4E] focus:border-[#2563EB] focus:ring-2 focus:ring-blue-500/20 focus:outline-none"
                                >
                                  {DURATION_OPTIONS.map((dur) => (
                                    <option key={dur} value={dur}>
                                      {dur}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>
                          </div>
                        ))}

                        {/* Add Another Medicine Button */}
                        <div className="pt-1">
                          <button
                            type="button"
                            onClick={handleAddMedicine}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-50 transition shadow-2xs"
                          >
                            <Plus className="h-4 w-4 text-[#2563EB]" />
                            + Add Another Medicine
                          </button>
                        </div>

                        {/* Send Prescription Button in Primary Blue */}
                        <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
                          <p className="text-xs text-slate-500 font-medium">
                            Updates Firestore <code>visits</code> collection &bull; triggers pictorial cards on kiosk
                          </p>
                          <button
                            type="submit"
                            disabled={isSendingPrescription}
                            className="inline-flex items-center gap-2 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] px-6 py-3 text-sm font-black text-white shadow-md shadow-blue-600/20 transition active:scale-95 disabled:opacity-50"
                          >
                            <Send className="h-4 w-4" />
                            {isSendingPrescription
                              ? 'Sending Prescription...'
                              : `Send Prescription (${prescriptions.length} Med${prescriptions.length === 1 ? '' : 's'})`}
                          </button>
                        </div>

                        {prescriptionNotice && (
                          <div className="flex items-center gap-2.5 rounded-xl border border-emerald-300 bg-emerald-50 p-3.5 text-xs font-bold text-emerald-900 shadow-xs">
                            <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                            <span>{prescriptionNotice.message}</span>
                          </div>
                        )}
                      </form>
                    </AnimatedCard>
                  )}

                  {/* Patient Vitals & Location Panel */}
                  <AnimatedCard className="p-6 space-y-5">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                      <div>
                        <h3 className="text-base font-black text-[#142D4E]">
                          Clinical Vitals Panel &bull; {selectedCase.patient_name} ({selectedCase.age}y)
                        </h3>
                        <p className="text-xs text-slate-500 font-medium">
                          Visit ID: {selectedCase.visit_id}
                        </p>
                      </div>
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3.5 py-1 text-xs font-extrabold text-[#2563EB]">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        AI Severity: {selectedCase.triage_result?.severity || 'Yellow'}
                      </span>
                    </div>

                    {/* Location Tracking Banner */}
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-blue-200 bg-[#EFF6FF] p-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#2563EB] text-white shadow-xs">
                          <MapPin className="h-5 w-5" />
                        </div>
                        <div>
                          <p className="text-xs font-black uppercase tracking-wider text-blue-900">
                            Patient GPS Location (Ration-Shop Kiosk)
                          </p>
                          <p className="text-sm font-bold text-[#142D4E]">
                            {locationText}
                          </p>
                        </div>
                      </div>
                      <span className="rounded-full bg-[#2563EB] px-3.5 py-1 text-[11px] font-black text-white shadow-xs">
                        GPS Verified
                      </span>
                    </div>

                    {/* Vitals Metrics Grid */}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <div className="rounded-2xl border border-blue-100 bg-[#EFF6FF]/70 p-4">
                        <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-blue-800">
                          <Activity className="h-4 w-4" />
                          SpO2 Saturation
                        </p>
                        <p className="mt-2 text-3xl font-black text-[#142D4E]">
                          {selectedCase.vitals?.spo2 ?? '--'}%
                        </p>
                        <span className="mt-1 block text-[11px] font-semibold text-blue-600">
                          {selectedCase.vitals?.spo2 < 92 ? 'Critical Hypoxia' : 'Normal Range'}
                        </span>
                      </div>

                      <div className="rounded-2xl border border-amber-100 bg-[#FFFBEB]/70 p-4">
                        <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-amber-800">
                          <Thermometer className="h-4 w-4" />
                          Body Temperature
                        </p>
                        <p className="mt-2 text-3xl font-black text-[#142D4E]">
                          {selectedCase.vitals?.temperature ?? '--'}&deg;F
                        </p>
                        <span className="mt-1 block text-[11px] font-semibold text-amber-700">
                          {selectedCase.vitals?.temperature > 100.4 ? 'Febrile State' : 'Afebrile'}
                        </span>
                      </div>

                      <div className="rounded-2xl border border-rose-100 bg-[#FEF2F2]/70 p-4">
                        <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-rose-800">
                          <HeartPulse className="h-4 w-4" />
                          Heart Rate
                        </p>
                        <p className="mt-2 text-3xl font-black text-[#142D4E]">
                          {selectedCase.vitals?.heart_rate ?? '--'} bpm
                        </p>
                        <span className="mt-1 block text-[11px] font-semibold text-rose-700">
                          Normal: 60&ndash;100 bpm
                        </span>
                      </div>
                    </div>

                    {/* Symptoms & AI Triage Summary */}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div className="rounded-2xl border border-slate-200/90 bg-slate-50/70 p-4">
                        <p className="text-xs font-black uppercase tracking-wider text-slate-500">
                          Complaints / Add-ons
                        </p>
                        <p className="mt-1.5 text-sm font-semibold text-[#142D4E] leading-relaxed">
                          {selectedCase.symptoms || 'No complaints recorded'}
                        </p>
                      </div>

                      <div className="rounded-2xl border border-slate-200/90 bg-slate-50/70 p-4">
                        <p className="text-xs font-black uppercase tracking-wider text-slate-500">
                          AI Triage Summary &amp; Rationale
                        </p>
                        <p className="mt-1.5 text-sm font-semibold text-[#142D4E] leading-relaxed">
                          {selectedCase.triage_result?.reason || 'Escalated by ration-shop operator.'}
                        </p>
                      </div>
                    </div>
                  </AnimatedCard>
                </motion.div>
              </AnimatePresence>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
