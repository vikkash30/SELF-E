"""FastAPI application for CareSync rural healthcare triage, IoT intake, and teleconsultation."""

import logging
import os
import urllib.parse
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Union
from uuid import uuid4

from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv
from fastapi import Body, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pydantic import BaseModel, Field
from pydantic import BaseModel, ConfigDict, Field
from twilio.base.exceptions import TwilioRestException
from twilio.rest import Client

from database import (
    get_db,
    get_patients_collection,
    get_visits_collection,
    init_firebase,
    is_firestore_connected,
)
from reminder_core import (
    generate_contextual_reminder_script,
    generate_reminder_script,
    get_contextual_fallback_script,
    get_time_of_day,
    get_twilio_language_code,
)
from services.scraper import scrape_health_schemes
from services.voice_reminders import (
    DEFAULT_TO_NUMBER,
    auto_schedule_prescription,
    build_twiml_xml,
    db_get_reminders,
    db_get_scheduled_reminders,
    db_save_reminder,
    db_save_scheduled_reminder,
    db_toggle_schedule_auto,
    execute_scheduled_call_sync,
    fetch_call_status,
    get_reminder_system_status,
    is_auto_dispatch_enabled,
    launch_cloudflared_tunnel,
    normalize_phone,
    seed_demo_scheduled_reminders,
    set_auto_dispatch_enabled,
    set_public_tunnel_url,
    start_background_scheduler,
)
from pathlib import Path
from triage_core import calculate_triage

# Load environment from both local directory and cwd
_env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(_env_path)
load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("caresync.api")

# Twilio Client Initialization (Phase 1)
twilio_client = Client(os.getenv("TWILIO_ACCOUNT_SID"), os.getenv("TWILIO_AUTH_TOKEN"))

# Background APScheduler for automated medication & appointment reminders
scheduler = BackgroundScheduler()

@asynccontextmanager
async def lifespan(app: FastAPI):
    if not scheduler.running:
        scheduler.start()
        logger.info("APScheduler background scheduler started.")
    yield
    if scheduler.running:
        scheduler.shutdown()
        logger.info("APScheduler background scheduler shutdown.")

app = FastAPI(
    title="CareSync API",
    description="Offline-first AI triage, IoT vital ingestion, and doctor escalation backend.",
    version="1.1.0",
    lifespan=lifespan,
)

# CORS configuration: allow React dev server (5173) and local testing origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://localhost:8050",
        "*",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Firebase Admin SDK on startup (gracefully degrades if credentials.json is placeholder).
init_firebase()
launch_cloudflared_tunnel()
start_background_scheduler()

# In-memory fallback stores used when credentials.json is still a placeholder.
_DEMO_VISITS_STORE: Dict[str, Dict[str, Any]] = {}
_DEMO_LATEST_IOT: Optional[Dict[str, Any]] = None
_DEMO_ACTIVE_SESSION: Optional[Dict[str, Any]] = None

MOCK_FACILITIES_BY_SEVERITY: Dict[str, List[Dict[str, Any]]] = {
    "Red": [
        {
            "id": "fac-chc-01",
            "name": "Block Community Health Centre (CHC) - Kinathukadavu",
            "type": "CHC / First Referral Unit",
            "lat": 10.8225,
            "lng": 77.0180,
            "distance_km": 15.5,
            "availability": "24x7 Emergency & Oxygen Bed Available",
            "contact": "108 / +91-1800-180-1104",
            "services": ["Oxygen Support", "Emergency Stabilization", "Ambulance Dispatch"],
        },
        {
            "id": "fac-dh-01",
            "name": "Coimbatore Medical College Hospital (CMCH) - ICU",
            "type": "District / Tertiary Hospital",
            "lat": 10.9958,
            "lng": 76.9708,
            "distance_km": 13.2,
            "availability": "ICU & Specialist On Call",
            "contact": "108 / +91-422-230-1393",
            "services": ["ICU", "Blood Bank", "General Medicine"],
        },
        {
            "id": "fac-phc-red-01",
            "name": "Madukkarai Block Emergency & Trauma Unit",
            "type": "First Referral Unit",
            "lat": 10.9038,
            "lng": 76.9562,
            "distance_km": 6.2,
            "availability": "24x7 Stabilization & Ambulance",
            "contact": "108 / +91-422-262-2100",
            "services": ["Oxygen Cylinder", "IV Stabilization"],
        },
    ],
    "Yellow": [
        {
            "id": "fac-phc-01",
            "name": "Madukkarai Primary Health Centre (PHC)",
            "type": "Primary Health Centre",
            "lat": 10.9038,
            "lng": 76.9562,
            "distance_km": 6.2,
            "availability": "MBBS Medical Officer Available (9 AM - 4 PM)",
            "contact": "+91-94150-00102",
            "services": ["OPD Consultation", "Rapid Malaria/Dengue Kit", "Essential Medicines"],
        },
        {
            "id": "fac-phc-02",
            "name": "Sundarapuram Urban Primary Health Centre",
            "type": "Primary Health Centre",
            "lat": 10.9554,
            "lng": 76.9735,
            "distance_km": 10.1,
            "availability": "Doctor & Lab Testing Open",
            "contact": "+91-422-267-4400",
            "services": ["OPD", "CBC & Fever Panel", "Pharmacy"],
        },
        {
            "id": "fac-tele-01",
            "name": "CareSync Ration-Shop Telemedicine Desk",
            "type": "Telemedicine Kiosk",
            "lat": 10.9005,
            "lng": 76.9010,
            "distance_km": 0.1,
            "availability": "Video Consult Queue: ~10 mins",
            "contact": "Operator Desk",
            "services": ["Live Doctor Video Call", "Digital e-Prescription"],
        },
    ],
    "Green": [
        {
            "id": "fac-hwc-01",
            "name": "Ayushman Arogya Mandir (Health & Wellness Centre) - Ettimadai",
            "type": "Sub-Centre / HWC",
            "lat": 10.8892,
            "lng": 76.8935,
            "distance_km": 1.4,
            "availability": "CHO & ASHA Worker Support Daily",
            "contact": "+91-94150-00199",
            "services": ["ORS & Zinc Packets", "Paracetamol Dispensing", "Follow-up Check"],
        },
        {
            "id": "fac-hwc-02",
            "name": "Madukkarai Community Health Sub-Centre",
            "type": "Primary Health Sub-Centre",
            "lat": 10.9038,
            "lng": 76.9562,
            "distance_km": 6.2,
            "availability": "Daily Outpatient & Follow-up",
            "contact": "+91-422-262-2100",
            "services": ["Hydration Protocol", "Symptom Monitoring", "Ration Shop Re-screening"],
        },
        {
            "id": "fac-hwc-03",
            "name": "Kuniyamuthur Wellness Clinic",
            "type": "Wellness Centre",
            "lat": 10.9598,
            "lng": 76.9482,
            "distance_km": 8.5,
            "availability": "9 AM - 5 PM",
            "contact": "+91-422-225-3300",
            "services": ["Primary Care", "Essential Medicines"],
        },
    ],
}


class VitalsInput(BaseModel):
    spo2: Optional[float] = Field(default=None, ge=0, le=100, description="Oxygen saturation %")
    temperature: Optional[float] = Field(default=None, ge=85, le=115, description="Body temp in °F")
    heart_rate: Optional[float] = Field(default=None, ge=20, le=250, description="Heart rate in bpm")


class TriageRequest(BaseModel):
    visit_id: Optional[str] = Field(default=None, description="Optional existing visit ID (e.g. from IoT)")
    patient_name: Optional[str] = Field(default=None, description="Patient full name")
    phone_number: Optional[str] = Field(default=None, description="Patient phone number")
    phoneNumber: Optional[str] = Field(default=None, description="Patient phone number alias")
    language: Optional[str] = Field(default="Tamil", description="Patient preferred language")
    gender: Optional[str] = Field(default=None, description="Patient gender (Male / Female)")
    age: Optional[int] = Field(default=None, ge=0, le=120, description="Patient age in years")
    country: Optional[str] = Field(default="India", description="Country")
    state: Optional[str] = Field(default="Tamil Nadu", description="State")
    city: Optional[str] = Field(default="Coimbatore", description="City / Village / Block")
    symptoms: str = Field(..., min_length=1, description="Complaints / add-ons text")
    vitals: VitalsInput = Field(default_factory=VitalsInput)


class ActiveSessionRequest(BaseModel):
    patientId: Union[int, str]
    name: str = ""
    gender: str = ""
    country: Optional[str] = "India"
    state: Optional[str] = "Tamil Nadu"
    city: Optional[str] = "Coimbatore"


class IoTReadingRequest(BaseModel):
    patient_id: Optional[Union[int, str]] = None
    patient_name: str = Field(..., min_length=1)
    gender: Optional[str] = None
    age: Optional[int] = Field(default=None, ge=0, le=120)
    country: Optional[str] = "India"
    state: Optional[str] = "Tamil Nadu"
    city: Optional[str] = "Coimbatore"
    vitals: VitalsInput
    device_id: Optional[str] = "IOT-KITS-FPS-01"


class VisitStatusUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    status: str = Field(..., description="e.g., 'okay', 'escalated', 'accepted', 'completed'")
    patient_name: Optional[str] = None
    patientName: Optional[str] = None
    phone_number: Optional[str] = None
    phoneNumber: Optional[str] = None
    language: Optional[str] = "Tamil"
    gender: Optional[str] = None
    age: Optional[int] = None
    country: Optional[str] = None
    state: Optional[str] = None
    city: Optional[str] = None
    symptoms: Optional[str] = None
    vitals: Optional[Dict[str, Any]] = None
    triage_result: Optional[Dict[str, Any]] = None
    prescription: Optional[Dict[str, Any]] = None
    prescriptions: Optional[List[Dict[str, Any]]] = None
    notes: Optional[str] = None


class VisitRecord(BaseModel):
    model_config = ConfigDict(extra="allow")

    local_id: Optional[Union[str, int]] = None
    visit_id: Optional[str] = None
    patient_id: Optional[str] = None
    patient_name: str
    patient_name: str = "Patient"
    phone_number: Optional[str] = None
    phoneNumber: Optional[str] = None
    language: Optional[str] = "Tamil"
    gender: Optional[str] = None
    age: int = Field(ge=0, le=120)
    age: Optional[int] = Field(default=30, ge=0, le=120)
    country: Optional[str] = "India"
    state: Optional[str] = "Tamil Nadu"
    city: Optional[str] = "Coimbatore"
    symptoms: str
    vitals: Dict[str, Any]
    symptoms: str = ""
    vitals: Dict[str, Any] = Field(default_factory=dict)
    triage_result: Optional[Dict[str, Any]] = None
    prescription: Optional[Dict[str, Any]] = None
    status: Optional[str] = "triaged"
    created_at: Optional[str] = None
    ration_shop_id: Optional[str] = "FPS-RURAL-01"


class VisitSyncRequest(BaseModel):
    visits: List[VisitRecord]


def _save_visit_record(visit_id: str, doc: Dict[str, Any]) -> str:
    """Persist a visit document to Firestore if connected, else demo memory."""
    """Persist a visit document to Firestore if connected, and always keep synchronized demo memory."""
    existing = _DEMO_VISITS_STORE.get(visit_id, {})
    _DEMO_VISITS_STORE[visit_id] = {**existing, **doc, "visit_id": visit_id}

    visits_col = get_visits_collection()
    if visits_col is not None:
        visits_col.document(visit_id).set(doc, merge=True)
        return "firestore"
    existing = _DEMO_VISITS_STORE.get(visit_id, {})
    _DEMO_VISITS_STORE[visit_id] = {**existing, **doc, "visit_id": visit_id}
        try:
            visits_col.document(visit_id).set(doc, merge=True)
            return "firestore"
        except Exception as exc:
            logger.warning("Firestore set failed for visit %s: %s", visit_id, exc)
            return "demo_memory_fallback"
    return "demo_memory"


@app.get("/health")
def health_check() -> Dict[str, Any]:
    """Return service health and Firestore connectivity status."""
    return {
        "status": "ok",
        "service": "CareSync Backend",
        "firestore_connected": is_firestore_connected(),
    }


@app.post("/session/current")
def set_active_session(payload: ActiveSessionRequest) -> Dict[str, Any]:
    """Store the live Operator active patient session (fallback for non-Firebase mode)."""
    global _DEMO_ACTIVE_SESSION
    now_iso = datetime.now(timezone.utc).isoformat()
    doc = {
        "patientId": payload.patientId,
        "name": payload.name.strip(),
        "gender": payload.gender.strip(),
        "country": (payload.country or "India").strip(),
        "state": (payload.state or "Tamil Nadu").strip(),
        "city": (payload.city or "Coimbatore").strip(),
        "updated_at": now_iso,
    }
    db = get_db()
    if db is not None:
        db.collection("active_sessions").document("current").set(doc, merge=True)
    _DEMO_ACTIVE_SESSION = doc
    return {"status": "ok", "session": doc}


@app.get("/session/current")
def get_active_session() -> Dict[str, Any]:
    """Return the current active patient session for the IoT Simulator."""
    if _DEMO_ACTIVE_SESSION is not None:
        return {"session": _DEMO_ACTIVE_SESSION}
    db = get_db()
    if db is not None:
        snap = db.collection("active_sessions").document("current").get()
        if snap.exists:
            return {"session": snap.to_dict()}
    return {"session": None}


@app.delete("/session/current")
def clear_active_session() -> Dict[str, Any]:
    """Clear the active session and latest IoT buffer when advancing to Next Patient."""
    global _DEMO_ACTIVE_SESSION, _DEMO_LATEST_IOT
    _DEMO_ACTIVE_SESSION = None
    _DEMO_LATEST_IOT = None
    db = get_db()
    if db is not None:
        db.collection("active_sessions").document("current").delete()
    return {"status": "ok"}


@app.post("/iot/readings")
def ingest_iot_readings(payload: IoTReadingRequest) -> Dict[str, Any]:
    """Receive readings from the IoT simulator and push to Firestore visits collection."""
    global _DEMO_LATEST_IOT
    now_iso = datetime.now(timezone.utc).isoformat()
    visit_id = str(payload.patient_id) if payload.patient_id is not None else f"iot-{uuid4().hex[:10]}"
    vitals_dict = payload.vitals.model_dump()

    doc = {
        "visit_id": visit_id,
        "patient_id": payload.patient_id if payload.patient_id is not None else visit_id,
        "patient_name": payload.patient_name.strip(),
        "gender": payload.gender,
        "age": payload.age,
        "vitals": vitals_dict,
        "symptoms": "",
        "status": "iot_pending",
        "source": "iot_simulator",
        "device_id": payload.device_id,
        "created_at": now_iso,
        "updated_at": now_iso,
    }

    storage = _save_visit_record(visit_id, doc)
    _DEMO_LATEST_IOT = doc

    logger.info("Ingested IoT readings for %s (%s) via %s", payload.patient_name, visit_id, storage)
    return {
        "status": "ok",
        "storage": storage,
        "reading": doc,
    }


@app.get("/iot/latest")
def get_latest_iot_reading() -> Dict[str, Any]:
    """Return the latest IoT reading so the Operator Dashboard populates automatically."""
    if _DEMO_LATEST_IOT is not None:
        return {"reading": _DEMO_LATEST_IOT}

    visits_col = get_visits_collection()
    if visits_col is not None:
        docs = (
            visits_col.where("status", "==", "iot_pending")
            .limit(10)
            .stream()
        )
        items = [doc.to_dict() for doc in docs]
        items.sort(key=lambda item: item.get("created_at", ""), reverse=True)
        if items:
            return {"reading": items[0]}

    return {"reading": None}


@app.post("/triage")
def run_triage(payload: TriageRequest) -> Dict[str, Any]:
    """Run hybrid vital-rules + NVIDIA NIM AI triage for a patient."""
    global _DEMO_LATEST_IOT
    vitals_dict = payload.vitals.model_dump()
    result = calculate_triage(
        payload.symptoms, vitals_dict, age=payload.age, gender=payload.gender
    )
    severity = result["severity"]

    now_iso = datetime.now(timezone.utc).isoformat()
    visit_id = payload.visit_id or f"vis-{uuid4().hex[:10]}"
    p_phone = (payload.phone_number or payload.phoneNumber or "").strip()
    p_lang = payload.language or "Tamil"

    visit_doc = {
        "visit_id": visit_id,
        "patient_name": (payload.patient_name or "Unknown Patient").strip(),
        "phone_number": p_phone,
        "phoneNumber": p_phone,
        "language": p_lang,
        "gender": payload.gender,
        "age": payload.age,
        "country": payload.country or "India",
        "state": payload.state or "Tamil Nadu",
        "city": payload.city or "Coimbatore",
        "symptoms": payload.symptoms,
        "vitals": vitals_dict,
        "triage_result": result,
        "status": "triaged",
        "evaluated_at": now_iso,
        "updated_at": now_iso,
        "created_at": now_iso,
    }
    storage = _save_visit_record(visit_id, visit_doc)

    # Clear pending IoT banner if this triage consumed the latest IoT reading.
    if _DEMO_LATEST_IOT and _DEMO_LATEST_IOT.get("visit_id") == visit_id:
        _DEMO_LATEST_IOT = None

    return {
        "visit_id": visit_id,
        "storage": storage,
        "patient_name": payload.patient_name,
        "age": payload.age,
        "country": payload.country or "India",
        "state": payload.state or "Tamil Nadu",
        "city": payload.city or "Coimbatore",
        "vitals": vitals_dict,
        "triage": result,
        "recommended_facilities": MOCK_FACILITIES_BY_SEVERITY.get(
            severity, MOCK_FACILITIES_BY_SEVERITY["Yellow"]
        ),
        "evaluated_at": now_iso,
    }


@app.patch("/visits/{visit_id}/status")
@app.post("/visits/{visit_id}/status")
def update_visit_status(visit_id: str, payload: VisitStatusUpdateRequest) -> Dict[str, Any]:
    """Update a patient visit status (e.g., 'okay', 'escalated', 'accepted') in Firestore."""
    now_iso = datetime.now(timezone.utc).isoformat()
    update_doc: Dict[str, Any] = {
        "visit_id": visit_id,
        "status": payload.status.strip().lower(),
        "updated_at": now_iso,
    }
    if update_doc["status"] == "escalated":
        update_doc["escalated_at"] = now_iso
    if payload.patient_name is not None:
        update_doc["patient_name"] = payload.patient_name
    p_name = payload.patient_name or payload.patientName
    if p_name is not None:
        update_doc["patient_name"] = p_name
        update_doc["patientName"] = p_name
    p_phone = payload.phone_number or payload.phoneNumber
    if p_phone is not None:
        update_doc["phone_number"] = p_phone
        update_doc["phoneNumber"] = p_phone
    if payload.language is not None:
        update_doc["language"] = payload.language
    if payload.gender is not None:
        update_doc["gender"] = payload.gender
    if payload.age is not None:
        update_doc["age"] = payload.age
    if payload.country is not None:
        update_doc["country"] = payload.country
    if payload.state is not None:
        update_doc["state"] = payload.state
    if payload.city is not None:
        update_doc["city"] = payload.city
    if payload.symptoms is not None:
        update_doc["symptoms"] = payload.symptoms
    if payload.vitals is not None:
        update_doc["vitals"] = payload.vitals
    if payload.triage_result is not None:
        update_doc["triage_result"] = payload.triage_result
    if payload.prescription is not None:
        update_doc["prescription"] = payload.prescription
    if payload.notes is not None:
        update_doc["notes"] = payload.notes

    storage = _save_visit_record(visit_id, update_doc)
    logger.info("Updated visit %s status -> %s (%s)", visit_id, update_doc["status"], storage)

    return {
        "status": "ok",
        "visit_id": visit_id,
        "visit_status": update_doc["status"],
        "storage": storage,
        "updated_at": now_iso,
    }


# ==============================================================================
# PHASE 1 & 3: Twilio SMS Reminder & APScheduler Engine
# ==============================================================================

def _normalize_phone_number(raw_phone: str) -> str:
    cleaned = str(raw_phone or "").strip()
    digits = "".join(ch for ch in cleaned if ch.isdigit())
    if cleaned.startswith("+"):
        return cleaned
    elif len(digits) == 10:
        return f"+91{digits}"
    elif len(digits) > 10:
        return f"+{digits}"
    return f"+91{cleaned}" if cleaned else ""


def _generate_sms_fallback_template(context_type: str, details: Dict[str, Any], language: str) -> str:
    lang = (language or "").strip().lower()
    is_tamil = "tam" in lang or lang == "ta"
    is_hindi = "hin" in lang or lang == "hi"
    is_telugu = "tel" in lang or lang == "te"

    p_name = details.get("patient_name") or "Patient"
    med_name = details.get("medicine_name") or details.get("medicine") or "prescribed medication"
    time_of_day = details.get("time_of_day") or "Morning"
    appt_time = details.get("appointment_time") or "tomorrow at 10 AM"
    p_name = details.get("patient_name") or "நோயாளி"
    med_name = details.get("medicine_name") or details.get("medicine") or "மருந்து"
    time_of_day = details.get("time_of_day") or "காலை"
    appt_time = details.get("appointment_time") or "நாளை காலை 10 மணிக்கு"
    alert_type = details.get("alert_type") or "1_day_before"

    if context_type in ("meds", "medication", "medicine"):
        if is_tamil:
            return f"CareSync: வணக்கம் {p_name}, தயவுசெய்து உங்கள் {time_of_day} மருந்தை ({med_name}) தவறாமல் உட்கொள்ளவும்."
        elif is_hindi:
        if is_hindi:
            return f"CareSync: नमस्ते {p_name}, कृपया अपनी {time_of_day} की दवा ({med_name}) समय पर अवश्य लें।"
        elif is_telugu:
            return f"CareSync: నమస్కారం {p_name}, దయచేసి మీ {time_of_day} మందును ({med_name}) ఇప్పుడు తీసుకోండి."
        else:
            return f"This is CareSync: Please take your {time_of_day} medicine ({med_name}) now."
            # Default to Tamil for all CareSync medication alerts
            return f"CareSync: வணக்கம் {p_name}, தயவுசெய்து உங்கள் {time_of_day} மருந்தை ({med_name}) தவறாமல் உட்கொள்ளவும்."
    else:
        # Appointment
        if is_tamil:
            prefix = "நாளை" if "1_day" in alert_type else "இன்னும் 10 நிமிடங்களில்"
            return f"CareSync: வணக்கம் {p_name}, உங்கள் மருத்துவ பரிசோதனை {prefix} ({appt_time}) திட்டமிடப்பட்டுள்ளது."
        elif is_hindi:
        if is_hindi:
            prefix_hi = "कल" if "1_day" in alert_type else "10 मिनट में"
            return f"CareSync: नमस्ते {p_name}, आपकी डॉक्टर से मुलाकात {prefix_hi} ({appt_time}) पर निर्धारित है।"
        elif is_telugu:
            prefix_te = "రేపు" if "1_day" in alert_type else "10 నిమిషాల్లో"
            return f"CareSync: నమస్కారం {p_name}, మీ వైద్య సంప్రదింపులు {prefix_te} ({appt_time}) వద్ద షెడ్యూల్ చేయబడ్డాయి."
        else:
            prefix_en = "tomorrow" if "1_day" in alert_type else "in 10 minutes"
            return f"This is CareSync: Your appointment is {prefix_en} at {appt_time}."
            # Default to Tamil for all CareSync appointment follow-ups
            prefix = "நாளை" if "1_day" in alert_type else "இன்னும் 10 நிமிடங்களில்"
            return f"CareSync: வணக்கம் {p_name}, உங்கள் மருத்துவ பரிசோதனை {prefix} ({appt_time}) திட்டமிடப்பட்டுள்ளது."


def _generate_sms_with_nemotron(context_type: str, details: Dict[str, Any], language: str) -> str:
    """Generate a strict 1-sentence SMS using NVIDIA Nemotron with instant fallback."""
    api_key = os.getenv("NVIDIA_API_KEY", "").strip()
    clean_lang = (language or "").strip().lower()
    if "hin" in clean_lang or clean_lang == "hi":
        target_lang = "Hindi"
    elif "tel" in clean_lang or clean_lang == "te":
        target_lang = "Telugu"
    else:
        target_lang = "Tamil"

    if not api_key:
        return _generate_sms_fallback_template(context_type, details, language)
        return _generate_sms_fallback_template(context_type, details, target_lang)

    p_name = details.get("patient_name") or "Patient"
    med_name = details.get("medicine_name") or "prescribed medication"
    time_of_day = details.get("time_of_day") or "Morning"
    appt_time = details.get("appointment_time") or "tomorrow at 10 AM"

    system_prompt = (
        f"You are CareSync, an automated healthcare SMS alert assistant. "
        f"Write a strict 1-sentence SMS in {language}. "
        f"Write a strict 1-sentence SMS in {target_lang}. "
        f"Rules: EXACTLY ONE concise sentence. Friendly and clinical tone. "
        f"Do NOT include markdown, asterisks, quotation marks, or translations. "
        f"Output ONLY the single SMS sentence in {language}."
        f"Output ONLY the single SMS sentence in {target_lang}."
    )

    if context_type in ("meds", "medication", "medicine"):
        user_prompt = f"Write a 1-sentence SMS to {p_name} reminding them to take their {time_of_day} medicine ({med_name}) now in {language}."
        user_prompt = f"Write a 1-sentence SMS to {p_name} reminding them to take their {time_of_day} medicine ({med_name}) now in {target_lang}."
    else:
        user_prompt = f"Write a 1-sentence SMS to {p_name} reminding them about their appointment at {appt_time} in {language}."
        user_prompt = f"Write a 1-sentence SMS to {p_name} reminding them about their appointment at {appt_time} in {target_lang}."

    try:
        model_name = os.getenv("NVIDIA_MODEL_NAME", "nvidia/nemotron-3.5-bolt-e4b")
        client = OpenAI(
            base_url="https://integrate.api.nvidia.com/v1",
            api_key=api_key,
            timeout=4.0,
            max_retries=1,
        )
        response = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=60,
            temperature=0.3,
        )
        raw_text = (response.choices[0].message.content or "").strip()
        clean_text = raw_text.replace('"', "").replace("\n", " ").strip()
        if clean_text:
            return clean_text
    except Exception as e:
        logger.info("NVIDIA Nemotron SMS notice (%s). Using localized template.", e)

    return _generate_sms_fallback_template(context_type, details, language)


_generate_sms_with_llama = _generate_sms_with_nemotron


class _HybridSMSCallable:
    """Wrapper making send_twilio_sms both awaitable and directly callable by APScheduler BackgroundScheduler."""
    def __init__(self, func):
        self.func = func
        self.__name__ = func.__name__

    def __call__(self, *args, **kwargs):
        res = self.func(*args, **kwargs)
        class _AwaitableDict(dict):
            def __init__(self, data):
                super().__init__(data)
            def __await__(self):
                async def _coro():
                    return self
                return _coro().__await__()
        return _AwaitableDict(res)


@_HybridSMSCallable
def send_twilio_sms(
    phone_number: str,
    context_type: str,
    details: Optional[Dict[str, Any]] = None,
    language: str = "Tamil",
) -> Dict[str, Any]:
    """
    Core function: Send an automated Twilio SMS reminder using NVIDIA Nemotron 1-sentence generation.
    Supports medications and appointment follow-ups.
    Trial compliant: catches Twilio exceptions, logs details, and provides trial simulated fallback.
    """
    det = details or {}
    to_phone = _normalize_phone_number(phone_number)
    from_phone = os.getenv("TWILIO_PHONE_NUMBER", "+17372508034").strip()

    # 1. Generate 1-sentence SMS via NVIDIA Nemotron
    generated_text = _generate_sms_with_nemotron(context_type, det, language)

    # 2. Terminal log
    print("\n" + "=" * 70)
    print("📱 [CARE-SYNC TWILIO SMS DISPATCH]")
    print(f" Target Recipient : {to_phone}")
    print(f" From Phone       : {from_phone}")
    print(f" Context Type     : {context_type}")
    print(f" Language         : {language}")
    print(f" Generated SMS    : {generated_text}")
    print("=" * 70 + "\n")

    # 3. Execute Twilio SMS
    sms_sid = f"SM-{uuid4().hex[:20]}"
    sms_status = "sent"
    error_msg = None

    try:
        msg = twilio_client.messages.create(
            body=generated_text,
            from_=from_phone,
            to=to_phone,
        )
        sms_sid = getattr(msg, "sid", sms_sid)
        sms_status = getattr(msg, "status", "queued")
        print(f"✅ Twilio SMS Delivered/Queued successfully! SID: {sms_sid}")
    except Exception as e:
        error_msg = str(e)
        print(f"❌ TWILIO API ERROR: {error_msg}")
        print(f"⚠️ [MOCK SMS FALLBACK] Activated for demo. To: {to_phone} | Body: {generated_text}")

    return {
        "status": "success",
        "sid": sms_sid,
        "sms_status": sms_status,
        "to": to_phone,
        "from": from_phone,
        "body": generated_text,
        "context_type": context_type,
        "language": language,
        "error": error_msg,
    }


@app.post("/api/prescribe")
@app.post("/visits/{visit_id}/prescription")
@app.patch("/visits/{visit_id}/prescription")
def save_visit_prescription(
    visit_id: Optional[str] = None,
    payload: Dict[str, Any] = Body(...),
) -> Dict[str, Any]:
    """
    Store or update prescription details issued by the consulting doctor,
    queue production medication and appointment SMS jobs in APScheduler,
    and trigger automated voice reminder slots.
    """
    resolved_visit_id = visit_id or payload.get("visit_id") or f"visit-{uuid4().hex[:8]}"
    now = datetime.now()
    now_iso = datetime.now(timezone.utc).isoformat()

    # 1. Parse multi-medicine array
    prescriptions_data = payload.get("prescriptions") or payload.get("prescription", payload)
    if isinstance(prescriptions_data, list):
        prescriptions_list = prescriptions_data
    elif isinstance(prescriptions_data, dict):
        prescriptions_list = [prescriptions_data]
    else:
        prescriptions_list = []

    primary_prescription = payload.get("prescription") or (
        prescriptions_list[0] if prescriptions_list else {}
    )

    # 2. Parse next_appointment timestamp
    next_appointment_str = payload.get("next_appointment") or payload.get("nextAppointment") or ""

    # 3. Patient contact details
    stored_visit = _DEMO_VISITS_STORE.get(resolved_visit_id, {})
    p_name = (
        payload.get("patient_name")
        or payload.get("name")
        or stored_visit.get("patient_name")
        or "Patient"
    )
    p_phone = (
        payload.get("phone_number")
        or payload.get("phoneNumber")
        or stored_visit.get("phoneNumber")
        or stored_visit.get("phone_number")
        or ""
    )
    p_lang = payload.get("language") or stored_visit.get("language") or "Tamil"
    raw_lang = (payload.get("language") or stored_visit.get("language") or "").strip().lower()
    p_lang = "Hindi" if "hin" in raw_lang else ("Telugu" if "tel" in raw_lang else "Tamil")

    # Save to storage / Firestore
    update_doc: Dict[str, Any] = {
        "visit_id": resolved_visit_id,
        "patient_name": p_name,
        "phone_number": p_phone,
        "phoneNumber": p_phone,
        "language": p_lang,
        "prescription": primary_prescription,
        "prescriptions": prescriptions_list,
        "next_appointment": next_appointment_str,
        "nextAppointment": next_appointment_str,
        "updated_at": now_iso,
    }
    storage = _save_visit_record(resolved_visit_id, update_doc)
    logger.info("Prescription saved for visit %s (%s)", resolved_visit_id, storage)

    scheduled_jobs = []
    tomorrow = now + timedelta(days=1)

    # 4. Schedule Medication Reminders via APScheduler:
    # If "Morning" is in timing, schedule for 09:00 next day. If "Lunch", 13:00. If "Night", 21:00.
    for med in prescriptions_list:
        m_name = med.get("medicine_name") or med.get("medicineName") or "Prescribed Medication"
        timing_raw = med.get("timing") or []
        if isinstance(timing_raw, list):
            timing_str = " ".join(str(t).lower() for t in timing_raw)
        else:
            timing_str = str(timing_raw).lower()

        slots_to_schedule = []
        if "morning" in timing_str:
            slots_to_schedule.append(("Morning", tomorrow.replace(hour=9, minute=0, second=0, microsecond=0)))
        if "lunch" in timing_str or "afternoon" in timing_str:
            slots_to_schedule.append(("Lunch", tomorrow.replace(hour=13, minute=0, second=0, microsecond=0)))
        if "night" in timing_str or "evening" in timing_str:
            slots_to_schedule.append(("Night", tomorrow.replace(hour=21, minute=0, second=0, microsecond=0)))

        for slot_name, calc_time in slots_to_schedule:
            try:
                if calc_time > now:
                    job = scheduler.add_job(
                        send_twilio_sms,
                        'date',
                        run_date=calc_time,
                        args=[
                            p_phone,
                            'meds',
                            {
                                "medicine_name": m_name,
                                "time_of_day": slot_name,
                                "patient_name": p_name,
                            },
                            p_lang,
                        ],
                    )
                    scheduled_jobs.append({
                        "job_id": job.id,
                        "type": f"meds_{slot_name.lower()}",
                        "medicine": m_name,
                        "run_date": calc_time.isoformat(),
                    })
            except Exception as exc:
                logger.warning("Gracefully skipping past/invalid med schedule (%s): %s", calc_time, exc)

    # 5. Schedule Appointment Reminders via APScheduler:
    # target_time - timedelta(days=1) (1 day before) and target_time - timedelta(minutes=10) (10 mins before)
    if next_appointment_str:
        try:
            clean_appt = next_appointment_str.replace("Z", "+00:00")
            target_time = datetime.fromisoformat(clean_appt)
            if target_time.tzinfo is not None:
                target_time = target_time.astimezone().replace(tzinfo=None)

            formatted_appt = target_time.strftime("%d %b at %I:%M %p")

            # 1 day before
            time_1_day_before = target_time - timedelta(days=1)
            try:
                if time_1_day_before > now:
                    job = scheduler.add_job(
                        send_twilio_sms,
                        'date',
                        run_date=time_1_day_before,
                        args=[
                            p_phone,
                            'appointment',
                            {
                                "appointment_time": formatted_appt,
                                "alert_type": "1_day_before",
                                "patient_name": p_name,
                            },
                            p_lang,
                        ],
                    )
                    scheduled_jobs.append({
                        "job_id": job.id,
                        "type": "appointment_1_day_before",
                        "run_date": time_1_day_before.isoformat(),
                    })
            except Exception as exc:
                logger.warning("Gracefully skipped past 1-day appointment schedule (%s): %s", time_1_day_before, exc)

            # 10 mins before
            time_10_min_before = target_time - timedelta(minutes=10)
            try:
                if time_10_min_before > now:
                    job = scheduler.add_job(
                        send_twilio_sms,
                        'date',
                        run_date=time_10_min_before,
                        args=[
                            p_phone,
                            'appointment',
                            {
                                "appointment_time": formatted_appt,
                                "alert_type": "10_mins_before",
                                "patient_name": p_name,
                            },
                            p_lang,
                        ],
                    )
                    scheduled_jobs.append({
                        "job_id": job.id,
                        "type": "appointment_10_mins_before",
                        "run_date": time_10_min_before.isoformat(),
                    })
            except Exception as exc:
                logger.warning("Gracefully skipped past 10-min appointment schedule (%s): %s", time_10_min_before, exc)

        except Exception as parse_err:
            logger.warning("Could not parse next_appointment string '%s': %s", next_appointment_str, parse_err)

    # Automatically schedule time-of-day voice reminders
    scheduled_voice = auto_schedule_prescription(
        visit_id=resolved_visit_id,
        patient_name=p_name,
        to_phone=p_phone,
        prescriptions=prescriptions_list,
        language=p_lang,
    )

    return {
        "status": "ok",
        "visit_id": resolved_visit_id,
        "prescription": primary_prescription,
        "prescriptions": prescriptions_list,
        "next_appointment": next_appointment_str,
        "scheduled_jobs": scheduled_jobs,
        "scheduled_slots": len(scheduled_voice),
        "scheduled_count": len(scheduled_jobs),
        "storage": storage,
        "updated_at": now_iso,
    }


@app.get("/visits/escalated")
def list_escalated_visits(
    include_accepted: bool = Query(default=True, description="Include cases already accepted by a doctor"),
) -> Dict[str, Any]:
    """Return visits with status 'escalated' (and optionally 'accepted') for the Doctor Dashboard."""
    target_statuses = {"escalated", "accepted"} if include_accepted else {"escalated"}
    visits_col = get_visits_collection()

    results: List[Dict[str, Any]] = []
    if visits_col is not None:
        for doc in visits_col.where("status", "in", list(target_statuses)).stream():
            item = doc.to_dict()
            item["visit_id"] = item.get("visit_id") or doc.id
            results.append(item)
    else:
        for item in _DEMO_VISITS_STORE.values():
            if item.get("status") in target_statuses:
                results.append(item)

    results.sort(
        key=lambda item: item.get("escalated_at") or item.get("updated_at") or item.get("created_at") or "",
        reverse=True,
    )
    return {
        "count": len(results),
        "visits": results,
        "storage": "firestore" if visits_col is not None else "demo_memory",
    }


@app.get("/visits")
@app.get("/api/visits")
def list_all_visits(limit: int = 100) -> Dict[str, Any]:
    """Return all patient visits from Firestore or demo memory store."""
    visits_col = get_visits_collection()
    results: List[Dict[str, Any]] = []
    if visits_col is not None:
        try:
            for doc in visits_col.order_by("created_at", direction="DESCENDING").limit(limit).stream():
                item = doc.to_dict()
                item["visit_id"] = item.get("visit_id") or doc.id
                results.append(item)
        except Exception:
            for doc in visits_col.stream():
                item = doc.to_dict()
                item["visit_id"] = item.get("visit_id") or doc.id
                results.append(item)
    if not results:
        results = list(_DEMO_VISITS_STORE.values())

    results.sort(
        key=lambda item: item.get("created_at") or item.get("updated_at") or item.get("evaluated_at") or "",
        reverse=True,
    )
    return {
        "count": len(results),
        "visits": results,
        "storage": "firestore" if visits_col is not None else "demo_memory",
    }


@app.post("/visits/sync")
def sync_offline_visits(
    payload: Union[VisitSyncRequest, List[VisitRecord]] = Body(...),
) -> Dict[str, Any]:
    """Bulk-write offline patient visits from the PWA queue into Firestore."""
    visits = payload.visits if isinstance(payload, VisitSyncRequest) else payload
    if not visits:
        return {"status": "ok", "synced_count": 0, "storage": "none", "synced_ids": []}

    synced_at = datetime.now(timezone.utc).isoformat()
    db = get_db()
    visits_col = get_visits_collection()
    patients_col = get_patients_collection()

    synced_ids: List[str] = []

    if db is not None and visits_col is not None:
        batch = db.batch()
        for visit in visits:
            doc_id = str(visit.visit_id or visit.local_id or uuid4())
            patient_id = visit.patient_id or f"pat-{visit.patient_name.strip().lower().replace(' ', '-')}-{visit.age}"
            phone = str(visit.phone_number or visit.phoneNumber or "").strip()
            lang = str(visit.language or "Tamil").strip()

            visit_doc = visit.model_dump()
            visit_doc["visit_id"] = doc_id
            visit_doc["patient_id"] = patient_id
            visit_doc["phone_number"] = phone
            visit_doc["phoneNumber"] = phone
            visit_doc["language"] = lang
            visit_doc["synced_at"] = synced_at

            if visit_doc.get("triage_result") is None:
                visit_doc["triage_result"] = calculate_triage(
                    visit.symptoms, visit.vitals, age=visit.age
                )

            batch.set(visits_col.document(doc_id), visit_doc, merge=True)

            if patients_col is not None:
                batch.set(
                    patients_col.document(patient_id),
                    {
                        "name": visit.patient_name,
                        "age": visit.age,
                        "phone": phone,
                        "last_visit_at": visit.created_at or synced_at,
                        "updated_at": synced_at,
                    },
                    merge=True,
                )

            synced_ids.append(doc_id)

        batch.commit()
        logger.info("Bulk-synced %d offline visits to Firestore.", len(synced_ids))
        return {
            "status": "ok",
            "synced_count": len(synced_ids),
            "storage": "firestore",
            "synced_ids": synced_ids,
            "synced_at": synced_at,
        }

    # Demo fallback when credentials.json has not yet been replaced with real service account keys.
    for visit in visits:
        doc_id = str(visit.visit_id or visit.local_id or uuid4())
        phone = str(visit.phone_number or visit.phoneNumber or "").strip()
        lang = str(visit.language or "Tamil").strip()
        record = visit.model_dump()
        record["visit_id"] = doc_id
        record["doc_id"] = doc_id
        record["phone_number"] = phone
        record["phoneNumber"] = phone
        record["language"] = lang
        record["synced_at"] = synced_at
        if record.get("triage_result") is None:
            record["triage_result"] = calculate_triage(
                visit.symptoms, visit.vitals, age=visit.age
            )
        existing = _DEMO_VISITS_STORE.get(doc_id, {})
        _DEMO_VISITS_STORE[doc_id] = {**existing, **record}
        synced_ids.append(doc_id)

    logger.info("Stored %d offline visits in demo memory buffer (Firestore placeholder mode).", len(synced_ids))
    return {
        "status": "ok",
        "synced_count": len(synced_ids),
        "storage": "demo_memory",
        "synced_ids": synced_ids,
        "synced_at": synced_at,
    }


@app.post("/admin/scrape-schemes")
def admin_scrape_schemes() -> Dict[str, Any]:
    """Scrape National Portal of India health schemes and refresh Firestore `health_schemes`."""
    return scrape_health_schemes()


@app.get("/facilities/recommend")
def recommend_facilities(
    severity: str = Query(default="Yellow", description="Triage severity: Red, Yellow, or Green"),
) -> Dict[str, Any]:
    """Return recommended rural healthcare facilities based on triage severity."""
    normalized = severity.strip().capitalize()
    if normalized not in MOCK_FACILITIES_BY_SEVERITY:
        normalized = "Yellow"

    return {
        "severity": normalized,
        "facilities": MOCK_FACILITIES_BY_SEVERITY[normalized],
    }


class TriggerCallRequest(BaseModel):
    patient_name: str = Field(..., description="Name of the patient")
    phone_number: str = Field(..., description="Phone number with country code, e.g. +919876543210")
    medicine_name: str = Field(..., description="Prescribed medicine name")
    instructions: str = Field(..., description="Medication instructions, e.g., 1 tablet after food")
    language: str = Field(default="Tamil", description="Target language (Tamil, Hindi, Telugu, English)")


@app.post("/admin/trigger-call")
async def trigger_call(payload: TriggerCallRequest) -> Dict[str, Any]:
    """
    Trigger an outbound Twilio voice reminder using an AI-generated native script.
    - Uses NVIDIA Nemotron to generate conversational 2-sentence instructions.
    - Constructs dynamic TwiML <Say language='...'>.
    - Executes Twilio call.create with aggressive error logging and TwilioRestException handling.
    """
    print(f"📥 [API HIT] Triggering Twilio for Patient: {payload.patient_name}, Exact Phone: {payload.phone_number}")

    # 1. AI Script Generation Logic
    generated_script = await generate_reminder_script(
        patient_name=payload.patient_name,
        medicine_name=payload.medicine_name,
        instructions=payload.instructions,
        language=payload.language,
    )

    # 2. Dynamic TwiML construction
    lang_tag = get_twilio_language_code(payload.language)
    twiml = f"<Response><Say language='{lang_tag}'>{generated_script}</Say></Response>"

    from_phone = os.getenv("TWILIO_PHONE_NUMBER", "+17372508034").strip()

    # Terminal Debug Prints as requested in Mission
    print("\n" + "=" * 70)
    print(" [TWILIO VOICE CALL TRIGGER DEBUG]")
    print(f" Patient Name    : {payload.patient_name}")
    print(f" Target Dialed   : {payload.phone_number}")
    print(f" From Phone      : {from_phone}")
    print(f" Language        : {payload.language} (Tag: {lang_tag})")
    print(" Generated TwiML :")
    print(twiml)
    print("=" * 70 + "\n")

    # 3. Outbound call placement with strict exception handling
    try:
        echo_url = f"https://twimlets.com/echo?Twiml={urllib.parse.quote(twiml)}"
        call = twilio_client.calls.create(
            to=payload.phone_number,
            from_=from_phone,
            url=echo_url,
        )
        call_sid = getattr(call, "sid", str(call))
        call_status = getattr(call, "status", "queued")
        return {
            "status": "success",
            "call_sid": call_sid,
            "call_status": call_status,
            "generated_script": generated_script,
            "to": payload.phone_number,
            "from": from_phone,
            "language": payload.language,
            "language_tag": lang_tag,
        }
    except Exception as e:
        print(f"❌ TWILIO API ERROR: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))


# ==============================================================================
# PHASE 4: Hackathon Time-Travel Endpoints (Bypass Scheduler for Live Demo)
# ==============================================================================

class TriggerMedsSMSRequest(BaseModel):
    phone_number: str = Field(..., description="Target phone number (E.164)")
    medicine_name: str = Field(default="Tab. Metformin 500mg", description="Prescribed medicine name")
    time_of_day: str = Field(default="Morning", description="Time of day: Morning, Lunch, or Night")
    language: str = Field(default="Tamil", description="Target language (Tamil, English, Hindi, Telugu)")
    patient_name: Optional[str] = Field(default="Patient", description="Patient name")


class TriggerApptSMSRequest(BaseModel):
    phone_number: str = Field(..., description="Target phone number (E.164)")
    appointment_time: str = Field(default="Tomorrow at 10:00 AM", description="Appointment time description")
    alert_type: str = Field(default="1_day_before", description="Alert interval: 1_day_before or 10_mins_before")
    language: str = Field(default="Tamil", description="Target language (Tamil, English, Hindi, Telugu)")
    patient_name: Optional[str] = Field(default="Patient", description="Patient name")


@app.post("/admin/trigger-sms/meds")
async def trigger_sms_meds(payload: TriggerMedsSMSRequest) -> Dict[str, Any]:
    """
    Hackathon time-travel endpoint: instantly dispatches an automated medication SMS reminder
    via Twilio and NVIDIA Nemotron. Bypasses the scheduler clock for live demonstration.
    """
    print(f"📥 [API HIT] Triggering Twilio for Patient: {payload.patient_name}, Exact Phone: {payload.phone_number}")
    result = await send_twilio_sms(
        phone_number=payload.phone_number,
        context_type="meds",
        details={
            "medicine_name": payload.medicine_name,
            "time_of_day": payload.time_of_day,
            "patient_name": payload.patient_name,
        },
        language=payload.language,
    )
    return result


@app.post("/admin/trigger-sms/appointment")
async def trigger_sms_appointment(payload: TriggerApptSMSRequest) -> Dict[str, Any]:
    """
    Hackathon time-travel endpoint: instantly dispatches an automated appointment follow-up SMS
    via Twilio and NVIDIA Nemotron. Bypasses the scheduler clock for live demonstration.
    """
    print(f"📥 [API HIT] Triggering Twilio for Patient: {payload.patient_name}, Exact Phone: {payload.phone_number}")
    result = await send_twilio_sms(
        phone_number=payload.phone_number,
        context_type="appointment",
        details={
            "appointment_time": payload.appointment_time,
            "alert_type": payload.alert_type,
            "patient_name": payload.patient_name,
        },
        language=payload.language,
    )
    return result


class ReminderCallRequest(BaseModel):
    to_phone: str = Field(..., description="Recipient phone number (E.164)")
    message_ta: str = Field(..., description="Tamil voice reminder text")
    patient_name: Optional[str] = Field(default="Patient", description="Patient name")
    voice: Optional[str] = Field(default="Google.ta-IN-Standard-A", description="Twilio Google Tamil voice")


@app.post("/reminders/call")
async def reminders_call(payload: ReminderCallRequest) -> Dict[str, Any]:
    """
    Trigger an outbound Tamil voice reminder call via Twilio.
    Trial compliant: uses echo URL with encoded TwiML (To, From, Url only).
    Wraps twilio_client.calls.create in strict try/except Exception as e.
    """
    clean_to = normalize_phone(payload.to_phone)
    from_phone = os.getenv("TWILIO_PHONE_NUMBER", os.getenv("TWILIO_FROM_NUMBER", "+17372508034")).strip()
    safe_msg = payload.message_ta.strip() or "வணக்கம், இது மருத்துவ நினைவூட்டல்."
    voice = payload.voice or "Google.ta-IN-Standard-A"

    twiml = f"<Response><Pause length='1'/><Say language='ta-IN' voice='{voice}'>{safe_msg}</Say></Response>"
    echo_url = f"https://twimlets.com/echo?Twiml={urllib.parse.quote(twiml)}"

    print("\n" + "=" * 70)
    print(" [TWILIO REMINDERS CALL TRIGGER]")
    print(f" Patient Name    : {payload.patient_name}")
    print(f" Target Dialed   : {clean_to}")
    print(f" From Phone      : {from_phone}")
    print(f" Voice           : {voice}")
    print(f" Generated TwiML : {twiml}")
    print(f" Echo URL        : {echo_url}")
    print("=" * 70 + "\n")

    try:
        call = twilio_client.calls.create(
            to=clean_to,
            from_=from_phone,
            url=echo_url,
        )
        call_sid = getattr(call, "sid", str(call))
        call_status = getattr(call, "status", "queued")

        db_save_reminder({
            "id": f"rem-{uuid4().hex[:8]}",
            "patient_name": payload.patient_name,
            "to_phone": clean_to,
            "message_ta": safe_msg,
            "voice": voice,
            "status": call_status,
            "call_sid": call_sid,
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        })

        return {
            "ok": True,
            "status": "queued",
            "call_sid": call_sid,
            "to_phone": clean_to,
            "from_phone": from_phone,
            "message": f"Twilio call initiated (SID: {call_sid})",
        }
    except Exception as e:
        print(f"❌ TWILIO API ERROR: {str(e)}")
        try:
            db_save_reminder({
                "id": f"rem-{uuid4().hex[:8]}",
                "patient_name": payload.patient_name,
                "to_phone": clean_to,
                "message_ta": safe_msg,
                "voice": voice,
                "status": "failed",
                "error_detail": str(e),
                "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            })
        except Exception:
            pass
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/reminders/status")
def reminders_status() -> Dict[str, Any]:
    """Return status of Twilio voice reminder service."""
    return get_reminder_system_status()


@app.get("/reminders")
def reminders_list(limit: int = 50) -> Dict[str, Any]:
    """Return recent voice reminders from SQLite."""
    return {"reminders": db_get_reminders(limit=limit)}


class TunnelUrlRequest(BaseModel):
    public_tunnel_url: str


@app.post("/reminders/tunnel-url")
def reminders_set_tunnel(payload: TunnelUrlRequest) -> Dict[str, Any]:
    """Update active public tunnel URL."""
    url = set_public_tunnel_url(payload.public_tunnel_url)
    return {"status": "ok", "public_tunnel_url": url}


@app.get("/reminders/call-status/{call_sid}")
def reminders_call_status(call_sid: str) -> Dict[str, Any]:
    """Check Twilio call status."""
    return fetch_call_status(call_sid)


@app.get("/twiml")
@app.post("/twiml")
def serve_twiml(msg: str = Query(default=""), voice: str = Query(default="Google.ta-IN-Standard-A")):
    """Serve TwiML XML document for Twilio call execution."""
    xml_content = build_twiml_xml(msg, voice)
    return Response(content=xml_content, media_type="application/xml")


@app.get("/reminders/schedules")
def list_scheduled_reminders() -> Dict[str, Any]:
    """Return all automated prescription reminder schedules along with current time-of-day slot."""
    schedules = db_get_scheduled_reminders()
    now = datetime.now()
    current_slot = get_time_of_day(now.hour)
    return {
        "schedules": schedules,
        "count": len(schedules),
        "current_time": now.strftime("%H:%M:%S"),
        "current_slot": current_slot,
        "auto_dispatch_enabled": is_auto_dispatch_enabled(),
    }


@app.post("/reminders/schedules/{schedule_id}/trigger")
def trigger_scheduled_call_endpoint(schedule_id: str) -> Dict[str, Any]:
    """MANUAL PUSH: Immediately trigger a scheduled reminder call for this patient and time slot."""
    result = execute_scheduled_call_sync(schedule_id, is_manual=True)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("message", "Call failed"))
    return result


class ToggleScheduleAutoRequest(BaseModel):
    is_auto: bool


@app.patch("/reminders/schedules/{schedule_id}/toggle-auto")
def toggle_schedule_auto(schedule_id: str, payload: ToggleScheduleAutoRequest) -> Dict[str, Any]:
    """Toggle auto-dispatch on/off for a specific schedule."""
    db_toggle_schedule_auto(schedule_id, payload.is_auto)
    return {"status": "ok", "schedule_id": schedule_id, "is_auto": payload.is_auto}


class ToggleGlobalAutoRequest(BaseModel):
    enabled: bool


@app.post("/reminders/schedules/toggle-global")
def toggle_global_auto(payload: ToggleGlobalAutoRequest) -> Dict[str, Any]:
    """Globally enable or pause automatic background calling."""
    state = set_auto_dispatch_enabled(payload.enabled)
    return {"status": "ok", "auto_dispatch_enabled": state}


class PreviewScriptRequest(BaseModel):
    patient_name: str = "முத்துசாமி"
    medicine_name: str = "Tab. Metformin 500mg"
    dosage: str = "1 Tablet"
    time_slot: str = "morning"  # morning, afternoon, night, auto
    food_context: str = "After Food"  # Before Food, After Food, With Food
    language: str = "Tamil"


@app.post("/reminders/preview-script")
async def preview_script_endpoint(payload: PreviewScriptRequest) -> Dict[str, Any]:
    """Dynamically preview the time-of-day & food-context customized voice script."""
    script = await generate_contextual_reminder_script(
        patient_name=payload.patient_name,
        medicine_name=payload.medicine_name,
        dosage=payload.dosage,
        time_slot=payload.time_slot,
        food_context=payload.food_context,
        language=payload.language,
    )
    lang_tag = get_twilio_language_code(payload.language)
    return {
        "status": "ok",
        "generated_script": script,
        "time_slot": payload.time_slot,
        "food_context": payload.food_context,
        "language": payload.language,
        "language_tag": lang_tag,
    }


@app.post("/reminders/schedules/seed-demo")
def seed_demo_schedules_endpoint() -> Dict[str, Any]:
    """Seed sample prescription schedules for instant dashboard demonstration."""
    seed_demo_scheduled_reminders()
    return {"status": "ok", "schedules": db_get_scheduled_reminders()}


