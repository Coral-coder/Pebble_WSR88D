/* Clay configuration schema. Clay expects a FLAT array of components — there
 * is no "section" wrapper — so "heading" items are used as group separators.
 * messageKey values prefixed SET_ are forwarded to the watch; the rest are
 * read by the JS side only. Keep defaults in sync with src/c/wsr88d.h and
 * getConfig() in index.js. */
module.exports = [
  { "type": "heading", "defaultValue": "WSR-88D Radar" },
  { "type": "text",
    "defaultValue": "Latest NWS weather-surveillance radar over a light or dark map for your location." },

  { "type": "heading", "defaultValue": "Location", "size": 4 },
  { "type": "radiogroup", "messageKey": "LOC_MODE", "label": "Location source",
    "defaultValue": "0", "options": [
      { "label": "Automatic (GPS)", "value": "0" },
      { "label": "Manual coordinates", "value": "1" }
    ] },
  { "type": "input", "messageKey": "LOC_LAT", "label": "Latitude (manual)",
    "attributes": { "placeholder": "e.g. 35.22", "type": "text" } },
  { "type": "input", "messageKey": "LOC_LON", "label": "Longitude (manual)",
    "attributes": { "placeholder": "e.g. -97.44", "type": "text" } },

  { "type": "heading", "defaultValue": "Radar", "size": 4 },
  { "type": "select", "messageKey": "SET_SCHEME", "label": "Color scheme",
    "defaultValue": 2, "options": [
      { "label": "Black & White", "value": 0 },
      { "label": "Original", "value": 1 },
      { "label": "Universal Blue", "value": 2 },
      { "label": "TITAN", "value": 3 },
      { "label": "The Weather Channel", "value": 4 },
      { "label": "Meteored", "value": 5 },
      { "label": "NEXRAD Level III", "value": 6 },
      { "label": "Rainbow (SELEX-SI)", "value": 7 },
      { "label": "Dark Sky", "value": 8 }
    ] },
  { "type": "toggle", "messageKey": "RADAR_SMOOTH", "label": "Smooth radar",
    "defaultValue": true },
  { "type": "toggle", "messageKey": "RADAR_SNOW",
    "label": "Distinct snow colors", "defaultValue": true },
  { "type": "slider", "messageKey": "SET_FRAMES", "label": "Loop frames",
    "defaultValue": 10, "min": 1, "max": 10, "step": 1 },
  { "type": "toggle", "messageKey": "SET_ANIMATE", "label": "Animate loop on tap",
    "defaultValue": true },

  { "type": "heading", "defaultValue": "Map", "size": 4 },
  { "type": "radiogroup", "messageKey": "MAP_DETAIL", "label": "Map labels",
    "defaultValue": "1", "options": [
      { "label": "No labels (clean)", "value": "1" },
      { "label": "With place labels", "value": "2" }
    ] },
  { "type": "select", "messageKey": "ZOOM", "label": "Zoom / range",
    "defaultValue": 6, "options": [
      { "label": "4 — Multi-state", "value": 4 },
      { "label": "5 — State (~440 mi)", "value": 5 },
      { "label": "6 — Regional (~220 mi)", "value": 6 },
      { "label": "7 — Metro (~110 mi)", "value": 7 },
      { "label": "8 — City (~55 mi, radar upscaled)", "value": 8 },
      { "label": "9 — Local (~28 mi, radar upscaled)", "value": 9 },
      { "label": "10 — Close (~14 mi, radar upscaled)", "value": 10 }
    ] },
  { "type": "select", "messageKey": "MAP_STYLE", "label": "Map style",
    "defaultValue": 1, "options": [
      { "label": "Roads & coastline (clean)", "value": 1 },
      { "label": "Roads & coastline — dark", "value": 5 },
      { "label": "Streets — Stamen Toner (needs key)", "value": 4 },
      { "label": "Full color", "value": 0 },
      { "label": "Custom tile URL", "value": 9 }
    ] },
  { "type": "input", "messageKey": "STADIA_KEY",
    "label": "Stadia Maps API key",
    "description": "Free at stadiamaps.com — enables the Streets (Stamen Toner) style with real black roads.",
    "attributes": { "placeholder": "paste key for Streets style" } },
  { "type": "input", "messageKey": "MAP_URL",
    "label": "Custom tile URL",
    "description": "Used only by the 'Custom tile URL' style.",
    "attributes": { "placeholder": "https://.../{z}/{x}/{y}.png" } },

  { "type": "heading", "defaultValue": "Display", "size": 4 },
  { "type": "radiogroup", "messageKey": "SET_UNITS", "label": "Units",
    "defaultValue": "0", "options": [
      { "label": "Miles", "value": "0" },
      { "label": "Kilometers", "value": "1" }
    ] },
  { "type": "select", "messageKey": "SET_UPDATE_MIN", "label": "Update frequency",
    "defaultValue": 10, "options": [
      { "label": "5 minutes", "value": 5 },
      { "label": "10 minutes", "value": 10 },
      { "label": "15 minutes", "value": 15 },
      { "label": "30 minutes", "value": 30 },
      { "label": "60 minutes", "value": 60 }
    ] },

  { "type": "submit", "defaultValue": "Save" }
];
