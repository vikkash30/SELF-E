"""FastAPI application for CareSync rural healthcare triage, IoT intake, and teleconsultation."""

import logging
import os
import urllib.parse
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Union
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import Body, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
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
from triage_core import calculate_triage

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("caresync.api")

# Twilio Client Initialization (Phase 1)
twilio_client = Client(os.getenv("TWILIO_ACCOUNT_SID"), os.getenv("TWILIO_AUTH_TOKEN"))

app = FastAPI(
    title="CareSync API",
    description="Offline-first AI triage, IoT vital ingestion, and doctor escalation backend.",
    version="1.1.0",
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
    status: str = Field(..., description="e.g., 'okay', 'escalated', 'accepted', 'completed'")
    patient_name: Optional[str] = None
    gender: Optional[str] = None
    age: Optional[int] = None
    country: Optional[str] = None
    state: Optional[str] = None
    city: Optional[str] = None
    symptoms: Optional[str] = None
    vitals: Optional[Dict[str, Any]] = None
    triage_result: Optional[Dict[str, Any]] = None
    prescription: Optional[Dict[str, Any]] = None
    notes: Optional[str] = None


class VisitRecord(BaseModel):
    local_id: Optional[Union[str, int]] = None
    visit_id: Optional[str] = None
    patient_id: Optional[str] = None
    patient_name: str
    gender: Optional[str] = None
    age: int = Field(ge=0, le=120)
    country: Optional[str] = "India"
    state: Optional[str] = "Tamil Nadu"
    city: Optional[str] = "Coimbatore"
    symptoms: str
    vitals: Dict[str, Any]
    triage_result: Optional[Dict[str, Any]] = None
    prescription: Optional[Dict[str, Any]] = None
    status: Optional[str] = "triaged"
    created_at: Optional[str] = None
    ration_shop_id: Optional[str] = "FPS-RURAL-01"


class VisitSyncRequest(BaseModel):
    visits: List[VisitRecord]


def _save_visit_record(visit_id: str, doc: Dict[str, Any]) -> str:
    """Persist a visit document to Firestore if connected, else demo memory."""
    visits_col = get_visits_collection()
    if visits_col is not None:
        visits_col.document(visit_id).set(doc, merge=True)
        return "firestore"
    existing = _DEMO_VISITS_STORE.get(visit_id, {})
    _DEMO_VISITS_STORE[visit_id] = {**existing, **doc, "visit_id": visit_id}
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

    visit_doc = {
        "visit_id": visit_id,
        "patient_name": (payload.patient_name or "Unknown Patient").strip(),
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


@app.post("/visits/{visit_id}/prescription")
@app.patch("/visits/{visit_id}/prescription")
def save_visit_prescription(visit_id: str, payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Store or update prescription details issued by the consulting doctor and auto-schedule reminders."""
    now_iso = datetime.now(timezone.utc).isoformat()
    prescriptions_data = payload.get("prescriptions") or payload.get("prescription", payload)
    prescription_data = payload.get("prescription") or (
        prescriptions_data[0] if isinstance(prescriptions_data, list) and prescriptions_data else prescriptions_data
    )
    update_doc: Dict[str, Any] = {
        "visit_id": visit_id,
        "prescription": prescription_data,
        "prescriptions": prescriptions_data if isinstance(prescriptions_data, list) else [prescription_data],
        "updated_at": now_iso,
    }
    storage = _save_visit_record(visit_id, update_doc)
    logger.info("Prescription saved for visit %s (%s)", visit_id, storage)

    # Automatically schedule time-of-day voice reminders (Morning, Afternoon, Night)
    patient_record = _DEMO_VISITS_STORE.get(visit_id, {})
    p_name = patient_record.get("patient_name") or payload.get("patient_name") or "Patient"
    p_phone = (
        patient_record.get("phoneNumber")
        or patient_record.get("phone_number")
        or payload.get("phone_number")
        or DEFAULT_TO_NUMBER
    )
    scheduled = auto_schedule_prescription(
        visit_id=visit_id,
        patient_name=p_name,
        to_phone=p_phone,
        prescriptions=prescriptions_data,
        language="Tamil",
    )

    return {
        "status": "ok",
        "visit_id": visit_id,
        "prescription": prescription_data,
        "prescriptions": prescriptions_data if isinstance(prescriptions_data, list) else [prescription_data],
        "scheduled_slots": len(scheduled),
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

            visit_doc = visit.model_dump()
            visit_doc["visit_id"] = doc_id
            visit_doc["patient_id"] = patient_id
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
        record = visit.model_dump()
        record["visit_id"] = doc_id
        record["doc_id"] = doc_id
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
    - Uses NVIDIA Llama 3.1 to generate conversational 2-sentence instructions.
    - Constructs dynamic TwiML <Say language='...'>.
    - Executes Twilio call.create with aggressive error logging and TwilioRestException handling.
    """
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

    # 3. Format and validate phone number to E.164 (+91 prefix for Indian numbers)
    raw_phone = payload.phone_number.strip()
    digits_only = "".join(ch for ch in raw_phone if ch.isdigit())
    if raw_phone.startswith("+"):
        to_phone = raw_phone
    elif len(digits_only) == 10:
        to_phone = f"+91{digits_only}"
    elif len(digits_only) > 10:
        to_phone = f"+{digits_only}"
    else:
        to_phone = f"+91{raw_phone}"

    from_phone = os.getenv("TWILIO_PHONE_NUMBER", "+17372508034").strip()

    # Terminal Debug Prints as requested in Mission
    print("\n" + "=" * 70)
    print(" [TWILIO VOICE CALL TRIGGER DEBUG]")
    print(f" Patient Name    : {payload.patient_name}")
    print(f" Target Dialed   : {to_phone} (E.164 verification: {'VALID +91' if to_phone.startswith('+91') else 'NON-+91'})")
    print(f" From Phone      : {from_phone}")
    print(f" Language        : {payload.language} (Tag: {lang_tag})")
    print(" Generated TwiML :")
    print(twiml)
    print("=" * 70 + "\n")

    # 4. Outbound call placement with strict exception handling (Phase 2)
    try:
        echo_url = f"https://twimlets.com/echo?Twiml={urllib.parse.quote(twiml)}"
        call = twilio_client.calls.create(
            to=to_phone,
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
            "to": to_phone,
            "from": from_phone,
            "language": payload.language,
            "language_tag": lang_tag,
        }
    except Exception as e:
        print(f"❌ TWILIO API ERROR: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))


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


