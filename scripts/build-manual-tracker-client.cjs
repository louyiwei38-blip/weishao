const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "manual-tracker");

function readAnyAbs(p) {
  const buf = fs.readFileSync(p);
  if (buf.length >= 2 && buf[1] === 0) return buf.toString("utf16le");
  return buf.toString("utf8");
}
function readAny(rel) { return readAnyAbs(path.join(ROOT, rel)); }
function out(rel, text) { fs.writeFileSync(path.join(ROOT, rel), text, "utf8"); }

const bankrollCore = readAny("lib/bankroll.js")
  .replace(/^export const DEFAULTS/m, "const DEFAULTS")
  .replace(/^export function /gm, "function ");

out("lib/bankroll.global.js", [
  "(function (g) {",
  bankrollCore,
  "  g.ManualBankroll = { DEFAULTS, defaultState, normalizeState, computeStake, recordTrade, getSummary, resetBankroll, setBalance, patchSettings, undoLastTrade };",
  "})(typeof window !== 'undefined' ? window : globalThis);",
  "",
].join("\n"));

let appBody = readAnyAbs(path.join(__dirname, "_manual-tracker-app-src.js"))
  .replace(/^import[\s\S]*?from '\.\/lib\/bankroll\.js';\r?\n\r?\n/m, "");
appBody = appBody.replace("const $ = (sel) => document.querySelector(sel);\n\n", "function q(id){ return document.getElementById(id); }\n\n");
appBody = appBody.replace(/\$\('#([^']+)'\)/g, "q('$1')");

out("app.bundle.js", [
  "(function () {",
  "  var BR = window.ManualBankroll;",
  "  if (!BR) { document.body.innerHTML = '<p style=\"padding:24px;color:#ef4444;font-family:sans-serif\">璇峰厛杩愯 npm run manual:tracker锛屽啀鎵撳紑 http://localhost:8787</p>'; return; }",
  "  var defaultState = BR.defaultState, normalizeState = BR.normalizeState, recordTrade = BR.recordTrade;",
  "  var getSummary = BR.getSummary, resetBankroll = BR.resetBankroll, setBalance = BR.setBalance;",
  "  var patchSettings = BR.patchSettings, undoLastTrade = BR.undoLastTrade;",
  appBody,
  "})();",
  "",
].join("\n"));

let html = readAny("index.html");
if (!html.includes("app.bundle.js")) {
  html = html.replace('<script type="module" src="app.js"></script>', '<script src="lib/bankroll.global.js"></script>\n  <script src="app.bundle.js"></script>');
}
html = html.replace('id="setDefaultBet" />', 'id="setDefaultBet" value="10" />')
  .replace('id="setStep" />', 'id="setStep" value="10" />')
  .replace('id="setStakeMax" />', 'id="setStakeMax" value="30" />')
  .replace('id="setTCap" />', 'id="setTCap" value="20" />')
  .replace('id="setOdds" value="1.85" />', 'id="setOdds" value="0.85" />')
  .replace('id="setOdds" />', 'id="setOdds" value="0.85" />');
out("index.html", html);
out("app.js", readAnyAbs(path.join(__dirname, "_manual-tracker-app-src.js")).replace(/\$\('#([^']+)'\)/g, "document.getElementById('$1')"));
out("lib/bankroll.js", readAny("lib/bankroll.js"));
console.log("manual-tracker client built (UTF-8)");