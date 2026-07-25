const fs = require("fs");
const p = "manual-tracker/lib/bankroll.js";
const buf = fs.readFileSync(p);
const t = (buf[1] === 0 ? buf.toString("utf16le") : buf.toString("utf8"));
let out = t
  .replace(/let st = normalizeState\(state\);\r?\n  if \(Number\.isFinite\(bal\)\) \{\r?\n    st\.balance = bal;\r?\n    st = syncCatchUpQueue\(st\);\r?\n  \}/,
    "let st = normalizeState(state);\n  if (Number.isFinite(bal)) st.balance = bal;")
  .replace("const layerUsd = round2(front.usd);", "const layerUsd = round2(gap > 0 ? Math.min(front.usd, gap) : front.usd);")
  .replace(/\/\/ gap>0[^\n]*[\s\S]*?catchUpQueue: \[made\.layer\],/,
`// gap>0 队列未登记：仅用于 sizing 展示，不写回状态
  const layerUsd = round2(gap);
  let T = round2(layerUsd + step);
  if (Number.isFinite(tCap) && tCap > 0) T = Math.min(T, tCap);
  const stakeUsd = stakeFromTarget(T, profitRatio, clampStake);
  const nextId = nextIdFromQueue([], st.nextLayerId);
  return {
    stakeUsd,
    profitUsd: round2(stakeUsd * profitRatio),
    mode: 'catch_up',
    targetProfitUsd: T,
    layerUsd,
    layerIndex: nextId,
    catchUpLabel: \`补\${nextId}\`,
    catchUpQueue: [{ id: nextId, usd: layerUsd }],`)
  .replace("st.nextLayerId = nextLayerId;\n  }\n\n  const trade =",
    "st.nextLayerId = nextLayerId;\n    syncCatchUpQueue(st);\n  }\n\n  const trade =")
  .replace("let st = normalizeState(state);\n  st = syncCatchUpQueue(st);", "const st = normalizeState(state);")
  .replace("catchUpQueue: sizing.catchUpQueue?.length ? sizing.catchUpQueue : st.catchUpQueue,",
    "catchUpQueue: st.catchUpQueue,")
  .replace("syncCatchUpQueue(st);\n  st.updatedAt = new Date().toISOString();\n  return st;\n}\n\nexport function patchSettings",
    "syncCatchUpQueue(st, { allowOpen: true });\n  st.updatedAt = new Date().toISOString();\n  return st;\n}\n\nexport function patchSettings");
fs.writeFileSync(p, out, "utf8");
console.log("ok");