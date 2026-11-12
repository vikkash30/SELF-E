"""Twilio Tamil Voice Reminder & Cloudflared Tunnel service for CareSync."""

import base64
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time
import urllib.request
import xml.sax.saxutils
from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import uuid4

logger = logging.getLogger("caresync.voice_reminders")

TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "").strip()
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "").strip()
TWILIO_FROM_NUMBER = os.getenv("TWILIO_FROM_NUMBER", "+17372508034").strip()
DEFAULT_TO_NUMBER = os.getenv("DEFAULT_TO_NUMBER", "+919994577702").strip()
DEFAULT_TAMIL_VOICE = os.getenv("TWILIO_TAMIL_VOICE", "Google.ta-IN-Standard-A").strip()
BACKEND_PORT = int(os.getenv("PORT", "8000"))

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(_BACKEND_DIR, "standalone_reminders.db")

_PUBLIC_TUNNEL_URL = os.getenv("PUBLIC_TUNNEL_URL", "").strip().rstrip("/")
_TUNNEL_LOCK = threading.Lock()
_TUNNEL_STARTED = False


def get_public_tunnel_url() -> str:
    """Return the active public HTTPS tunnel URL if available."""
    with _TUNNEL_LOCK:
        return _PUBLIC_TUNNEL_URL


def set_public_tunnel_url(url: str) -> str:
    """Update the active public HTTPS tunnel URL at runtime."""
    global _PUBLIC_TUNNEL_URL
    cleaned = (url or "").strip().rstrip("/")
    with _TUNNEL_LOCK:
        _PUBLIC_TUNNEL_URL = cleaned
    return cleaned


def init_reminders_db() -> None:
    """Initialize local SQLite tables for Tamil voice call reminders and auto-schedules."""
    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.cursor()
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS reminders (
                id TEXT PRIMARY KEY,
                patient_name TEXT,
                to_phone TEXT,
                message_ta TEXT,
                voice TEXT,
                status TEXT,
                call_sid TEXT,
                error_detail TEXT,
                duration_sec INTEGER,
                created_at TEXT
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS scheduled_reminders (
                id TEXT PRIMARY KEY,
                visit_id TEXT,
                patient_name TEXT,
                to_phone TEXT,
                time_slot TEXT,
                scheduled_time TEXT,
                food_context TEXT,
                medicines_summary TEXT,
                dosage TEXT,
                duration TEXT,
                language TEXT,
                status TEXT,
                is_auto INTEGER DEFAULT 1,
                last_triggered_at TEXT,
                call_sid TEXT,
                generated_script TEXT,
                created_at TEXT
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def db_save_scheduled_reminder(item: Dict[str, Any]) -> None:
    """Persist or update an automated scheduled reminder in SQLite."""
    init_reminders_db()
    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT OR REPLACE INTO scheduled_reminders
            (id, visit_id, patient_name, to_phone, time_slot, scheduled_time, food_context,
             medicines_summary, dosage, duration, language, status, is_auto,
             last_triggered_at, call_sid, generated_script, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item.get("id"),
                item.get("visit_id"),
                item.get("patient_name"),
                item.get("to_phone"),
                item.get("time_slot"),
                item.get("scheduled_time"),
                item.get("food_context"),
                item.get("medicines_summary"),
                item.get("dosage"),
                item.get("duration"),
                item.get("language") or "Tamil",
                item.get("status") or "scheduled",
                1 if item.get("is_auto", True) else 0,
                item.get("last_triggered_at"),
                item.get("call_sid"),
                item.get("generated_script"),
                item.get("created_at") or time.strftime("%Y-%m-%d %H:%M:%S"),
            ),
        )
        conn.commit()
    finally:
        conn.close()


def db_get_scheduled_reminders() -> List[Dict[str, Any]]:
    """Retrieve all automated prescription reminder schedules."""
    init_reminders_db()
    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, visit_id, patient_name, to_phone, time_slot, scheduled_time,
                   food_context, medicines_summary, dosage, duration, language,
                   status, is_auto, last_triggered_at, call_sid, generated_script, created_at
            FROM scheduled_reminders
            ORDER BY scheduled_time ASC, created_at DESC
            """
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    return [
        {
            "id": r[0],
            "visit_id": r[1],
            "patient_name": r[2],
            "to_phone": r[3],
            "time_slot": r[4],
            "scheduled_time": r[5],
            "food_context": r[6],
            "medicines_summary": r[7],
            "dosage": r[8],
            "duration": r[9],
            "language": r[10],
            "status": r[11],
            "is_auto": bool(r[12]),
            "last_triggered_at": r[13],
            "call_sid": r[14],
            "generated_script": r[15],
            "created_at": r[16],
        }
        for r in rows
    ]


def db_update_schedule_status(
    schedule_id: str,
    status: str,
    call_sid: Optional[str] = None,
    script: Optional[str] = None,
) -> None:
    """Update status, call_sid, and last_triggered_at for a scheduled reminder."""
    init_reminders_db()
    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.cursor()
        now_str = time.strftime("%Y-%m-%d %H:%M:%S")
        if call_sid and script:
            cur.execute(
                """
                UPDATE scheduled_reminders
                SET status = ?, call_sid = ?, generated_script = ?, last_triggered_at = ?
                WHERE id = ?
                """,
                (status, call_sid, script, now_str, schedule_id),
            )
        elif call_sid:
            cur.execute(
                """
                UPDATE scheduled_reminders
                SET status = ?, call_sid = ?, last_triggered_at = ?
                WHERE id = ?
                """,
                (status, call_sid, now_str, schedule_id),
            )
        else:
            cur.execute(
                "UPDATE scheduled_reminders SET status = ? WHERE id = ?",
                (status, schedule_id),
            )
        conn.commit()
    finally:
        conn.close()


def db_toggle_schedule_auto(schedule_id: str, is_auto: bool) -> None:
    """Toggle automatic calling for a specific schedule."""
    init_reminders_db()
    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE scheduled_reminders SET is_auto = ? WHERE id = ?",
            (1 if is_auto else 0, schedule_id),
        )
        conn.commit()
    finally:
        conn.close()


def auto_schedule_prescription(
    visit_id: str,
    patient_name: str,
    to_phone: str,
    prescriptions: Any,
    language: str = "Tamil",
) -> List[Dict[str, Any]]:
    """
    Parse a doctor prescription and automatically schedule time-of-day voice reminders.
    Creates entries for Morning (08:30 AM), Afternoon (01:30 PM), and Night (08:30 PM)
    based on the prescription timings and food context.
    """
    if not prescriptions:
        return []

    presc_list = prescriptions if isinstance(prescriptions, list) else [prescriptions]
    clean_to = normalize_phone(to_phone or DEFAULT_TO_NUMBER)
    p_name = (patient_name or "Patient").strip()

    # Slot buckets: { 'morning': { medicines: [], food_context: ..., dosage: ... } }
    slots_map: Dict[str, Dict[str, Any]] = {
        "morning": {"time": "08:30", "meds": [], "foods": set(), "dosages": []},
        "afternoon": {"time": "13:30", "meds": [], "foods": set(), "dosages": []},
        "night": {"time": "20:30", "meds": [], "foods": set(), "dosages": []},
    }

    for p in presc_list:
        if not isinstance(p, dict):
            continue
        med_name = p.get("medicine_name") or p.get("medicineName") or "Medication"
        dosage = p.get("dosage") or "1 Tablet"
        food = p.get("food_context") or p.get("foodContext") or "After Food"
        duration = p.get("duration") or "5 Days"

        raw_timing = p.get("timing") or ["Morning", "Night"]
        timing_list = raw_timing if isinstance(raw_timing, list) else [str(raw_timing)]
        timing_str = " ".join(timing_list).lower()

        if "morning" in timing_str or "காலை" in timing_str:
            slots_map["morning"]["meds"].append(med_name)
            slots_map["morning"]["foods"].add(food)
            slots_map["morning"]["dosages"].append(dosage)

        if "afternoon" in timing_str or "மதியம்" in timing_str or "three times" in timing_str or "noon" in timing_str:
            slots_map["afternoon"]["meds"].append(med_name)
            slots_map["afternoon"]["foods"].add(food)
            slots_map["afternoon"]["dosages"].append(dosage)

        if "night" in timing_str or "இரவு" in timing_str or "evening" in timing_str:
            slots_map["night"]["meds"].append(med_name)
            slots_map["night"]["foods"].add(food)
            slots_map["night"]["dosages"].append(dosage)

    created_schedules: List[Dict[str, Any]] = []

    for slot_name, slot_data in slots_map.items():
        if not slot_data["meds"]:
            continue

        sched_id = f"sched-{visit_id}-{slot_name}"
        food_ctx = next(iter(slot_data["foods"])) if slot_data["foods"] else "After Food"
        meds_text = ", ".join(dict.fromkeys(slot_data["meds"]))
        dosage_text = slot_data["dosages"][0] if slot_data["dosages"] else "1 Tablet"

        sched_item = {
            "id": sched_id,
            "visit_id": visit_id,
            "patient_name": p_name,
            "to_phone": clean_to,
            "time_slot": slot_name,
            "scheduled_time": slot_data["time"],
            "food_context": food_ctx,
            "medicines_summary": meds_text,
            "dosage": dosage_text,
            "duration": duration,
            "language": language,
            "status": "scheduled",
            "is_auto": True,
            "last_triggered_at": None,
            "call_sid": None,
            "generated_script": None,
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        db_save_scheduled_reminder(sched_item)
        created_schedules.append(sched_item)

    logger.info(
        "Auto-scheduled %d voice reminder slots for patient %s (visit: %s)",
        len(created_schedules),
        p_name,
        visit_id,
    )
    return created_schedules


def seed_demo_scheduled_reminders() -> None:
    """Pre-populate sample prescription schedules for instant dashboard demonstration."""
    existing = db_get_scheduled_reminders()
    if existing:
        return

    demo_patients = [
        {
            "visit_id": "demo-v-001",
            "patient_name": "Muthusamy K.",
            "to_phone": DEFAULT_TO_NUMBER,
            "prescriptions": [
                {
                    "medicine_name": "Tab. Metformin 500mg",
                    "dosage": "1 Tablet",
                    "timing": ["Morning", "Night"],
                    "food_context": "After Food",
                    "duration": "30 Days",
                }
            ],
            "language": "Tamil",
        },
        {
            "visit_id": "demo-v-002",
            "patient_name": "Lakshmi Narayanan",
            "to_phone": "+919842100012",
            "prescriptions": [
                {
                    "medicine_name": "Cap. Amoxicillin 250mg",
                    "dosage": "1 Capsule",
                    "timing": ["Morning", "Afternoon", "Night"],
                    "food_context": "Before Food",
                    "duration": "7 Days",
                }
            ],
            "language": "Tamil",
        },
        {
            "visit_id": "demo-v-003",
            "patient_name": "Arumugam P.",
            "to_phone": "+919443211100",
            "prescriptions": [
                {
                    "medicine_name": "Tab. Paracetamol 650mg",
                    "dosage": "1 Tablet",
                    "timing": ["Morning", "Night"],
                    "food_context": "After Food",
                    "duration": "5 Days",
                }
            ],
            "language": "Tamil",
        },
    ]

    for p in demo_patients:
        auto_schedule_prescription(
            visit_id=p["visit_id"],
            patient_name=p["patient_name"],
            to_phone=p["to_phone"],
            prescriptions=p["prescriptions"],
            language=p["language"],
        )


_SCHEDULER_RUNNING = False
_SCHEDULER_LOCK = threading.Lock()
_AUTO_DISPATCH_ENABLED = True


def is_auto_dispatch_enabled() -> bool:
    global _AUTO_DISPATCH_ENABLED
    return _AUTO_DISPATCH_ENABLED


def set_auto_dispatch_enabled(enabled: bool) -> bool:
    global _AUTO_DISPATCH_ENABLED
    _AUTO_DISPATCH_ENABLED = bool(enabled)
    return _AUTO_DISPATCH_ENABLED


def start_background_scheduler(interval_sec: int = 30) -> None:
    """Start daemon thread that evaluates due schedules and executes automatic calls."""
    global _SCHEDULER_RUNNING
    with _SCHEDULER_LOCK:
        if _SCHEDULER_RUNNING:
            return
        _SCHEDULER_RUNNING = True

    # Seed demo schedules if table is empty
    seed_demo_scheduled_reminders()

    def _loop() -> None:
        logger.info("Prescription Voice Reminder Auto-Scheduler loop running (every %ds)...", interval_sec)
        while True:
            time.sleep(interval_sec)
            if not _AUTO_DISPATCH_ENABLED:
                continue

            try:
                now = datetime.now()
                now_hm = now.strftime("%H:%M")
                today_str = now.strftime("%Y-%m-%d")

                # Determine slot: morning (08:00-11:59), afternoon (12:00-16:59), night (17:00-23:59)
                hour = now.hour
                if 5 <= hour < 12:
                    current_slot = "morning"
                elif 12 <= hour < 17:
                    current_slot = "afternoon"
                else:
                    current_slot = "night"

                schedules = db_get_scheduled_reminders()
                for item in schedules:
                    if not item.get("is_auto"):
                        continue
                    if item.get("status") not in ("scheduled", "queued"):
                        continue

                    # Check if already triggered today
                    last_trig = str(item.get("last_triggered_at") or "")
                    if last_trig.startswith(today_str):
                        continue

                    sched_time = str(item.get("scheduled_time") or "")
                    slot = item.get("time_slot")

                    # Match slot or exact time
                    is_due = (slot == current_slot) or (sched_time == now_hm)

                    if is_due:
                        logger.info(
                            "⏰ [AUTO CALL TRIGGER] Executing scheduled call for %s (%s slot - %s)",
                            item["patient_name"],
                            slot,
                            item["medicines_summary"],
                        )
                        # Execute call in separate thread to prevent blocking scheduler
                        threading.Thread(
                            target=execute_scheduled_call_sync,
                            args=(item["id"], False),
                            daemon=True,
                        ).start()
            except Exception as exc:
                logger.warning("Auto-scheduler loop error: %s", exc)

    thread = threading.Thread(target=_loop, daemon=True)
    thread.start()


def execute_scheduled_call_sync(schedule_id: str, is_manual: bool = True) -> Dict[str, Any]:
    """Synchronous execution of a scheduled voice reminder call."""
    from reminder_core import get_contextual_fallback_script, get_twilio_language_code
    from twilio.rest import Client

    schedules = db_get_scheduled_reminders()
    target = next((s for s in schedules if s["id"] == schedule_id), None)
    if not target:
        return {"ok": False, "message": f"Schedule {schedule_id} not found."}

    p_name = target["patient_name"]
    to_phone = normalize_phone(target["to_phone"] or DEFAULT_TO_NUMBER)
    meds = target["medicines_summary"]
    dosage = target.get("dosage") or "1 Tablet"
    slot = target.get("time_slot") or "morning"
    food = target.get("food_context") or "After Food"
    lang = target.get("language") or "Tamil"

    # 1. Generate Contextual Native Script
    script = get_contextual_fallback_script(
        patient_name=p_name,
        medicine_name=meds,
        dosage=dosage,
        time_slot=slot,
        food_context=food,
        language=lang,
    )

    lang_tag = get_twilio_language_code(lang)
    voice = DEFAULT_TAMIL_VOICE if lang_tag == "ta-IN" else "Polly.Aditi"

    twiml = f"<Response><Pause length='1'/><Say language='{lang_tag}' voice='{voice}'>{script}</Say></Response>"
    echo_url = f"https://twimlets.com/echo?Twiml={urllib.parse.quote(twiml)}"

    from_phone = os.getenv("TWILIO_PHONE_NUMBER", os.getenv("TWILIO_FROM_NUMBER", "+17372508034")).strip()

    print("\n" + "=" * 70)
    print(f" [{'MANUAL PUSH' if is_manual else 'AUTOMATIC'} VOICE CALL TRIGGER]")
    print(f" Patient         : {p_name}")
    print(f" Dialing Target  : {to_phone}")
    print(f" Time Slot       : {slot.upper()} ({food})")
    print(f" Medicines       : {meds} ({dosage})")
    print(f" Language        : {lang} (Tag: {lang_tag})")
    print(f" Generated Audio Script :\n {script}")
    print("=" * 70 + "\n")

    try:
        twilio_client = Client(os.getenv("TWILIO_ACCOUNT_SID"), os.getenv("TWILIO_AUTH_TOKEN"))
        call = twilio_client.calls.create(
            to=to_phone,
            from_=from_phone,
            url=echo_url,
        )
        call_sid = getattr(call, "sid", str(call))
        call_status = getattr(call, "status", "queued")

        db_update_schedule_status(
            schedule_id=schedule_id,
            status="triggered",
            call_sid=call_sid,
            script=script,
        )

        db_save_reminder({
            "id": f"rem-{uuid4().hex[:8]}",
            "patient_name": p_name,
            "to_phone": to_phone,
            "message_ta": script,
            "voice": voice,
            "status": call_status,
            "call_sid": call_sid,
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        })

        return {
            "ok": True,
            "status": "triggered",
            "call_sid": call_sid,
            "to_phone": to_phone,
            "generated_script": script,
            "time_slot": slot,
            "food_context": food,
            "is_manual": is_manual,
            "message": f"Twilio call successfully placed to {p_name} ({slot} slot, SID: {call_sid})",
        }
    except Exception as exc:
        print(f"❌ TWILIO API ERROR: {str(exc)}")
        db_update_schedule_status(
            schedule_id=schedule_id,
            status="failed",
            script=script,
        )
        return {
            "ok": False,
            "status": "failed",
            "error": str(exc),
            "generated_script": script,
            "time_slot": slot,
            "food_context": food,
            "message": f"Twilio API Error: {str(exc)}",
        }



def db_save_reminder(item: Dict[str, Any]) -> None:
    """Persist or update a voice reminder record in SQLite."""
    init_reminders_db()
    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT OR REPLACE INTO reminders
            (id, patient_name, to_phone, message_ta, voice, status, call_sid, error_detail, duration_sec, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item.get("id"),
                item.get("patient_name"),
                item.get("to_phone"),
                item.get("message_ta"),
                item.get("voice"),
                item.get("status"),
                item.get("call_sid"),
                item.get("error_detail"),
                item.get("duration_sec"),
                item.get("created_at") or time.strftime("%Y-%m-%d %H:%M:%S"),
            ),
        )
        conn.commit()
    finally:
        conn.close()


def db_update_call_status(
    call_sid: str,
    status: str,
    duration_sec: Optional[int] = None,
) -> None:
    """Update call status/duration in SQLite for an existing Call SID."""
    if not call_sid:
        return
    init_reminders_db()
    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.cursor()
        if duration_sec is not None:
            cur.execute(
                "UPDATE reminders SET status = ?, duration_sec = ? WHERE call_sid = ?",
                (status, duration_sec, call_sid),
            )
        else:
            cur.execute(
                "UPDATE reminders SET status = ? WHERE call_sid = ?",
                (status, call_sid),
            )
        conn.commit()
    finally:
        conn.close()


def db_get_reminders(limit: int = 100) -> List[Dict[str, Any]]:
    """Fetch recent voice reminder records from SQLite."""
    init_reminders_db()
    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, patient_name, to_phone, message_ta, voice, status,
                   call_sid, error_detail, duration_sec, created_at
            FROM reminders
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    return [
        {
            "id": r[0],
            "patient_name": r[1],
            "to_phone": r[2],
            "message_ta": r[3],
            "voice": r[4],
            "status": r[5],
            "call_sid": r[6],
            "error_detail": r[7],
            "duration_sec": r[8],
            "created_at": r[9],
        }
        for r in rows
    ]


def launch_cloudflared_tunnel(local_port: int = BACKEND_PORT) -> None:
    """Launch a background cloudflared tunnel if installed and not already running."""
    global _TUNNEL_STARTED
    with _TUNNEL_LOCK:
        if _TUNNEL_STARTED or _PUBLIC_TUNNEL_URL:
            return
        _TUNNEL_STARTED = True

    cloudflared_bin = shutil.which("cloudflared")
    if not cloudflared_bin:
        for candidate in (
            r"C:\Program Files (x86)\cloudflared\cloudflared.exe",
            r"C:\Program Files\cloudflared\cloudflared.exe",
        ):
            if os.path.exists(candidate):
                cloudflared_bin = candidate
                break

    if not cloudflared_bin:
        logger.info(
            "cloudflared not found in PATH; set PUBLIC_TUNNEL_URL env or via POST /reminders/tunnel-url for live Twilio callbacks."
        )
        return

    def _run_tunnel() -> None:
        logger.info("Starting cloudflared tunnel for port %s...", local_port)
        try:
            proc = subprocess.Popen(
                [cloudflared_bin, "tunnel", "--url", f"http://127.0.0.1:{local_port}"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        except Exception as exc:
            logger.warning("Failed to start cloudflared tunnel: %s", exc)
            return

        if proc.stdout is None:
            return
        url_regex = re.compile(r"https://[a-zA-Z0-9\-]+\.trycloudflare\.com")
        for line in iter(proc.stdout.readline, ""):
            match = url_regex.search(line)
            if match and not get_public_tunnel_url():
                url = set_public_tunnel_url(match.group(0))
                logger.info("Public HTTPS TwiML tunnel ready: %s", url)

    thread = threading.Thread(target=_run_tunnel, daemon=True)
    thread.start()


def normalize_phone(phone: str) -> str:
    """Normalize 10-digit Indian mobile numbers to E.164 format."""
    cleaned = re.sub(r"[\s\-()]+", "", (phone or "").strip())
    if re.fullmatch(r"\d{10}", cleaned):
        cleaned = "+91" + cleaned
    elif re.fullmatch(r"91\d{10}", cleaned):
        cleaned = "+" + cleaned
    return cleaned


TWILIO_LANGUAGES = {"ta-IN", "hi-IN", "te-IN", "en-IN"}


def build_twiml_xml(
    message_ta: str,
    voice: str = DEFAULT_TAMIL_VOICE,
    language: str = "ta-IN",
) -> str:
    """Build TwiML XML document instructing Twilio to speak the reminder via Google TTS."""
    safe_msg = xml.sax.saxutils.escape((message_ta or "").strip() or "வணக்கம், இது மருத்துவ நினைவூட்டல்.")
    safe_voice = xml.sax.saxutils.quoteattr((voice or DEFAULT_TAMIL_VOICE).strip())
    safe_lang = language if language in TWILIO_LANGUAGES else "ta-IN"
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response>"
        '<Pause length="1"/>'
        f'<Say language={xml.sax.saxutils.quoteattr(safe_lang)} voice={safe_voice}>{safe_msg}</Say>'
        "</Response>"
    )


def _twilio_auth_header() -> str:
    auth_str = f"{TWILIO_ACCOUNT_SID}:{TWILIO_AUTH_TOKEN}"
    b64_auth = base64.b64encode(auth_str.encode("utf-8")).decode("ascii")
    return f"Basic {b64_auth}"


def fetch_call_status(call_sid: str) -> Dict[str, Any]:
    """Query Twilio for the live status of a call SID and sync it into SQLite."""
    if not call_sid or not call_sid.startswith("CA"):
        return {"status": "unknown"}
    if not (TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN):
        return {"status": "unconfigured", "call_sid": call_sid}

    twilio_endpoint = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Calls/{call_sid}.json"
    req = urllib.request.Request(twilio_endpoint, method="GET")
    req.add_header("Authorization", _twilio_auth_header())

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            status = payload.get("status", "unknown")
            duration_raw = payload.get("duration")
            duration_sec = int(duration_raw) if duration_raw is not None else None
            db_update_call_status(call_sid, status, duration_sec)
            return payload
    except Exception as exc:
        return {"status": "error", "detail": str(exc)}


def get_reminder_system_status() -> Dict[str, Any]:
    """Return masked Twilio credentials, phone defaults, and public tunnel state."""
    configured = bool(TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER)
    if len(TWILIO_ACCOUNT_SID) >= 10:
        masked_sid = f"{TWILIO_ACCOUNT_SID[:6]}...{TWILIO_ACCOUNT_SID[-4:]}"
    elif TWILIO_ACCOUNT_SID:
        masked_sid = "***"
    else:
        masked_sid = "Not configured"

    public_url = get_public_tunnel_url()
    return {
        "configured": configured,
        "account_sid_masked": masked_sid,
        "from_number": TWILIO_FROM_NUMBER,
        "default_to_number": DEFAULT_TO_NUMBER,
        "default_voice": DEFAULT_TAMIL_VOICE,
        "public_tunnel_url": public_url or "Tunnel pending...",
        "tunnel_ready": bool(public_url.startswith("https://") or public_url.startswith("http://")),
        "port": BACKEND_PORT,
    }

