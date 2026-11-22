// Live events feed: real upcoming events from free public sources (no API key), and their official results from the SAME source.
//   ESPN public scoreboards (football in 7 leagues, NBA, NHL, NFL)  site.api.espn.com   (unofficial public JSON, no key)
//   Coinbase Exchange public market data (BTC, ETH, SOL)            api.exchange.coinbase.com (no key)
//   Open-Meteo forecast API (rain and temperature, 4 cities)        api.open-meteo.com  (no key, free for non-commercial use)
// Each candidate: { source_ref, title, category, outcomes, closes_at (ISO), meta }. Each result: { final, outcome, url, bytes, summary }.
// `bytes` is the exact response body the result was read from: its SHA-256 goes on chain, the bytes are kept in .run/evidence.
const UA = { "user-agent": "EventScope-testnet-demo/1.0 (hackathon prototype)" };
async function get(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  return { bytes, json: JSON.parse(bytes.toString("utf8")) };
}
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// ------------------------------------------------------------------ sports (ESPN)
export const LEAGUES = [
  { path: "soccer/eng.1", name: "Premier League", category: "football", draw: true, max: 4 },
  { path: "soccer/esp.1", name: "LaLiga", category: "football", draw: true, max: 3 },
  { path: "soccer/ger.1", name: "Bundesliga", category: "football", draw: true, max: 3 },
  { path: "soccer/ita.1", name: "Serie A", category: "football", draw: true, max: 3 },
  { path: "soccer/fra.1", name: "Ligue 1", category: "football", draw: true, max: 2 },
  { path: "soccer/usa.1", name: "MLS", category: "football", draw: true, max: 2 },
  { path: "soccer/uefa.champions", name: "Champions League", category: "football", draw: true, max: 4 },
  { path: "basketball/nba", name: "NBA", category: "basketball", draw: false, max: 4 },
  { path: "hockey/nhl", name: "NHL", category: "hockey", draw: false, max: 3 },
  { path: "football/nfl", name: "NFL", category: "american-football", draw: false, max: 3 },
];

export async function sportsCandidates({ days = 3, now = Date.now(), leagues = null } = {}) {
  const out = [];
  for (const L of leagues ? LEAGUES.filter((x) => leagues.includes(x.path)) : LEAGUES) {
    const picked = [];
    for (let i = 0; i < days && picked.length < L.max; i++) {
      let j; try { j = (await get(`https://site.api.espn.com/apis/site/v2/sports/${L.path}/scoreboard?dates=${ymd(new Date(now + i * 86400000))}`)).json; } catch { continue; }
      for (const e of j.events || []) {
        if (picked.length >= L.max) break;
        const st = e.status?.type; const t = Date.parse(e.date);
        if (!st || st.state !== "pre" || t < now + 20 * 60_000) continue; // only games that have not started (20 min margin)
        const c = e.competitions?.[0]; const home = c?.competitors?.find((x) => x.homeAway === "home"), away = c?.competitors?.find((x) => x.homeAway === "away");
        if (!home || !away) continue;
        const H = home.team, A = away.team;
        const outcomes = L.draw ? [`${H.shortDisplayName || H.displayName} win`, "Draw", `${A.shortDisplayName || A.displayName} win`]
          : [`${H.shortDisplayName || H.displayName} win`, `${A.shortDisplayName || A.displayName} win`];
        picked.push({ source_ref: `espn:${L.path}:${e.id}`, category: L.category, title: `${H.displayName} v ${A.displayName}`, outcomes, closes_at: iso(t),
          meta: { league: L.name, home: { name: H.displayName, abbr: H.abbreviation, logo: H.logo, color: H.color }, away: { name: A.displayName, abbr: A.abbreviation, logo: A.logo, color: A.color },
            venue: c.venue?.fullName || null, kickoff: e.date, rule: L.draw ? "Result after normal time as published by ESPN (full time)." : "Final result including overtime as published by ESPN." } });
      }
    }
    out.push(...picked);
  }
  return out;
}

async function sportsResult(ev) {
  const [, path, id] = ev.source_ref.split(":");
  const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/summary?event=${id}`;
  const { bytes, json } = await get(url);
  const c = json.header?.competitions?.[0]; const st = c?.status?.type;
  if (!st?.completed) return { final: false, url, note: st?.description || "not finished" };
  const home = c.competitors.find((x) => x.homeAway === "home"), away = c.competitors.find((x) => x.homeAway === "away");
  const hs = Number(home.score), as = Number(away.score);
  const draw = ev.outcomes.length === 3;
  let outcome;
  if (hs > as) outcome = 0; else if (hs < as) outcome = draw ? 2 : 1; else if (draw) outcome = 1; else return { final: false, url, note: "tie in a no-draw sport" };
  if (/postponed|canceled|cancelled|abandoned/i.test(st.description || "")) return { final: false, void: true, url, note: st.description };
  return { final: true, outcome, url, bytes, summary: `${home.team.abbreviation} ${hs} - ${as} ${away.team.abbreviation} (${st.description})` };
}

// ------------------------------------------------------------------ crypto (Coinbase Exchange)
export const COINS = [{ id: "BTC-USD", name: "Bitcoin", sym: "BTC" }, { id: "ETH-USD", name: "Ether", sym: "ETH" }, { id: "SOL-USD", name: "Solana", sym: "SOL" }];
const fmtUsd = (x) => "$" + (x >= 1000 ? Math.round(x).toLocaleString("en-US") : x.toFixed(2));

/** Rolling price events: "Bitcoin at 16:00 UTC: above or below $63,800?" Target time on the next quarter hour (+ lead). */
// Testnet fees are about 20 CCD per contract call at today's energy price, so the rolling feed is kept lean by default:
// a 1-hour band for each coin and a 15-minute line for Bitcoin only. EVENTSCOPE_FEED=full adds 15-minute lines for all coins.
const FULL = process.env.EVENTSCOPE_FEED === "full";
export async function cryptoCandidates({ now = Date.now(), leadMin = 12, horizonsMin = [15, 60] } = {}) {
  const out = [];
  for (const c of COINS) {
    let px; try { px = Number((await get(`https://api.exchange.coinbase.com/products/${c.id}/ticker`)).json.price); } catch { continue; }
    if (!(px > 0)) continue;
    for (const h of horizonsMin) {
      if (h < 60 && !FULL && c.sym !== "BTC") continue;
      const q = 15 * 60_000; const target = Math.ceil((now + leadMin * 60_000 + (h - 15) * 60_000) / q) * q;
      const step = c.sym === "BTC" ? 25 : c.sym === "ETH" ? 1 : 0.05;
      const line = Math.round(px / step) * step;
      const t = new Date(target).toISOString().slice(11, 16);
      const type = h >= 60 ? "band" : "line";
      if (type === "line") {
        out.push({ source_ref: `coinbase:${c.id}:${target / 1000}:line:${line}`, category: "crypto", title: `${c.name} at ${t} UTC: above ${fmtUsd(line)}?`,
          outcomes: [`Above ${fmtUsd(line)}`, `${fmtUsd(line)} or below`], closes_at: iso(target - 5 * 60_000),
          meta: { coin: c.sym, pair: c.id, target: iso(target), line, price_at_creation: px, rule: `Opening price of the 1-minute Coinbase ${c.id} candle that starts at ${t} UTC.` } });
      } else {
        const w = Math.max(step, Math.round((px * 0.004) / step) * step); // +-0.4% band
        const lo = line - w, hi = line + w;
        out.push({ source_ref: `coinbase:${c.id}:${target / 1000}:band:${lo}:${hi}`, category: "crypto", title: `${c.name} at ${t} UTC: where will it be?`,
          outcomes: [`Under ${fmtUsd(lo)}`, `${fmtUsd(lo)} to ${fmtUsd(hi)}`, `Over ${fmtUsd(hi)}`], closes_at: iso(target - 10 * 60_000),
          meta: { coin: c.sym, pair: c.id, target: iso(target), lo, hi, price_at_creation: px, rule: `Opening price of the 1-minute Coinbase ${c.id} candle that starts at ${t} UTC. Edges count as the middle band.` } });
      }
    }
  }
  return out;
}

/** Curated daily crypto: fixed UTC slots, one band event per slot, created up to `aheadH` hours before.
 *  Band is +-0.4% per hour of lead time, capped at +-3%, so the middle band stays a real question. */
export const CRYPTO_SLOTS = [{ sym: "BTC", hour: 9 }, { sym: "BTC", hour: 21 }, { sym: "ETH", hour: 18 }, { sym: "SOL", hour: 15 }];
export async function cryptoDaily({ now = Date.now(), aheadH = 14 } = {}) {
  const out = []; const px = {};
  for (const s of CRYPTO_SLOTS) {
    const c = COINS.find((x) => x.sym === s.sym);
    let target = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate(), s.hour);
    if (target < now + 90 * 60_000) target += 86400_000;
    if (target > now + aheadH * 3600_000) continue;
    if (px[c.id] === undefined) { try { px[c.id] = Number((await get(`https://api.exchange.coinbase.com/products/${c.id}/ticker`)).json.price); } catch { px[c.id] = 0; } }
    const p = px[c.id]; if (!(p > 0)) continue;
    const step = c.sym === "BTC" ? 50 : c.sym === "ETH" ? 2 : 0.1;
    const line = Math.round(p / step) * step; const pct = Math.min(0.03, 0.004 * Math.max(1, (target - now) / 3600_000) ** 0.5 * 2);
    const w = Math.max(step, Math.round((p * pct) / step) * step); const lo = line - w, hi = line + w;
    const t = new Date(target).toISOString().slice(11, 16);
    out.push({ source_ref: `coinbase:${c.id}:${target / 1000}:band:${lo}:${hi}`, category: "crypto", title: `${c.name} at ${t} UTC: where will it be?`,
      outcomes: [`Under ${fmtUsd(lo)}`, `${fmtUsd(lo)} to ${fmtUsd(hi)}`, `Over ${fmtUsd(hi)}`], closes_at: iso(target - 30 * 60_000),
      meta: { coin: c.sym, pair: c.id, target: iso(target), lo, hi, price_at_creation: p, rule: `Opening price of the 1-minute Coinbase ${c.id} candle that starts at ${t} UTC. Edges count as the middle band.` } });
  }
  return out;
}

async function cryptoResult(ev) {
  const [, pair, ts, kind, a, b] = ev.source_ref.split(":");
  const start = Number(ts);
  const url = `https://api.exchange.coinbase.com/products/${pair}/candles?granularity=60&start=${iso((start - 60) * 1000)}&end=${iso((start + 120) * 1000)}`;
  if (Date.now() < start * 1000 + 90_000) return { final: false, url, note: "candle not closed yet" };
  const { bytes, json } = await get(url);
  const candle = (json || []).find((k) => Number(k[0]) === start);
  if (!candle) return { final: false, url, note: "candle not published yet" };
  const open = Number(candle[3]); // [time, low, high, open, close, volume]
  let outcome;
  if (kind === "line") outcome = open > Number(a) ? 0 : 1;
  else outcome = open < Number(a) ? 0 : open > Number(b) ? 2 : 1;
  return { final: true, outcome, url, bytes, summary: `${pair} opened at ${fmtUsd(open)} at ${iso(start * 1000).slice(11, 16)} UTC` };
}

// ------------------------------------------------------------------ weather (Open-Meteo)
// Cities no longer used for new events, kept so their already-created events still resolve.
export const RETIRED_CITIES = [{ id: "lagos", name: "Lagos", lat: 6.5244, lon: 3.3792 }];
export const HIDDEN_PREFIXES = ["openmeteo:lagos:"];
export const CITIES = [
  { id: "london", name: "London", lat: 51.5072, lon: -0.1276 }, // Lagos removed 19 Nov at Henry's request (old Lagos events are hidden in the UI)
  { id: "newyork", name: "New York", lat: 40.7128, lon: -74.006 }, { id: "tokyo", name: "Tokyo", lat: 35.6762, lon: 139.6503 },
];
const meteo = (c, extra = "") => `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&hourly=temperature_2m,precipitation&timezone=GMT&past_days=1&forecast_days=2${extra}`;

/** "Will it rain in London between 17:00 and 18:00 UTC?" and "Lagos at 18:00 UTC: temperature band". */
export async function weatherCandidates({ now = Date.now(), leadHours = 1 } = {}) {
  const out = [];
  const hour = Math.ceil(now / 3600_000) * 3600_000 + leadHours * 3600_000; // a full hour that starts at least ~1h from now
  const hh = new Date(hour).toISOString().slice(11, 13);
  for (const c of FULL ? CITIES : CITIES.slice(0, 2)) {
    let j; try { j = (await get(meteo(c))).json; } catch { continue; }
    const i = j.hourly.time.indexOf(new Date(hour).toISOString().slice(0, 13) + ":00");
    if (i < 0) continue;
    const t = j.hourly.temperature_2m[i]; const rainFc = j.hourly.precipitation[i];
    out.push({ source_ref: `openmeteo:${c.id}:${hour / 1000}:rain`, category: "weather", title: `Rain in ${c.name} between ${hh}:00 and ${String((Number(hh) + 1) % 24).padStart(2, "0")}:00 UTC?`,
      outcomes: ["Rain (0.1 mm or more)", "Dry"], closes_at: iso(hour),
      meta: { city: c.name, hour: iso(hour), forecast_mm: rainFc, rule: "Open-Meteo hourly precipitation for that hour (model data, read about 2 hours after the hour)." } });
    const mid = Math.round(t); const lo = mid - 1, hi = mid + 1;
    out.push({ source_ref: `openmeteo:${c.id}:${hour / 1000}:temp:${lo}:${hi}`, category: "weather", title: `${c.name} at ${hh}:00 UTC: how warm?`,
      outcomes: [`Below ${lo}°C`, `${lo} to ${hi}°C`, `Above ${hi}°C`], closes_at: iso(hour - 30 * 60_000),
      meta: { city: c.name, hour: iso(hour), forecast_c: t, lo, hi, rule: "Open-Meteo hourly 2 m temperature for that hour (model data, read about 2 hours after the hour). Edges count as the middle band." } });
  }
  return out;
}

/** Curated daily weather: one temperature question per city at local early afternoon (UTC hour below). */
export const WEATHER_SLOTS = [{ id: "london", hour: 14 }, { id: "newyork", hour: 18 }, { id: "tokyo", hour: 5 }];
export async function weatherDaily({ now = Date.now(), aheadH = 26 } = {}) {
  const out = []; let lastErr = null;
  // one request for all cities (Open-Meteo accepts comma-separated coordinates and answers with an array): fewer calls, fewer 429s
  const cs = WEATHER_SLOTS.map((s) => CITIES.find((x) => x.id === s.id));
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${cs.map((c) => c.lat).join(",")}&longitude=${cs.map((c) => c.lon).join(",")}&hourly=temperature_2m,precipitation&timezone=GMT&past_days=1&forecast_days=2`;
  let all = null;
  for (let k = 0; k < 2 && !all; k++) { try { const j = (await get(url)).json; all = Array.isArray(j) ? j : [j]; } catch (e) { lastErr = e; if (k === 0) await new Promise((r) => setTimeout(r, 8000)); } }
  if (!all) throw lastErr;
  for (const [n, s] of WEATHER_SLOTS.entries()) {
    const c = cs[n];
    let hour = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate(), s.hour);
    if (hour < now + 2 * 3600_000) hour += 86400_000;
    if (hour > now + aheadH * 3600_000) continue;
    const j = all[n]; if (!j?.hourly) continue;
    const i = j.hourly.time.indexOf(new Date(hour).toISOString().slice(0, 13) + ":00"); if (i < 0) continue;
    const t = j.hourly.temperature_2m[i]; const hh = new Date(hour).toISOString().slice(11, 13);
    const mid = Math.round(t); const lo = mid - 1, hi = mid + 1;
    out.push({ source_ref: `openmeteo:${c.id}:${hour / 1000}:temp:${lo}:${hi}`, category: "weather", title: `${c.name} at ${hh}:00 UTC: how warm?`,
      outcomes: [`Below ${lo}°C`, `${lo} to ${hi}°C`, `Above ${hi}°C`], closes_at: iso(hour - 60 * 60_000),
      meta: { city: c.name, hour: iso(hour), forecast_c: t, lo, hi, rule: "Open-Meteo hourly 2 m temperature for that hour (model data, read about 2 hours after the hour). Edges count as the middle band." } });
  }
  return out;
}

async function weatherResult(ev) {
  const [, cityId, ts, kind, a, b] = ev.source_ref.split(":");
  const c = [...CITIES, ...RETIRED_CITIES].find((x) => x.id === cityId); const hour = Number(ts) * 1000;
  const url = meteo(c);
  if (Date.now() < hour + 2 * 3600_000) return { final: false, url, note: "waiting for the hour's data to settle" };
  const { bytes, json } = await get(url);
  const i = json.hourly.time.indexOf(new Date(hour).toISOString().slice(0, 13) + ":00");
  if (i < 0) return { final: false, url, note: "hour not in response" };
  if (kind === "rain") { const mm = json.hourly.precipitation[i]; return { final: true, outcome: mm >= 0.1 ? 0 : 1, url, bytes, summary: `${c.name} ${mm} mm` }; }
  const t = json.hourly.temperature_2m[i];
  return { final: true, outcome: t < Number(a) ? 0 : t > Number(b) ? 2 : 1, url, bytes, summary: `${c.name} ${t}°C` };
}

export async function resultFor(ev) {
  const src = ev.source_ref.split(":")[0];
  if (src === "espn") return sportsResult(ev);
  if (src === "coinbase") return cryptoResult(ev);
  if (src === "openmeteo") return weatherResult(ev);
  return { final: false, note: "unknown source" };
}
