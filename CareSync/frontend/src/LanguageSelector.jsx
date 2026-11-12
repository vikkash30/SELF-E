import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Globe2,
  HeartPulse,
  PhoneCall,
  ShieldCheck,
  Stethoscope,
  UserCheck,
} from 'lucide-react';
import { LANGUAGE_LABELS } from './i18n.js';

const LANGUAGES = [
  {
    code: 'en',
    name: 'English',
    nativeName: 'English',
    region: 'Universal / India',
    desc: 'Standard clinical interface and international guidance',
  },
  {
    code: 'hi',
    name: 'Hindi',
    nativeName: 'हिन्दी',
    region: 'North & Central India',
    desc: 'राष्ट्रीय भाषा में संपूर्ण स्वास्थ्य निर्देश एवं योजनाएं',
  },
  {
    code: 'ta',
    name: 'Tamil',
    nativeName: 'தமிழ்',
    region: 'Tamil Nadu & Puducherry',
    desc: 'ஆரம்ப சுகாதார நிலைய வழிகாட்டுதல் மற்றும் மருத்துவ நினைவூட்டல்',
  },
  {
    code: 'te',
    name: 'Telugu',
    nativeName: 'తెలుగు',
    region: 'Andhra Pradesh & Telangana',
    desc: 'గ్రామీణ ఆరోగ్య స్క్రీనింగ్ మరియు ప్రభుత్వ సంక్షేమ పథకాలు',
  },
];

export default function LanguageSelector() {
  const { i18n, t } = useTranslation();
  const navigate = useNavigate();

  const [selectedLang, setSelectedLang] = useState(
    localStorage.getItem('app_lang') || i18n.language || 'en'
  );

  function handleSelectLanguage(code) {
    setSelectedLang(code);
    localStorage.setItem('app_lang', code);
    i18n.changeLanguage(code);
  }

  function handleProceed(targetRoute = '/operator') {
    localStorage.setItem('app_lang', selectedLang);
    i18n.changeLanguage(selectedLang);
    navigate(targetRoute);
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-[#EFF6FF] via-[#F8FAFC] to-[#F1F5F9] text-[#142D4E] flex flex-col justify-between">
      {/* Background soft ambient orbs */}
      <div className="pointer-events-none absolute -top-32 -left-32 h-96 w-96 rounded-full bg-blue-200/40 blur-3xl" />
      <div className="pointer-events-none absolute top-1/3 -right-32 h-96 w-96 rounded-full bg-teal-200/30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 left-1/4 h-96 w-96 rounded-full bg-indigo-200/30 blur-3xl" />

      {/* Top Header Bar */}
      <header className="relative z-10 border-b border-slate-200/60 bg-white/70 backdrop-blur-md px-6 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-[#2563EB] to-[#1D4ED8] text-white shadow-md shadow-blue-500/20">
              <HeartPulse className="h-6 w-6 stroke-[2.2]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-black tracking-tight text-[#142D4E]">
                  CareSync
                </span>
                <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-[11px] font-extrabold text-[#2563EB]">
                  MediCare+
                </span>
              </div>
              <p className="text-xs font-medium text-slate-500">
                Offline-First Clinical Triage &amp; Telehealth Kiosk
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
              National Health Mission Compliant
            </span>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="relative z-10 mx-auto max-w-5xl px-6 py-10 w-full space-y-10">
        {/* Welcome Hero */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="text-center space-y-3"
        >
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white/80 px-4 py-1.5 text-xs font-bold text-[#2563EB] shadow-xs">
            <Globe2 className="h-4 w-4" />
            <span>Select Your Preferred Clinical Language • மொழி தேர்வு</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-black text-[#142D4E] tracking-tight leading-tight">
            Welcome to <span className="text-[#2563EB]">CareSync MediCare+</span>
          </h1>
          <p className="mx-auto max-w-2xl text-sm sm:text-base text-slate-600 leading-relaxed font-medium">
            Empowering rural ration-shop operators and village health workers with AI triage, IoT sensor telemetry, telemedicine escalation, and pictorial talking prescriptions.
          </p>
        </motion.div>

        {/* 4 Language Cards */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
        >
          {LANGUAGES.map((lang) => {
            const isSelected = selectedLang === lang.code;
            return (
              <button
                key={lang.code}
                type="button"
                onClick={() => handleSelectLanguage(lang.code)}
                className={`relative flex flex-col justify-between text-left rounded-2xl p-5 transition-all duration-200 border-2 ${
                  isSelected
                    ? 'border-[#2563EB] bg-white shadow-lg shadow-blue-500/10 ring-4 ring-blue-500/10 translate-y-[-2px]'
                    : 'border-slate-200/90 bg-white/80 hover:bg-white hover:border-blue-300 hover:shadow-md'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-extrabold uppercase tracking-wider text-slate-400">
                      {lang.name}
                    </span>
                    {isSelected && (
                      <CheckCircle2 className="h-5 w-5 text-[#2563EB]" />
                    )}
                  </div>
                  <h3 className="text-2xl font-black text-[#142D4E] tracking-tight">
                    {lang.nativeName}
                  </h3>
                  <p className="mt-1 text-xs font-semibold text-[#2563EB]">
                    {lang.region}
                  </p>
                  <p className="mt-2 text-xs text-slate-500 leading-relaxed">
                    {lang.desc}
                  </p>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs font-bold text-slate-700">
                  <span>{isSelected ? 'Selected' : 'Click to Select'}</span>
                  <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
                </div>
              </button>
            );
          })}
        </motion.div>

        {/* Primary Proceed CTA Button */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
          className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-2"
        >
          <button
            type="button"
            onClick={() => handleProceed('/operator')}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-3 rounded-2xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white px-8 py-4 text-base font-extrabold shadow-lg shadow-blue-600/25 transition-all active:scale-[0.99]"
          >
            <Stethoscope className="h-5 w-5" />
            <span>Launch Operator Intake Terminal</span>
            <ArrowRight className="h-5 w-5" />
          </button>
        </motion.div>

        {/* Portal Shortcuts Grid */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.3 }}
          className="rounded-2xl border border-slate-200/80 bg-white/70 p-5 backdrop-blur-xs space-y-3"
        >
          <div className="flex items-center justify-between border-b border-slate-100 pb-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Direct Portal Access (Role-Based Workspaces)
            </h4>
            <span className="text-xs text-slate-400">CareSync Multi-Portal</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <button
              type="button"
              onClick={() => handleProceed('/operator')}
              className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5 text-left hover:border-blue-400 hover:shadow-xs transition"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-[#2563EB]">
                <Stethoscope className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-bold text-[#142D4E]">Operator Desk</p>
                <p className="text-xs text-slate-500">Intake, Triage &amp; Telehealth</p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => handleProceed('/doctor')}
              className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5 text-left hover:border-blue-400 hover:shadow-xs transition"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                <UserCheck className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-bold text-[#142D4E]">Doctor Portal</p>
                <p className="text-xs text-slate-500">Video Consult &amp; Prescription</p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => handleProceed('/iot')}
              className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5 text-left hover:border-blue-400 hover:shadow-xs transition"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700">
                <Cpu className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-bold text-[#142D4E]">IoT Simulator</p>
                <p className="text-xs text-slate-500">Hardware Sensor Telemetry</p>
              </div>
            </button>
          </div>
        </motion.div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-slate-200/60 bg-white/60 py-4 text-center text-xs text-slate-500">
        <p>
          CareSync MediCare+ • Developed for Rural Health Disparity Elimination • AI-Driven Clinical Triaging
        </p>
      </footer>
    </div>
  );
}

