"""Hybrid rule-based + NVIDIA NIM (Llama 3.1 8B) AI triage & scheme checklist engine."""

import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

from openai import OpenAI

from database import get_all_health_schemes

logger = logging.getLogger("caresync.triage")

NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"
NVIDIA_MODEL_NAME = "meta/llama-3.1-8b-instruct"

COMPETITOR_BAN_PATTERN = re.compile(r"e[-\s]?sanjeevani|sanjeevani", re.IGNORECASE)

_nvidia_api_key = os.environ.get("NVIDIA_API_KEY", "").strip()
client: Optional[OpenAI] = (
    OpenAI(base_url=NVIDIA_BASE_URL, api_key=_nvidia_api_key)
    if _nvidia_api_key
    else None
)

TRIAGE_SYSTEM_PROMPT = """You are CareSync, a clinical triage and public health scheme checklist assistant supporting trained ration-shop operators in rural India.
The patient's vitals have already passed critical emergency thresholds.
Evaluate the patient's demographics (Age, Gender), Vitals, Symptoms (Complaints / Add-ons), and the provided list of government `health_schemes`.

CRITICAL RULE: You must NEVER recommend, mention, or include "eSanjeevani" or any of its variants in your response.

1. Classify care urgency into strictly one of two levels:
- "Yellow": Consult Doctor (moderate symptoms, persistent fever, infection signs, dehydration, chest discomfort, breathing difficulty not yet critical, pediatric/elderly vulnerability, or unclear risk requiring PHC/CareSync telemedicine doctor review).
- "Green": Self-care (mild, self-limiting symptoms such as mild cold, mild headache, minor fatigue, or mild acidity with normal vitals).

2. Select 1 to 3 schemes strictly from the PROVIDED `health_schemes` list that fit the patient. For each scheme, set `requires_verification`:
- `false` if the patient directly qualifies based on known data (e.g., Age, Gender, Symptoms, or universal generic drug access).
- `true` if external document/BPL/income verification is needed (e.g., Ayushman Bharat BPL/SECC eligibility).
You MUST copy scheme names verbatim from the provided list and NEVER invent schemes not on the list.

Return ONLY valid JSON matching this exact schema:
{
  "severity": "Yellow" | "Green",
  "classification": "Consult Doctor" | "Self-care",
  "reason": "1-2 short sentences explaining the triage decision in plain language.",
  "recommended_action": "Clear, practical next step for the ration-shop operator and patient.",
  "red_flags_to_watch": ["symptom 1", "symptom 2"],
  "eligible_schemes": [
    {
      "name": "Scheme Name (e.g., RBSK)",
      "requires_verification": false,
      "reason": "Short explanation of why they qualify (e.g., Patient is below 18 years)."
    },
    {
      "name": "Ayushman Bharat",
      "requires_verification": true,
      "reason": "May provide financial support for referral or advanced treatment."
    }
  ]
}
"""

YELLOW_FALLBACK_KEYWORDS = (
    "chest pain",
    "breath",
    "dyspnea",
    "wheez",
    "dizz",
    "faint",
    "vomit",
    "diarrh",
    "blood",
    "pregnant",
    "seizure",
    "rash",
    "jaundice",
    "yellow eyes",
    "severe",
    "persistent",
    "infection",
    "wound",
    "fever",
)

DEFAULT_SCHEME_NAMES = [
    "Ayushman Bharat - Pradhan Mantri Jan Arogya Yojana (AB-PMJAY)",
    "Pradhan Mantri Bhartiya Janaushadhi Pariyojana (PMBJP)",
    "Janani Suraksha Yojana (JSY)",
    "Rashtriya Bal Swasthya Karyakram (RBSK)",
    "Pradhan Mantri Matru Vandana Yojana (PMMVY)",
    "Mission Indradhanush (Universal Immunization Programme)",
    "Nikshay Poshan Yojana (National TB Elimination Programme)",
    "National Programme for Health Care of the Elderly (NPHCE)",
    "Ayushman Arogya Mandir (Health & Wellness Centres)",
]


def _is_banned_competitor(text: str) -> bool:
    """Return True if text mentions the banned competitor name or variant."""
    return bool(COMPETITOR_BAN_PATTERN.search(text or ""))


def _sanitize_competitor_mentions(text: str) -> str:
    """Scrub any accidental competitor mentions from output strings."""
    return COMPETITOR_BAN_PATTERN.sub("CareSync Telemedicine", text or "")


def _get_nvidia_client() -> Optional[OpenAI]:
    """Return an initialized NVIDIA NIM OpenAI client if a valid nvapi- key is set."""
    global client
    api_key = os.environ.get("NVIDIA_API_KEY", "").strip()
    if not api_key:
        return None
    if not api_key.startswith("nvapi-"):
        logger.warning("NVIDIA_API_KEY does not start with 'nvapi-'; skipping NVIDIA NIM call.")
        return None
    if client is None or getattr(client, "api_key", None) != api_key:
        client = OpenAI(base_url=NVIDIA_BASE_URL, api_key=api_key)
    return client


def _fetch_scheme_names() -> List[str]:
    """Fetch scheme names from Firestore `health_schemes`, filtering out banned competitor entries."""
    docs = get_all_health_schemes()
    names = [
        str(doc.get("scheme_name") or doc.get("name") or "").strip()
        for doc in docs
        if (doc.get("scheme_name") or doc.get("name"))
        and not _is_banned_competitor(str(doc.get("scheme_name") or doc.get("name") or ""))
    ]
    if names:
        return names
    return [name for name in DEFAULT_SCHEME_NAMES if not _is_banned_competitor(name)]


def _match_schemes_heuristic(
    scheme_names: List[str],
    symptoms_text: str,
    age: Optional[int],
    gender: Optional[str],
    severity: str,
) -> List[Dict[str, Any]]:
    """Deterministically build 1-3 checklist scheme items strictly from `scheme_names`."""
    if not scheme_names:
        return []

    lowered = (symptoms_text or "").lower()
    gender_norm = (gender or "").strip().lower()
    candidates: List[tuple] = []

    for name in scheme_names:
        if _is_banned_competitor(name):
            continue
        lname = name.lower()
        priority = 1
        requires_verification = False
        reason = "Provides primary screening and subsidized care at rural health centres."

        if age is not None and age >= 60 and ("elderly" in lname or "nphce" in lname):
            priority = 10
            requires_verification = False
            reason = f"Patient is {age} years old (60+), qualifying for geriatric health support."
        elif age is not None and age <= 18 and ("bal" in lname or "rbsk" in lname or "indradhanush" in lname):
            priority = 10
            requires_verification = False
            reason = f"Patient is {age} years old (below 18), directly eligible for child health screening."
        elif (
            gender_norm == "female"
            and any(w in lowered for w in ("pregnan", "matern", "deliver"))
            and ("janani" in lname or "matru" in lname or "jsy" in lname or "pmmvy" in lname)
        ):
            priority = 10
            requires_verification = True
            reason = "Female maternal care candidate; requires MCP/ration card verification to claim benefits."
        elif gender_norm == "female" and ("janani" in lname or "matru" in lname):
            priority = 3
            requires_verification = True
            reason = "Applicable to eligible pregnant/lactating women upon document verification."
        elif any(w in lowered for w in ("tb", "tuberculosis", "cough")) and ("nikshay" in lname or "tb" in lname):
            priority = 7
            requires_verification = True
            reason = "Cough/respiratory symptoms warrant screening; nutrition support requires TB diagnosis confirmation."
        elif ("ayushman bharat" in lname or "pmjay" in lname or "jan arogya" in lname) and severity in ("Red", "Yellow"):
            priority = 9 if severity == "Red" else 8
            requires_verification = True
            reason = "May provide financial support for referral or advanced treatment after BPL/PM-JAY ID check."
        elif "janaushadhi" in lname:
            priority = 6
            requires_verification = False
            reason = "Provides affordable generic medicines at Janaushadhi Kendras with no income barrier."
        elif "arogya mandir" in lname:
            priority = 5
            requires_verification = False
            reason = "Provides free local sub-centre consultation, ORS, and primary care follow-up."

        candidates.append(
            (
                priority,
                {
                    "name": name,
                    "requires_verification": requires_verification,
                    "reason": reason,
                },
            )
        )

    candidates.sort(key=lambda item: item[0], reverse=True)
    return [entry for _, entry in candidates[:3]]


def _resolve_allowed_name(candidate: str, allowed_names: List[str]) -> Optional[str]:
    """Match a candidate scheme name strictly to `allowed_names` while blocking competitor names."""
    clean = (candidate or "").strip()
    if not clean or _is_banned_competitor(clean):
        return None
    allowed_by_lower = {name.lower(): name for name in allowed_names}
    if clean.lower() in allowed_by_lower:
        return allowed_by_lower[clean.lower()]
    for allowed in allowed_names:
        if clean.lower() in allowed.lower() or allowed.lower() in clean.lower():
            return allowed
    return None


def _filter_strict_schemes(
    raw_list: Any,
    allowed_names: List[str],
    symptoms_text: str,
    age: Optional[int],
    gender: Optional[str],
    severity: str,
) -> List[Dict[str, Any]]:
    """Validate LLM `eligible_schemes` checklist objects strictly against `allowed_names` and ban list."""
    if not isinstance(raw_list, list) or not allowed_names:
        return _match_schemes_heuristic(allowed_names, symptoms_text, age, gender, severity)

    matched: List[Dict[str, Any]] = []
    seen_names = set()

    for item in raw_list:
        if isinstance(item, dict):
            raw_name = str(item.get("name") or item.get("scheme_name") or "").strip()
            raw_verify = bool(item.get("requires_verification", False))
            raw_reason = str(item.get("reason") or "").strip()
        else:
            raw_name = str(item).strip()
            raw_verify = False
            raw_reason = ""

        resolved = _resolve_allowed_name(raw_name, allowed_names)
        if not resolved or resolved in seen_names or _is_banned_competitor(resolved):
            continue

        seen_names.add(resolved)
        matched.append(
            {
                "name": resolved,
                "requires_verification": raw_verify,
                "reason": _sanitize_competitor_mentions(
                    raw_reason or "Matches patient clinical profile and rural health eligibility."
                ),
            }
        )
        if len(matched) >= 3:
            break

    if not matched:
        return _match_schemes_heuristic(allowed_names, symptoms_text, age, gender, severity)

    return matched[:3]


def _to_float(value: Any) -> Optional[float]:
    """Safely convert vital readings to float, returning None if absent/invalid."""
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _evaluate_hard_rules(
    vitals: Dict[str, Any],
    scheme_names: List[str],
    symptoms_text: str,
    age: Optional[int],
    gender: Optional[str],
) -> Optional[Dict[str, Any]]:
    """Apply deterministic red-flag rules before invoking the LLM."""
    spo2 = _to_float(vitals.get("spo2"))
    temperature = _to_float(vitals.get("temperature"))
    heart_rate = _to_float(vitals.get("heart_rate"))

    reasons: List[str] = []
    if spo2 is not None and spo2 < 92:
        reasons.append(f"Critically low SpO2 ({spo2:g}% < 92%)")
    if temperature is not None and temperature > 103:
        reasons.append(f"Dangerously high fever ({temperature:g}°F > 103°F)")
    if heart_rate is not None and (heart_rate > 140 or heart_rate < 40):
        reasons.append(f"Critical heart rate ({heart_rate:g} bpm)")

    if not reasons:
        return None

    return {
        "severity": "Red",
        "classification": "Emergency Referral",
        "reason": "; ".join(reasons) + ".",
        "recommended_action": (
            "Immediate referral to nearest Community Health Centre (CHC) or District Hospital. "
            "Arrange 108 ambulance transport and stabilize patient."
        ),
        "red_flags_to_watch": reasons,
        "eligible_schemes": _match_schemes_heuristic(
            scheme_names, symptoms_text, age, gender, "Red"
        ),
        "source": "hard_rules",
    }


def _parse_llm_json(
    raw_text: str,
    scheme_names: List[str],
    symptoms_text: str,
    age: Optional[int],
    gender: Optional[str],
) -> Dict[str, Any]:
    """Extract and validate strict JSON output from NVIDIA NIM chat completion."""
    cleaned = (raw_text or "").strip()
    fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, re.DOTALL)
    if fence_match:
        cleaned = fence_match.group(1)
    else:
        brace_match = re.search(r"(\{.*\})", cleaned, re.DOTALL)
        if brace_match:
            cleaned = brace_match.group(1)

    parsed = json.loads(cleaned)
    severity = parsed.get("severity")
    if severity not in ("Yellow", "Green"):
        raise ValueError(f"Invalid AI severity '{severity}'; expected 'Yellow' or 'Green'.")

    default_classification = "Consult Doctor" if severity == "Yellow" else "Self-care"
    red_flags = parsed.get("red_flags_to_watch")
    if not isinstance(red_flags, list):
        red_flags = []

    eligible_schemes = _filter_strict_schemes(
        parsed.get("eligible_schemes"),
        scheme_names,
        symptoms_text,
        age,
        gender,
        severity,
    )

    return {
        "severity": severity,
        "classification": _sanitize_competitor_mentions(
            parsed.get("classification") or default_classification
        ),
        "reason": _sanitize_competitor_mentions(
            str(parsed.get("reason") or "Evaluated from reported symptoms and stable vitals.")
        ),
        "recommended_action": _sanitize_competitor_mentions(
            str(
                parsed.get("recommended_action")
                or (
                    "Book a PHC or CareSync telemedicine consultation within 24 hours."
                    if severity == "Yellow"
                    else "Provide ORS/hydration guidance, rest, and monitor symptoms."
                )
            )
        ),
        "red_flags_to_watch": [_sanitize_competitor_mentions(str(item)) for item in red_flags],
        "eligible_schemes": eligible_schemes,
        "source": f"nvidia-nim/{NVIDIA_MODEL_NAME}",
    }


def _fallback_symptom_triage(
    symptoms_text: str,
    note: str,
    scheme_names: List[str],
    age: Optional[int],
    gender: Optional[str],
) -> Dict[str, Any]:
    """Deterministic fallback when NVIDIA_API_KEY is missing or unreachable."""
    lowered = symptoms_text.lower()
    matched = [kw for kw in YELLOW_FALLBACK_KEYWORDS if kw in lowered]

    if matched:
        return {
            "severity": "Yellow",
            "classification": "Consult Doctor",
            "reason": f"Stable vitals, but complaints include moderate-risk indicators ({', '.join(matched[:3])}).",
            "recommended_action": "Schedule a PHC doctor or CareSync telemedicine consultation today.",
            "red_flags_to_watch": ["Worsening breathlessness", "SpO2 dropping below 92%", "Persistent high fever"],
            "eligible_schemes": _match_schemes_heuristic(
                scheme_names, symptoms_text, age, gender, "Yellow"
            ),
            "source": note,
        }

    return {
        "severity": "Green",
        "classification": "Self-care",
        "reason": "Vitals are within safe limits and no moderate-risk symptom flags were detected.",
        "recommended_action": "Advise rest, hydration/ORS, and follow up at the ration shop kiosk if symptoms persist beyond 48 hours.",
        "red_flags_to_watch": ["Fever rising above 103°F", "SpO2 below 92%", "New chest pain or confusion"],
        "eligible_schemes": _match_schemes_heuristic(
            scheme_names, symptoms_text, age, gender, "Green"
        ),
        "source": note,
    }


def calculate_triage(
    symptoms_text: str,
    vitals: dict,
    age: Optional[int] = None,
    gender: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Calculate patient triage severity ('Red', 'Yellow', or 'Green') and scheme checklist.

    1. Fetches scheme names from Firestore `health_schemes`, stripping any banned competitor names.
    2. Evaluates hard-coded vital-sign red flags first (SpO2 < 92, Temperature > 103°F, etc.).
    3. If vitals are stable, calls NVIDIA NIM (meta/llama-3.1-8b-instruct) via OpenAI SDK.
    """
    vitals = vitals or {}
    symptoms_clean = (symptoms_text or "").strip()
    health_schemes = _fetch_scheme_names()

    rule_result = _evaluate_hard_rules(vitals, health_schemes, symptoms_clean, age, gender)
    if rule_result is not None:
        return rule_result

    nim_client = _get_nvidia_client()
    if nim_client is None:
        logger.warning("Valid NVIDIA_API_KEY (nvapi-...) not set; using deterministic symptom fallback.")
        return _fallback_symptom_triage(
            symptoms_clean,
            note="fallback_no_api_key",
            scheme_names=health_schemes,
            age=age,
            gender=gender,
        )

    schemes_bullets = "\n".join(f"- {name}" for name in health_schemes)
    user_prompt = (
        f"Patient Age: {age if age is not None else 'Unknown'}\n"
        f"Patient Gender: {gender or 'Unknown'}\n"
        f"Patient Vitals: SpO2={vitals.get('spo2', 'N/A')}%, "
        f"Temperature={vitals.get('temperature', 'N/A')}°F, "
        f"Heart Rate={vitals.get('heart_rate', 'N/A')} bpm\n"
        f"Patient Symptoms (Complaints / Add-ons): {symptoms_clean or 'None reported'}\n\n"
        f"Available Government `health_schemes`:\n{schemes_bullets}\n\n"
        "Respond with ONLY the JSON object including `eligible_schemes` objects "
        "(`name`, `requires_verification`, `reason`) strictly from the list above. "
        "Never mention eSanjeevani."
    )

    try:
        completion = nim_client.chat.completions.create(
            model=NVIDIA_MODEL_NAME,
            messages=[
                {"role": "system", "content": TRIAGE_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.1,
            max_tokens=550,
            response_format={"type": "json_object"},
        )
        content = completion.choices[0].message.content
        return _parse_llm_json(content, health_schemes, symptoms_clean, age, gender)
    except Exception as exc:
        logger.error("NVIDIA NIM triage call failed (%s); falling back to local heuristic.", exc)
        return _fallback_symptom_triage(
            symptoms_clean,
            note="fallback_api_error",
            scheme_names=health_schemes,
            age=age,
            gender=gender,
        )


# Exported reminder script generator helper (Phase 2)
from reminder_core import generate_reminder_script, get_twilio_language_code  # noqa: E402

