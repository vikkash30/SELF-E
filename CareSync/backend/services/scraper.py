"""Scraper for National Portal of India Health & Wellness government schemes."""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

from database import replace_health_schemes

logger = logging.getLogger("caresync.scraper")

INDIA_GOV_SCHEMES_URL = (
    "https://www.india.gov.in/my-government/schemes/search"
    "?schemeCategory=5&schemeCategoryName=Health%20%26%20Wellness"
)

CURATED_FALLBACK_SCHEMES: List[Dict[str, str]] = [
    {
        "scheme_name": "Ayushman Bharat - Pradhan Mantri Jan Arogya Yojana (AB-PMJAY)",
        "scheme_url": "https://www.india.gov.in/spotlight/ayushman-bharat-pradhan-mantri-jan-arogya-yojana",
    },
    {
        "scheme_name": "Pradhan Mantri Bhartiya Janaushadhi Pariyojana (PMBJP)",
        "scheme_url": "https://www.india.gov.in/spotlight/pradhan-mantri-bhartiya-janaushadhi-pariyojana",
    },
    {
        "scheme_name": "Janani Suraksha Yojana (JSY)",
        "scheme_url": "https://www.india.gov.in/janani-suraksha-yojana",
    },
    {
        "scheme_name": "Rashtriya Bal Swasthya Karyakram (RBSK)",
        "scheme_url": "https://www.india.gov.in/rashtriya-bal-swasthya-karyakram-rbsk",
    },
    {
        "scheme_name": "Pradhan Mantri Matru Vandana Yojana (PMMVY)",
        "scheme_url": "https://www.india.gov.in/pradhan-mantri-matru-vandana-yojana",
    },
    {
        "scheme_name": "Mission Indradhanush (Universal Immunization Programme)",
        "scheme_url": "https://www.india.gov.in/mission-indradhanush",
    },
    {
        "scheme_name": "Nikshay Poshan Yojana (National TB Elimination Programme)",
        "scheme_url": "https://www.india.gov.in/nikshay-poshan-yojana",
    },
    {
        "scheme_name": "National Programme for Health Care of the Elderly (NPHCE)",
        "scheme_url": "https://www.india.gov.in/national-programme-health-care-elderly-nphce",
    },
    {
        "scheme_name": "Ayushman Arogya Mandir (Health & Wellness Centres)",
        "scheme_url": "https://www.india.gov.in/ayushman-arogya-mandir",
    },
]


def _extract_schemes_from_html(html: str, base_url: str) -> List[Dict[str, str]]:
    """Parse scheme names and URLs from Drupal .views-row or table rows."""
    soup = BeautifulSoup(html, "html.parser")
    extracted: List[Dict[str, str]] = []
    seen_names = set()

    containers = soup.select(".views-row")
    if not containers:
        containers = soup.select("table tbody tr")

    for row in containers:
        anchor = row.select_one("a[href]")
        if not anchor:
            continue
        name = " ".join(anchor.get_text(strip=True).split())
        href = (anchor.get("href") or "").strip()
        if not name or len(name) < 4 or name.lower() in seen_names:
            continue
        seen_names.add(name.lower())
        extracted.append(
            {
                "scheme_name": name,
                "scheme_url": urljoin(base_url, href),
            }
        )

    return extracted


def scrape_health_schemes() -> Dict[str, Any]:
    """
    Scrape Health & Wellness schemes from india.gov.in, clear existing Firestore
    `health_schemes` documents, and bulk-write the refreshed schemes.
    """
    scraped_at = datetime.now(timezone.utc).isoformat()
    source = "india.gov.in_live"
    schemes: List[Dict[str, str]] = []

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "en-IN,en;q=0.9",
    }

    try:
        response = requests.get(INDIA_GOV_SCHEMES_URL, headers=headers, timeout=15)
        response.raise_for_status()
        schemes = _extract_schemes_from_html(response.text, INDIA_GOV_SCHEMES_URL)
        if not schemes:
            logger.warning(
                "No scheme rows matched on india.gov.in (likely client-rendered); using curated national schemes."
            )
            source = "curated_fallback_empty_dom"
            schemes = [dict(item) for item in CURATED_FALLBACK_SCHEMES]
    except Exception as exc:
        logger.warning("Live scrape of india.gov.in failed (%s); using curated national schemes.", exc)
        source = "curated_fallback_network"
        schemes = [dict(item) for item in CURATED_FALLBACK_SCHEMES]

    enriched = [
        {
            **item,
            "category": "Health & Wellness",
            "source": source,
            "scraped_at": scraped_at,
        }
        for item in schemes
    ]

    storage = replace_health_schemes(enriched)
    logger.info("Stored %d health schemes in %s (%s).", len(enriched), storage, source)

    return {
        "status": "ok",
        "count": len(enriched),
        "storage": storage,
        "source": source,
        "scraped_at": scraped_at,
        "schemes": enriched,
    }

