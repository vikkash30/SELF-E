import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  Globe,
  HeartPulse,
  Sparkles,
  Stethoscope,
} from 'lucide-react';

const LANGUAGE_CARDS = [
  {
    code: 'en',
    title: 'English',
    nativeLabel: 'English',
    region: 'National / Standard',
    tagline: 'Standard clinical screening, triage & welfare programs',
    accent: 'from-blue-600 to-indigo-700',
    hoverBorder: 'hover:border-blue-500',
    bgBadge: 'bg-blue-50 text-blue-700 border-blue-200',
  },
  {
    code: 'hi',
    title: 'हिंदी (Hindi)',
    nativeLabel: 'हिंदी',
    region: 'उत्तर एवं मध्य भारत',
    tagline: 'प्राथमिक स्वास्थ्य जांच, ट्रायज एवं सरकारी स्वास्थ्य योजनाएं',
    accent: 'from-emerald-600 to-teal-700',
    hoverBorder: 'hover:border-emerald-500',
    bgBadge: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  },
  {
    code: 'ta',
    title: 'தமிழ் (Tamil)',
    nativeLabel: 'தமிழ்',
    region: 'தமிழ்நாடு & புதுச்சேரி',
    tagline: 'ஆரம்ப சுகாதாரப் பரிசோதனை, மருத்துவ மதிப்பீடு & குரல் நினைவூட்டல்',
    accent: 'from-teal-600 to-blue-700',
    hoverBorder: 'hover:border-teal-500',
    bgBadge: 'bg-teal-50 text-teal-800 border-teal-200',
  },
  {
    code: 'te',
    title: 'తెలుగు (Telugu)',
    nativeLabel: 'తెలుగు',
    region: 'ఆంధ్రప్రదేశ్ & తెలంగాణ',
    tagline: 'గ్రామీణ క్లినికల్ స్క్రీనింగ్, ట్రయాజ్ మరియు ప్రభుత్వ ఆరోగ్య పథకాలు',
    accent: 'from-indigo-600 to-blue-800',
    hoverBorder: 'hover:border-indigo-500',
    bgBadge: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  },
];

export default function LanguageSelection() {
  const { i18n } = useTranslation();
  const navigate = useNavigate();

  function handleSelectLanguage(langCode) {
    i18n.changeLanguage(langCode);
    localStorage.setItem('careSyncLang', langCode);
    localStorage.setItem('app_lang', langCode);
    navigate('/operator');
  }

  return (
    <div className="relative min-h-screen bg-[#F6F9F8] text-[#142D4E] flex flex-col justify-between antialiased overflow-hidden selection:bg-blue-100 selection:text-blue-900">
      {/* Calm ambient background blurs */}
      <div className="pointer-events-none absolute -top-32 -left-32 h-96 w-96 rounded-full bg-blue-200/40 blur-3xl" />
      <div className="pointer-events-none absolute top-1/2 -right-32 h-96 w-96 rounded-full bg-teal-200/30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 left-1/3 h-96 w-96 rounded-full bg-indigo-200/30 blur-3xl" />

      {/* Top Header Bar */}
      <header className="relative z-10 border-b border-slate-200/80 bg-white/80 backdrop-blur-md px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-[#2563EB] to-[#1D4ED8] text-white shadow-md shadow-blue-500/20">
              <HeartPulse className="h-6 w-6 stroke-[2.2]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xl font-black tracking-tight text-[#142D4E]">
                  CareSync
                </span>
                <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-black text-[#2563EB]">
                  MediCare+
                </span>
              </div>
              <p className="text-xs font-semibold text-slate-500">
                Rural Healthcare Kiosk &bull; Clinical Triage &bull; Telehealth
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs font-bold text-slate-600">
            <span className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>Kiosk Terminal Active</span>
          </div>
        </div>
      </header>

      {/* Main Language Gateway Viewport */}
      <main className="relative z-10 mx-auto w-full max-w-5xl px-6 py-10 sm:py-14 flex-1 flex flex-col justify-center">
        {/* Title Area */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="text-center space-y-4 max-w-3xl mx-auto mb-10 sm:mb-12"
        >
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-[#EFF6FF] px-4 py-1.5 text-xs font-extrabold text-[#2563EB] shadow-xs">
            <Globe className="h-4 w-4" />
            <span>Multilingual Healthcare Gateway</span>
          </div>

          <h1 className="text-2xl sm:text-3xl lg:text-4xl font-black text-[#142D4E] tracking-tight leading-snug">
            Choose Your Language / மொழியைத் தேர்ந்தெடுக்கவும் / भाषा चुनें / భాషను ఎంచుకోండి
          </h1>

          <p className="text-sm sm:text-base font-semibold text-slate-600 max-w-2xl mx-auto leading-relaxed">
            Please select your preferred language to proceed to the clinical triage and patient screening desk.
          </p>
        </motion.div>

        {/* 4 Large Visually Appealing Language Buttons */}
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {LANGUAGE_CARDS.map((lang, idx) => (
            <motion.button
              key={lang.code}
              type="button"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: idx * 0.08 }}
              whileHover={{ y: -4, transition: { duration: 0.2 } }}
              whileTap={{ scale: 0.98 }}
              onClick={() => handleSelectLanguage(lang.code)}
              className={`group relative flex flex-col justify-between rounded-3xl border-2 border-slate-200 bg-white p-6 sm:p-7 text-left shadow-sm transition-all duration-200 cursor-pointer ${lang.hoverBorder} hover:shadow-xl hover:shadow-blue-500/10 focus:outline-none focus:ring-4 focus:ring-blue-500/20`}
            >
              {/* Top Row: Region Badge & Selection Arrow */}
              <div>
                <div className="flex items-center justify-between gap-2 mb-4">
                  <span
                    className={`rounded-xl border px-3 py-1 font-mono text-[11px] font-bold ${lang.bgBadge}`}
                  >
                    {lang.region}
                  </span>
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-slate-500 transition-colors group-hover:bg-[#2563EB] group-hover:text-white">
                    <ArrowRight className="h-4 w-4 stroke-[2.5] transition-transform group-hover:translate-x-0.5" />
                  </div>
                </div>

                {/* Primary Native Language Heading */}
                <h2 className="text-2xl sm:text-3xl font-black text-[#142D4E] tracking-tight group-hover:text-[#2563EB] transition-colors">
                  {lang.nativeLabel}
                </h2>

                <p className="text-xs font-extrabold uppercase tracking-wider text-slate-600 mt-1">
                  {lang.title}
                </p>

                {/* Tagline */}
                <p className="mt-3.5 text-xs font-semibold leading-relaxed text-slate-600">
                  {lang.tagline}
                </p>
              </div>

              {/* Bottom Quick-Action Indicator */}
              <div className="mt-6 pt-4 border-t border-slate-100 flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500 group-hover:text-slate-800">
                  Select &amp; Launch
                </span>
                <span className="inline-flex items-center gap-1 text-xs font-black text-[#2563EB] opacity-0 transition-opacity group-hover:opacity-100">
                  <span>Enter</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </span>
              </div>
            </motion.button>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-slate-200/80 bg-white/70 backdrop-blur-md px-6 py-4 text-center">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 text-xs font-semibold text-slate-500">
          <p>
            CareSync Rural Kiosk &bull; Powered by NVIDIA Llama 3.1 &amp; Twilio Voice
          </p>
          <div className="flex items-center gap-4">
            <span>Offline-First (IndexedDB + SQLite)</span>
            <span>&bull;</span>
            <span>National Health Portal</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

