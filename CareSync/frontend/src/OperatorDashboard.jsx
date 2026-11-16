import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BCP47_LANGUAGE_TAGS } from './i18n.js';
import { JitsiMeeting } from '@jitsi/react-sdk';
import { motion, AnimatePresence } from 'framer-motion';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import HospitalMap from './components/HospitalMap.jsx';
import PictorialPrescriptionCard from './components/PictorialPrescriptionCard.jsx';
import AnimatedCard from './components/AnimatedCard.jsx';
import VoiceReminderPanel from './components/VoiceReminderPanel.jsx';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  CloudOff,
  Cpu,
  Globe,
  HeartPulse,
  Home,
  Hospital,
  Lock,
  MapPin,
  Microscope,
  Navigation,
  Phone,
  PhoneCall,
  RefreshCw,
  Sparkles,
  Stethoscope,
  Thermometer,
  User,
  UserPlus,
  Video,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import {
  cacheFacilitiesForSeverity,
  getCachedFacilitiesBySeverity,
  getRecentVisits,
  saveVisitToDexie,
  updateLocalVisitStatus,
} from './db.js';
import { firestoreDb, isFirebaseConfigured } from './firebase.js';
import {
  IOT_CHANNEL_NAME,
  IOT_STORAGE_KEY,
  SESSION_CHANNEL_NAME,
  SESSION_STORAGE_KEY,
} from './IoTSimulator.jsx';
import {
  API_BASE_URL,
  getPendingSyncCount,
  initSyncManager,
  queueOfflineVisit,
  syncPendingVisits,
} from './syncManager.js';

export const ESCALATED_FALLBACK_KEY = 'caresync_escalated_fallback';
export const ESCALATION_CHANNEL_NAME = 'caresync-escalation';

// Hardcoded rural village coordinates near Coimbatore for hackathon mapping demo
const PATIENT_LOCATION = { lat: 10.9000, lng: 76.9000 };

const COIMBATORE_FALLBACK_FACILITIES = [
  {
    id: 'cbe-hwc-01',
    name: 'Ayushman Arogya Mandir - Ettimadai',
    type: 'Health & Wellness Centre',
    lat: 10.8892,
    lng: 76.8935,
  },
  {
    id: 'cbe-phc-01',
    name: 'Madukkarai Primary Health Centre (PHC)',
    type: 'Primary Health Centre',
    lat: 10.9038,
    lng: 76.9562,
  },
  {
    id: 'cbe-chc-01',
    name: 'Kinathukadavu Block CHC',
    type: 'Community Health Centre',
    lat: 10.8225,
    lng: 77.0180,
  },
  {
    id: 'cbe-dh-01',
    name: 'Coimbatore Medical College Hospital (CMCH)',
    type: 'Tertiary Care Hospital',
    lat: 10.9958,
    lng: 76.9708,
  },
];

const QUICK_SYMPTOMS = [
  'Fever & chills',
  'Cough & cold',
  'Shortness of breath',
  'Chest pain',
  'Diarrhea & weakness',
  'Headache & body ache',
];

const SEVERITY_STYLES = {
  Red: {
    card: 'border-red-300 bg-red-50 text-red-950',
    badge: 'bg-red-600 text-white',
    label: 'RED — EMERGENCY REFERRAL',
  },
  Yellow: {
    card: 'border-amber-300 bg-amber-50 text-amber-950',
    badge: 'bg-amber-500 text-white',
    label: 'YELLOW — CONSULT DOCTOR',
  },
  Green: {
    card: 'border-emerald-300 bg-emerald-50 text-emerald-950',
    badge: 'bg-emerald-600 text-white',
    label: 'GREEN — SELF-CARE',
  },
};

function runOfflineVitalSafetyCheck(vitals) {
  const spo2 = Number(vitals.spo2);
  const temp = Number(vitals.temperature);

  if ((!Number.isNaN(spo2) && spo2 > 0 && spo2 < 92) || (!Number.isNaN(temp) && temp > 103)) {
    const reasons = [];
    if (!Number.isNaN(spo2) && spo2 > 0 && spo2 < 92) {
      reasons.push(`Low SpO2 (${spo2}% < 92%)`);
    }
    if (!Number.isNaN(temp) && temp > 103) {
      reasons.push(`High Fever (${temp}°F > 103°F)`);
    }
    return {
      severity: 'Red',
      classification: 'Offline Emergency Alert',
      reason: `Offline vital red-flag detected: ${reasons.join(', ')}.`,
      recommended_action:
        'Do not wait for internet sync. Call 108 ambulance and refer immediately to nearest CHC / District Hospital.',
      clinical_suggestions: {
        immediate_action: 'Elevate legs, provide high-flow oxygen if available, clear airway, and keep patient warm.',
        facility_routing: 'Refer to Community Health Centre (CHC) or District Hospital via 108 ambulance.',
        required_tests: 'Continuous SpO2 monitoring, 12-lead ECG, blood pressure series, arterial blood gas.',
      },
      red_flags_to_watch: reasons,
      source: 'offline_vital_guard',
    };
  }

  return {
    severity: 'Yellow',
    classification: 'Queued for AI & Doctor Sync',
    reason: `Device is offline (SpO2 ${vitals.spo2 || '--'}%, Temp ${vitals.temperature || '--'}°F, HR ${vitals.heart_rate || '--'} bpm). Saved locally in IndexedDB.`,
    recommended_action:
      'Keep patient hydrated and monitor vitals. Visit will auto-sync to CareSync cloud when network returns.',
    clinical_suggestions: {
      immediate_action: 'Elevate legs if dizzy, provide oral rehydration salts (ORS), and avoid heavy physical exertion.',
      facility_routing: 'Refer to Primary Health Centre (PHC) or schedule CareSync telemedicine doctor consultation.',
      required_tests: 'Check random blood sugar (RBS), complete blood count (CBC), and repeat vitals.',
    },
    red_flags_to_watch: ['SpO2 < 92%', 'Temperature > 103°F', 'Severe breathlessness'],
    source: 'offline_queue',
  };
}

function SuggestionBox({ suggestions }) {
  const { t } = useTranslation();
  if (!suggestions || typeof suggestions !== 'object') return null;

  const immediateAction =
    suggestions.immediate_action ||
    'Keep patient rested, provide oral rehydration salts (ORS), and monitor vitals.';
  const facilityRouting =
    suggestions.facility_routing ||
    'Refer to Primary Health Centre (PHC) or schedule CareSync telemedicine doctor consultation.';
  const requiredTests =
    suggestions.required_tests ||
    'Check random blood sugar (RBS), complete blood count (CBC), and repeat vital signs.';

  return (
    <div className="mt-4 rounded-2xl border border-blue-200 bg-[#EFF6FF] p-5 text-slate-800 shadow-sm">
      <div className="mb-3.5 flex items-center gap-2 border-b border-blue-100 pb-2.5">
        <Sparkles className="h-4 w-4 text-blue-600" />
        <h4 className="text-xs font-black uppercase tracking-wider text-blue-900">
          {t('Clinical Suggestions & AI Advice') || 'Clinical Suggestions & AI Advice'}
        </h4>
      </div>

      <div className="space-y-3">
        {/* Immediate Action */}
        <div className="flex items-start gap-3 rounded-xl border border-blue-100/70 bg-white/90 p-3.5 shadow-2xs">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
            <Zap className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-black uppercase tracking-wide text-amber-900">
              ⚡ {t('Immediate Action') || 'Immediate Action'}
            </p>
            <p className="mt-0.5 text-sm font-semibold leading-snug text-slate-800">
              {immediateAction}
            </p>
          </div>
        </div>

        {/* Facility Routing */}
        <div className="flex items-start gap-3 rounded-xl border border-blue-100/70 bg-white/90 p-3.5 shadow-2xs">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-700">
            <Hospital className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-black uppercase tracking-wide text-blue-900">
              🏥 {t('Facility Routing') || 'Facility Routing'}
            </p>
            <p className="mt-0.5 text-sm font-semibold leading-snug text-slate-800">
              {facilityRouting}
            </p>
          </div>
        </div>

        {/* Required Tests */}
        <div className="flex items-start gap-3 rounded-xl border border-blue-100/70 bg-white/90 p-3.5 shadow-2xs">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
            <Microscope className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-black uppercase tracking-wide text-emerald-900">
              🔬 {t('Required Tests') || 'Required Tests'}
            </p>
            <p className="mt-0.5 text-sm font-semibold leading-snug text-slate-800">
              {requiredTests}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function OperatorDashboard() {
  const { t, i18n } = useTranslation();
  // Master Controller Identity State
  const [patientId, setPatientId] = useState(1);
  const [patientName, setPatientName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [gender, setGender] = useState('');
  const [age, setAge] = useState('');
  const [country, setCountry] = useState('India');
  const [patientState, setPatientState] = useState('Tamil Nadu');
  const [city, setCity] = useState('Coimbatore');
  const [symptoms, setSymptoms] = useState('');

  // Talking Prescription State (Multi-Medicine Array - Phase 3)
  const [prescriptions, setPrescriptions] = useState([]);
  const prescription = prescriptions[0] || null;

  // Phase 2: Karaoke-Style TTS Highlight State
  const [activeAudioIndex, setActiveAudioIndex] = useState(null);

  // Locked hardware-fed vitals (strictly readOnly on Operator Dashboard)
  const [spo2, setSpo2] = useState('');
  const [temperature, setTemperature] = useState('');
  const [heartRate, setHeartRate] = useState('');
  const [iotSyncedAt, setIotSyncedAt] = useState('');

  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [pendingCount, setPendingCount] = useState(0);
  const [syncMessage, setSyncMessage] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [reviewDecision, setReviewDecision] = useState('');
  const [inCall, setInCall] = useState(false);
  const [activeCallVisitId, setActiveCallVisitId] = useState('');
  const [formError, setFormError] = useState('');
  const [triageOutput, setTriageOutput] = useState(null);
  const [facilities, setFacilities] = useState([]);
  const [firebaseFacilities, setFirebaseFacilities] = useState([]);
  const [recentVisits, setRecentVisits] = useState([]);
  const [showVoiceReminders, setShowVoiceReminders] = useState(false);
  const [reminderSuggestedMsg, setReminderSuggestedMsg] = useState('');

  function applyLiveVitals(data) {
    if (!data?.vitals) return;
    // Only apply vitals belonging to the current patient session.
    const incomingId = data.patient_id ?? data.visit_id;
    if (incomingId != null && String(incomingId) !== String(patientId)) {
      return;
    }
    if (data.vitals.spo2 != null) setSpo2(String(data.vitals.spo2));
    if (data.vitals.temperature != null) setTemperature(String(data.vitals.temperature));
    if (data.vitals.heart_rate != null) setHeartRate(String(data.vitals.heart_rate));
    setIotSyncedAt(new Date().toLocaleTimeString());
  }

  async function refreshLocalState() {
    const [count, visits] = await Promise.all([
      getPendingSyncCount(),
      getRecentVisits(6),
    ]);
    setPendingCount(count);
    setRecentVisits(visits);
  }

  // Auto-update `active_sessions/current` whenever Operator edits Name, Gender, or Location.
  useEffect(() => {
    const trimmedName = patientName.trim();
    if (!trimmedName && !gender) return;

    const sessionPayload = {
      patientId,
      name: trimmedName,
      phoneNumber: phoneNumber.trim(),
      gender,
      country,
      state: patientState,
      city,
    };

    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessionPayload));
      if (typeof BroadcastChannel !== 'undefined') {
        const ch = new BroadcastChannel(SESSION_CHANNEL_NAME);
        ch.postMessage({ type: 'SESSION_UPDATE', session: sessionPayload });
        ch.close();
      }
    } catch {
      // Ignore storage errors.
    }

    const syncTimer = setTimeout(async () => {
      try {
        if (isFirebaseConfigured) {
          await setDoc(
            doc(firestoreDb, 'active_sessions', 'current'),
            {
              ...sessionPayload,
              updated_at: serverTimestamp(),
            },
            { merge: true }
          );
        } else if (navigator.onLine) {
          await fetch(`${API_BASE_URL}/session/current`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sessionPayload),
          });
        }
      } catch {
        // Offline or network error; local bridge already updated.
      }
    }, 150);

    return () => clearTimeout(syncTimer);
  }, [patientId, patientName, phoneNumber, gender, country, patientState, city]);

  // Real-time listener for Doctor's Prescription (Phase 3 Multi-Medicine Array)
  useEffect(() => {
    const currentVisitId = activeCallVisitId || triageOutput?.visitId || String(patientId);
    if (!currentVisitId) return;

    function extractPrescriptionList(payload) {
      if (!payload) return [];
      if (Array.isArray(payload.prescriptions) && payload.prescriptions.length > 0) {
        return payload.prescriptions;
      }
      if (Array.isArray(payload.prescription)) {
        return payload.prescription;
      }
      if (payload.prescription && typeof payload.prescription === 'object') {
        return [payload.prescription];
      }
      return [];
    }

    let unsubscribe = () => {};
    if (isFirebaseConfigured) {
      const visitDocRef = doc(firestoreDb, 'visits', String(currentVisitId));
      unsubscribe = onSnapshot(
        visitDocRef,
        (snap) => {
          if (snap.exists()) {
            const data = snap.data();
            const list = extractPrescriptionList(data);
            if (list.length > 0) {
              setPrescriptions(list);
            }
          }
        },
        (err) => console.warn('Prescription listener error:', err)
      );
    }

    let bc;
    if (typeof BroadcastChannel !== 'undefined') {
      bc = new BroadcastChannel('caresync-prescription');
      bc.onmessage = (event) => {
        if (
          event.data?.type === 'NEW_PRESCRIPTION' &&
          (String(event.data.visit_id) === String(currentVisitId) || !event.data.visit_id)
        ) {
          const list = extractPrescriptionList(event.data);
          if (list.length > 0) {
            setPrescriptions(list);
          }
        }
      };
    }

    const onStorage = (e) => {
      if (e.key === 'caresync_latest_prescription') {
        try {
          const item = JSON.parse(e.newValue || '{}');
          if (String(item.visit_id) === String(currentVisitId) || !item.visit_id) {
            const list = extractPrescriptionList(item);
            if (list.length > 0) {
              setPrescriptions(list);
            }
          }
        } catch {
          // Ignore
        }
      }
    };
    window.addEventListener('storage', handleStorage => onStorage(handleStorage));

    try {
      const cached = JSON.parse(localStorage.getItem('caresync_latest_prescription') || 'null');
      if (cached && (String(cached.visit_id) === String(currentVisitId) || !cached.visit_id)) {
        const list = extractPrescriptionList(cached);
        if (list.length > 0) {
          setPrescriptions(list);
        }
      }
    } catch {
      // Ignore
    }

    return () => {
      unsubscribe();
      if (bc) bc.close();
      window.removeEventListener('storage', onStorage);
    };
  }, [activeCallVisitId, triageOutput?.visitId, patientId]);

  // Listen for incoming IoT vitals for `visits/${patientId}`
  useEffect(() => {
    const docId = String(patientId);
    let unsubscribeSnapshot = () => {};

    if (isFirebaseConfigured) {
      const docRef = doc(firestoreDb, 'visits', docId);
      unsubscribeSnapshot = onSnapshot(
        docRef,
        (snapshot) => {
          if (snapshot.exists()) {
            applyLiveVitals(snapshot.data());
          }
        },
        (error) => {
          console.warn('Firestore visits listener error:', error);
        }
      );
    }

    const checkLocalVitals = () => {
      try {
        const raw = localStorage.getItem(IOT_STORAGE_KEY);
        if (raw) {
          applyLiveVitals(JSON.parse(raw));
        }
      } catch {
        // Ignore JSON parse errors.
      }
    };
    checkLocalVitals();

    let channel;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(IOT_CHANNEL_NAME);
      channel.onmessage = (event) => {
        if (event.data?.type === 'NEW_READINGS' && event.data.readings) {
          applyLiveVitals(event.data.readings);
        }
      };
    }

    const handleStorage = (event) => {
      if (event.key === IOT_STORAGE_KEY && event.newValue) {
        try {
          applyLiveVitals(JSON.parse(event.newValue));
        } catch {
          // Ignore parse errors.
        }
      }
    };
    window.addEventListener('storage', handleStorage);

    let pollTimer = null;
    if (!isFirebaseConfigured) {
      const pollBackend = async () => {
        try {
          const res = await fetch(`${API_BASE_URL}/iot/latest?patient_id=${encodeURIComponent(docId)}`);
          if (res.ok) {
            const data = await res.json();
            if (data?.reading) {
              applyLiveVitals(data.reading);
            }
          }
        } catch {
          // Backend offline; local bridge already active.
        }
      };
      pollBackend();
      pollTimer = setInterval(pollBackend, 1500);
    }

    return () => {
      unsubscribeSnapshot();
      if (channel) channel.close();
      window.removeEventListener('storage', handleStorage);
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [patientId]);

  // Bootstrap facilities, online status, and offline queue sync
  useEffect(() => {
    refreshLocalState();
    getCachedFacilitiesBySeverity('Yellow').then((cached) => {
      if (cached && cached.length > 0) setFacilities(cached);
    });

    if (isFirebaseConfigured) {
      getDocs(collection(firestoreDb, 'facilities'))
        .then((snapshot) => {
          const docs = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
          if (docs.length > 0) {
            setFirebaseFacilities(docs);
          }
        })
        .catch((err) => {
          console.warn('Could not load facilities from Firestore:', err);
        });
    }

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const unsubscribeSync = initSyncManager((event) => {
      if (typeof event.pendingCount === 'number') {
        setPendingCount(event.pendingCount);
      }
      if (event.lastMessage) {
        setSyncMessage(event.lastMessage);
      }
      setIsSyncing(event.status === 'syncing');
      refreshLocalState();
    });

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      unsubscribeSync();
    };
  }, []);

  async function handleNextPatient() {
    // 1. Reset patient form, vitals, triage results, schemes, and call UI
    setPatientName('');
    setPhoneNumber('');
    setGender('');
    setAge('');
    setSymptoms('');
    setSpo2('');
    setTemperature('');
    setHeartRate('');
    setIotSyncedAt('');
    setFormError('');
    setTriageOutput(null);
    setFacilities([]);
    setReviewDecision('');
    setInCall(false);
    setActiveCallVisitId('');
    setPrescriptions([]);
    setActiveAudioIndex(null);
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    // 2. Increment Patient ID by 1
    setPatientId((prev) => prev + 1);

    // 3. Clear `active_sessions/current` in Firebase & local bridge
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      localStorage.removeItem(IOT_STORAGE_KEY);
      localStorage.removeItem('caresync_latest_prescription');
      if (typeof BroadcastChannel !== 'undefined') {
        const ch = new BroadcastChannel(SESSION_CHANNEL_NAME);
        ch.postMessage({ type: 'SESSION_CLEARED' });
        ch.close();
      }
    } catch {
      // Ignore storage errors.
    }

    try {
      if (isFirebaseConfigured) {
        await deleteDoc(doc(firestoreDb, 'active_sessions', 'current'));
      } else if (navigator.onLine) {
        await fetch(`${API_BASE_URL}/session/current`, { method: 'DELETE' });
      }
    } catch {
      // Ignore network errors while clearing session.
    }
  }

  // Phase 2: Karaoke-Style TTS Highlight Audio Walkthrough
  function playPrescriptionAudio() {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      alert('Browser speech synthesis is not supported in this browser.');
      return;
    }

    if (activeAudioIndex !== null) {
      window.speechSynthesis.cancel();
      setActiveAudioIndex(null);
      return;
    }

    if (!prescriptions || prescriptions.length === 0) return;

    window.speechSynthesis.cancel();

    const rawLang =
      localStorage.getItem('careSyncLang') ||
      localStorage.getItem('app_lang') ||
      i18n.language ||
      'en';
    const langKey = ['en', 'hi', 'ta', 'te'].includes(rawLang) ? rawLang : 'en';
    const bcp47 = BCP47_LANGUAGE_TAGS[langKey] || 'en-IN';

    function speakNextMedicine(index) {
      if (index >= prescriptions.length) {
        setActiveAudioIndex(null);
        return;
      }

      const med = prescriptions[index];
      const name = med.medicine_name || med.medicineName || `Medicine #${index + 1}`;
      const dos = med.dosage || '1 Tablet';
      const food = med.food_context || med.foodContext || 'After Food';
      const dur = med.duration || '5 Days';
      const tRaw = med.timing;
      const tList = Array.isArray(tRaw)
        ? tRaw
        : typeof tRaw === 'string'
          ? tRaw.split(/[,&]+/).map((s) => s.trim())
          : ['Morning'];

      const timingEn = tList.join(' and ');
      const timingHi = tList.map((tm) => t(tm)).join(' और ');
      const timingTa = tList.map((tm) => t(tm)).join(' மற்றும் ');
      const timingTe = tList.map((tm) => t(tm)).join(' మరియు ');

      let speechText = '';
      if (langKey === 'hi') {
        speechText = `दवा ${index + 1}: ${t(food)}, ${timingHi}, ${name} की ${t(dos)}, ${t(dur)} लें।`;
      } else if (langKey === 'ta') {
        speechText = `மருந்து ${index + 1}: ${t(food)}, ${timingTa}, ${name} ${t(dos)}, ${t(dur)} எடுத்துக்கொள்ளவும்.`;
      } else if (langKey === 'te') {
        speechText = `మందు ${index + 1}: ${t(food)}, ${timingTe}, ${name} ${t(dos)}, ${t(dur)} తీసుకోండి.`;
      } else {
        speechText = `Medicine ${index + 1}: Take ${dos} of ${name} in the ${timingEn.toLowerCase()}, ${food.toLowerCase()}, for ${dur}.`;
      }

      const utterance = new SpeechSynthesisUtterance(speechText);
      utterance.lang = bcp47;
      utterance.rate = 0.88;

      utterance.onstart = () => {
        setActiveAudioIndex(index);
      };

      utterance.onend = () => {
        if (index + 1 < prescriptions.length) {
          speakNextMedicine(index + 1);
        } else {
          setActiveAudioIndex(null);
        }
      };

      utterance.onerror = () => {
        setActiveAudioIndex(null);
      };

      window.speechSynthesis.speak(utterance);
    }

    speakNextMedicine(0);
  }

  // Phase 3: The "Teach-Back" Confirmation
  async function handleTeachBackConfirm(idx) {
    const updated = prescriptions.map((p, i) =>
      i === idx ? { ...p, understood: true } : p
    );
    setPrescriptions(updated);

    const currentVisitId = activeCallVisitId || triageOutput?.visitId || String(patientId);

    // 1. Update Firebase visits document
    if (isFirebaseConfigured && currentVisitId) {
      try {
        await setDoc(
          doc(firestoreDb, 'visits', String(currentVisitId)),
          {
            prescriptions: updated,
            prescription: updated[0] || null,
            updated_at: serverTimestamp(),
          },
          { merge: true }
        );
      } catch (err) {
        console.warn('Firestore teach-back update error:', err);
      }
    }

    // 2. Broadcast via BroadcastChannel and update localStorage for zero-latency local demo
    try {
      localStorage.setItem(
        'caresync_latest_prescription',
        JSON.stringify({
          visit_id: currentVisitId,
          prescriptions: updated,
          prescription: updated[0] || null,
        })
      );
      if (typeof BroadcastChannel !== 'undefined') {
        const ch = new BroadcastChannel('caresync-prescription');
        ch.postMessage({
          type: 'TEACH_BACK_CONFIRMED',
          visit_id: currentVisitId,
          medicineIndex: idx,
          prescriptions: updated,
          prescription: updated[0] || null,
        });
        ch.close();
      }
    } catch {
      // Ignore
    }
  }

  // Phase 4: Hackathon "Demo" Button (Safety Net)
  function handleLoadDemoCase() {
    setPatientName('Ramesh');
    setAge('55');
    setGender('Male');
    setPhoneNumber('+919994577702');
    setCountry('India');
    setPatientState('Tamil Nadu');
    setCity('Coimbatore');
    setSymptoms('Severe chest pain radiating to left arm, heavy sweating, acute shortness of breath since 2 hours.');
    setTemperature('99.2');
    setSpo2('91');
    setHeartRate('114');
    setFormError('');

    const sessionPayload = {
      patientId: 1,
      name: 'Ramesh',
      gender: 'Male',
      country: 'India',
      state: 'Tamil Nadu',
      city: 'Coimbatore',
    };

    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessionPayload));
      if (typeof BroadcastChannel !== 'undefined') {
        const ch = new BroadcastChannel(SESSION_CHANNEL_NAME);
        ch.postMessage({ type: 'SESSION_UPDATE', session: sessionPayload });
        ch.close();
      }
    } catch {
      // Ignore
    }
  }

  function appendQuickSymptom(chip) {
    setSymptoms((prev) => {
      const trimmed = prev.trim();
      if (!trimmed) return chip;
      if (trimmed.toLowerCase().includes(chip.toLowerCase())) return prev;
      return `${trimmed}, ${chip}`;
    });
  }

  async function handleManualSync() {
    setIsSyncing(true);
    await syncPendingVisits();
    await refreshLocalState();
    setIsSyncing(false);
  }

  async function handleRunTriage(e) {
    e.preventDefault();
    setFormError('');
    setReviewDecision('');

    if (!patientName.trim() || !gender || age === '' || !symptoms.trim()) {
      setFormError('Please enter Patient Name, Gender, Age, and Complaints / Add-ons.');
      return;
    }

    if (spo2 === '' || temperature === '' || heartRate === '') {
      setFormError(
        'Vitals are locked to IoT telemetry. Please push readings from the /iot simulator first.'
      );
      return;
    }

    const docId = String(patientId);
    const vitalsPayload = {
      spo2: Number(spo2),
      temperature: Number(temperature),
      heart_rate: Number(heartRate),
    };

    const visitBase = {
      visitId: docId,
      patientId: docId,
      patientName: patientName.trim(),
      phoneNumber: phoneNumber.trim(),
      gender,
      age: Number(age),
      country,
      state: patientState,
      city,
      symptoms: symptoms.trim(),
      vitals: vitalsPayload,
      createdAt: new Date().toISOString(),
    };

    setIsSubmitting(true);

    try {
      if (!navigator.onLine) {
        throw new Error('Browser is offline');
      }

      const currentLangCode =
        localStorage.getItem('careSyncLang') || localStorage.getItem('app_lang') || 'ta';

      const fetchOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visit_id: docId,
          patient_name: visitBase.patientName,
          gender: visitBase.gender,
          age: visitBase.age,
          country: visitBase.country,
          state: visitBase.state,
          city: visitBase.city,
          symptoms: visitBase.symptoms,
          vitals: vitalsPayload,
          language: currentLangCode,
        }),
      };
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        fetchOptions.signal = AbortSignal.timeout(10000);
      }

      const response = await fetch(`${API_BASE_URL}/triage`, fetchOptions);

      if (!response.ok) {
        throw new Error(`Server returned HTTP ${response.status}`);
      }

      const data = await response.json();
      const result = data.triage;
      let recommended = data.recommended_facilities || [];

      if (recommended.length === 0 && result?.severity) {
        try {
          const facRes = await fetch(
            `${API_BASE_URL}/facilities/recommend?severity=${encodeURIComponent(result.severity)}`
          );
          if (facRes.ok) {
            const facData = await facRes.json();
            recommended = facData.facilities || [];
          }
        } catch {
          // Ignore secondary facility fetch errors.
        }
      }

      const payload = {
        visit_id: docId,
        patient_id: patientId,
        patient_name: visitBase.patientName,
        patientName: visitBase.patientName,
        phoneNumber: visitBase.phoneNumber,
        phone_number: visitBase.phoneNumber,
        gender: visitBase.gender,
        age: visitBase.age,
        country: visitBase.country,
        state: visitBase.state,
        city: visitBase.city,
        symptoms: visitBase.symptoms,
        vitals: vitalsPayload,
        triage_result: result,
        status: 'triaged',
        created_at: new Date().toISOString(),
        updated_at: serverTimestamp(),
      };

      console.log("Saving to Firebase:", payload);
      if (isFirebaseConfigured) {
        try {
          await Promise.race([
            setDoc(doc(firestoreDb, 'visits', docId), payload, { merge: true }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Firestore timeout')), 1500)),
          ]);
        } catch (err) {
          console.warn('Direct Firestore setDoc write error:', err);
        }
      }

      await cacheFacilitiesForSeverity(result.severity, recommended);
      const savedLocal = await saveVisitToDexie(
        { ...visitBase, triageResult: result, status: 'triaged' },
        1
      );

      setTriageOutput({
        ...result,
        visitId: docId,
        localId: savedLocal.localId,
        mode: 'online',
        patientName: visitBase.patientName,
        phoneNumber: visitBase.phoneNumber,
        gender: visitBase.gender,
        age: visitBase.age,
        country: visitBase.country,
        state: visitBase.state,
        city: visitBase.city,
        symptoms: visitBase.symptoms,
        vitals: vitalsPayload,
      });
      setFacilities(recommended);
      await refreshLocalState();
    } catch {
      const offlineResult = runOfflineVitalSafetyCheck(vitalsPayload);
      const savedLocal = await queueOfflineVisit({
        ...visitBase,
        triageResult: offlineResult,
        status: 'triaged',
      });
      const cached = await getCachedFacilitiesBySeverity(offlineResult.severity);
      setTriageOutput({
        ...offlineResult,
        visitId: docId,
        localId: savedLocal.localId,
        mode: 'offline',
        patientName: visitBase.patientName,
        gender: visitBase.gender,
        age: visitBase.age,
        country: visitBase.country,
        state: visitBase.state,
        city: visitBase.city,
        symptoms: visitBase.symptoms,
        vitals: vitalsPayload,
      });
      setFacilities(cached);
      await refreshLocalState();
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleReviewDecision(decision) {
    if (!triageOutput) return;
    setIsUpdatingStatus(true);

    const visitId = triageOutput.visitId || String(patientId);
    const targetStatus = decision === 'escalate' ? 'escalated' : 'okay';

    await updateLocalVisitStatus(triageOutput.localId, targetStatus);

    const payload = {
      visit_id: visitId,
      patient_id: patientId,
      status: targetStatus,
      patient_name: patientName.trim() || triageOutput.patientName || 'Patient',
      patientName: patientName.trim() || triageOutput.patientName || 'Patient',
      phoneNumber: phoneNumber.trim() || triageOutput.phoneNumber || '',
      phone_number: phoneNumber.trim() || triageOutput.phoneNumber || '',
      language: 'Tamil',
      gender: gender || triageOutput.gender,
      age: Number(age) || triageOutput.age,
      country: country || triageOutput.country,
      state: patientState || triageOutput.state,
      city: city || triageOutput.city,
      symptoms: symptoms.trim() || triageOutput.symptoms || '',
      vitals: triageOutput.vitals,
      prescription: prescription || triageOutput.prescription || undefined,
      triage_result: {
        severity: triageOutput.severity,
        classification: triageOutput.classification,
        reason: triageOutput.reason,
        recommended_action: triageOutput.recommended_action,
        red_flags_to_watch: triageOutput.red_flags_to_watch,
        eligible_schemes: triageOutput.eligible_schemes || [],
        source: triageOutput.source,
      },
      escalated_at: targetStatus === 'escalated' ? new Date().toISOString() : undefined,
    };
    const statusPayload = payload;

    console.log("Saving to Firebase:", payload);
    if (isFirebaseConfigured) {
      try {
        await Promise.race([
          setDoc(
            doc(firestoreDb, 'visits', visitId),
            {
              ...payload,
              updated_at: serverTimestamp(),
            },
            { merge: true }
          ),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Firestore timeout')), 1500)),
        ]);
      } catch (err) {
        console.warn('Direct Firestore status update failed, falling back to API:', err);
      }
    }

    try {
      await fetch(`${API_BASE_URL}/visits/${encodeURIComponent(visitId)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      // Offline fallback handled below.
    }

    if (targetStatus === 'escalated') {
      try {
        const existing = JSON.parse(localStorage.getItem(ESCALATED_FALLBACK_KEY) || '[]');
        const updated = [
          statusPayload,
          ...existing.filter((item) => item.visit_id !== visitId),
        ];
        localStorage.setItem(ESCALATED_FALLBACK_KEY, JSON.stringify(updated));
        if (typeof BroadcastChannel !== 'undefined') {
          const ch = new BroadcastChannel(ESCALATION_CHANNEL_NAME);
          ch.postMessage({ type: 'ESCALATED', visit: statusPayload });
          ch.close();
        }
      } catch {
        // Ignore storage errors.
      }
    }

    setIsUpdatingStatus(false);
    await refreshLocalState();

    if (decision === 'escalate') {
      setActiveCallVisitId(visitId);
      setInCall(true);
      window.open('/doctor', '_blank');
    } else {
      setReviewDecision('okay');
    }
  }

  function openVoiceReminderFromTriage() {
    const pName = (triageOutput?.patientName || patientName || 'நோயாளி').trim();
    const sev = triageOutput?.severity;
    if (sev === 'Red' || sev === 'Yellow') {
      setReminderSuggestedMsg(
        `வணக்கம் ${pName}, இது CareSync மருத்துவ நினைவூட்டல். தயவுசெய்து உடனடியாக அருகிலுள்ள ஆரம்ப சுகாதார நிலையம் (PHC) அல்லது மருத்துவரைச் சென்று பரிசோதிக்கவும். நன்றி.`
      );
    } else {
      setReminderSuggestedMsg(
        `வணக்கம் ${pName}, இது CareSync மருத்துவ நினைவூட்டல். தயவுசெய்து உணவுக்குப் பிறகு உங்கள் மருந்தை தவறாமல் எடுத்துக்கொள்ளவும். நன்றி.`
      );
    }
    setShowVoiceReminders(true);
  }

  const severityTheme =
    SEVERITY_STYLES[triageOutput?.severity] || SEVERITY_STYLES.Yellow;

  const callVisitId = activeCallVisitId || triageOutput?.visitId || String(patientId);
  const jitsiRoomName = `CareSync-Consult-${String(callVisitId).replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#142D4E] pb-16 antialiased">
      {/* MediCare+ Operator Portal Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/85 backdrop-blur-md text-[#142D4E] shadow-xs">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-3.5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-[#2563EB] to-[#1D4ED8] text-white shadow-md shadow-blue-500/20">
              <Stethoscope className="h-6 w-6 stroke-[2.2]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-black tracking-tight text-[#142D4E]">
                  {t('CareSync Operator Desk')}
                </h1>
                <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-[11px] font-extrabold text-[#2563EB]">
                  {t('MediCare+ Kiosk')}
                </span>
              </div>
              <p className="text-xs text-slate-500 font-medium">
                Master Patient Intake &bull; AI Triaging &bull; Route: <code>/operator</code>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Online Status Pill */}
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${
                isOnline
                  ? 'border border-emerald-300 bg-emerald-50 text-emerald-800'
                  : 'border border-amber-300 bg-amber-50 text-amber-800'
              }`}
            >
              {isOnline ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              {isOnline ? t('Online') : t('Offline Mode')}
            </span>

            {/* Offline Sync Queue */}
            <button
              type="button"
              onClick={handleManualSync}
              disabled={!isOnline || isSyncing || pendingCount === 0}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 shadow-xs hover:bg-slate-50 disabled:opacity-50 transition"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              {pendingCount > 0 ? `${t('Sync Queue')} (${pendingCount})` : t('All Synced')}
            </button>

            {/* Tamil Voice Follow-Up Toggle */}
            <button
              type="button"
              onClick={() => setShowVoiceReminders((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold border transition ${
                showVoiceReminders
                  ? 'border-[#2563EB] bg-[#EFF6FF] text-[#2563EB] shadow-xs'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <PhoneCall className="h-3.5 w-3.5" />
              {t('Tamil Voice')}
            </button>

            {/* Language Gateway link */}
            <a
              href="/"
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50 transition"
              title="Return to Language Gateway"
            >
              <Home className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t('Gateway')}</span>
            </a>

            {/* Phase 4: Hackathon Demo Button */}
            <button
              type="button"
              onClick={handleLoadDemoCase}
              className="inline-flex items-center gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-black text-amber-900 shadow-2xs hover:bg-amber-100 hover:scale-105 active:scale-95 transition"
              title="Instantly auto-fill patient intake with a verified clinical demo case"
            >
              <Sparkles className="h-3.5 w-3.5 text-amber-600 animate-pulse" />
              <span>Load Demo Case</span>
            </button>

            {/* Next Patient Loop in Success Green */}
            <button
              type="button"
              onClick={handleNextPatient}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#16A34A] hover:bg-[#15803D] text-white px-4 py-1.5 text-xs font-black shadow-md shadow-emerald-600/20 transition active:scale-95"
            >
              <UserPlus className="h-3.5 w-3.5 stroke-[2.5]" />
              {t('Next Patient')}
            </button>
          </div>
        </div>
      </header>

      {inCall ? (
        /* Teleconsultation Room */
        <main className="mx-auto max-w-5xl space-y-5 px-6 pt-6">
          <AnimatedCard className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-red-100 text-red-600">
                  <Video className="h-6 w-6 stroke-[2.2]" />
                </div>
                <div>
                  <h2 className="text-base font-black text-[#142D4E]">
                    Live Teleconsultation Room &bull; #{patientId} {triageOutput?.patientName || patientName}
                  </h2>
                  <p className="text-xs text-slate-500 font-medium">
                    Room: <code>{jitsiRoomName}</code> &bull; SpO2 {spo2 || '--'}% &bull; Temp {temperature || '--'}&deg;F &bull; HR{' '}
                    {heartRate || '--'} bpm
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setInCall(false)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 transition"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back to Intake
                </button>
                <button
                  type="button"
                  onClick={handleNextPatient}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[#16A34A] hover:bg-[#15803D] text-white px-4 py-2 text-xs font-black shadow-md shadow-emerald-600/20 transition active:scale-95"
                >
                  <UserPlus className="h-4 w-4 stroke-[2.5]" />
                  Next Patient
                </button>
              </div>
            </div>
          </AnimatedCard>

          <div className="overflow-hidden rounded-2xl border-2 border-[#142D4E] bg-black shadow-lg">
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
                displayName: 'Ration Shop Operator',
              }}
              getIFrameRef={(iframeRef) => {
                iframeRef.style.height = '540px';
                iframeRef.style.width = '100%';
              }}
            />
          </div>

          {/* Real-time Pictorial Prescription Cards during Active Call */}
          <AnimatePresence>
            {prescriptions.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.4 }}
                className="space-y-4 pt-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                  <span className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-[#2563EB]">
                    <Sparkles className="h-4 w-4 text-[#2563EB]" />
                    Prescriptions Received from Doctor ({prescriptions.length} Medicine{prescriptions.length === 1 ? '' : 's'})
                  </span>
                  <button
                    type="button"
                    onClick={playPrescriptionAudio}
                    className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1 text-xs font-black transition shadow-2xs ${
                      activeAudioIndex !== null
                        ? 'border-rose-300 bg-rose-50 text-rose-700 animate-pulse'
                        : 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100'
                    }`}
                  >
                    {activeAudioIndex !== null ? (
                      <>
                        <VolumeX className="h-3.5 w-3.5" />
                        <span>Stop Karaoke Audio</span>
                      </>
                    ) : (
                      <>
                        <Volume2 className="h-3.5 w-3.5 text-amber-600" />
                        <span>Play Karaoke Audio 🔊</span>
                      </>
                    )}
                  </button>
                </div>
                <div className="space-y-4">
                  {prescriptions.map((med, idx) => {
                    const isPlayingAudio = activeAudioIndex !== null;
                    const isCurrentCard = idx === activeAudioIndex;
                    const cardHighlightClasses = isCurrentCard
                      ? 'scale-105 ring-4 ring-amber-400 shadow-xl transition-all duration-300'
                      : isPlayingAudio
                      ? 'opacity-50 transition-all duration-300'
                      : 'transition-all duration-300';

                    return (
                      <div key={idx} className={`space-y-2 rounded-2xl ${cardHighlightClasses}`}>
                        <PictorialPrescriptionCard
                          prescription={med}
                          allPrescriptions={prescriptions}
                          medicineIndex={idx + 1}
                          totalMedicines={prescriptions.length}
                          isActiveAudio={isCurrentCard}
                          isAudioPlaying={isPlayingAudio}
                          onPlayAudio={playPrescriptionAudio}
                        />

                        {/* Phase 3: The "Teach-Back" Confirmation Button */}
                        <div className="flex items-center justify-between rounded-xl border border-teal-200/80 bg-teal-50/70 p-3 shadow-2xs">
                          <div className="flex items-center gap-2 text-xs font-bold text-teal-900">
                            <Stethoscope className="h-4 w-4 text-teal-600 shrink-0" />
                            <span>Patient Teach-Back Comprehension:</span>
                          </div>

                          {med.understood ? (
                            <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-100 border border-emerald-300 px-3.5 py-1.5 text-xs font-black text-emerald-800 shadow-2xs">
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                              Patient Understood ✓
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleTeachBackConfirm(idx)}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 px-3.5 py-1.5 text-xs font-bold text-white shadow-sm transition active:scale-95"
                            >
                              <Check className="h-3.5 w-3.5" />
                              Patient Understood ✓
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      ) : (
        /* Main Screening Intake & Triage Workspace */
        <main className="mx-auto max-w-4xl space-y-6 px-6 pt-6">
          {/* Real-time Session Bridge Status */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-blue-200 bg-[#EFF6FF] px-4 py-3 text-xs text-[#142D4E] shadow-xs">
            <span className="flex items-center gap-2 font-bold">
              <Cpu className="h-4 w-4 text-[#2563EB]" />
              Session Telemetry Bridge: <code>active_sessions/current</code> &bull; Stream:{' '}
              <code>visits/{patientId}</code> (
              {isFirebaseConfigured ? 'Firestore Live' : 'Active Local Bridge'})
            </span>
            {iotSyncedAt && (
              <span className="font-extrabold text-[#2563EB] bg-white px-2.5 py-0.5 rounded-full shadow-2xs">
                Sensors synced at {iotSyncedAt}
              </span>
            )}
          </div>

          {syncMessage && (
            <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-700 shadow-xs">
              <span className="flex items-center gap-2 font-medium">
                {isOnline ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                ) : (
                  <CloudOff className="h-4 w-4 text-amber-600" />
                )}
                {syncMessage}
              </span>
            </div>
          )}

          {/* Patient Screening Intake Form in Soft MediCare+ Card */}
          <AnimatedCard className="p-6 sm:p-8 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
              <div>
                <h2 className="text-xl font-black text-[#142D4E] tracking-tight">
                  {t('Patient Clinical Screening Intake')}
                </h2>
                <p className="text-xs text-slate-500 font-medium mt-0.5">
                  Enter Patient Details &amp; Location to pair with the IoT terminal. Vitals are locked read-only.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-xl bg-[#2563EB] px-3.5 py-1.5 font-mono text-sm font-black text-white shadow-xs">
                  Patient #{patientId}
                </span>
                <button
                  type="button"
                  onClick={handleNextPatient}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-black text-emerald-800 transition hover:bg-emerald-100"
                >
                  <UserPlus className="h-3.5 w-3.5 stroke-[2.5]" />
                  {t('Next Patient')}
                </button>
              </div>
            </div>

            <form onSubmit={handleRunTriage} className="space-y-6">
              {/* Patient Demographics */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-12">
                <div className="sm:col-span-4">
                  <label
                    htmlFor="patient-name"
                    className="mb-1.5 flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider text-slate-600"
                  >
                    <User className="h-4 w-4 text-[#2563EB]" />
                    {t('Patient Name')}
                  </label>
                  <input
                    id="patient-name"
                    type="text"
                    required
                    value={patientName}
                    onChange={(e) => setPatientName(e.target.value)}
                    placeholder={t('Enter patient full name...')}
                    className="w-full rounded-xl border border-slate-300 bg-slate-50/70 px-4 py-2.5 text-sm font-semibold text-[#142D4E] placeholder:text-slate-400 focus:border-[#2563EB] focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:outline-none transition"
                  />
                </div>

                <div className="sm:col-span-3">
                  <label
                    htmlFor="patient-phone"
                    className="mb-1.5 flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider text-slate-600"
                  >
                    <Phone className="h-4 w-4 text-[#2563EB]" />
                    {t('Phone Number')}
                  </label>
                  <input
                    id="patient-phone"
                    type="tel"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="+91 99945 77702"
                    className="w-full rounded-xl border border-slate-300 bg-slate-50/70 px-4 py-2.5 text-sm font-semibold text-[#142D4E] placeholder:text-slate-400 focus:border-[#2563EB] focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:outline-none transition"
                  />
                </div>

                <div className="sm:col-span-3">
                  <label
                    htmlFor="patient-gender"
                    className="mb-1.5 block text-xs font-extrabold uppercase tracking-wider text-slate-600"
                  >
                    {t('Gender')}
                  </label>
                  <select
                    id="patient-gender"
                    required
                    value={gender}
                    onChange={(e) => setGender(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 bg-slate-50/70 px-3.5 py-2.5 text-sm font-semibold text-[#142D4E] focus:border-[#2563EB] focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:outline-none transition"
                  >
                    <option value="">{t('Select gender...')}</option>
                    <option value="Male">{t('Male')}</option>
                    <option value="Female">{t('Female')}</option>
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <label
                    htmlFor="patient-age"
                    className="mb-1.5 block text-xs font-extrabold uppercase tracking-wider text-slate-600"
                  >
                    {t('Age')}
                  </label>
                  <input
                    id="patient-age"
                    type="number"
                    min="0"
                    max="120"
                    required
                    value={age}
                    onChange={(e) => setAge(e.target.value)}
                    placeholder="42"
                    className="w-full rounded-xl border border-slate-300 bg-slate-50/70 px-3.5 py-2.5 text-sm font-semibold text-[#142D4E] focus:border-[#2563EB] focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:outline-none transition"
                  />
                </div>
              </div>

              {/* Location Tracking Inputs */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label
                    htmlFor="patient-country"
                    className="mb-1.5 flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider text-slate-600"
                  >
                    <Globe className="h-4 w-4 text-[#2563EB]" />
                    {t('Country')}
                  </label>
                  <input
                    id="patient-country"
                    type="text"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    placeholder="India"
                    className="w-full rounded-xl border border-slate-300 bg-slate-50/70 px-4 py-2.5 text-sm font-semibold text-[#142D4E] focus:border-[#2563EB] focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:outline-none transition"
                  />
                </div>

                <div>
                  <label
                    htmlFor="patient-state"
                    className="mb-1.5 flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider text-slate-600"
                  >
                    <MapPin className="h-4 w-4 text-[#2563EB]" />
                    {t('State')}
                  </label>
                  <input
                    id="patient-state"
                    type="text"
                    value={patientState}
                    onChange={(e) => setPatientState(e.target.value)}
                    placeholder="Tamil Nadu"
                    className="w-full rounded-xl border border-slate-300 bg-slate-50/70 px-4 py-2.5 text-sm font-semibold text-[#142D4E] focus:border-[#2563EB] focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:outline-none transition"
                  />
                </div>

                <div>
                  <label
                    htmlFor="patient-city"
                    className="mb-1.5 flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider text-slate-600"
                  >
                    <Navigation className="h-4 w-4 text-[#2563EB]" />
                    {t('City / Block')}
                  </label>
                  <input
                    id="patient-city"
                    type="text"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    placeholder="Coimbatore"
                    className="w-full rounded-xl border border-slate-300 bg-slate-50/70 px-4 py-2.5 text-sm font-semibold text-[#142D4E] focus:border-[#2563EB] focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:outline-none transition"
                  />
                </div>
              </div>

              {/* Hardware-Fed Read-Only Vitals */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-extrabold uppercase tracking-wider text-slate-600">
                    {t('Live Vitals Telemetry (IoT Hardware Sensor Locked)')}
                  </p>
                  <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600">
                    <Lock className="h-3 w-3" />
                    {t('Read-Only Sensor Stream')}
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-2xl border border-blue-100 bg-[#EFF6FF]/70 p-4">
                    <label
                      htmlFor="vital-spo2"
                      className="mb-1 flex items-center justify-between text-xs font-bold uppercase tracking-wider text-blue-800"
                    >
                      <span className="flex items-center gap-1.5">
                        <Activity className="h-4 w-4" />
                        {t('SpO2 (%)')}
                      </span>
                      <Lock className="h-3 w-3 text-blue-400" />
                    </label>
                    <input
                      id="vital-spo2"
                      type="number"
                      readOnly
                      value={spo2}
                      placeholder="Waiting for IoT..."
                      className="w-full cursor-not-allowed bg-transparent text-2xl font-black text-[#142D4E] focus:outline-none"
                    />
                    <span className="mt-1 block text-[11px] font-semibold text-blue-600">
                      Alert if &lt; 92%
                    </span>
                  </div>

                  <div className="rounded-2xl border border-amber-100 bg-[#FFFBEB]/70 p-4">
                    <label
                      htmlFor="vital-temp"
                      className="mb-1 flex items-center justify-between text-xs font-bold uppercase tracking-wider text-amber-800"
                    >
                      <span className="flex items-center gap-1.5">
                        <Thermometer className="h-4 w-4" />
                        {t('Temp (°F)')}
                      </span>
                      <Lock className="h-3 w-3 text-amber-400" />
                    </label>
                    <input
                      id="vital-temp"
                      type="number"
                      step="0.1"
                      readOnly
                      value={temperature}
                      placeholder="Waiting for IoT..."
                      className="w-full cursor-not-allowed bg-transparent text-2xl font-black text-[#142D4E] focus:outline-none"
                    />
                    <span className="mt-1 block text-[11px] font-semibold text-amber-700">
                      Alert if &gt; 100.4&deg;F
                    </span>
                  </div>

                  <div className="rounded-2xl border border-rose-100 bg-[#FEF2F2]/70 p-4">
                    <label
                      htmlFor="vital-hr"
                      className="mb-1 flex items-center justify-between text-xs font-bold uppercase tracking-wider text-rose-800"
                    >
                      <span className="flex items-center gap-1.5">
                        <HeartPulse className="h-4 w-4" />
                        {t('Heart Rate (bpm)')}
                      </span>
                      <Lock className="h-3 w-3 text-rose-400" />
                    </label>
                    <input
                      id="vital-hr"
                      type="number"
                      readOnly
                      value={heartRate}
                      placeholder="Waiting for IoT..."
                      className="w-full cursor-not-allowed bg-transparent text-2xl font-black text-[#142D4E] focus:outline-none"
                    />
                    <span className="mt-1 block text-[11px] font-semibold text-rose-700">
                      Normal: 60&ndash;100 bpm
                    </span>
                  </div>
                </div>
              </div>

              {/* Complaints / Add-ons */}
              <div>
                <label
                  htmlFor="symptoms"
                  className="mb-1.5 block text-xs font-extrabold uppercase tracking-wider text-slate-600"
                >
                  {t('Clinical Complaints & Add-on Symptoms')}
                </label>
                <textarea
                  id="symptoms"
                  rows={3}
                  required
                  value={symptoms}
                  onChange={(e) => setSymptoms(e.target.value)}
                  placeholder={t('Enter patient complaints, symptom duration, or specific discomfort...')}
                  className="w-full rounded-xl border border-slate-300 bg-slate-50/70 p-3.5 text-sm font-semibold text-[#142D4E] placeholder:text-slate-400 focus:border-[#2563EB] focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:outline-none transition leading-relaxed"
                />
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {QUICK_SYMPTOMS.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      onClick={() => appendQuickSymptom(chip)}
                      className="rounded-full border border-blue-200 bg-[#EFF6FF] px-3 py-1 text-xs font-bold text-[#2563EB] transition hover:bg-blue-100 active:scale-95"
                    >
                      + {chip}
                    </button>
                  ))}
                </div>
              </div>

              {formError && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3.5 text-xs font-bold text-red-700">
                  {formError}
                </div>
              )}

              {/* Primary Blue Action: Run Triage */}
              <button
                type="submit"
                disabled={isSubmitting}
                className="flex w-full items-center justify-center gap-2.5 rounded-2xl bg-[#2563EB] hover:bg-[#1D4ED8] px-6 py-4 text-base font-black text-white shadow-lg shadow-blue-600/25 transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Stethoscope className="h-5 w-5" />
                {isSubmitting ? t('Evaluating Clinical Triage with NVIDIA Nemotron AI...') : t('Run Clinical Triage')}
              </button>
            </form>
          </AnimatedCard>

          {/* AI Triage Waiting State Skeleton (Phase 2 Micro-interaction) */}
          <AnimatePresence>
            {isSubmitting && (
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
              >
                <AnimatedCard className="border-2 border-blue-200 bg-gradient-to-r from-blue-50/70 via-indigo-50/50 to-blue-50/70 p-6 space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#2563EB] text-white shadow-md animate-pulse">
                      <Sparkles className="h-6 w-6" />
                    </div>
                    <div>
                      <h4 className="text-sm font-black text-[#142D4E]">
                        Evaluating Clinical Risk with NVIDIA Nemotron AI...
                      </h4>
                      <p className="text-xs text-slate-500 font-medium">
                        Analyzing vital stability thresholds, demographic vulnerability, and Indian public health schemes...
                      </p>
                    </div>
                  </div>
                  <div className="space-y-2.5 pt-2">
                    <div className="h-4 w-5/6 bg-blue-200/70 rounded-md animate-pulse" />
                    <div className="h-3 w-3/4 bg-blue-100 rounded-md animate-pulse" />
                    <div className="h-3 w-1/2 bg-blue-100 rounded-md animate-pulse" />
                  </div>
                </AnimatedCard>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Pictorial Prescription Cards (Smooth Cascade-in) */}
          <AnimatePresence>
            {prescriptions.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.4 }}
                className="space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                  <span className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-[#2563EB]">
                    <Sparkles className="h-4 w-4 text-[#2563EB]" />
                    Prescriptions Received from Doctor ({prescriptions.length} Medicine{prescriptions.length === 1 ? '' : 's'})
                  </span>
                  <button
                    type="button"
                    onClick={playPrescriptionAudio}
                    className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1 text-xs font-black transition shadow-2xs ${
                      activeAudioIndex !== null
                        ? 'border-rose-300 bg-rose-50 text-rose-700 animate-pulse'
                        : 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100'
                    }`}
                  >
                    {activeAudioIndex !== null ? (
                      <>
                        <VolumeX className="h-3.5 w-3.5" />
                        <span>Stop Karaoke Audio</span>
                      </>
                    ) : (
                      <>
                        <Volume2 className="h-3.5 w-3.5 text-amber-600" />
                        <span>Play Karaoke Audio 🔊</span>
                      </>
                    )}
                  </button>
                </div>
                <div className="space-y-4">
                  {prescriptions.map((med, idx) => {
                    const isPlayingAudio = activeAudioIndex !== null;
                    const isCurrentCard = idx === activeAudioIndex;
                    const cardHighlightClasses = isCurrentCard
                      ? 'scale-105 ring-4 ring-amber-400 shadow-xl transition-all duration-300'
                      : isPlayingAudio
                      ? 'opacity-50 transition-all duration-300'
                      : 'transition-all duration-300';

                    return (
                      <div key={idx} className={`space-y-2 rounded-2xl ${cardHighlightClasses}`}>
                        <PictorialPrescriptionCard
                          prescription={med}
                          allPrescriptions={prescriptions}
                          medicineIndex={idx + 1}
                          totalMedicines={prescriptions.length}
                          isActiveAudio={isCurrentCard}
                          isAudioPlaying={isPlayingAudio}
                          onPlayAudio={playPrescriptionAudio}
                        />

                        {/* Phase 3: The "Teach-Back" Confirmation Button */}
                        <div className="flex items-center justify-between rounded-xl border border-teal-200/80 bg-teal-50/70 p-3 shadow-2xs">
                          <div className="flex items-center gap-2 text-xs font-bold text-teal-900">
                            <Stethoscope className="h-4 w-4 text-teal-600 shrink-0" />
                            <span>Patient Teach-Back Comprehension:</span>
                          </div>

                          {med.understood ? (
                            <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-100 border border-emerald-300 px-3.5 py-1.5 text-xs font-black text-emerald-800 shadow-2xs">
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                              Patient Understood ✓
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleTeachBackConfirm(idx)}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 px-3.5 py-1.5 text-xs font-bold text-white shadow-sm transition active:scale-95"
                            >
                              <Check className="h-3.5 w-3.5" />
                              Patient Understood ✓
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Triage Review Section (Cascades in Smoothly) */}
          <AnimatePresence>
            {triageOutput && (
              <motion.section
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.35 }}
                className={`rounded-2xl border-2 p-6 shadow-sm ${severityTheme.card}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={`rounded-full px-3.5 py-1 text-xs font-black tracking-wide ${severityTheme.badge}`}>
                    {severityTheme.label}
                  </span>
                  <span className="text-xs font-bold opacity-80">
                    #{triageOutput.visitId} {triageOutput.patientName} ({triageOutput.gender}) &bull;{' '}
                    {triageOutput.mode === 'offline' ? 'Saved Offline (Dexie)' : `AI: ${triageOutput.source}`}
                  </span>
                </div>

                <h3 className="mt-3 text-xl font-black">{triageOutput.classification}</h3>
                <p className="mt-1 text-sm leading-relaxed font-medium">{triageOutput.reason}</p>

                <div className="mt-4 rounded-xl bg-white/90 p-4 text-[#142D4E] shadow-2xs">
                  <p className="text-xs font-black uppercase tracking-wider text-slate-500">
                    Operator Clinical Guidance
                  </p>
                  <p className="mt-1 text-sm font-semibold">{triageOutput.recommended_action}</p>
                </div>

                {triageOutput.red_flags_to_watch?.length > 0 && (
                  <div className="mt-3.5 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="inline-flex items-center gap-1 font-extrabold text-red-900">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Watch for:
                    </span>
                    {triageOutput.red_flags_to_watch.map((flag, idx) => (
                      <span
                        key={idx}
                        className="rounded-md bg-white/80 px-2.5 py-0.5 font-bold text-slate-800 shadow-2xs"
                      >
                        {flag}
                      </span>
                    ))}
                  </div>
                )}

                {/* Structured Clinical Suggestion Box */}
                <SuggestionBox suggestions={triageOutput.clinical_suggestions} />

                {/* Eligible Government Health Programs (Smooth Cascade) */}
                {Array.isArray(triageOutput.eligible_schemes) &&
                  triageOutput.eligible_schemes.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.35, delay: 0.1 }}
                      className="mt-5 rounded-2xl border border-slate-200/90 bg-white/95 p-5 text-[#142D4E] shadow-xs"
                    >
                      <h4 className="mb-3 text-sm font-black text-[#142D4E]">
                        {t('Relevant Government Health Programs')}
                      </h4>
                      <div className="space-y-3">
                        {triageOutput.eligible_schemes.map((rawScheme, index) => {
                          const scheme =
                            rawScheme && typeof rawScheme === 'object'
                              ? rawScheme
                              : {
                                  name: String(rawScheme),
                                  requires_verification: false,
                                  reason: 'Matches patient triage profile.',
                                };

                          return (
                            <motion.div
                              key={index}
                              initial={{ opacity: 0, x: -8 }}
                              animate={{ opacity: 1, x: 0 }}
                              transition={{ duration: 0.25, delay: index * 0.06 }}
                              className="rounded-xl border border-slate-100 bg-slate-50/70 p-3"
                            >
                              <div className="flex items-center text-sm sm:text-base font-bold text-[#142D4E]">
                                <span className="text-[#16A34A] mr-2 text-base">✓</span>
                                <span>{scheme.name}</span>
                                {scheme.requires_verification && (
                                  <span className="text-amber-700 ml-2 text-xs font-semibold bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-md">
                                    (Eligibility Verification Required)
                                  </span>
                                )}
                              </div>
                              <div className="text-slate-600 text-xs sm:text-sm ml-5 mt-1 font-medium">
                                Reason: {scheme.reason}
                              </div>
                            </motion.div>
                          );
                        })}
                      </div>
                    </motion.div>
                  )}

                <div className="mt-5">
                  <HospitalMap
                    patientLocation={PATIENT_LOCATION}
                    facilities={
                      firebaseFacilities.some(
                        (f) => f.lat != null || f.latitude != null || f.location?.lat != null
                      )
                        ? firebaseFacilities
                        : facilities.some(
                              (f) => f.lat != null || f.latitude != null || f.location?.lat != null
                            )
                          ? facilities
                          : COIMBATORE_FALLBACK_FACILITIES
                    }
                  />
                </div>

                {/* Side-by-side Okay & Escalate Decisions */}
                <div className="mt-5 border-t border-black/10 pt-4">
                  <p className="mb-3 text-xs font-black uppercase tracking-wider opacity-80">
                    {t('Operator Triage Review Action')}
                  </p>
                  {reviewDecision === 'okay' ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white/95 px-4 py-3 text-sm font-bold text-emerald-800 shadow-2xs">
                      <span className="flex items-center gap-2">
                        <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                        Case marked as Okay — Local care guidance recorded.
                      </span>
                      {/* Next Patient Loop in Success Green */}
                      <button
                        type="button"
                        onClick={handleNextPatient}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-[#16A34A] hover:bg-[#15803D] px-4 py-2 text-xs font-black text-white shadow-md shadow-emerald-600/20"
                      >
                        <UserPlus className="h-3.5 w-3.5 stroke-[2.5]" />
                        {t('Next Patient')}
                      </button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-4">
                      {/* Okay Button */}
                      <button
                        type="button"
                        disabled={isUpdatingStatus}
                        onClick={() => handleReviewDecision('okay')}
                        className="flex items-center justify-center gap-2 rounded-xl border-2 border-emerald-600 bg-white px-4 py-3 text-sm font-black text-emerald-800 shadow-xs transition hover:bg-emerald-50 active:scale-95 disabled:opacity-60"
                      >
                        <Check className="h-4 w-4 stroke-[2.5]" />
                        {t('Okay')}
                      </button>

                      {/* Escalate Button in Amber Pending Theme */}
                      <button
                        type="button"
                        disabled={isUpdatingStatus}
                        onClick={() => handleReviewDecision('escalate')}
                        className="flex items-center justify-center gap-2 rounded-xl bg-amber-500 hover:bg-amber-600 px-4 py-3 text-sm font-black text-slate-950 shadow-md shadow-amber-500/20 transition active:scale-95 disabled:opacity-60"
                      >
                        <AlertOctagon className="h-4 w-4 stroke-[2.5]" />
                        {isUpdatingStatus ? t('Escalating to Doctor...') : t('Escalate to Doctor')}
                      </button>
                    </div>
                  )}
                </div>

                {facilities.length > 0 && (
                  <div className="mt-5 border-t border-black/10 pt-4">
                    <h4 className="mb-3 flex items-center gap-1.5 text-sm font-black">
                      <Hospital className="h-4 w-4" />
                      Recommended Rural Facilities
                    </h4>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {facilities.map((fac) => (
                        <div
                          key={fac.id}
                          className="rounded-2xl border border-slate-200/80 bg-white p-3.5 text-[#142D4E] shadow-2xs"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-bold">{fac.name}</p>
                            <span className="shrink-0 rounded-md bg-blue-50 px-2 py-0.5 text-xs font-extrabold text-[#2563EB]">
                              {fac.distance_km} km
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs font-bold text-teal-700">{fac.type}</p>
                          <p className="mt-1 text-xs text-slate-600 font-medium">{fac.availability}</p>
                          <p className="mt-1 text-xs font-semibold text-slate-800">
                            Contact: {fac.contact}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </motion.section>
            )}
          </AnimatePresence>

          {/* Fused Tamil Voice Reminder Engine (Twilio) */}
          <AnimatePresence>
            {showVoiceReminders && (
              <motion.section
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.35 }}
                className="space-y-2"
              >
                <VoiceReminderPanel
                  suggestedPatientName={triageOutput?.patientName || patientName}
                  suggestedMessage={reminderSuggestedMsg}
                />
              </motion.section>
            )}
          </AnimatePresence>

          {/* Recent Local Visits Queue in MediCare+ Card */}
          <AnimatedCard className="p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-sm font-black uppercase tracking-wider text-[#142D4E]">
                Recent Local Screenings (Offline IndexedDB)
              </h3>
              <span className="text-xs font-extrabold text-[#2563EB] bg-blue-50 px-2.5 py-1 rounded-full">
                {pendingCount} queued for cloud sync
              </span>
            </div>

            {recentVisits.length === 0 ? (
              <p className="text-xs text-slate-500 font-medium py-3 text-center">
                No patient screenings recorded on this device yet.
              </p>
            ) : (
              <div className="divide-y divide-slate-100">
                {recentVisits.map((visit) => (
                  <div
                    key={visit.localId}
                    className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
                  >
                    <div>
                      <p className="font-extrabold text-[#142D4E]">
                        {visit.patientName}, {visit.age}y
                      </p>
                      <p className="text-xs text-slate-500 font-medium mt-0.5">
                        SpO2: {visit.vitals?.spo2 ?? '--'}% &bull; Temp: {visit.vitals?.temperature ?? '--'}&deg;F &bull; HR:{' '}
                        {visit.vitals?.heart_rate ?? '--'} bpm
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {visit.status && (
                        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-black uppercase text-slate-700">
                          {visit.status}
                        </span>
                      )}
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-black uppercase ${
                          visit.severity === 'Red'
                            ? 'bg-red-100 text-red-700'
                            : visit.severity === 'Green'
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {visit.severity}
                      </span>
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                          visit.synced
                            ? 'bg-blue-50 text-[#2563EB]'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {visit.synced ? 'Synced' : 'Queued Offline'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </AnimatedCard>
        </main>
      )}
    </div>
  );
}
