import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Link2,
  PhoneCall,
  RefreshCw,
  Volume2,
  XCircle,
} from 'lucide-react';
import { API_BASE_URL } from '../syncManager.js';

export const TAMIL_REMINDER_TEMPLATES = {
  pill: 'வணக்கம், இது CareSync மருத்துவ நினைவூட்டல். தயவுசெய்து உணவுக்குப் பிறகு உங்கள் காலை மாத்திரையை எடுத்துக்கொள்ளவும். நன்றி.',
  phc: 'வணக்கம், நாளை காலை 9 மணிக்கு ஆரம்ப சுகாதார நிலையத்தில் உங்கள் மருத்துவ பரிசோதனை உள்ளது. தயவுசெய்து தவறாமல் வரவும்.',
  asha: 'வணக்கம், உங்கள் ரத்த அழுத்தம் மற்றும் சர்க்கரை அளவை பரிசோதிக்க இன்று ASHA பணியாளர் வருகை தருவார்.',
  night: 'வணக்கம், இரவு உணவிற்குப் பின் உங்கள் இரவு மாத்திரையை எடுத்துக்கொள்ள மறக்காதீர்கள். நல்ல ஆரோக்கியம் பெற வாழ்த்துகள்.',
  custom: '',
};

const TAMIL_VOICES = [
  { value: 'Google.ta-IN-Standard-A', label: 'Google.ta-IN-Standard-A (Female)' },
  { value: 'Google.ta-IN-Standard-B', label: 'Google.ta-IN-Standard-B (Male)' },
  { value: 'Google.ta-IN-Wavenet-A', label: 'Google.ta-IN-Wavenet-A (Natural)' },
];

export default function VoiceReminderPanel({
  suggestedPatientName = '',
  suggestedMessage = '',
  suggestedTemplate = 'pill',
}) {
  const [statusInfo, setStatusInfo] = useState(null);
  const [reminders, setReminders] = useState([]);
  const [templateKey, setTemplateKey] = useState(suggestedTemplate);
  const [patientName, setPatientName] = useState(suggestedPatientName || 'Patient');
  const [toPhone, setToPhone] = useState('+919994577702');
  const [voice, setVoice] = useState('Google.ta-IN-Standard-A');
  const [messageTa, setMessageTa] = useState(
    suggestedMessage || TAMIL_REMINDER_TEMPLATES[suggestedTemplate] || TAMIL_REMINDER_TEMPLATES.pill
  );

  const [isCalling, setIsCalling] = useState(false);
  const [callFeedback, setCallFeedback] = useState(null);
  const [showTunnelEditor, setShowTunnelEditor] = useState(false);
  const [manualTunnelUrl, setManualTunnelUrl] = useState('');
  const [checkingSid, setCheckingSid] = useState('');

  // Sync incoming triage/patient suggestions when operator selects a patient or clicks shortcut
  useEffect(() => {
    if (suggestedPatientName && suggestedPatientName.trim()) {
      setPatientName(suggestedPatientName.trim());
    }
  }, [suggestedPatientName]);

  useEffect(() => {
    if (suggestedMessage && suggestedMessage.trim()) {
      setTemplateKey('custom');
      setMessageTa(suggestedMessage.trim());
    }
  }, [suggestedMessage]);

  async function fetchStatus() {
    try {
      const res = await fetch(`${API_BASE_URL}/reminders/status`);
      if (!res.ok) return;
      const data = await res.json();
      setStatusInfo(data);
      if (data.default_to_number) {
        setToPhone((prev) => (prev === '+919994577702' ? data.default_to_number : prev));
      }
      if (data.tunnel_ready && data.public_tunnel_url) {
        setManualTunnelUrl(data.public_tunnel_url);
      }
    } catch {
      // Backend may be offline
    }
  }

  async function fetchReminders() {
    try {
      const res = await fetch(`${API_BASE_URL}/reminders`);
      if (!res.ok) return;
      const data = await res.json();
      setReminders(Array.isArray(data) ? data : data.reminders || []);
    } catch {
      // Backend may be offline
    }
  }

  useEffect(() => {
    fetchStatus();
    fetchReminders();
    const statusTimer = setInterval(fetchStatus, 5000);
    const listTimer = setInterval(fetchReminders, 8000);
    return () => {
      clearInterval(statusTimer);
      clearInterval(listTimer);
    };
  }, []);

  function handleTemplateChange(nextKey) {
    setTemplateKey(nextKey);
    if (nextKey !== 'custom' && TAMIL_REMINDER_TEMPLATES[nextKey]) {
      setMessageTa(TAMIL_REMINDER_TEMPLATES[nextKey]);
    }
  }

  function handlePreviewAudio() {
    const text = messageTa.trim();
    if (!text || typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'ta-IN';
    window.speechSynthesis.speak(utter);
  }

  async function handleSaveTunnelUrl(e) {
    e.preventDefault();
    if (!manualTunnelUrl.trim()) return;
    try {
      const res = await fetch(`${API_BASE_URL}/reminders/tunnel-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_tunnel_url: manualTunnelUrl.trim() }),
      });
      if (res.ok) {
        setShowTunnelEditor(false);
        await fetchStatus();
      }
    } catch {
      // Ignore network errors
    }
  }

  async function handleMakeCall() {
    if (!toPhone.trim() || !messageTa.trim()) {
      setCallFeedback({
        ok: false,
        message: 'Please enter both phone number and Tamil message.',
      });
      return;
    }

    setIsCalling(true);
    setCallFeedback(null);

    try {
      const res = await fetch(`${API_BASE_URL}/reminders/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to_phone: toPhone.trim(),
          message_ta: messageTa.trim(),
          patient_name: patientName.trim() || 'Patient',
          voice,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.ok) {
        const errorDetail =
          data?.detail ||
          data?.error_detail ||
          data?.message ||
          (typeof data === 'string' ? data : `HTTP ${res.status}: Call request failed.`);
        const customError = new Error(errorDetail);
        customError.response = { data, status: res.status };
        throw customError;
      }

      setCallFeedback({
        ok: true,
        message: data.message || `Call placed successfully (SID: ${data.call_sid}).`,
        call_sid: data.call_sid,
      });
      await fetchReminders();
    } catch (error) {
      console.error("Call Trigger Error:", error);
      const errorMessage =
        error.response?.data?.detail ||
        error.response?.data?.error_detail ||
        error.response?.data?.message ||
        error.message ||
        'Call failed.';
      setCallFeedback({
        ok: false,
        message: errorMessage,
      });
    } finally {
      setIsCalling(false);
    }
  }

  async function handleCheckCallStatus(callSid) {
    if (!callSid) return;
    setCheckingSid(callSid);
    try {
      await fetch(`${API_BASE_URL}/reminders/call-status/${encodeURIComponent(callSid)}`);
      await fetchReminders();
    } catch {
      // Ignore errors
    } finally {
      setCheckingSid('');
    }
  }

  const tunnelReady = Boolean(statusInfo?.tunnel_ready);

  return (
    <div className="space-y-5">
      {/* Twilio & Public Tunnel Status Strip */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-700 text-white">
              <PhoneCall className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                Tamil Voice Reminder Engine (Twilio Trial-Compliant)
              </h3>
              <p className="text-xs text-slate-500">
                Google ta-IN TTS via <code>/twiml</code> &amp; SQLite Call Persistence
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span
              className={`rounded-full border px-2.5 py-0.5 font-semibold ${
                tunnelReady
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                  : 'border-amber-300 bg-amber-50 text-amber-800'
              }`}
            >
              {tunnelReady ? 'Tunnel Online' : 'Tunnel Pending'}
            </span>
            <button
              type="button"
              onClick={() => setShowTunnelEditor((v) => !v)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 font-semibold text-slate-700 hover:bg-slate-100"
            >
              <Link2 className="h-3.5 w-3.5" />
              Set URL
            </button>
            <button
              type="button"
              onClick={() => {
                fetchStatus();
                fetchReminders();
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 font-semibold text-slate-700 hover:bg-slate-100"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
        </div>

        {showTunnelEditor && (
          <form
            onSubmit={handleSaveTunnelUrl}
            className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-teal-200 bg-teal-50/70 p-2.5 text-xs"
          >
            <input
              type="url"
              value={manualTunnelUrl}
              onChange={(e) => setManualTunnelUrl(e.target.value)}
              placeholder="https://your-subdomain.trycloudflare.com"
              className="min-w-[240px] flex-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-teal-600 focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-lg bg-teal-700 px-3 py-1.5 font-bold text-white hover:bg-teal-800"
            >
              Save Tunnel URL
            </button>
          </form>
        )}

        <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-4">
          <div>
            <p className="font-semibold uppercase text-slate-400">Twilio Account SID</p>
            <p className="mt-0.5 font-mono font-bold text-slate-800">
              {statusInfo?.account_sid_masked || 'Loading...'}
            </p>
          </div>
          <div>
            <p className="font-semibold uppercase text-slate-400">From Number</p>
            <p className="mt-0.5 font-mono font-bold text-slate-800">
              {statusInfo?.from_number || '+17372508034'}
            </p>
          </div>
          <div>
            <p className="font-semibold uppercase text-slate-400">Verified To Number</p>
            <p className="mt-0.5 font-mono font-bold text-emerald-700">
              {statusInfo?.default_to_number || '+919994577702'}
            </p>
          </div>
          <div>
            <p className="font-semibold uppercase text-slate-400">Public TwiML URL</p>
            <p
              className="mt-0.5 truncate font-mono text-slate-700"
              title={statusInfo?.public_tunnel_url || ''}
            >
              {statusInfo?.public_tunnel_url || 'Detecting...'}
            </p>
          </div>
        </div>
      </div>

      {/* Main Composer & History Grid */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Call Composer */}
        <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs lg:col-span-5">
          <h4 className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <PhoneCall className="h-4 w-4 text-teal-700" />
            Place Outbound Voice Call
          </h4>

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">
              Select Tamil Template
            </label>
            <select
              value={templateKey}
              onChange={(e) => handleTemplateChange(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white p-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
            >
              <option value="pill">காலை மருந்து நினைவூட்டல் (Morning Pill)</option>
              <option value="phc">PHC மருத்துவமனை சந்திப்பு (Hospital Visit)</option>
              <option value="asha">ASHA பணியாளர் வருகை (BP / Sugar Check)</option>
              <option value="night">இரவு மருந்து நினைவூட்டல் (Night Pill)</option>
              <option value="custom">தனிப்பயன் செய்தி (Custom Text)</option>
            </select>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                Recipient Name
              </label>
              <input
                type="text"
                value={patientName}
                onChange={(e) => setPatientName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 p-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                Phone Number (E.164)
              </label>
              <input
                type="text"
                value={toPhone}
                onChange={(e) => setToPhone(e.target.value)}
                className="w-full rounded-lg border border-slate-300 p-2 font-mono text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">
              Twilio Google Tamil Voice
            </label>
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white p-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
            >
              {TAMIL_VOICES.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="block text-xs font-semibold text-slate-700">
                Tamil Voice Text (தமிழ் உரை)
              </label>
              <button
                type="button"
                onClick={handlePreviewAudio}
                className="inline-flex items-center gap-1 text-xs font-semibold text-teal-700 hover:underline"
              >
                <Volume2 className="h-3.5 w-3.5" />
                Preview Audio
              </button>
            </div>
            <textarea
              rows={4}
              value={messageTa}
              onChange={(e) => {
                setMessageTa(e.target.value);
                setTemplateKey('custom');
              }}
              className="w-full rounded-lg border border-slate-300 p-2.5 text-sm leading-relaxed text-slate-900 focus:border-teal-600 focus:outline-none"
            />
          </div>

          <button
            type="button"
            disabled={isCalling}
            onClick={handleMakeCall}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:opacity-50"
          >
            <PhoneCall className="h-4 w-4" />
            {isCalling ? 'Calling via Twilio...' : 'Call User Now (Tamil)'}
          </button>

          {callFeedback && (
            <div
              className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${
                callFeedback.ok
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-rose-200 bg-rose-50 text-rose-900'
              }`}
            >
              {callFeedback.ok ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              ) : (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
              )}
              <div className="flex-1 break-words">
                <strong>{callFeedback.ok ? 'Success: ' : 'Failed: '}</strong>
                <span className={callFeedback.ok ? '' : 'font-mono'}>{callFeedback.message}</span>
              </div>
            </div>
          )}
        </div>

        {/* SQLite Call History */}
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs lg:col-span-7">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-bold text-slate-900">
              Call History &amp; Log ({reminders.length})
            </h4>
            <button
              type="button"
              onClick={fetchReminders}
              className="text-xs font-semibold text-teal-700 hover:underline"
            >
              Refresh List
            </button>
          </div>

          <div className="max-h-[460px] space-y-2.5 overflow-y-auto pr-1">
            {reminders.length === 0 ? (
              <p className="p-6 text-center text-xs text-slate-400">
                No call records yet. Place an outbound Tamil reminder call to log it here.
              </p>
            ) : (
              reminders.map((item) => {
                const isSuccess = ['completed', 'queued', 'ringing', 'in-progress'].includes(
                  item.status
                );
                const badgeClass = isSuccess
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-rose-200 bg-rose-50 text-rose-700';

                return (
                  <div
                    key={item.id}
                    className="space-y-1.5 rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="font-bold text-slate-900">
                          {item.patient_name || 'Patient'}
                        </span>
                        <span className="ml-2 font-mono text-slate-500">{item.to_phone}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${badgeClass}`}
                        >
                          {item.status}
                        </span>
                        {item.call_sid && (
                          <button
                            type="button"
                            disabled={checkingSid === item.call_sid}
                            onClick={() => handleCheckCallStatus(item.call_sid)}
                            className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                          >
                            {checkingSid === item.call_sid ? '...' : 'Sync'}
                          </button>
                        )}
                      </div>
                    </div>

                    <p className="rounded border border-slate-200 bg-white p-2 text-slate-700">
                      {item.message_ta}
                    </p>

                    {item.error_detail && (
                      <p className="text-[11px] font-medium text-rose-700">
                        {item.error_detail}
                      </p>
                    )}

                    <div className="flex flex-wrap items-center justify-between pt-0.5 text-[11px] text-slate-400">
                      <span>🕒 {item.created_at}</span>
                      {item.call_sid && <span className="font-mono">SID: {item.call_sid}</span>}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

