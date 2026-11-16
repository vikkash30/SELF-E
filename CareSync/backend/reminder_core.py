"""NVIDIA Nemotron AI Voice Reminder Script Generator with Time-of-Day & Food-Context Awareness."""

import asyncio
from datetime import datetime
import logging
import os
import re
from typing import Optional
from openai import AsyncOpenAI, OpenAI

logger = logging.getLogger("caresync.reminder_core")

NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"
NVIDIA_MODEL_NAME = os.getenv("NVIDIA_MODEL_NAME", "nvidia/nemotron-3.5-bolt-e4b")

# Contextual time-of-day and food-context native templates
# Supports: Tamil (primary/ta-IN), Hindi, Telugu, and English.
CONTEXTUAL_TEMPLATES = {
    "tamil": {
        "morning": {
            "before_food": (
                "காலை வணக்கம் {patient_name}. இது CareSync மருத்துவ நினைவூட்டல். "
                "காலை உணவுக்கு முன் உங்கள் {medicine_name} {dosage} எடுத்துக் கொள்ளவும். "
                "உடலை நன்றாகப் பார்த்துக் கொள்ளுங்கள்."
            ),
            "after_food": (
                "காலை வணக்கம் {patient_name}. இது CareSync மருத்துவ நினைவூட்டல். "
                "காலை உணவுக்குப் பிறகு உங்கள் {medicine_name} {dosage} தவறாமல் எடுத்துக் கொள்ளவும். "
                "உடலை நன்றாகப் பார்த்துக் கொள்ளுங்கள்."
            ),
            "with_food": (
                "காலை வணக்கம் {patient_name}. இது CareSync மருத்துவ நினைவூட்டல். "
                "காலை உணவுடன் உங்கள் {medicine_name} {dosage} எடுத்துக் கொள்ளவும். "
                "நல்ல ஆரோக்கியம் பெற வாழ்த்துகள்."
            ),
        },
        "afternoon": {
            "before_food": (
                "மதிய வணக்கம் {patient_name}. இது CareSync மருத்துவ நினைவூட்டல். "
                "மதிய உணவுக்கு முன் உங்கள் {medicine_name} {dosage} மருந்தை எடுத்துக் கொள்ளவும். "
                "நல்ல ஆரோக்கியம் பெற வாழ்த்துகள்."
            ),
            "after_food": (
                "மதிய வணக்கம் {patient_name}. இது CareSync மருத்துவ நினைவூட்டல். "
                "மதிய உணவுக்குப் பின் உங்கள் {medicine_name} {dosage} மருந்தை தவறாமல் எடுத்துக் கொள்ளவும். "
                "உடலை நன்றாகப் பார்த்துக் கொள்ளுங்கள்."
            ),
            "with_food": (
                "மதிய வணக்கம் {patient_name}. இது CareSync மருத்துவ நினைவூட்டல். "
                "மதிய உணவுடன் உங்கள் {medicine_name} {dosage} மருந்தை எடுத்துக் கொள்ளவும். "
                "நல்ல ஆரோக்கியம் பெற வாழ்த்துகள்."
            ),
        },
        "night": {
            "before_food": (
                "இரவு வணக்கம் {patient_name}. இது CareSync மருத்துவ நினைவூட்டல். "
                "இரவு உணவுக்கு முன் உங்கள் {medicine_name} {dosage} மாத்திரையை எடுத்துக் கொள்ளவும். "
                "நல்ல ஓய்வு பெறவும்."
            ),
            "after_food": (
                "இரவு வணக்கம் {patient_name}. இது CareSync மருத்துவ நினைவூட்டல். "
                "இரவு உணவிற்குப் பின் உங்கள் {medicine_name} {dosage} மாத்திரையை எடுத்துக் கொள்ள மறக்காதீர்கள். "
                "நல்ல ஆரோக்கியம் பெற வாழ்த்துகள்."
            ),
            "with_food": (
                "இரவு வணக்கம் {patient_name}. இது CareSync மருத்துவ நினைவூட்டல். "
                "இரவு உணவுடன் உங்கள் {medicine_name} {dosage} மாத்திரையை எடுத்துக் கொள்ளவும். "
                "நல்ல ஓய்வு பெறவும்."
            ),
        },
    },
    "english": {
        "morning": {
            "before_food": "Good morning {patient_name}. This is your CareSync health reminder. Please take your {medicine_name} {dosage} before breakfast. Wishing you good health.",
            "after_food": "Good morning {patient_name}. This is your CareSync health reminder. Please take your {medicine_name} {dosage} after your breakfast. Have a wonderful day.",
            "with_food": "Good morning {patient_name}. This is your CareSync health reminder. Please take your {medicine_name} {dosage} with your morning meal. Stay healthy.",
        },
        "afternoon": {
            "before_food": "Good afternoon {patient_name}. This is your CareSync health reminder. Please take your {medicine_name} {dosage} before your lunch. Take care.",
            "after_food": "Good afternoon {patient_name}. This is your CareSync health reminder. Please remember to take your {medicine_name} {dosage} after lunch. Stay healthy.",
            "with_food": "Good afternoon {patient_name}. This is your CareSync health reminder. Please take your {medicine_name} {dosage} with your lunch.",
        },
        "night": {
            "before_food": "Good evening {patient_name}. This is your CareSync health reminder. Please take your {medicine_name} {dosage} before dinner. Have a restful night.",
            "after_food": "Good evening {patient_name}. This is your CareSync health reminder. Please remember to take your {medicine_name} {dosage} after dinner. Wishing you a peaceful night.",
            "with_food": "Good evening {patient_name}. This is your CareSync health reminder. Please take your {medicine_name} {dosage} with your evening meal. Rest well.",
        },
    },
    "hindi": {
        "morning": {
            "before_food": "शुभ प्रभात {patient_name}। यह CareSync का स्वास्थ्य अनुस्मारक है। कृपया नाश्ते से पहले अपनी दवा {medicine_name} {dosage} लें।",
            "after_food": "शुभ प्रभात {patient_name}। यह CareSync का स्वास्थ्य अनुस्मारक है। कृपया नाश्ते के बाद अपनी दवा {medicine_name} {dosage} अवश्य लें।",
            "with_food": "शुभ प्रभात {patient_name}। यह CareSync का स्वास्थ्य अनुस्मारक है। कृपया नाश्ते के साथ अपनी दवा {medicine_name} {dosage} लें।",
        },
        "afternoon": {
            "before_food": "नमस्ते {patient_name}। यह CareSync का स्वास्थ्य अनुस्मारक है। कृपया दोपहर के भोजन से पहले अपनी दवा {medicine_name} {dosage} लें।",
            "after_food": "नमस्ते {patient_name}। यह CareSync का स्वास्थ्य अनुस्मारक है। कृपया दोपहर के भोजन के बाद अपनी दवा {medicine_name} {dosage} समय पर लें।",
            "with_food": "नमस्ते {patient_name}। यह CareSync का स्वास्थ्य अनुस्मारक है। कृपया दोपहर के भोजन के साथ अपनी दवा {medicine_name} {dosage} लें।",
        },
        "night": {
            "before_food": "शुभ संध्या {patient_name}। यह CareSync का स्वास्थ्य अनुस्मारक है। कृपया रात के खाने से पहले अपनी दवा {medicine_name} {dosage} लें।",
            "after_food": "शुभ रात्रि {patient_name}। यह CareSync का स्वास्थ्य अनुस्मारक है। कृपया रात के खाने के बाद अपनी दवा {medicine_name} {dosage} लेना न भूलें।",
            "with_food": "शुभ रात्रि {patient_name}। यह CareSync का स्वास्थ्य अनुस्मारक है। कृपया रात के खाने के साथ अपनी दवा {medicine_name} {dosage} लें।",
        },
    },
    "telugu": {
        "morning": {
            "before_food": "శుభోదయం {patient_name}. ఇది CareSync ఆరోగ్య రిమైండర్. దయచేసి ఉదయం అల్పాహారానికి ముందు మీ {medicine_name} {dosage} మందు తీసుకోండి.",
            "after_food": "శుభోదయం {patient_name}. ఇది CareSync ఆరోగ్య రిమైండర్. దయచేసి ఉదయం అల్పాహారం తర్వాత మీ {medicine_name} {dosage} మందు తప్పకుండా తీసుకోండి.",
            "with_food": "శుభోదయం {patient_name}. ఇది CareSync ఆరోగ్య రిమైండర్. దయచేసి ఉదయం అల్పాహారంతో పాటు మీ {medicine_name} {dosage} మందు తీసుకోండి.",
        },
        "afternoon": {
            "before_food": "నమస్కారం {patient_name}. ఇది CareSync ఆరోగ్య రిమైండర్. దయచేసి మధ్యాహ్న భోజనానికి ముందు మీ {medicine_name} {dosage} మందు తీసుకోండి.",
            "after_food": "నమస్కారం {patient_name}. ఇది CareSync ఆరోగ్య రిమైండర్. దయచేసి మధ్యాహ్న భోజనం తర్వాత మీ {medicine_name} {dosage} మందు తీసుకోండి.",
            "with_food": "నమస్కారం {patient_name}. ఇది CareSync ఆరోగ్య రిమైండర్. దయచేసి మధ్యాహ్న భోజనంతో పాటు మీ {medicine_name} {dosage} మందు తీసుకోండి.",
        },
        "night": {
            "before_food": "శుభరాత్రి {patient_name}. ఇది CareSync ఆరోగ్య రిమైండర్. దయచేసి రాత్రి భోజనానికి ముందు మీ {medicine_name} {dosage} మందు తీసుకోండి.",
            "after_food": "శుభరాత్రి {patient_name}. ఇది CareSync ఆరోగ్య రిమైండర్. దయచేసి రాత్రి భోజనం తర్వాత మీ {medicine_name} {dosage} మందు తీసుకోవడం మర్చిపోకండి.",
            "with_food": "శుభరాత్రి {patient_name}. ఇది CareSync ఆరోగ్య రిమైండర్. దయచేసి రాత్రి భోజనంతో పాటు మీ {medicine_name} {dosage} మందు తీసుకోండి.",
        },
    },
}

FALLBACK_SCRIPTS = {
    "tamil": (
        "வணக்கம் {patient_name}. உங்கள் மருத்துவர் பரிந்துரைத்த {medicine_name} "
        "மருந்தை {instructions} தவறாமல் எடுத்துக் கொள்ளவும். உடலை நன்றாக பார்த்துக் கொள்ளுங்கள்."
    ),
    "hindi": (
        "नमस्ते {patient_name}। कृपया अपने डॉक्टर द्वारा बताई गई दवा {medicine_name} "
        "{instructions} समय पर लें। अपने स्वास्थ्य का पूरा ध्यान रखें।"
    ),
    "telugu": (
        "నమస్కారం {patient_name}. దయచేసి మీ డాక్టర్ సూచించిన {medicine_name} "
        "మందును {instructions} సరైన సమయానికి తీసుకోండి. మీ ఆరోగ్యాన్ని జాగ్రత్తగా చూసుకోండి."
    ),
    "english": (
        "Hello {patient_name}. Please remember to take your prescribed medicine "
        "{medicine_name} {instructions}. Wishing you good health."
    ),
}


def get_time_of_day(hour: Optional[int] = None) -> str:
    """Return 'morning', 'afternoon', or 'night' based on the 24-hour clock."""
    if hour is None:
        hour = datetime.now().hour
    if 5 <= hour < 12:
        return "morning"
    elif 12 <= hour < 17:
        return "afternoon"
    else:
        return "night"


def normalize_food_context(food_context: Optional[str]) -> str:
    """Normalize input food context string into 'before_food', 'after_food', or 'with_food'."""
    fc = (food_context or "").strip().lower()
    if "before" in fc or "முன்" in fc or "पहले" in fc or "ముందు" in fc:
        return "before_food"
    elif "with" in fc or "உடன்" in fc or "साथ" in fc or "పాటు" in fc:
        return "with_food"
    return "after_food"


def get_contextual_fallback_script(
    patient_name: str,
    medicine_name: str,
    dosage: str = "",
    time_slot: str = "auto",
    food_context: str = "After Food",
    language: str = "Tamil",
) -> str:
    """Generate deterministic time-of-day and food-context native template."""
    clean_lang = (language or "").strip().lower()
    if "tam" in clean_lang or clean_lang == "ta":
        lang_key = "tamil"
        p_name = patient_name.strip() if patient_name else "நோயாளி"
    elif "hin" in clean_lang or clean_lang == "hi":
    if "hin" in clean_lang or clean_lang == "hi":
        lang_key = "hindi"
        p_name = patient_name.strip() if patient_name else "मरीज"
    elif "tel" in clean_lang or clean_lang == "te":
        lang_key = "telugu"
        p_name = patient_name.strip() if patient_name else "రోగి"
    else:
        lang_key = "english"
        p_name = patient_name.strip() if patient_name else "Patient"
        # Default to Tamil for all CareSync patient voice reminders
        lang_key = "tamil"
        p_name = patient_name.strip() if patient_name else "நோயாளி"

    m_name = (medicine_name or "பரிந்துரைக்கப்பட்ட மருந்து").strip()
    d_str = f"({dosage.strip()})" if dosage and dosage.strip() else ""

    # Resolve time slot
    slot = (time_slot or "auto").strip().lower()
    if slot in ("morning", "afternoon", "night"):
        resolved_slot = slot
    else:
        resolved_slot = get_time_of_day()

    resolved_food = normalize_food_context(food_context)

    lang_dict = CONTEXTUAL_TEMPLATES.get(lang_key, CONTEXTUAL_TEMPLATES["tamil"])
    slot_dict = lang_dict.get(resolved_slot, lang_dict.get("morning", {}))
    template = slot_dict.get(resolved_food, slot_dict.get("after_food"))

    if not template:
        return FALLBACK_SCRIPTS.get(lang_key, FALLBACK_SCRIPTS["tamil"]).format(
            patient_name=p_name,
            medicine_name=m_name,
            instructions=f"{resolved_slot} {food_context}",
        )

    return template.format(
        patient_name=p_name,
        medicine_name=m_name,
        dosage=d_str,
    ).strip()


def _get_fallback_script(
    patient_name: str,
    medicine_name: str,
    instructions: str,
    language: str,
) -> str:
    """Return a polite, grammatically correct 2-sentence native template."""
    clean_lang = (language or "").strip().lower()
    p_name = (patient_name or "நோயாளி").strip()
    m_name = (medicine_name or "பரிந்துரைக்கப்பட்ட மருந்து").strip()
    inst = (instructions or "").strip()

    if "tam" in clean_lang or clean_lang == "ta":
        template = FALLBACK_SCRIPTS["tamil"]
    elif "hin" in clean_lang or clean_lang == "hi":
    if "hin" in clean_lang or clean_lang == "hi":
        template = FALLBACK_SCRIPTS["hindi"]
        if p_name == "நோயாளி":
            p_name = "मरीज"
    elif "tel" in clean_lang or clean_lang == "te":
        template = FALLBACK_SCRIPTS["telugu"]
        if p_name == "நோயாளி":
            p_name = "రోగి"
    else:
        template = FALLBACK_SCRIPTS["english"]
        if p_name == "நோயாளி":
            p_name = "Patient"
        # Default to Tamil
        template = FALLBACK_SCRIPTS["tamil"]

    return template.format(
        patient_name=p_name,
        medicine_name=m_name,
        instructions=inst,
    ).strip()


def get_twilio_language_code(language: str) -> str:
    """Map human language name to Twilio TwiML <Say> language tag."""
    lang = (language or "").strip().lower()
    if "tam" in lang or lang == "ta":
        return "ta-IN"
    elif "hin" in lang or lang == "hi":
    if "hin" in lang or lang == "hi":
        return "hi-IN"
    elif "tel" in lang or lang == "te":
        return "te-IN"
    return "en-IN"
    # Default to Tamil (ta-IN)
    return "ta-IN"


async def generate_contextual_reminder_script(
    patient_name: str,
    medicine_name: str,
    dosage: str = "",
    time_slot: str = "auto",
    food_context: str = "After Food",
    language: str = "Tamil",
) -> str:
    """
    Generate an intelligent time-of-day and food-context customized voice reminder script
    using NVIDIA Nemotron or deterministic native templates.
    """
    clean_lang = (language or "").strip().lower()
    target_lang = "Hindi" if "hin" in clean_lang else ("Telugu" if "tel" in clean_lang else "Tamil")
    api_key = os.getenv("NVIDIA_API_KEY", "").strip()
    resolved_slot = time_slot if time_slot in ("morning", "afternoon", "night") else get_time_of_day()

    if not api_key:
        return get_contextual_fallback_script(
            patient_name=patient_name,
            medicine_name=medicine_name,
            dosage=dosage,
            time_slot=resolved_slot,
            food_context=food_context,
            language=language,
            language=target_lang,
        )

    system_prompt = (
        f"You are a polite healthcare assistant speaking to a patient named {patient_name} in {language}. "
        f"It is currently {resolved_slot}. Write a concise, natural 2-sentence phone reminder script in {language} "
        f"You are a polite healthcare assistant speaking to a patient named {patient_name} in {target_lang}. "
        f"It is currently {resolved_slot}. Write a concise, natural 2-sentence phone reminder script in {target_lang} "
        f"asking {patient_name} to take their medicine {medicine_name} ({dosage}) {food_context} for their {resolved_slot} dose. "
        f"Greet them appropriately for the time of day ({resolved_slot}) and mention the food instruction ({food_context}). "
        f"Do not include English translations, asterisks, quotation marks, or markdown. Output ONLY the spoken text in {language} native script."
        f"Do not include English translations, asterisks, quotation marks, or markdown. Output ONLY the spoken text in {target_lang} native script."
    )

    user_prompt = (
        f"Generate {language} phone script: patient={patient_name}, medicine={medicine_name}, "
        f"Generate {target_lang} phone script: patient={patient_name}, medicine={medicine_name}, "
        f"dosage={dosage}, time={resolved_slot}, food={food_context}."
    )

    try:
        client = AsyncOpenAI(base_url=NVIDIA_BASE_URL, api_key=api_key, timeout=4.0, max_retries=1)
        response = await client.chat.completions.create(
            model=NVIDIA_MODEL_NAME,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.3,
            max_tokens=250,
        )

        content = (response.choices[0].message.content or "").strip()
        cleaned = re.sub(r'[*_#`"]', '', content).strip()
        if (cleaned.startswith("'") and cleaned.endswith("'")) or (cleaned.startswith('"') and cleaned.endswith('"')):
            cleaned = cleaned[1:-1].strip()

        if cleaned and len(cleaned) > 10:
            return cleaned

    except Exception as exc:
        logger.warning(
            "NVIDIA Nemotron contextual script generation failed (%s); falling back to native template.",
            exc,
        )

    return get_contextual_fallback_script(
        patient_name=patient_name,
        medicine_name=medicine_name,
        dosage=dosage,
        time_slot=resolved_slot,
        food_context=food_context,
        language=language,
        language=target_lang,
    )


async def generate_reminder_script(
    patient_name: str,
    medicine_name: str,
    instructions: str,
    language: str = "Tamil",
) -> str:
    """
    Generate a conversational voice reminder script in the native language
    using NVIDIA Nemotron or contextual templates.
    """
    # Detect time-of-day and food-context keywords from instructions if available
    inst_lower = (instructions or "").lower()
    time_slot = "auto"
    if "morning" in inst_lower or "காலை" in inst_lower or "breakfast" in inst_lower:
        time_slot = "morning"
    elif "afternoon" in inst_lower or "மதியம்" in inst_lower or "lunch" in inst_lower:
        time_slot = "afternoon"
    elif "night" in inst_lower or "இரவு" in inst_lower or "dinner" in inst_lower or "evening" in inst_lower:
        time_slot = "night"

    food_context = "After Food"
    if "before" in inst_lower or "முன்" in inst_lower:
        food_context = "Before Food"
    elif "with" in inst_lower or "உடன்" in inst_lower:
        food_context = "With Food"

    return await generate_contextual_reminder_script(
        patient_name=patient_name,
        medicine_name=medicine_name,
        dosage="",
        time_slot=time_slot,
        food_context=food_context,
        language=language,
    )


