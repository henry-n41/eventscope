// Card art: one SVG per event outcome, generated from the event's own data (teams and colours, coin, city, weather type).
// Rarity sets the frame: legendary gold, epic violet, rare blue, common silver. No external fonts.
import { createHash } from "node:crypto";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hue = (s, k = 0) => createHash("sha256").update(String(s) + k).digest()[0] * 360 / 256;
const FRAMES = {
  legendary: ["#fde68a", "#f59e0b", "#b45309", "LEGENDARY"], epic: ["#e9d5ff", "#a855f7", "#6b21a8", "EPIC"],
  rare: ["#bae6fd", "#38bdf8", "#0369a1", "RARE"], common: ["#e4e4e7", "#a1a1aa", "#52525b", "COMMON"], preview: ["#e4e4e7", "#71717a", "#3f3f46", ""],
};
const COIN = { BTC: "₿", ETH: "Ξ", SOL: "◎" };
function wrap(text, max = 22) {
  const words = String(text).split(/\s+/); const lines = [""];
  for (const w of words) { if ((lines.at(-1) + " " + w).trim().length > max && lines.at(-1)) lines.push(w); else lines[lines.length - 1] = (lines.at(-1) + " " + w).trim(); }
  return lines.slice(0, 3);
}
function motif(ev, outcome, c1, c2) {
  const cat = ev.category; const m = ev.meta || {};
  if (cat === "crypto") {
    const sym = COIN[m.coin] || "¤"; const up = /above|over/i.test(ev.outcomes[outcome]) ? 1 : /under|below/i.test(ev.outcomes[outcome]) ? -1 : 0;
    const pts = Array.from({ length: 12 }, (_, i) => `${30 + i * 22},${150 - Math.sin(i * 0.9 + hue(ev.source_ref) / 50) * 18 - up * i * 5}`).join(" ");
    return `<circle cx="150" cy="140" r="64" fill="url(#coin)" stroke="#fff" stroke-opacity=".5" stroke-width="3"/><text x="150" y="166" font-size="76" text-anchor="middle" fill="#fff" font-weight="800">${sym}</text>
      <polyline points="${pts}" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="4" stroke-linecap="round"/>`;
  }
  if (cat === "weather") {
    const rain = /rain/i.test(ev.outcomes[outcome]); const dry = /dry/i.test(ev.outcomes[outcome]); const temp = /°C/.test(ev.outcomes[outcome]);
    if (temp) { const lvl = outcome === 0 ? 0.3 : outcome === 1 ? 0.6 : 0.9; return `<rect x="135" y="70" width="30" height="130" rx="15" fill="#fff" fill-opacity=".25" stroke="#fff" stroke-width="3"/><rect x="141" y="${76 + 118 * (1 - lvl)}" width="18" height="${118 * lvl}" rx="9" fill="${outcome === 2 ? "#f97316" : outcome === 0 ? "#38bdf8" : "#facc15"}"/><circle cx="150" cy="205" r="22" fill="${outcome === 2 ? "#f97316" : outcome === 0 ? "#38bdf8" : "#facc15"}" stroke="#fff" stroke-width="3"/>`; }
    if (dry) return `<circle cx="150" cy="135" r="46" fill="#fde047"/>${Array.from({ length: 12 }, (_, i) => { const a = i * Math.PI / 6; return `<line x1="${150 + Math.cos(a) * 58}" y1="${135 + Math.sin(a) * 58}" x2="${150 + Math.cos(a) * 78}" y2="${135 + Math.sin(a) * 78}" stroke="#fde047" stroke-width="6" stroke-linecap="round"/>`; }).join("")}`;
    return `<g fill="#fff"><circle cx="120" cy="130" r="34"/><circle cx="160" cy="112" r="44"/><circle cx="196" cy="135" r="30"/><rect x="88" y="130" width="140" height="34" rx="17"/></g>${rain ? Array.from({ length: 7 }, (_, i) => `<line x1="${100 + i * 18}" y1="180" x2="${92 + i * 18}" y2="210" stroke="#7dd3fc" stroke-width="5" stroke-linecap="round"/>`).join("") : ""}`;
  }
  // sports: two crests split diagonally, the picked side lit
  const h = m.home || {}, a = m.away || {};
  const lit = ev.outcomes.length === 3 ? [outcome === 0, outcome === 2] : [outcome === 0, outcome === 1];
  const draw = ev.outcomes.length === 3 && outcome === 1;
  const crest = (t, x, on) => `<g opacity="${on || draw ? 1 : 0.35}"><circle cx="${x}" cy="135" r="50" fill="#fff" fill-opacity=".95"/>${t.logo ? `<image href="${esc(t.logo)}" x="${x - 40}" y="95" width="80" height="80"/>` : `<text x="${x}" y="148" font-size="30" text-anchor="middle" font-weight="800" fill="#111">${esc(t.abbr)}</text>`}</g>`;
  const ball = { football: `<circle cx="150" cy="215" r="13" fill="#fff"/><polygon points="150,207 157,212 155,220 145,220 143,212" fill="#111"/>`,
    basketball: `<circle cx="150" cy="215" r="13" fill="#f97316"/><path d="M137 215h26M150 202v26" stroke="#111" stroke-width="2"/>`,
    hockey: `<ellipse cx="150" cy="217" rx="16" ry="7" fill="#111" stroke="#fff"/>`, "american-football": `<ellipse cx="150" cy="215" rx="17" ry="10" fill="#92400e" stroke="#fff"/><path d="M143 215h14" stroke="#fff" stroke-width="2"/>` }[cat] || "";
  return `${crest(h, 85, lit[0])}${crest(a, 215, lit[1])}<text x="150" y="146" font-size="22" text-anchor="middle" fill="#fff" font-weight="800">${draw ? "=" : "v"}</text>${ball}`;
}

export function cardSvg(ev, outcome, { serial = null, rarity = "preview", minted = null } = {}) {
  const [f1, f2, f3, label] = FRAMES[rarity] || FRAMES.preview;
  const m = ev.meta || {};
  const c1 = m.home?.color ? `#${m.home.color}` : `hsl(${hue(ev.source_ref)},70%,42%)`;
  const c2 = m.away?.color ? `#${m.away.color}` : `hsl(${(hue(ev.source_ref, 1) + 120) % 360},70%,30%)`;
  const sub = m.league || (ev.category === "crypto" ? `Crypto · ${m.coin}` : ev.category === "weather" ? `Weather · ${m.city}` : ev.category);
  const t = wrap(ev.title, 26); const o = wrap(ev.outcomes[outcome], 20);
  const when = new Date(m.kickoff || m.target || m.hour || ev.closes_at).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const foil = rarity === "legendary" || rarity === "epic";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 420" width="300" height="420">
<defs>
 <linearGradient id="fr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${f1}"/><stop offset=".5" stop-color="${f2}"/><stop offset="1" stop-color="${f3}"/></linearGradient>
 <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset=".49" stop-color="${c1}"/><stop offset=".51" stop-color="${c2}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
 <radialGradient id="coin"><stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#d97706"/></radialGradient>
 <linearGradient id="foil" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
 <pattern id="dots" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.2" fill="#fff" fill-opacity=".12"/></pattern>
 <clipPath id="win"><rect x="16" y="44" width="268" height="196" rx="10"/></clipPath>
</defs>
<rect width="300" height="420" rx="18" fill="url(#fr)"/>
<rect x="8" y="8" width="284" height="404" rx="13" fill="#0c0a12"/>
<text x="20" y="32" font-family="system-ui,sans-serif" font-size="12" font-weight="700" fill="${f1}" letter-spacing="1.5">${esc(String(sub).toUpperCase())}</text>
<text x="280" y="32" font-family="system-ui,sans-serif" font-size="12" font-weight="700" fill="${f1}" text-anchor="end">${serial ? `#${String(serial).padStart(3, "0")}` : minted != null ? `${minted} minted` : ""}</text>
<g clip-path="url(#win)"><rect x="16" y="44" width="268" height="196" fill="url(#bg)"/><rect x="16" y="44" width="268" height="196" fill="url(#dots)"/>
 <g font-family="system-ui,sans-serif">${motif(ev, outcome, c1, c2)}</g>
 ${foil ? `<rect x="-120" y="44" width="120" height="196" fill="url(#foil)" transform="skewX(-20)"><animate attributeName="x" from="-160" to="420" dur="3.2s" repeatCount="indefinite"/></rect>` : ""}
</g>
<g font-family="system-ui,sans-serif">
 ${t.map((line, i) => `<text x="20" y="${266 + i * 17}" font-size="14" fill="#d4d4d8" font-weight="600">${esc(line)}</text>`).join("")}
 <rect x="16" y="${300 + (t.length - 1) * 6}" width="268" height="${o.length * 24 + 18}" rx="10" fill="${f2}" fill-opacity=".16" stroke="${f2}" stroke-opacity=".6"/>
 ${o.map((line, i) => `<text x="150" y="${326 + (t.length - 1) * 6 + i * 24}" font-size="21" fill="#fff" font-weight="800" text-anchor="middle">${esc(line)}</text>`).join("")}
 <text x="20" y="400" font-size="11" fill="#a1a1aa">${esc(when)}</text>
 <text x="280" y="400" font-size="11" fill="${f1}" font-weight="800" text-anchor="end" letter-spacing="1.5">${label}</text>
</g></svg>`;
}

/** Pack wrapper art. */
export function packSvg(name = "Matchday pack", n = 3) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 420" width="300" height="420"><defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset=".5" stop-color="#db2777"/><stop offset="1" stop-color="#f59e0b"/></linearGradient>
<pattern id="z" width="22" height="22" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><rect width="11" height="22" fill="#fff" fill-opacity=".07"/></pattern></defs>
<rect width="300" height="420" rx="18" fill="url(#p)"/><rect width="300" height="420" rx="18" fill="url(#z)"/>
<path d="M0 40 L20 30 L40 40 L60 30 L80 40 L100 30 L120 40 L140 30 L160 40 L180 30 L200 40 L220 30 L240 40 L260 30 L280 40 L300 30 L300 0 L0 0Z" fill="#000" fill-opacity=".25"/>
<g font-family="system-ui,sans-serif" text-anchor="middle" fill="#fff"><text x="150" y="190" font-size="32" font-weight="900">EVENTSCOPE</text><text x="150" y="226" font-size="18" font-weight="700">${esc(name)}</text>
<text x="150" y="262" font-size="14" fill-opacity=".85">${n} cards · ${n} different live events</text><text x="150" y="380" font-size="12" fill-opacity=".8">Testnet · play money</text></g></svg>`;
}
