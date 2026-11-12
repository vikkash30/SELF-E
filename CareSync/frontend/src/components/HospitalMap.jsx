import L from 'leaflet';
import { MapContainer, Marker, Popup, TileLayer } from 'react-leaflet';

/**
 * Calculate great-circle distance between two coordinates using the Haversine formula.
 * @returns {number} Distance in kilometers.
 */
export function calculateDistance(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function createPinIcon(fillColor) {
  return L.divIcon({
    className: 'caresync-map-pin',
    html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="26" height="38">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 9 12 24 12 24s12-15 12-24C24 5.37 18.63 0 12 0z" fill="${fillColor}" stroke="#ffffff" stroke-width="2"/>
      <circle cx="12" cy="12" r="4.5" fill="#ffffff"/>
    </svg>`,
    iconSize: [26, 38],
    iconAnchor: [13, 38],
    popupAnchor: [0, -34],
  });
}

const PATIENT_ICON = createPinIcon('#2563eb');
const HOSPITAL_ICON = createPinIcon('#dc2626');

function getFacilityCoords(facility) {
  const lat = Number(
    facility?.lat ?? facility?.latitude ?? facility?.location?.lat
  );
  const lng = Number(
    facility?.lng ?? facility?.longitude ?? facility?.location?.lng
  );
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return { lat, lng };
}

export default function HospitalMap({ patientLocation, facilities = [] }) {
  if (!patientLocation || patientLocation.lat == null || patientLocation.lng == null) {
    return null;
  }

  const nearestFacilities = facilities
    .map((fac) => {
      const coords = getFacilityCoords(fac);
      if (!coords) return null;
      const distanceKm = calculateDistance(
        patientLocation.lat,
        patientLocation.lng,
        coords.lat,
        coords.lng
      );
      return {
        ...fac,
        lat: coords.lat,
        lng: coords.lng,
        distanceKm,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, 3);

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3.5 py-2 text-xs">
        <span className="font-bold text-slate-800">
          Nearest Capable Hospitals (OpenStreetMap)
        </span>
        <span className="flex items-center gap-3 text-[11px] font-semibold text-slate-600">
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-full bg-blue-600" />
            Patient Kiosk
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-full bg-red-600" />
            Top {nearestFacilities.length} Nearest Facilities
          </span>
        </span>
      </div>

      <div className="h-64 w-full">
        <MapContainer
          center={[patientLocation.lat, patientLocation.lng]}
          zoom={11}
          scrollWheelZoom={false}
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          <Marker
            position={[patientLocation.lat, patientLocation.lng]}
            icon={PATIENT_ICON}
          >
            <Popup>
              <div className="text-xs">
                <p className="font-bold text-blue-700">Patient Location (Ration Shop)</p>
                <p className="text-slate-600">
                  {patientLocation.lat.toFixed(4)}, {patientLocation.lng.toFixed(4)}
                </p>
              </div>
            </Popup>
          </Marker>

          {nearestFacilities.map((fac, idx) => (
            <Marker
              key={fac.id || `${fac.name}-${idx}`}
              position={[fac.lat, fac.lng]}
              icon={HOSPITAL_ICON}
            >
              <Popup>
                <div className="text-xs">
                  <p className="font-bold text-red-700">{fac.name}</p>
                  {fac.type && <p className="text-slate-600">{fac.type}</p>}
                  <p className="mt-1 font-semibold text-slate-900">
                    Distance: {fac.distanceKm.toFixed(2)} km
                  </p>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}

