"""Firebase Admin SDK initialization and Firestore collection helpers."""

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

import firebase_admin
from firebase_admin import credentials, firestore

logger = logging.getLogger("caresync.database")

BASE_DIR = Path(__file__).resolve().parent
CREDENTIALS_PATH = Path(os.getenv("FIREBASE_CREDENTIALS_PATH", BASE_DIR / "credentials.json"))

COLLECTIONS = (
    "patients",
    "visits",
    "facilities",
    "doctors",
    "slots",
    "appointments",
    "health_schemes",
)

_db_client: Optional[Any] = None
_firebase_ready: bool = False
_DEMO_HEALTH_SCHEMES: List[Dict[str, Any]] = []


def _is_placeholder_credentials(path: Path) -> bool:
    """Return True if credentials.json is missing or still holds placeholder keys."""
    if not path.exists():
        return True
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        private_key = data.get("private_key", "")
        return "REPLACE_WITH" in private_key or not private_key.strip()
    except (OSError, json.JSONDecodeError):
        return True


def init_firebase() -> Optional[Any]:
    """Initialize Firebase Admin SDK once and return the Firestore client if configured."""
    global _db_client, _firebase_ready

    if _db_client is not None:
        return _db_client

    if _is_placeholder_credentials(CREDENTIALS_PATH):
        logger.warning(
            "Placeholder or missing Firebase credentials at %s. "
            "Running with Firestore disabled until real credentials.json is provided.",
            CREDENTIALS_PATH,
        )
        _firebase_ready = False
        return None

    try:
        if not firebase_admin._apps:
            cred = credentials.Certificate(str(CREDENTIALS_PATH))
            firebase_admin.initialize_app(cred)
        _db_client = firestore.client()
        _firebase_ready = True
        logger.info("Firebase Admin SDK initialized successfully.")
    except Exception as exc:
        logger.error("Failed to initialize Firebase Admin SDK: %s", exc)
        _db_client = None
        _firebase_ready = False

    return _db_client


def get_db() -> Optional[Any]:
    """Return the initialized Firestore client, initializing it on demand."""
    if _db_client is None and not _firebase_ready:
        return init_firebase()
    return _db_client


def is_firestore_connected() -> bool:
    """Indicate whether a live Firestore client is available."""
    return get_db() is not None


def get_collection(name: str):
    """Return a Firestore CollectionReference for a validated CareSync collection."""
    if name not in COLLECTIONS:
        raise ValueError(f"Unknown collection '{name}'. Expected one of {COLLECTIONS}.")
    db = get_db()
    if db is None:
        return None
    return db.collection(name)


def get_patients_collection():
    """Return the Firestore 'patients' collection reference."""
    return get_collection("patients")


def get_visits_collection():
    """Return the Firestore 'visits' collection reference."""
    return get_collection("visits")


def get_facilities_collection():
    """Return the Firestore 'facilities' collection reference."""
    return get_collection("facilities")


def get_doctors_collection():
    """Return the Firestore 'doctors' collection reference."""
    return get_collection("doctors")


def get_slots_collection():
    """Return the Firestore 'slots' collection reference."""
    return get_collection("slots")


def get_appointments_collection():
    """Return the Firestore 'appointments' collection reference."""
    return get_collection("appointments")


def get_health_schemes_collection():
    """Return the Firestore 'health_schemes' collection reference."""
    return get_collection("health_schemes")


def replace_health_schemes(schemes: List[Dict[str, Any]]) -> str:
    """Clear existing health_schemes in Firestore (or demo store) and bulk-write new schemes."""
    global _DEMO_HEALTH_SCHEMES
    db = get_db()
    schemes_col = get_health_schemes_collection()

    if db is not None and schemes_col is not None:
        # Delete existing documents in batches of 400 (Firestore batch limit is 500).
        existing_docs = list(schemes_col.stream())
        for start in range(0, len(existing_docs), 400):
            batch = db.batch()
            for doc_snap in existing_docs[start : start + 400]:
                batch.delete(doc_snap.reference)
            batch.commit()

        # Bulk-write new schemes in batches of 400.
        for start in range(0, len(schemes), 400):
            batch = db.batch()
            for idx, scheme in enumerate(schemes[start : start + 400], start=start + 1):
                doc_id = f"scheme-{idx:03d}"
                batch.set(schemes_col.document(doc_id), scheme)
            batch.commit()
        return "firestore"

    _DEMO_HEALTH_SCHEMES = list(schemes)
    return "demo_memory"


def get_all_health_schemes() -> List[Dict[str, Any]]:
    """Fetch all stored health schemes from Firestore or demo memory."""
    schemes_col = get_health_schemes_collection()
    if schemes_col is not None:
        return [doc_snap.to_dict() for doc_snap in schemes_col.stream() if doc_snap.to_dict()]
    return list(_DEMO_HEALTH_SCHEMES)
