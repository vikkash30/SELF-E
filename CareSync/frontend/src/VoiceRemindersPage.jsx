import { PhoneCall } from 'lucide-react';
import VoiceReminderPanel from './components/VoiceReminderPanel.jsx';

export default function VoiceRemindersPage() {
  return (
    <div className="min-h-screen bg-slate-50 pb-12">
      <header className="sticky top-0 z-20 border-b border-teal-800/20 bg-teal-700 text-white shadow-sm">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15">
              <PhoneCall className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">
                CareSync Tamil Voice Reminder Dashboard
              </h1>
              <p className="text-xs text-teal-100">
                Twilio Google TTS Follow-Up Portal • Route: <code>/reminders</code>
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pt-6">
        <VoiceReminderPanel />
      </main>
    </div>
  );
}

