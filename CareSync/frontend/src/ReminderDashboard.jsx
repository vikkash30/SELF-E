import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  collection,
  doc,
  onSnapshot,
  setDoc,
} from 'firebase/firestore';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Globe,
  Loader2,
  MessageSquare,
  Phone,
  PhoneCall,
  Pill,
  PlusCircle,
  RefreshCw,
  Sparkles,
  User,
  Volume2,
  X,
} from 'lucide-react';
import { firestoreDb, isFirebaseConfigured } from './firebase.js';
import { API_BASE_URL } from './syncManager.js';
import AnimatedCard from './components/AnimatedCard.jsx';

const LANGUAGE_OPTIONS = [
  { code: 'Tamil', label: 'தமிழ் (Tamil)', tag: 'ta-IN' },
  { code: 'Hindi', label: 'हिन्दी (Hindi)', tag: 'hi-IN' },
  { code: 'Telugu', label: 'తెలుగు (Telugu)', tag: 'te-IN' },
  { code: 'English', label: 'English', tag: 'en-IN' },
];

const LANG_CODE_TO_NAME = {
  en: 'English',
  hi: 'Hindi',
  ta: 'Tamil',
  te: 'Telugu',
};

const LANG_NAME_TO_CODE = {
  English: 'en',
  Hindi: 'hi',
  Tamil: 'ta',
  Telugu: 'te',
};

export default function ReminderDashboard() {
  const { t, i18n } = useTranslation();
  const [patients, setPatients] = useState([]);
  const [loadingMap, setLoadingMap] = useState({});
  const [activeAlert, setActiveAlert] = useState(null);

  const initialCode =
    (typeof window !== 'undefined' &&
      (localStorage.getItem('careSyncLang') || localStorage.getItem('app_lang'))) ||
    'ta';
  const [selectedLanguage, setSelectedLanguage] = useState(
    LANG_CODE_TO_NAME[initialCode] || 'Tamil'
  );
  const [callHistory, setCallHistory] = useState([]);
  const [phoneOverrides, setPhoneOverrides] = useState({});
  const [smsLoadingMap, setSmsLoadingMap] = useState({});
  const [toast, setToast] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  function handleLanguageChange(nextLangName) {
    setSelectedLanguage(nextLangName);
    const code = LANG_NAME_TO_CODE[nextLangName] || 'ta';
    localStorage.setItem('careSyncLang', code);
    localStorage.setItem('app_lang', code);
    i18n.changeLanguage(code);
  }

  // Phase 2: Read Live Firebase Data (Zero Mock Arrays)
  useEffect(() => {
    let unsubscribe = () => {};
  function normalizePatient(docId, data) {
    if (!data) return null;
    const phone = data.phoneNumber || data.phone_number || '';
    const pName = data.patient_name || data.patientName || data.name || 'Patient';
    const prescList = Array.isArray(data.prescriptions) && data.prescriptions.length > 0
      ? data.prescriptions
      : data.prescription
        ? [data.prescription]
        : [];
    const rawLang = (data.language || '').toLowerCase();
    const lang = rawLang.includes('hin') ? 'Hindi' : (rawLang.includes('tel') ? 'Telugu' : (rawLang.includes('eng') ? 'English' : 'Tamil'));

    return {
      visit_id: docId || data.visit_id || data.id,
      ...data,
      patient_name: pName,
      patientName: pName,
      phoneNumber: phone,
      phone_number: phone,
      language: lang,
      prescriptions: prescList,
      prescription: prescList[0] || null,
    };
  }

  const fetchBackendVisits = async () => {
    try {
      const visitsRef = collection(firestoreDb, 'visits');
      unsubscribe = onSnapshot(
        visitsRef,
        (snapshot) => {
          const fetchedData = snapshot.docs.map((docSnap) => {
            const data = docSnap.data();
            const phone = data.phoneNumber || data.phone_number || '';
            const pName = data.patient_name || data.patientName || data.name || 'Patient';
            const prescList = Array.isArray(data.prescriptions) && data.prescriptions.length > 0
              ? data.prescriptions
              : data.prescription
                ? [data.prescription]
                : [];
            return {
              visit_id: docSnap.id,
              ...data,
              patient_name: pName,
              patientName: pName,
              phoneNumber: phone,
              phone_number: phone,
              prescriptions: prescList,
              prescription: prescList[0] || null,
            };
      const res = await fetch(`${API_BASE_URL || 'http://localhost:8000'}/visits`, {
        signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined,
      });
      if (res.ok) {
        const data = await res.json();
        const visits = Array.isArray(data) ? data : (data.visits || []);
        if (visits.length > 0) {
          setPatients((prev) => {
            const map = new Map();
            prev.forEach((p) => {
              if (p.visit_id) map.set(p.visit_id, p);
            });
            visits.forEach((raw) => {
              const norm = normalizePatient(raw.visit_id || raw.id, raw);
              if (norm && norm.visit_id) {
                const existing = map.get(norm.visit_id) || {};
                map.set(norm.visit_id, { ...existing, ...norm });
              }
            });
            return Array.from(map.values());
          });

          console.log("Fetched Live Patients:", fetchedData);
          setPatients(fetchedData);
        },
        (err) => {
          console.error("Firestore visits listener error:", err);
        }
      );
      }
    } catch (err) {
      console.error("Failed to attach Firestore listener:", err);
      console.warn("Backend /visits fetch error:", err);
    }
  };

    return () => unsubscribe();
  // Phase 2: Live Dual-Sync (Backend /visits polling + Firestore onSnapshot)
  useEffect(() => {
    let unsubscribe = () => {};

    // 1. Initial backend fetch & polling every 3s
    fetchBackendVisits();
    const interval = setInterval(fetchBackendVisits, 3000);

    // 2. Firestore listener if configured
    if (isFirebaseConfigured && firestoreDb) {
      try {
        const visitsRef = collection(firestoreDb, 'visits');
        unsubscribe = onSnapshot(
          visitsRef,
          (snapshot) => {
            const fetchedData = snapshot.docs
              .map((docSnap) => normalizePatient(docSnap.id, docSnap.data()))
              .filter(Boolean);

            console.log("Fetched Live Patients from Firestore:", fetchedData);
            setPatients((prev) => {
              const map = new Map();
              prev.forEach((p) => {
                if (p.visit_id) map.set(p.visit_id, p);
              });
              fetchedData.forEach((norm) => {
                const existing = map.get(norm.visit_id) || {};
                map.set(norm.visit_id, { ...existing, ...norm });
              });
              return Array.from(map.values());
            });
          },
          (err) => {
            console.error("Firestore visits listener error:", err);
          }
        );
      } catch (err) {
        console.error("Failed to attach Firestore listener:", err);
      }
    }

    return () => {
      clearInterval(interval);
      unsubscribe();
    };
  }, []);

  function handlePhoneChange(visitId, newPhone) {
    setPhoneOverrides((prev) => ({
      ...prev,
      [visitId]: newPhone,
    }));
  }

  // 2. Action Logic: POST to /admin/trigger-call
  async function handleTriggerCall(patient) {
    const visitId = patient.visit_id;
    const phoneToUse = (phoneOverrides[visitId] || patient.phoneNumber || patient.phone_number || '').trim();

    if (!phoneToUse) {
      setActiveAlert({
        type: 'error',
        title: 'Missing Phone Number',
        message: 'Please provide a valid phone number with country code (+91...).',
      });
      return;
    }

    const prescList = Array.isArray(patient.prescriptions) && patient.prescriptions.length > 0
      ? patient.prescriptions
      : [patient.prescription].filter(Boolean);

    const medicine = prescList.map((p) => p.medicine_name || p.medicineName || 'Medicine').join(', ');
    const instructions = prescList
      .map((p) => {
        const timings = Array.isArray(p.timing) ? p.timing.join('/') : p.timing || '';
        return [p.dosage, timings, p.food_context || p.foodContext, p.duration]
          .filter(Boolean)
          .join(' • ');
      })
      .join('; ');

    setLoadingMap((prev) => ({ ...prev, [visitId]: true }));
    setActiveAlert(null);

    const payload = {
      patient_name: patient.patient_name || patient.name || 'Patient',
      phone_number: phoneToUse,
      medicine_name: medicine,
      instructions: instructions || 'Take as directed by doctor',
      language: selectedLanguage,
      language: selectedLanguage || patient.language || 'Tamil',
    };

    console.log("Call Button Clicked", payload);

    try {
      const targetUrl = `${API_BASE_URL || 'http://localhost:8000'}/admin/trigger-call`;
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data.status !== 'success') {
        const errorDetail =
          data?.detail ||
          data?.message ||
          `HTTP ${response.status}: Call request failed`;
        const customError = new Error(errorDetail);
        customError.response = { data, status: response.status };
        throw customError;
      }

      const alertItem = {
        type: 'success',
        title: 'Twilio Voice Call Placed Successfully!',
        callSid: data.call_sid,
        to: data.to,
        language: data.language,
        script: data.generated_script,
        timestamp: new Date().toLocaleTimeString(),
      };
      setActiveAlert(alertItem);
      setCallHistory((prev) => [alertItem, ...prev]);
    } catch (error) {
      console.error("Call Trigger Error:", error);
      const errorMessage =
        error.response?.data?.detail ||
        error.response?.data?.message ||
        error.message ||
        'Call failed.';
      setActiveAlert({
        type: 'error',
        title: 'Call Failed',
        message: errorMessage,
      });
    } finally {
      setLoadingMap((prev) => ({ ...prev, [visitId]: false }));
    }
  }

  // Phase 4 & 5: Trigger Hackathon Time-Travel Medication SMS
  async function handleTriggerMedsSMS(patient) {
    const visitId = patient.visit_id;
    const phoneToUse = (phoneOverrides[visitId] || patient.phoneNumber || patient.phone_number || '').trim();

    if (!phoneToUse) {
      console.error("Missing Phone Number for patient:", patient);
      setActiveAlert({
        type: 'error',
        title: 'Missing Phone Number',
        message: 'Patient has no phone number recorded. Cannot send medication SMS.',
      });
      setToast({
        type: 'error',
        title: 'Missing Phone Number',
        message: 'Patient has no phone number recorded. Please update phone number first.',
      });
      return;
    }

    const patientName = patient.patient_name || patient.patientName || 'Patient';

    const prescList = Array.isArray(patient.prescriptions) && patient.prescriptions.length > 0
      ? patient.prescriptions
      : patient.prescription
        ? [patient.prescription]
        : [];
    const medName = prescList[0]?.medicine_name || prescList[0]?.medicineName || patient.prescription?.medicine_name || 'Prescribed Medication';

    setSmsLoadingMap((prev) => ({ ...prev, [`${visitId}-meds`]: true }));

    try {
      const res = await fetch(`${API_BASE_URL || 'http://localhost:8000'}/admin/trigger-sms/meds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone_number: phoneToUse,
          medicine_name: medName,
          time_of_day: 'Morning',
          language: selectedLanguage,
          language: selectedLanguage || patient.language || 'Tamil',
          patient_name: patientName,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data?.detail || data?.message || `HTTP ${res.status}: Meds SMS failed`);
      }

      const alertItem = {
        type: 'success',
        title: 'Twilio Morning Meds SMS Dispatched!',
        callSid: data.sid,
        to: data.to,
        language: data.language,
        script: data.body,
        timestamp: new Date().toLocaleTimeString(),
      };
      setActiveAlert(alertItem);
      setCallHistory((prev) => [alertItem, ...prev]);
      setToast({
        type: 'success',
        title: 'Morning Meds SMS Sent',
        message: `Dispatched to ${data.to}: "${data.body}"`,
      });
      setTimeout(() => setToast(null), 5000);
    } catch (err) {
      console.error('Trigger Meds SMS error:', err);
      setActiveAlert({
        type: 'error',
        title: 'Meds SMS Failed',
        message: err.message || 'Failed to dispatch medication SMS',
      });
      setToast({
        type: 'error',
        title: 'SMS Failed',
        message: err.message,
      });
      setTimeout(() => setToast(null), 5000);
    } finally {
      setSmsLoadingMap((prev) => ({ ...prev, [`${visitId}-meds`]: false }));
    }
  }

  // Phase 4 & 5: Trigger Hackathon Time-Travel Appointment SMS
  async function handleTriggerApptSMS(patient, alertType) {
    const visitId = patient.visit_id;
    const phoneToUse = (phoneOverrides[visitId] || patient.phoneNumber || patient.phone_number || '').trim();

    if (!phoneToUse) {
      console.error("Missing Phone Number for patient:", patient);
      setActiveAlert({
        type: 'error',
        title: 'Missing Phone Number',
        message: 'Patient has no phone number recorded. Cannot send appointment SMS.',
      });
      setToast({
        type: 'error',
        title: 'Missing Phone Number',
        message: 'Patient has no phone number recorded. Please update phone number first.',
      });
      return;
    }

    const patientName = patient.patient_name || patient.patientName || 'Patient';
    const apptTime = patient.next_appointment || patient.nextAppointment || 'Tomorrow at 10:00 AM';

    setSmsLoadingMap((prev) => ({ ...prev, [`${visitId}-${alertType}`]: true }));

    try {
      const res = await fetch(`${API_BASE_URL || 'http://localhost:8000'}/admin/trigger-sms/appointment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone_number: phoneToUse,
          appointment_time: apptTime,
          alert_type: alertType,
          language: selectedLanguage,
          language: selectedLanguage || patient.language || 'Tamil',
          patient_name: patientName,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data?.detail || data?.message || `HTTP ${res.status}: Appt SMS failed`);
      }

      const alertLabel = alertType === '1_day_before' ? '1 Day Before' : '10 Min Before';
      const alertItem = {
        type: 'success',
        title: `Twilio Appointment (${alertLabel}) SMS Dispatched!`,
        callSid: data.sid,
        to: data.to,
        language: data.language,
        script: data.body,
        timestamp: new Date().toLocaleTimeString(),
      };
      setActiveAlert(alertItem);
      setCallHistory((prev) => [alertItem, ...prev]);
      setToast({
        type: 'success',
        title: `Appt SMS (${alertLabel}) Sent`,
        message: `Dispatched to ${data.to}: "${data.body}"`,
      });
      setTimeout(() => setToast(null), 5000);
    } catch (err) {
      console.error('Trigger Appt SMS error:', err);
      setActiveAlert({
        type: 'error',
        title: 'Appt SMS Failed',
        message: err.message || 'Failed to dispatch appointment SMS',
      });
      setToast({
        type: 'error',
        title: 'SMS Failed',
        message: err.message,
      });
      setTimeout(() => setToast(null), 5000);
    } finally {
      setSmsLoadingMap((prev) => ({ ...prev, [`${visitId}-${alertType}`]: false }));
    }
  }

  async function handleAddTestPatient() {
    const id = `visit-${Date.now().toString().slice(-6)}`;
    const newPatient = {
      visit_id: id,
      patient_name: `Patient #${patients.length + 1}`,
      patientName: `Patient #${patients.length + 1}`,
      phoneNumber: '',
      phone_number: '',
      age: 45,
      gender: 'Male',
      language: 'Tamil',
      symptoms: 'Routine medication follow-up',
      prescription: {
        medicine_name: 'Tab. Paracetamol 650mg',
        dosage: '1 Tablet',
        timing: 'Morning and Night after food',
        food_context: 'After Food',
        duration: '3 Days',
      },
      prescriptions: [{
        medicine_name: 'Tab. Paracetamol 650mg',
        dosage: '1 Tablet',
        timing: ['Morning', 'Night'],
        food_context: 'After Food',
        duration: '3 Days',
      }],
      status: 'triaged',
      created_at: new Date().toISOString(),
    };

    try {
      await setDoc(doc(firestoreDb, 'visits', id), newPatient, { merge: true });
    } catch {
      setPatients((prev) => [newPatient, ...prev]);
    setPatients((prev) => [newPatient, ...prev]);

    if (isFirebaseConfigured && firestoreDb) {
      try {
        await Promise.race([
          setDoc(doc(firestoreDb, 'visits', id), newPatient, { merge: true }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500))
        ]);
      } catch (e) {
        console.warn("Firestore setDoc bypassed/timed out:", e);
      }
    }
  }

  return (
    <div className="min-h-screen bg-[#F6F9F8] text-slate-900 antialiased">
      {/* Top Header Shell */}
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/95 backdrop-blur-md shadow-xs">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Link
              to="/operator"
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition"
              title="Back to Operator Intake"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-[#2563EB]">
              <PhoneCall className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold text-[#142D4E] tracking-tight">
                  {t('Voice Reminder Trigger Workstation')}
                </h1>
                <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-bold text-blue-700">
                  Twilio + NVIDIA Nemotron
                </span>
              </div>
              <p className="text-xs text-slate-500">
                Automated Outbound Multilingual Phone Calls &bull; Route: <code className="text-slate-700 font-mono">/reminders</code>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Global Language Selector */}
            <div className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700">
              <Globe className="h-3.5 w-3.5 text-[#2563EB]" />
              <label htmlFor="lang-select" className="sr-only">Select Script Language</label>
              <select
                id="lang-select"
                value={selectedLanguage}
                onChange={(e) => handleLanguageChange(e.target.value)}
                className="bg-transparent font-bold text-[#142D4E] focus:outline-none"
              >
                {LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.code} value={opt.code}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              onClick={() => {
                setIsRefreshing(true);
                fetchBackendVisits().finally(() => setIsRefreshing(false));
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 transition shadow-xs cursor-pointer"
              title="Poll live patients from backend API"
            >
              <RefreshCw className={`h-3.5 w-3.5 text-blue-600 ${isRefreshing ? 'animate-spin' : ''}`} />
              {t('Sync Live Data')}
            </button>

            <button
              type="button"
              onClick={handleAddTestPatient}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 transition shadow-xs"
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 transition shadow-xs cursor-pointer"
            >
              <PlusCircle className="h-3.5 w-3.5 text-emerald-600" />
              {t('Add Test Patient')}
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        {/* Active Alert / Call Status Banner */}
        {activeAlert && (
          <AnimatedCard
            className={`rounded-2xl border p-5 shadow-sm transition ${
              activeAlert.type === 'success'
                ? 'border-emerald-300 bg-emerald-50/80 text-emerald-950'
                : activeAlert.type === 'warning'
                  ? 'border-amber-300 bg-amber-50/90 text-amber-950'
                  : 'border-blue-300 bg-blue-50/80 text-blue-950'
            }`}
          >
            <div className="flex items-start gap-3.5">
              <div
                className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                  activeAlert.type === 'success'
                    ? 'bg-emerald-600 text-white'
                    : activeAlert.type === 'warning'
                      ? 'bg-amber-500 text-white'
                      : 'bg-[#2563EB] text-white'
                }`}
              >
                {activeAlert.type === 'success' ? (
                  <CheckCircle2 className="h-5 w-5" />
                ) : (
                  <Sparkles className="h-5 w-5" />
                )}
              </div>

              <div className="flex-1 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-black">{activeAlert.title}</h3>
                  {activeAlert.callSid && (
                    <span className="font-mono text-xs rounded-md bg-white/70 px-2 py-0.5 font-bold border border-current/20">
                      SID: {activeAlert.callSid}
                    </span>
                  )}
                </div>

                {activeAlert.message && (
                  <p className="text-xs font-medium opacity-90">{activeAlert.message}</p>
                )}

                {activeAlert.script && (
                  <div className="rounded-xl border border-current/15 bg-white/80 p-3">
                    <p className="mb-1 flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-slate-500">
                      <Volume2 className="h-3.5 w-3.5 text-[#2563EB]" />
                      NVIDIA Nemotron Generated Spoken Script ({activeAlert.language}):
                    </p>
                    <p className="text-sm font-semibold leading-relaxed text-[#142D4E]">
                      "{activeAlert.script}"
                    </p>
                  </div>
                )}
              </div>
            </div>
          </AnimatedCard>
        )}

        {/* Prescription Follow-Up Call Queue */}
        <AnimatedCard className="rounded-2xl border border-slate-200/80 bg-white shadow-[0_8px_30px_-18px_rgba(15,23,42,0.18)] p-6">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-4">
            <div>
              <h2 className="text-base font-extrabold text-[#142D4E] flex items-center gap-2">
                <Pill className="h-5 w-5 text-[#2563EB]" />
                {t('Patients with Prescriptions Ready for Follow-Up')}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Real-time sync from Firestore <code>visits</code> collection. Click trigger to execute an AI localized voice call.
              </p>
            </div>
            <span className="rounded-xl bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">
              {patients.length} Patient{patients.length === 1 ? '' : 's'} Eligible
            </span>
          </div>

          {patients.length === 0 ? (
            <div className="rounded-xl bg-slate-50 px-5 py-12 text-center">
              <Pill className="mx-auto mb-3 h-8 w-8 text-slate-400" />
              <p className="text-sm font-bold text-slate-700">No Prescribed Patients Found</p>
              <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                Patients who receive a prescription from the Doctor Workstation will automatically appear here.
              </p>
              <button
                type="button"
                onClick={handleAddTestPatient}
                className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-blue-700 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-800 transition"
              >
                <PlusCircle className="h-4 w-4" />
                {t('Add Test Patient')}
              </button>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {patients.map((patient) => {
                const visitId = patient.visit_id;
                const isLoading = Boolean(loadingMap[visitId]);
                const phoneVal = phoneOverrides[visitId] !== undefined ? phoneOverrides[visitId] : (patient.phoneNumber || patient.phone_number || '');
                const presc = patient.prescription || {};

                return (
                  <div
                    key={visitId}
                    className="flex flex-col gap-4 py-4 xl:flex-row xl:items-center xl:justify-between transition hover:bg-slate-50/50 rounded-xl px-2 border-b border-slate-100 last:border-b-0"
                  >
                    {/* Patient Info & Contact */}
                    <div className="space-y-1 xl:max-w-[26%]">
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50 text-[#2563EB]">
                          <User className="h-4 w-4" />
                        </span>
                        <p className="font-extrabold text-[#142D4E] text-sm">
                          {patient.patient_name || patient.name || t('Patient Name')}
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5 pt-1">
                        <Phone className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                        <input
                          type="tel"
                          value={phoneVal}
                          onChange={(e) => handlePhoneChange(visitId, e.target.value)}
                          placeholder="+91 99945 77702"
                          className="h-8 w-44 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-bold text-slate-800 placeholder:text-slate-400 focus:border-[#2563EB] focus:outline-none focus:ring-1 focus:ring-blue-500/20"
                          title="Phone number with country code"
                        />
                      </div>

                      <p className="text-[11px] text-slate-500 font-medium">
                        {t('Age')}: {patient.age ?? '--'} &bull; {t('Gender')}: {patient.gender || 'Not specified'}
                      </p>
                    </div>

                    {/* Prescribed Medicine & Timing */}
                    <div className="space-y-1 xl:max-w-[32%]">
                      <div className="flex items-center gap-2">
                        <span className="rounded-md bg-blue-50 px-2 py-0.5 text-xs font-black text-[#2563EB]">
                          {presc.medicine_name || t('Prescription Details')}
                        </span>
                      </div>
                      <p className="text-xs font-bold text-slate-700">
                        {presc.dosage || '1 unit'} &bull; {Array.isArray(presc.timing) ? presc.timing.join(', ') : (presc.timing || 'As directed')}
                      </p>
                      <p className="text-[11px] text-slate-500 font-medium">
                        {t('Food Context')}: {presc.food_context || t('After Food')} &bull; {t('Duration')}: {presc.duration || '3 days'}
                      </p>
                      {(patient.next_appointment || patient.nextAppointment) && (
                        <p className="text-[11px] font-bold text-indigo-700 bg-indigo-50/80 px-2 py-0.5 rounded-md inline-flex items-center gap-1 border border-indigo-200/60 mt-1">
                          <Clock className="h-3 w-3 text-indigo-600" />
                          <span>Appt: {patient.next_appointment || patient.nextAppointment}</span>
                        </p>
                      )}
                    </div>

                    {/* Action Controls: Live Voice Call + SMS Overrides Column */}
                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 xl:justify-end">
                      {/* Voice Call Button */}
                      <button
                        type="button"
                        disabled={isLoading}
                        onClick={() => handleTriggerCall(patient)}
                        className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-blue-700 hover:bg-blue-800 px-4 py-2 text-xs font-bold text-white shadow-xs active:scale-95 transition disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                        title="Initiate automated outbound Twilio voice reminder"
                      >
                        {isLoading ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            <span>{t('Calling...')}</span>
                          </>
                        ) : (
                          <>
                            <PhoneCall className="h-4 w-4" />
                            <span>📞 {t('Trigger Voice Call')}</span>
                          </>
                        )}
                      </button>

                      {/* Phase 5: SMS Overrides Column */}
                      <div className="flex flex-col gap-1.5 border-t sm:border-t-0 sm:border-l border-slate-200/80 pt-2 sm:pt-0 sm:pl-3">
                        <span className="text-[10px] font-black uppercase tracking-wider text-slate-500 flex items-center gap-1">
                          <MessageSquare className="h-3 w-3 text-blue-600" />
                          SMS Overrides (Live Demo)
                        </span>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {/* 1. Test Morning Meds SMS */}
                          <button
                            type="button"
                            disabled={Boolean(smsLoadingMap[`${visitId}-meds`])}
                            onClick={() => handleTriggerMedsSMS(patient)}
                            className="inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50/90 hover:bg-blue-100 px-2.5 py-1.5 text-[11px] font-bold text-blue-800 transition active:scale-95 disabled:opacity-50 cursor-pointer shadow-2xs"
                            title="Trigger instant morning medication reminder SMS"
                          >
                            {smsLoadingMap[`${visitId}-meds`] ? (
                              <Loader2 className="h-3 w-3 animate-spin text-blue-700" />
                            ) : (
                              <span>📱</span>
                            )}
                            <span>Test Morning Meds SMS</span>
                          </button>

                          {/* 2. Test Appt (1 Day) */}
                          <button
                            type="button"
                            disabled={Boolean(smsLoadingMap[`${visitId}-1_day_before`])}
                            onClick={() => handleTriggerApptSMS(patient, '1_day_before')}
                            className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50/90 hover:bg-emerald-100 px-2.5 py-1.5 text-[11px] font-bold text-emerald-800 transition active:scale-95 disabled:opacity-50 cursor-pointer shadow-2xs"
                            title="Trigger 1-day before appointment follow-up SMS"
                          >
                            {smsLoadingMap[`${visitId}-1_day_before`] ? (
                              <Loader2 className="h-3 w-3 animate-spin text-emerald-700" />
                            ) : (
                              <span>📅</span>
                            )}
                            <span>Test Appt (1 Day)</span>
                          </button>

                          {/* 3. Test Appt (10 Min) */}
                          <button
                            type="button"
                            disabled={Boolean(smsLoadingMap[`${visitId}-10_mins_before`])}
                            onClick={() => handleTriggerApptSMS(patient, '10_mins_before')}
                            className="inline-flex items-center gap-1 rounded-lg border border-purple-200 bg-purple-50/90 hover:bg-purple-100 px-2.5 py-1.5 text-[11px] font-bold text-purple-800 transition active:scale-95 disabled:opacity-50 cursor-pointer shadow-2xs"
                            title="Trigger 10-minutes before appointment follow-up SMS"
                          >
                            {smsLoadingMap[`${visitId}-10_mins_before`] ? (
                              <Loader2 className="h-3 w-3 animate-spin text-purple-700" />
                            ) : (
                              <span>⏳</span>
                            )}
                            <span>Test Appt (10 Min)</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </AnimatedCard>

        {/* Live Call Activity Log */}
        {callHistory.length > 0 && (
          <AnimatedCard className="rounded-2xl border border-slate-200/80 bg-white shadow-[0_8px_30px_-18px_rgba(15,23,42,0.18)] p-6">
            <h3 className="text-sm font-extrabold text-[#142D4E] mb-3 flex items-center gap-2">
              <Clock className="h-4 w-4 text-[#2563EB]" />
              {t('Session Call History & Generated Scripts')}
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500 font-bold uppercase tracking-wider text-[11px]">
                    <th className="py-2 px-3">Time</th>
                    <th className="py-2 px-3">Recipient</th>
                    <th className="py-2 px-3">Language</th>
                    <th className="py-2 px-3">Twilio SID (Voice / SMS)</th>
                    <th className="py-2 px-3">Generated Script</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {callHistory.map((item, idx) => (
                    <tr key={idx} className="hover:bg-slate-50/60">
                      <td className="py-2.5 px-3 font-semibold text-slate-600 whitespace-nowrap">
                        {item.timestamp}
                      </td>
                      <td className="py-2.5 px-3 font-bold text-slate-900 whitespace-nowrap">
                        {item.to}
                      </td>
                      <td className="py-2.5 px-3 font-bold text-[#2563EB] whitespace-nowrap">
                        {item.language}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600 whitespace-nowrap">
                        {item.callSid}
                      </td>
                      <td className="py-2.5 px-3 font-medium text-slate-800 max-w-md truncate" title={item.script}>
                        {item.script}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AnimatedCard>
        )}

        {/* Phase 5: Floating SMS & Call Feedback Toast */}
        {toast && (
          <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 rounded-2xl border border-slate-200 bg-white/95 backdrop-blur-md p-4 shadow-xl text-xs font-bold transition-all">
            <span
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-white ${
                toast.type === 'error' ? 'bg-rose-600' : 'bg-emerald-600'
              }`}
            >
              {toast.type === 'error' ? (
                <AlertCircle className="h-4 w-4" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
            </span>
            <div className="max-w-xs space-y-0.5">
              <p className="font-black text-slate-900">{toast.title || 'Notification'}</p>
              <p className="text-slate-600 text-[11px] line-clamp-2">{toast.message}</p>
            </div>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="text-slate-400 hover:text-slate-600 p-1 rounded-lg cursor-pointer transition"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

