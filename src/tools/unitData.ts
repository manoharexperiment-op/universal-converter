export interface Unit {
  id: string;
  label: string;
  toBase: number;
  /** Compact name used in the "1 gaj = 9 sq ft" line. Falls back to label. */
  short?: string;
}

export interface Category {
  id: string;
  label: string;
  icon: string;
  units: Unit[];
  base: string;
}

const SQ_FT = 0.09290304;
const SQ_YD = 0.83612736;

export const CATEGORIES: Category[] = [
  {
    id: 'length',
    label: 'Length',
    icon: '📏',
    base: 'm',
    units: [
      { id: 'nm', label: 'Nanometre (nm)', short: 'nm', toBase: 1e-9 },
      { id: 'um', label: 'Micrometre (µm)', short: 'µm', toBase: 1e-6 },
      { id: 'mm', label: 'Millimetre (mm)', short: 'mm', toBase: 0.001 },
      { id: 'cm', label: 'Centimetre (cm)', short: 'cm', toBase: 0.01 },
      { id: 'm', label: 'Metre (m)', short: 'm', toBase: 1 },
      { id: 'km', label: 'Kilometre (km)', short: 'km', toBase: 1000 },
      { id: 'in', label: 'Inch (in)', short: 'in', toBase: 0.0254 },
      { id: 'ft', label: 'Foot (ft)', short: 'ft', toBase: 0.3048 },
      { id: 'yd', label: 'Yard / gaj (yd)', short: 'yd', toBase: 0.9144 },
      { id: 'mi', label: 'Mile (mi)', short: 'mi', toBase: 1609.344 },
      { id: 'nmi', label: 'Nautical mile', short: 'nmi', toBase: 1852 },
    ],
  },
  {
    id: 'weight',
    label: 'Weight',
    icon: '⚖️',
    base: 'kg',
    units: [
      { id: 'mg', label: 'Milligram (mg)', short: 'mg', toBase: 1e-6 },
      { id: 'g', label: 'Gram (g)', short: 'g', toBase: 0.001 },
      { id: 'kg', label: 'Kilogram (kg)', short: 'kg', toBase: 1 },
      { id: 'quintal', label: 'Quintal (100 kg)', short: 'quintal', toBase: 100 },
      { id: 't', label: 'Tonne (1000 kg)', short: 't', toBase: 1000 },
      { id: 'ct', label: 'Carat (200 mg)', short: 'ct', toBase: 0.0002 },
      { id: 'tola', label: 'Tola (11.6638 g)', short: 'tola', toBase: 0.0116638038 },
      { id: 'ozt', label: 'Troy ounce (31.1035 g)', short: 'oz t', toBase: 0.0311034768 },
      { id: 'oz', label: 'Ounce (oz)', short: 'oz', toBase: 0.028349523125 },
      { id: 'lb', label: 'Pound (lb)', short: 'lb', toBase: 0.45359237 },
      { id: 'st', label: 'Stone (14 lb)', short: 'st', toBase: 6.35029318 },
      { id: 'ton-us', label: 'Short ton (2000 lb)', short: 'short ton', toBase: 907.18474 },
      { id: 'ton-uk', label: 'Long ton (2240 lb)', short: 'long ton', toBase: 1016.0469088 },
    ],
  },
  {
    id: 'temperature',
    label: 'Temperature',
    icon: '🌡️',
    base: 'c',
    // toBase is meaningless here: temperature scales are affine, not ratios, so
    // convert() routes this category through convertTemperature() instead.
    units: [
      { id: 'c', label: 'Celsius (°C)', short: '°C', toBase: 1 },
      { id: 'f', label: 'Fahrenheit (°F)', short: '°F', toBase: 1 },
      { id: 'k', label: 'Kelvin (K)', short: 'K', toBase: 1 },
    ],
  },
  {
    id: 'area',
    label: 'Area',
    icon: '🗺️',
    base: 'sqm',
    units: [
      { id: 'sqmm', label: 'Square millimetre (mm²)', short: 'mm²', toBase: 1e-6 },
      { id: 'sqcm', label: 'Square centimetre (cm²)', short: 'cm²', toBase: 1e-4 },
      { id: 'sqm', label: 'Square metre (m²)', short: 'm²', toBase: 1 },
      { id: 'sqkm', label: 'Square kilometre (km²)', short: 'km²', toBase: 1e6 },
      { id: 'hectare', label: 'Hectare (10,000 m²)', short: 'hectare', toBase: 10000 },
      { id: 'sqin', label: 'Square inch (sq in)', short: 'sq in', toBase: 0.00064516 },
      { id: 'sqft', label: 'Square foot (sq ft)', short: 'sq ft', toBase: SQ_FT },
      { id: 'gaj', label: 'Square yard / gaj (9 sq ft)', short: 'gaj', toBase: SQ_YD },
      { id: 'acre', label: 'Acre (43,560 sq ft)', short: 'acre', toBase: SQ_FT * 43560 },
      { id: 'sqmi', label: 'Square mile', short: 'sq mi', toBase: 2589988.110336 },
      { id: 'cent', label: 'Cent (435.6 sq ft, 1/100 acre)', short: 'cent', toBase: SQ_FT * 435.6 },
      { id: 'ankanam', label: 'Ankanam (72 sq ft, Andhra)', short: 'ankanam', toBase: SQ_FT * 72 },
      { id: 'guntha', label: 'Guntha (1,089 sq ft, 1/40 acre)', short: 'guntha', toBase: SQ_FT * 1089 },
      { id: 'marla', label: 'Marla (272.25 sq ft, north India)', short: 'marla', toBase: SQ_FT * 272.25 },
      { id: 'kanal', label: 'Kanal (5,445 sq ft, 20 marla)', short: 'kanal', toBase: SQ_FT * 5445 },
      { id: 'ground', label: 'Ground (2,400 sq ft, Tamil Nadu)', short: 'ground', toBase: SQ_FT * 2400 },
      { id: 'katha-wb', label: 'Katha (720 sq ft, West Bengal)', short: 'katha (WB)', toBase: SQ_FT * 720 },
      { id: 'katha-bihar', label: 'Katha (1,361 sq ft, Bihar)', short: 'katha (Bihar)', toBase: SQ_FT * 1361 },
      { id: 'bigha-wb', label: 'Bigha (14,400 sq ft, West Bengal)', short: 'bigha (WB)', toBase: SQ_FT * 14400 },
      { id: 'bigha-raj', label: 'Bigha kachha (17,424 sq ft, Rajasthan)', short: 'bigha (kachha)', toBase: SQ_FT * 17424 },
      { id: 'bigha-up', label: 'Bigha pucca (27,225 sq ft, UP / Rajasthan)', short: 'bigha (pucca)', toBase: SQ_FT * 27225 },
    ],
  },
  {
    id: 'volume',
    label: 'Volume',
    icon: '🧪',
    base: 'l',
    units: [
      { id: 'ml', label: 'Millilitre (ml)', short: 'ml', toBase: 0.001 },
      { id: 'cucm', label: 'Cubic centimetre (cc)', short: 'cc', toBase: 0.001 },
      { id: 'l', label: 'Litre (L)', short: 'L', toBase: 1 },
      { id: 'cum', label: 'Cubic metre (m³)', short: 'm³', toBase: 1000 },
      { id: 'cuin', label: 'Cubic inch', short: 'cu in', toBase: 0.016387064 },
      { id: 'cuft', label: 'Cubic foot', short: 'cu ft', toBase: 28.316846592 },
      { id: 'tsp', label: 'Teaspoon (US, 4.93 ml)', short: 'tsp', toBase: 0.00492892159375 },
      { id: 'tbsp', label: 'Tablespoon (US, 14.79 ml)', short: 'tbsp', toBase: 0.01478676478125 },
      { id: 'cup-metric', label: 'Cup (metric, 250 ml)', short: 'cup (250 ml)', toBase: 0.25 },
      { id: 'cup-us', label: 'Cup (US, 236.6 ml)', short: 'cup (US)', toBase: 0.2365882365 },
      { id: 'floz-us', label: 'Fluid ounce (US)', short: 'fl oz (US)', toBase: 0.0295735295625 },
      { id: 'floz-uk', label: 'Fluid ounce (imperial)', short: 'fl oz (imp)', toBase: 0.0284130625 },
      { id: 'pt-us', label: 'Pint (US)', short: 'pt (US)', toBase: 0.473176473 },
      { id: 'qt-us', label: 'Quart (US)', short: 'qt (US)', toBase: 0.946352946 },
      { id: 'gal-us', label: 'Gallon (US)', short: 'gal (US)', toBase: 3.785411784 },
      { id: 'gal-uk', label: 'Gallon (imperial)', short: 'gal (imp)', toBase: 4.54609 },
    ],
  },
  {
    id: 'speed',
    label: 'Speed',
    icon: '🏎️',
    base: 'ms',
    units: [
      { id: 'ms', label: 'Metre per second (m/s)', short: 'm/s', toBase: 1 },
      { id: 'kmh', label: 'Kilometre per hour (km/h)', short: 'km/h', toBase: 1000 / 3600 },
      { id: 'mph', label: 'Mile per hour (mph)', short: 'mph', toBase: 0.44704 },
      { id: 'fts', label: 'Foot per second (ft/s)', short: 'ft/s', toBase: 0.3048 },
      { id: 'knot', label: 'Knot (nautical mile per hour)', short: 'knot', toBase: 1852 / 3600 },
      { id: 'mach', label: 'Mach (sea level, 340.29 m/s)', short: 'Mach', toBase: 340.29 },
    ],
  },
  {
    id: 'time',
    label: 'Time',
    icon: '⏱️',
    base: 's',
    units: [
      { id: 'ns', label: 'Nanosecond (ns)', short: 'ns', toBase: 1e-9 },
      { id: 'us', label: 'Microsecond (µs)', short: 'µs', toBase: 1e-6 },
      { id: 'ms', label: 'Millisecond (ms)', short: 'ms', toBase: 0.001 },
      { id: 's', label: 'Second (s)', short: 's', toBase: 1 },
      { id: 'min', label: 'Minute (min)', short: 'min', toBase: 60 },
      { id: 'hr', label: 'Hour (h)', short: 'h', toBase: 3600 },
      { id: 'day', label: 'Day (24 h)', short: 'day', toBase: 86400 },
      { id: 'week', label: 'Week (7 days)', short: 'week', toBase: 604800 },
      { id: 'month', label: 'Month (30 days)', short: 'month', toBase: 2592000 },
      { id: 'year', label: 'Year (365 days)', short: 'year', toBase: 31536000 },
    ],
  },
  {
    id: 'data',
    label: 'Digital storage',
    icon: '💾',
    base: 'byte',
    units: [
      { id: 'bit', label: 'Bit (b)', short: 'bit', toBase: 0.125 },
      { id: 'byte', label: 'Byte (B)', short: 'B', toBase: 1 },
      { id: 'kb', label: 'Kilobyte (KB, 1024 B)', short: 'KB', toBase: 1024 },
      { id: 'mb', label: 'Megabyte (MB, 1024 KB)', short: 'MB', toBase: 1024 ** 2 },
      { id: 'gb', label: 'Gigabyte (GB, 1024 MB)', short: 'GB', toBase: 1024 ** 3 },
      { id: 'tb', label: 'Terabyte (TB, 1024 GB)', short: 'TB', toBase: 1024 ** 4 },
      { id: 'pb', label: 'Petabyte (PB, 1024 TB)', short: 'PB', toBase: 1024 ** 5 },
    ],
  },
];

const DEFAULT_PAIRS: Record<string, [string, string]> = {
  length: ['cm', 'in'],
  weight: ['kg', 'lb'],
  temperature: ['c', 'f'],
  area: ['gaj', 'sqft'],
  volume: ['l', 'gal-us'],
  speed: ['kmh', 'mph'],
  time: ['hr', 'min'],
  data: ['gb', 'mb'],
};

export function getCategory(categoryId: string): Category | undefined {
  return CATEGORIES.find((c) => c.id === categoryId);
}

export function getUnit(categoryId: string, unitId: string): Unit | undefined {
  return getCategory(categoryId)?.units.find((u) => u.id === unitId);
}

export function unitName(unit: Unit | undefined): string {
  if (!unit) return '';
  return unit.short ?? unit.label;
}

export function defaultPair(categoryId: string): [string, string] {
  const preset = DEFAULT_PAIRS[categoryId];
  const cat = getCategory(categoryId);
  if (!cat) return ['', ''];
  const has = (id: string) => cat.units.some((u) => u.id === id);
  if (preset && has(preset[0]) && has(preset[1])) return [preset[0], preset[1]];
  return [cat.units[0].id, (cat.units[1] ?? cat.units[0]).id];
}

function toCelsius(fromId: string, value: number): number {
  if (fromId === 'c') return value;
  if (fromId === 'f') return ((value - 32) * 5) / 9;
  if (fromId === 'k') return value - 273.15;
  return NaN;
}

function fromCelsius(toId: string, celsius: number): number {
  if (toId === 'c') return celsius;
  if (toId === 'f') return (celsius * 9) / 5 + 32;
  if (toId === 'k') return celsius + 273.15;
  return NaN;
}

export function convertTemperature(fromId: string, toId: string, value: number): number {
  if (fromId === toId) return value;
  return fromCelsius(toId, toCelsius(fromId, value));
}

export function convert(categoryId: string, fromId: string, toId: string, value: number): number {
  if (!Number.isFinite(value)) return NaN;
  const cat = getCategory(categoryId);
  if (!cat) return NaN;
  if (cat.id === 'temperature') return convertTemperature(fromId, toId, value);

  const from = cat.units.find((u) => u.id === fromId);
  const to = cat.units.find((u) => u.id === toId);
  if (!from || !to || !to.toBase) return NaN;
  if (from.id === to.id) return value;
  return (value * from.toBase) / to.toBase;
}

const SIG = 10;

function exponentialForm(n: number): string {
  const [mantissa, exponent] = n.toExponential(SIG - 1).split('e');
  const trimmed = mantissa.indexOf('.') < 0 ? mantissa : mantissa.replace(/0+$/, '').replace(/\.$/, '');
  const e = Number(exponent);
  return `${trimmed}e${e < 0 ? '' : '+'}${e}`;
}

export function formatResult(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  if (n === 0) return '0';

  const abs = Math.abs(n);
  if (Number.isInteger(n) && abs <= Number.MAX_SAFE_INTEGER) return String(n);
  if (abs >= 1e15 || abs < 1e-6) return exponentialForm(n);

  // Rounding to significant digits first is what kills 0.30000000000000004:
  // String() of the rounded value then drops the trailing zeros for free, and
  // inside 1e-6..1e15 it never falls back to exponential notation.
  return String(Number(n.toPrecision(SIG)));
}
