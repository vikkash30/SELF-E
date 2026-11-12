"""Data-driven stress tests for the CareSync backend and data-flow logic.

Run from the backend directory:
    .venv/Scripts/python.exe -m pytest test_system_stress.py -v
"""

import asyncio
import json
import math
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

import httpx
import pytest
import pytest_asyncio
from twilio.base.exceptions import TwilioRestException
from xml.etree import ElementTree

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import database  # noqa: E402
import main  # noqa: E402
import triage_core  # noqa: E402

APP_URL = "http://caresync.test"
MAP_COMPONENT = BACKEND_DIR.parent / "frontend" / "src" / "components" / "HospitalMap.jsx"

# Schemes that any patient qualifies for regardless of demographic profile.
UNIVERSAL_SCHEME_PATTERNS = (
    "ayushman bharat",
    "pmjay",
    "jan arogya",
    "janaushadhi",
    "arogya mandir",
)

ELDERLY_OR_WOMEN_SCHEME_PATTERNS = (
    "elderly",
    "nphce",
    "janani",
    "jsy",
    "matru",
    "pmmvy",
    "women",
    "maternal",
)

HAS_LLM_KEY = os.environ.get("NVIDIA_API_KEY", "").strip().startswith("nvapi-")


@pytest_asyncio.fixture
async def client():
    """In-process ASGI client: exercises real routing/validation without a network server."""
    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(transport=transport, base_url=APP_URL) as async_client:
        yield async_client


# --------------------------------------------------------------------------------------
# PHASE 1: Data-driven triage personas
# --------------------------------------------------------------------------------------

PERSONAS = [
    pytest.param(
        {
            "id": "persona-A-red-flag",
            "payload": {
                "patient_name": "Persona A",
                "age": 45,
                "gender": "Male",
                "symptoms": "Chest pain",
                "vitals": {"temperature": 98.6, "spo2": 88, "heart_rate": 110},
            },
            "expected_severity": "Red",
        },
        id="persona-A-red-flag",
    ),
    pytest.param(
        {
            "id": "persona-B-target-demographic",
            "payload": {
                "patient_name": "Persona B",
                "age": 72,
                "gender": "Female",
                "symptoms": "Severe joint pain and blurry vision",
                "vitals": {"temperature": 99.1, "spo2": 96, "heart_rate": 75},
            },
            "expected_severity": "Yellow",
        },
        id="persona-B-target-demographic",
    ),
    pytest.param(
        {
            "id": "persona-C-routine",
            "payload": {
                "patient_name": "Persona C",
                "age": 22,
                "gender": "Male",
                "symptoms": "Mild headache",
                "vitals": {"temperature": 98.6, "spo2": 98, "heart_rate": 70},
            },
            "expected_severity": "Green",
        },
        id="persona-C-routine",
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("persona", PERSONAS)
async def test_triage_personas(client: httpx.AsyncClient, persona: Dict[str, Any], monkeypatch):
    """Each persona must land in its expected severity bucket with a valid scheme payload."""
    payload = persona["payload"]

    # Persona A must never reach the LLM: any attempt to build an LLM client is a hard
    # failure. Personas B/C are supposed to reach the AI stage, so record that they do.
    llm_calls: List[int] = []

    def _forbidden_llm_call():
        raise AssertionError(
            "LLM was invoked for a hard-coded red-flag case; vitals rule did not short-circuit."
        )

    def _recording_llm_call():
        llm_calls.append(1)
        return None  # No configured key -> deterministic engine takes over.

    if persona["id"] == "persona-A-red-flag":
        monkeypatch.setattr(triage_core, "_get_nvidia_client", _forbidden_llm_call)
    else:
        monkeypatch.setattr(triage_core, "_get_nvidia_client", _recording_llm_call)

    started = time.perf_counter()
    response = await client.post("/triage", json=payload)
    elapsed = time.perf_counter() - started

    assert response.status_code == 200, response.text
    body = response.json()
    triage = body["triage"]

    assert triage["severity"] == persona["expected_severity"], (
        f"{persona['id']}: expected severity {persona['expected_severity']!r}, "
        f"got {triage['severity']!r} (source={triage.get('source')}, reason={triage.get('reason')!r})"
    )
    assert triage["classification"], f"{persona['id']}: classification missing"
    assert triage["recommended_action"], f"{persona['id']}: recommended_action missing"
    assert isinstance(triage["red_flags_to_watch"], list)

    schemes = triage["eligible_schemes"]
    assert isinstance(schemes, list)

    for scheme in schemes:
        assert isinstance(scheme.get("name"), str) and scheme["name"].strip(), (
            f"{persona['id']}: scheme entry without a usable name: {scheme!r}"
        )
        assert "requires_verification" in scheme or "match_percentage" in scheme, (
            f"{persona['id']}: scheme entry must have requires_verification or match_percentage: {scheme!r}"
        )
        if "requires_verification" in scheme:
            assert isinstance(scheme["requires_verification"], bool)
        if "match_percentage" in scheme and scheme["match_percentage"] is not None:
            assert isinstance(scheme["match_percentage"], int)
            assert 0 <= scheme["match_percentage"] <= 100
        assert isinstance(scheme.get("reason"), str) and scheme["reason"].strip()

    if persona["id"] == "persona-A-red-flag":
        assert triage["source"] == "hard_rules", (
            f"SpO2=88 should trigger the deterministic rule, got source={triage.get('source')!r}"
        )
        assert "spo2" in (triage["reason"] or "").lower(), (
            f"Red reason should cite the low SpO2 trigger, got {triage['reason']!r}"
        )
        assert elapsed < 1.5, f"Red-flag triage took {elapsed:.3f}s; expected an instant rule match"
        assert body["recommended_facilities"], "Red triage must return emergency facilities"

    elif persona["id"] == "persona-B-target-demographic":
        assert llm_calls == [1], "Persona B never reached the AI stage; a hard rule short-circuited it"
        if not HAS_LLM_KEY:
            assert triage["source"].startswith("fallback"), triage["source"]
        assert schemes, "Yellow elderly patient must receive at least one eligible scheme"
        matched = [
            s for s in schemes
            if any(p in s["name"].lower() for p in ELDERLY_OR_WOMEN_SCHEME_PATTERNS)
        ]
        assert matched, (
            "No elderly/women's scheme matched for a 72-year-old female; "
            f"returned schemes: {[s['name'] for s in schemes]}"
        )
        assert any(
            s.get("match_percentage", 100) > 50 or s.get("requires_verification") is False
            for s in matched
        ), (
            f"Elderly/women's scheme match was not confident: {matched}"
        )

    elif persona["id"] == "persona-C-routine":
        assert llm_calls == [1], "Persona C never reached the AI stage; a hard rule short-circuited it"
        non_universal = [
            s["name"] for s in schemes
            if not any(p in s["name"].lower() for p in UNIVERSAL_SCHEME_PATTERNS)
        ]
        assert len(schemes) == 0 or not non_universal, (
            "Green triage returned non-universal schemes: " f"{non_universal}"
        )


@pytest.mark.asyncio
async def test_triage_concurrent_mixed_personas(client: httpx.AsyncClient):
    """Concurrent mixed-persona load: every request stays correct and isolated."""
    requests = (PERSONAS * 2)  # 6 requests across the 3 personas
    results = await asyncio.gather(
        *[client.post("/triage", json=p.values[0]["payload"]) for p in requests]
    )

    expected = [p.values[0]["expected_severity"] for p in requests]
    actual = [r.json()["triage"]["severity"] for r in results]

    assert all(r.status_code == 200 for r in results), [r.status_code for r in results]
    assert actual == expected, f"Concurrency mismatch: expected {expected}, got {actual}"
    visit_ids = {r.json()["visit_id"] for r in results}
    assert len(visit_ids) == len(results), "Concurrent triage calls reused a visit_id"


# --------------------------------------------------------------------------------------
# PHASE 2: Firebase session workflow (Operator -> IoT -> Operator)
# --------------------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_operator_iot_operator_workflow(client: httpx.AsyncClient):
    """Operator creates a session, IoT reads it and pushes vitals, Operator reads vitals back."""
    patient_id = 4521
    try:
        # 1. Operator writes the active session (Firestore when connected, demo buffer otherwise).
        write = await client.post(
            "/session/current",
            json={"patientId": patient_id, "name": "Test User", "gender": "Male"},
        )
        assert write.status_code == 200, write.text
        session_write = write.json()["session"]
        assert session_write["patientId"] == patient_id
        assert isinstance(session_write["patientId"], int)
        assert session_write["name"] == "Test User"
        assert session_write["gender"] == "Male"

        # 2. IoT reads the session back.
        read = await client.get("/session/current")
        assert read.status_code == 200, read.text
        session_read = read.json()["session"]
        assert session_read is not None, "Active session was not persisted"
        assert session_read["patientId"] == patient_id
        assert session_read["name"] == "Test User"
        assert session_read["gender"] == "Male"
        assert isinstance(session_read.get("updated_at"), str) and session_read["updated_at"]

        # 3. IoT pushes vitals into the visits collection for that patientId.
        iot_payload = {
            "patient_id": session_read["patientId"],
            "patient_name": session_read["name"],
            "gender": session_read["gender"],
            "age": 45,
            "vitals": {"spo2": 96.5, "temperature": 99.1, "heart_rate": 78},
            "device_id": "IOT-KITS-STRESS-01",
        }
        push = await client.post("/iot/readings", json=iot_payload)
        assert push.status_code == 200, push.text
        push_body = push.json()
        assert push_body["status"] == "ok"
        assert push_body["storage"] in {"firestore", "demo_memory"}

        reading = push_body["reading"]
        assert reading["patient_id"] == patient_id
        assert reading["patient_name"] == "Test User"
        assert reading["gender"] == "Male"
        assert reading["age"] == 45
        assert reading["status"] == "iot_pending"
        assert reading["device_id"] == "IOT-KITS-STRESS-01"
        # VitalsInput declares every measurement as float, so Pydantic coerces ints.
        assert isinstance(reading["vitals"]["spo2"], float)
        assert isinstance(reading["vitals"]["temperature"], float)
        assert isinstance(reading["vitals"]["heart_rate"], float)
        assert reading["vitals"] == {"spo2": 96.5, "temperature": 99.1, "heart_rate": 78.0}

        # 4. Operator reads the vitals back out of the buffer.
        latest = await client.get("/iot/latest")
        assert latest.status_code == 200, latest.text
        latest_reading = latest.json()["reading"]
        assert latest_reading is not None, "IoT reading was not retrievable for the operator"
        assert latest_reading["visit_id"] == reading["visit_id"]
        assert latest_reading["vitals"] == reading["vitals"]
        assert latest_reading["patient_name"] == "Test User"
    finally:
        await client.delete("/session/current")


@pytest.mark.skipif(
    not database.is_firestore_connected(),
    reason="Firestore is disabled: credentials.json holds placeholder keys",
)
def test_firestore_direct_session_and_visit_roundtrip():
    """Direct Firestore round-trip for active_sessions/current and visits/{id}."""
    db = database.get_db()
    active_ref = db.collection("active_sessions").document("current")
    visit_ref = db.collection("visits").document("stress-visit-001")

    try:
        active_ref.set({"patientId": 4521, "name": "Test User", "gender": "Male"})
        snap = active_ref.get()
        assert snap.exists, "active_sessions/current was not created"
        data = snap.to_dict()
        assert data["patientId"] == 4521 and isinstance(data["patientId"], int)
        assert data["name"] == "Test User" and data["gender"] == "Male"

        visit_ref.set(
            {
                "visit_id": "stress-visit-001",
                "patient_id": 4521,
                "patient_name": "Test User",
                "vitals": {"spo2": 96.5, "temperature": 99.1, "heart_rate": 78},
                "status": "iot_pending",
            },
            merge=True,
        )
        visit = visit_ref.get().to_dict()
        assert visit["patient_id"] == 4521
        assert isinstance(visit["vitals"]["spo2"], float)
    finally:
        active_ref.delete()
        visit_ref.delete()


# --------------------------------------------------------------------------------------
# PHASE 3: Haversine routing (patient 10.9000, 76.9000)
# --------------------------------------------------------------------------------------

PATIENT_LOCATION = (10.9000, 76.9000)

HOSPITALS = [
    {"id": "near-tele", "name": "CareSync Telemedicine Desk", "lat": 10.9005, "lng": 76.9010},
    {"id": "mid-hwc", "name": "Ettimadai Health & Wellness Centre", "lat": 10.8892, "lng": 76.8935},
    {"id": "far-chc", "name": "Kinathukadavu CHC", "lat": 10.9500, "lng": 76.9300},
    {"id": "extreme-500km", "name": "500km Reference Hospital", "lat": 15.4000, "lng": 76.9000},
]


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Python mirror of frontend `calculateDistance` (HospitalMap.jsx)."""
    radius = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def rank_facilities(patient, facilities: List[Dict[str, Any]], limit: int = 3):
    """Mirror of the map/sort/slice pipeline in HospitalMap.jsx."""
    ranked = [
        {**fac, "distanceKm": haversine_km(patient[0], patient[1], fac["lat"], fac["lng"])}
        for fac in facilities
        if not (math.isnan(fac["lat"]) or math.isnan(fac["lng"]))
    ]
    ranked.sort(key=lambda item: item["distanceKm"])
    return ranked[:limit]


def _extract_js_function(source: str, function_name: str) -> str:
    """Slice an exported JS function out of the source file by brace matching."""
    start = source.index(f"export function {function_name}")
    brace_start = source.index("{", start)
    depth = 0
    for index in range(brace_start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start : index + 1].replace("export ", "", 1)
    raise AssertionError(f"Could not extract {function_name} from {MAP_COMPONENT}")


def test_haversine_sorting_drops_furthest_hospital():
    """Ascending distance order is preserved and the 500km outlier is dropped."""
    ranked = rank_facilities(PATIENT_LOCATION, HOSPITALS)

    assert len(ranked) == 3, f"Expected top-3 hospitals, got {len(ranked)}"

    distances = [f["distanceKm"] for f in ranked]
    assert distances == sorted(distances), f"Distances are not ascending: {distances}"

    ids = [f["id"] for f in ranked]
    assert "extreme-500km" not in ids, f"500km hospital was not dropped: {ids}"
    assert "near-tele" in ids, f"Nearest facility missing from results: {ids}"

    far = next(f for f in HOSPITALS if f["id"] == "extreme-500km")
    far_km = haversine_km(*PATIENT_LOCATION, far["lat"], far["lng"])
    assert 495 <= far_km <= 505, f"Reference hospital should be ~500km away, computed {far_km:.1f}km"
    assert far_km > max(distances), "Outlier distance should exceed every kept facility"

    assert distances[0] < 0.2, f"Nearest facility should be < 200m, computed {distances[0]:.3f}km"
    for fac in ranked:
        assert fac["distanceKm"] > 0


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js not available for JS parity check")
def test_haversine_matches_shipped_js_implementation():
    """The Python mirror must agree with the real calculateDistance shipped in the frontend."""
    assert MAP_COMPONENT.exists(), f"Map component not found at {MAP_COMPONENT}"
    js_function = _extract_js_function(MAP_COMPONENT.read_text(encoding="utf-8"), "calculateDistance")

    points = [(PATIENT_LOCATION[0], PATIENT_LOCATION[1], h["lat"], h["lng"]) for h in HOSPITALS]
    script = (
        f"{js_function}\n"
        f"const pts = {json.dumps(points)};\n"
        "console.log(JSON.stringify(pts.map((p) => calculateDistance(p[0], p[1], p[2], p[3]))));\n"
    )
    completed = subprocess.run(
        ["node", "-e", script], capture_output=True, text=True, timeout=30, check=True
    )
    js_distances = json.loads(completed.stdout)

    for point, js_km in zip(points, js_distances):
        py_km = haversine_km(*point)
        assert math.isclose(js_km, py_km, rel_tol=1e-9, abs_tol=1e-9), (
            f"Haversine drift for {point}: JS={js_km}, Python={py_km}"
        )


class _FakeCall:
    sid = "CAstub000000000000000000000000000"
    status = "queued"


class _FakeCalls:
    def __init__(self):
        self.attempts = []

    def create(self, **kwargs):
        self.attempts.append(kwargs)
        return _FakeCall()


class _FakeTwilioClient:
    """Stands in for twilio.rest.Client so tests never dial a real phone number."""

    last = None
    reject_inline_twiml = False

    def __init__(self, sid, token):
        self.calls = _FakeCalls()
        _FakeTwilioClient.last = self
        if _FakeTwilioClient.reject_inline_twiml:
            self.calls.create = self._reject_twiml

    def _reject_twiml(self, **kwargs):
        self.calls.attempts.append(kwargs)
        if "url" in kwargs:
            return _FakeCall()
        raise TwilioRestException(
            400,
            "https://api.twilio.com/x",
            "Invalid or disallowed parameters provided - trial accounts have limited "
            "parameter access",
            code=0,
        )


@pytest.mark.asyncio
async def test_admin_trigger_call_endpoint(client: httpx.AsyncClient, monkeypatch):
    """Script generation + TwiML contract for the exact {phone_number, tamil_text} payload."""
    monkeypatch.setattr(main, "Client", _FakeTwilioClient)
    _FakeTwilioClient.reject_inline_twiml = False

    tamil = 'மருந்து "தினமும்" <சாப்பிடுங்கள்> & ஓய்வு'
    resp = await client.post(
        "/admin/trigger-call",
        json={"phone_number": "9994577702", "tamil_text": tamil},
    )

    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["status"] == "success"
    assert data["call_sid"] == _FakeCall.sid
    assert data["to"] == "+919994577702"
    assert data["language_tag"] == "ta-IN"

    kwargs = _FakeTwilioClient.last.calls.attempts[-1]
    assert "url" not in kwargs, "Inline TwiML should be attempted first"
    twiml_root = ElementTree.fromstring(kwargs["twiml"])
    say = twiml_root.find("Say")
    assert say is not None and say.get("language") == "ta-IN"
    assert say.text == tamil, "Tamil text must round-trip; XML special chars must be escaped"


@pytest.mark.asyncio
async def test_trigger_call_legacy_dashboard_payload(client: httpx.AsyncClient, monkeypatch):
    """ReminderDashboard's payload (no tamil_text) must still generate a native script."""
    monkeypatch.setattr(main, "Client", _FakeTwilioClient)
    _FakeTwilioClient.reject_inline_twiml = False

    resp = await client.post(
        "/admin/trigger-call",
        json={
            "patient_name": "Muthusamy",
            "phone_number": "+919994577702",
            "medicine_name": "Paracetamol 650mg",
            "instructions": "1 tablet morning and night after food",
            "language": "Tamil",
        },
    )

    assert resp.status_code == 200, resp.text
    assert "Muthusamy" in resp.json()["generated_script"]


@pytest.mark.asyncio
async def test_trigger_call_falls_back_to_url_on_trial_account(client: httpx.AsyncClient, monkeypatch):
    """Trial accounts reject inline TwiML; the call must retry with a TwiML URL."""
    monkeypatch.setattr(main, "Client", _FakeTwilioClient)
    _FakeTwilioClient.reject_inline_twiml = True
    monkeypatch.setattr(main, "get_public_tunnel_url", lambda: "")

    try:
        resp = await client.post(
            "/admin/trigger-call",
            json={"phone_number": "+919994577702", "tamil_text": "வணக்கம்"},
        )
    finally:
        _FakeTwilioClient.reject_inline_twiml = False

    assert resp.status_code == 200, resp.text
    attempts = _FakeTwilioClient.last.calls.attempts
    assert len(attempts) == 2, "Expected inline attempt then URL fallback"
    assert "twiml" in attempts[0]
    assert "url" in attempts[1] and attempts[1]["url"].startswith("https://")


@pytest.mark.asyncio
async def test_trigger_call_reports_twilio_rejection(client: httpx.AsyncClient, monkeypatch):
    """A non-trial Twilio error must surface the real reason instead of failing silently."""
    monkeypatch.setattr(main, "Client", _FakeTwilioClient)

    original_create = _FakeTwilioClient.__init__

    def _reject_unverified(self, sid, token):
        original_create(self, sid, token)
        def _boom(**kwargs):
            raise TwilioRestException(
                400, "https://api.twilio.com/x", "The number is unverified", code=21219
            )
        self.calls.create = _boom

    monkeypatch.setattr(_FakeTwilioClient, "__init__", _reject_unverified)

    resp = await client.post(
        "/admin/trigger-call",
        json={"phone_number": "+919994577702", "tamil_text": "வணக்கம்"},
    )

    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert "21219" in detail and "unverified" in detail.lower()


@pytest.mark.asyncio
async def test_trigger_call_missing_credentials(client: httpx.AsyncClient, monkeypatch):
    """Missing .env credentials must fail loudly with 500, not a fake success."""
    for key in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "TWILIO_FROM_NUMBER"):
        monkeypatch.delenv(key, raising=False)

    resp = await client.post(
        "/admin/trigger-call",
        json={"phone_number": "+919994577702", "tamil_text": "வணக்கம்"},
    )

    assert resp.status_code == 500
    assert "credentials" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_trigger_call_prefers_public_tunnel_over_twimlets(client: httpx.AsyncClient, monkeypatch):
    """With a public tunnel configured, the trial fallback must stay in-house."""
    monkeypatch.setattr(main, "Client", _FakeTwilioClient)
    _FakeTwilioClient.reject_inline_twiml = True
    monkeypatch.setattr(main, "get_public_tunnel_url", lambda: "https://demo.trycloudflare.com/")

    try:
        resp = await client.post(
            "/admin/trigger-call",
            json={"phone_number": "+919994577702", "tamil_text": "வணக்கம்"},
        )
    finally:
        _FakeTwilioClient.reject_inline_twiml = False

    assert resp.status_code == 200, resp.text
    url = _FakeTwilioClient.last.calls.attempts[-1]["url"]
    assert url.startswith("https://demo.trycloudflare.com/twiml?"), url
    assert "twimlets.com" not in url


@pytest.mark.asyncio
async def test_twiml_endpoint_serves_valid_escaped_xml(client: httpx.AsyncClient):
    """The tunnel fallback depends on /twiml returning parseable, escaped TwiML."""
    resp = await client.get("/twiml", params={"msg": 'a < b & "c"', "lang": "hi-IN"})

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/xml")
    say = ElementTree.fromstring(resp.text).find("Say")
    assert say is not None and say.get("language") == "hi-IN"
    assert say.text == 'a < b & "c"'


@pytest.mark.asyncio
async def test_reminders_call_endpoint_uses_inline_twiml(client: httpx.AsyncClient, monkeypatch):
    """\"Call User Now (Tamil)\" must reach Twilio with the operator's Tamil text."""
    monkeypatch.setattr(main, "Client", _FakeTwilioClient)
    _FakeTwilioClient.reject_inline_twiml = False
    saved_reminders: List[Dict[str, Any]] = []
    monkeypatch.setattr(main, "db_save_reminder", lambda item: saved_reminders.append(item))

    resp = await client.post(
        "/reminders/call",
        json={
            "to_phone": "9994577702",
            "message_ta": "வணக்கம், மருந்து எடுத்துக் கொள்ளுங்கள்",
            "patient_name": "Test User",
        },
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True and body["call_sid"] == _FakeCall.sid
    kwargs = _FakeTwilioClient.last.calls.attempts[-1]
    assert "twiml" in kwargs and "url" not in kwargs
    assert kwargs["to"] == "+919994577702"
    assert "Google.ta-IN-Standard-A" in kwargs["twiml"]
    assert len(saved_reminders) == 1 and saved_reminders[0]["call_sid"] == _FakeCall.sid

