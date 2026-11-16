import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Calendar,
  Moon,
  Pill,
  Sun,
  Utensils,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { BCP47_LANGUAGE_TAGS, LANGUAGE_LABELS } from '../i18n.js';

export default function PictorialPrescriptionCard({
  prescription,
  allPrescriptions = [],
  medicineIndex = 1,
  totalMedicines = 1,
  isActiveAudio = false,
  isAudioPlaying = false,
  onPlayAudio,
}) {
  const { t, i18n } = useTranslation();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentLang, setCurrentLang] = useState(
    typeof window !== 'undefined'
      ? localStorage.getItem('app_lang') || i18n.language || 'en'
      : 'en'
  );

  useEffect(() => {
    const handleStorage = (e) => {
      if (e.key === 'app_lang') {
        setCurrentLang(e.newValue || 'en');
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  if (!prescription) return null;

  const medicineName =
    prescription.medicine_name || prescription.medicineName || 'Prescribed Medication';
  const dosage = prescription.dosage || '1 Tablet';
  const foodContext =
    prescription.food_context || prescription.foodContext || 'After Food';
  const duration = prescription.duration || '5 Days';

  // Parse multi-select timing array or string
  const timingRaw = prescription.timing;
  const timingList = Array.isArray(timingRaw)
    ? timingRaw
    : typeof timingRaw === 'string'
      ? timingRaw.split(/[,&]+/).map((s) => s.trim())
      : [];

  const hasMorning = timingList.some((tVal) => String(tVal).toLowerCase().includes('morning'));
  const hasLunch = timingList.some(
    (tVal) => String(tVal).toLowerCase().includes('lunch') || String(tVal).toLowerCase().includes('noon')
  );
  const hasNight = timingList.some((tVal) => String(tVal).toLowerCase().includes('night'));

  const isAfterFood =
    foodContext.toLowerCase().includes('after') || foodContext === 'After Food';

  // Audio Logic: Loop through the entire prescriptions array and speak all in one continuous utterance
  function playPrescriptionAudio() {
    if (onPlayAudio) {
      onPlayAudio();
      return;
    }

    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      alert('Browser speech synthesis is not supported in this browser.');
      return;
    }

    if (isPlaying) {
      window.speechSynthesis.cancel();
      setIsPlaying(false);
      return;
    }

    const rawLang =
      localStorage.getItem('app_lang') || i18n.language || currentLang || 'en';
    const langKey = ['en', 'hi', 'ta', 'te'].includes(rawLang) ? rawLang : 'en';
    const bcp47 = BCP47_LANGUAGE_TAGS[langKey] || 'en-IN';

    const listToSpeak =
      allPrescriptions && allPrescriptions.length > 0
        ? allPrescriptions
        : [prescription];

    const sentenceList = [];

    listToSpeak.forEach((med, idx) => {
      const name = med.medicine_name || med.medicineName || `Medicine #${idx + 1}`;
      const dos = med.dosage || '1 Tablet';
      const food = med.food_context || med.foodContext || 'After Food';
      const dur = med.duration || '5 Days';

      const tRaw = med.timing;
      const tList = Array.isArray(tRaw)
        ? tRaw
        : typeof tRaw === 'string'
          ? tRaw.split(/[,&]+/).map((s) => s.trim())
          : ['Morning'];

      const timingJoinEn = tList.join(' and ');
      const timingJoinHi = tList.map((tm) => t(tm)).join(' और ');
      const timingJoinTa = tList.map((tm) => t(tm)).join(' மற்றும் ');
      const timingJoinTe = tList.map((tm) => t(tm)).join(' మరియు ');

      if (langKey === 'hi') {
        sentenceList.push(
          `दवा ${idx + 1}: ${t(food)}, ${timingJoinHi}, ${name} की ${t(dos)}, ${t(dur)} लें।`
        );
      } else if (langKey === 'ta') {
        sentenceList.push(
          `மருந்து ${idx + 1}: ${t(food)}, ${timingJoinTa}, ${name} ${t(dos)}, ${t(dur)} எடுத்துக்கொள்ளவும்.`
        );
      } else if (langKey === 'te') {
        sentenceList.push(
          `మందు ${idx + 1}: ${t(food)}, ${timingJoinTe}, ${name} ${t(dos)}, ${t(dur)} తీసుకోండి.`
        );
      } else {
        sentenceList.push(
          `Medicine ${idx + 1}: Take ${dos} of ${name} in the ${timingJoinEn.toLowerCase()}, ${food.toLowerCase()}, for ${dur}.`
        );
      }
    });

    // Add final doctor consultation safety advice
    let safetyNotice = '';
    if (langKey === 'hi') {
      safetyNotice = ' डॉक्टर से पूछे बिना दवा बंद न करें।';
    } else if (langKey === 'ta') {
      safetyNotice = ' மருத்துவரின் ஆலோசனை இல்லாமல் மருந்தை நிறுத்த வேண்டாம்.';
    } else if (langKey === 'te') {
      safetyNotice = ' డాక్టర్ సలహా లేకుండా మందులు ఆపవద్దు.';
    } else {
      safetyNotice = ' Do not stop medication without asking doctor.';
    }

    const fullSpeechText = sentenceList.join(' ') + safetyNotice;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(fullSpeechText);
    utterance.lang = bcp47;
    utterance.rate = 0.88;

    utterance.onstart = () => setIsPlaying(true);
    utterance.onend = () => setIsPlaying(false);
    utterance.onerror = () => setIsPlaying(false);

    window.speechSynthesis.speak(utterance);
  }

  const activeLangKey = ['en', 'hi', 'ta', 'te'].includes(currentLang)
    ? currentLang
    : 'en';
  const activeLangLabel = LANGUAGE_LABELS[activeLangKey] || 'English';

  return (
    <div className="overflow-hidden rounded-2xl border-2 border-teal-500 bg-white shadow-xl transition-all">
      {/* Card Header with Prominent Custom Typed Medicine Name */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-gradient-to-r from-teal-700 to-emerald-700 px-5 py-4 text-white">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/20 text-white shadow-xs">
            <Pill className="h-6 w-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-teal-200">
                {t('Pictorial Prescription')}
              </span>
              {totalMedicines > 1 && (
                <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-[11px] font-black text-white">
                  Drug {medicineIndex} of {totalMedicines}
                </span>
              )}
              <span className="rounded-full bg-emerald-400/25 px-2 py-0.5 text-[11px] font-extrabold text-emerald-100 ring-1 ring-emerald-300/40">
                Doctor Verified
              </span>
            </div>
            {/* Prominently Displayed Custom Typed Medicine Name */}
            <h3 className="text-xl font-black text-white tracking-tight">{medicineName}</h3>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-black/25 px-3 py-1 font-mono text-xs font-bold text-teal-100">
            {activeLangLabel} ({BCP47_LANGUAGE_TAGS[activeLangKey]})
          </span>
        </div>
      </div>

      <div className="space-y-5 p-5">
        {/* Large Visual Pictogram Grid (Morning Sun, Lunch Sun/Clock, Night Moon, Food, Duration) */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {/* Morning Timing (Sun Icon) */}
          {hasMorning && (
            <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-amber-300 bg-amber-50/80 p-4 text-center shadow-xs">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500 text-white shadow-md">
                <Sun className="h-8 w-8 stroke-[2.5]" />
              </div>
              <p className="mt-2 text-xs font-bold uppercase tracking-wide text-amber-800">
                {t('Morning')}
              </p>
              <p className="mt-0.5 text-base font-extrabold text-amber-950">
                {t(dosage)}
              </p>
            </div>
          )}

          {/* Lunch Timing (Sun / Noon Icon) */}
          {hasLunch && (
            <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-orange-300 bg-orange-50/80 p-4 text-center shadow-xs">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-orange-500 text-white shadow-md">
                <Sun className="h-8 w-8 stroke-[2.5]" />
              </div>
              <p className="mt-2 text-xs font-bold uppercase tracking-wide text-orange-800">
                {t('Lunch')}
              </p>
              <p className="mt-0.5 text-base font-extrabold text-orange-950">
                {t(dosage)}
              </p>
            </div>
          )}

          {/* Night Timing (Moon Icon) */}
          {hasNight && (
            <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-indigo-300 bg-indigo-50/80 p-4 text-center shadow-xs">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-md">
                <Moon className="h-8 w-8 stroke-[2.5]" />
              </div>
              <p className="mt-2 text-xs font-bold uppercase tracking-wide text-indigo-800">
                {t('Night')}
              </p>
              <p className="mt-0.5 text-base font-extrabold text-indigo-950">
                {t(dosage)}
              </p>
            </div>
          )}

          {/* Food Context (Utensils Icon) */}
          <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-emerald-300 bg-emerald-50/80 p-4 text-center shadow-xs">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow-md">
              <Utensils className="h-8 w-8 stroke-[2.5]" />
            </div>
            <p className="mt-2 text-xs font-bold uppercase tracking-wide text-emerald-800">
              {isAfterFood ? 'Full Plate' : 'Plate'}
            </p>
            <p className="mt-0.5 text-base font-extrabold text-emerald-950">
              {t(foodContext)}
            </p>
          </div>

          {/* Duration (Calendar Icon) */}
          <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-sky-300 bg-sky-50/80 p-4 text-center shadow-xs">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-600 text-white shadow-md">
              <Calendar className="h-8 w-8 stroke-[2.5]" />
            </div>
            <p className="mt-2 text-xs font-bold uppercase tracking-wide text-sky-800">
              {t('Duration')}
            </p>
            <p className="mt-0.5 text-base font-extrabold text-sky-950">
              {t(duration)}
            </p>
          </div>
        </div>

        {/* Safety Warning Banner */}
        <div className="flex items-center gap-3 rounded-2xl border-2 border-rose-300 bg-rose-50 px-4 py-3 text-rose-950 shadow-xs">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-600 text-white">
            <AlertTriangle className="h-6 w-6 stroke-[2.5]" />
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-rose-700">
              Important Safety Instruction
            </p>
            <p className="text-sm font-black text-rose-950">
              {t('Do not stop without asking doctor')}
            </p>
          </div>
        </div>

        {/* Multilingual Continuous Speech TTS Audio Button */}
        <div className="pt-1">
          <button
            type="button"
            onClick={playPrescriptionAudio}
            className={`flex w-full items-center justify-center gap-3 rounded-2xl px-6 py-4 text-base font-black shadow-lg transition-all active:scale-[0.98] ${
              isActiveAudio
                ? 'bg-amber-500 text-white hover:bg-amber-600 ring-4 ring-amber-300 animate-pulse'
                : isAudioPlaying || isPlaying
                ? 'bg-rose-600 text-white hover:bg-rose-700 ring-4 ring-rose-200'
                : 'bg-gradient-to-r from-emerald-600 via-teal-600 to-teal-700 text-white hover:from-emerald-700 hover:to-teal-800 shadow-teal-700/25'
            }`}
          >
            {isActiveAudio ? (
              <>
                <Volume2 className="h-6 w-6 animate-bounce" />
                <span>🎙️ Reading Medicine #{medicineIndex} (Karaoke)...</span>
              </>
            ) : isAudioPlaying || isPlaying ? (
              <>
                <VolumeX className="h-6 w-6" />
                <span>{t('Stop Audio')}</span>
              </>
            ) : (
              <>
                <Volume2 className="h-6 w-6" />
                <span>
                  🔊 {allPrescriptions.length > 1 ? t('Play All Prescribed Medicines Audio') : t('Play Audio Instructions')}
                </span>
                <span className="rounded-full bg-white/20 px-3 py-0.5 text-xs font-bold">
                  {activeLangLabel}
                </span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
