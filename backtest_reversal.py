#!/usr/bin/env python3
"""Backtest: Reversal Continuation on BTC/USDT 5m + martingale stats."""

import json
import urllib.request
from collections import Counter
from datetime import datetime, timezone

SYMBOL = "BTCUSDT"
INTERVAL = "5m"
TARGET_TRADES = 500
FETCH_BARS = 4000  # 5m needs more bars for 500 signals
MARTINGALE_MAX_LOSSES = 4  # PRD v2.2
PAGE_SIZE = 1000  # Binance max per request


def fetch_klines_pages(total_bars: int) -> list[dict]:
    """Fetch historical klines by paging backward."""
    all_candles: list[dict] = []
    end_time: int | None = None

    while len(all_candles) < total_bars:
        limit = min(PAGE_SIZE, total_bars - len(all_candles))
        url = (
            f"https://api.binance.com/api/v3/klines"
            f"?symbol={SYMBOL}&interval={INTERVAL}&limit={limit}"
        )
        if end_time is not None:
            url += f"&endTime={end_time}"

        with urllib.request.urlopen(url, timeout=30) as resp:
            raw = json.loads(resp.read().decode())

        if not raw:
            break

        page = [
            {
                "t": int(row[0]),
                "open": float(row[1]),
                "high": float(row[2]),
                "low": float(row[3]),
                "close": float(row[4]),
                "volume": float(row[5]),
            }
            for row in raw
        ]

        # Prepend older bars (API returns chronological)
        all_candles = page + all_candles
        end_time = page[0]["t"] - 1

        if len(page) < limit:
            break

    # Deduplicate by timestamp and sort
    by_t = {c["t"]: c for c in all_candles}
    return sorted(by_t.values(), key=lambda c: c["t"])


def classify(c: dict) -> str:
    if c["close"] > c["open"]:
        return "BULL"
    if c["close"] < c["open"]:
        return "BEAR"
    return "DOJI"


def evaluate_signal(prev: dict, curr: dict) -> tuple[str | None, str | None]:
    p, c = classify(prev), classify(curr)
    if p == "BULL" and c == "BEAR":
        return "DOWN", "S1"
    if p == "BEAR" and c == "BULL":
        return "UP", "S2"
    return None, None


def outcome(signal: str, nxt: dict) -> str:
    n = classify(nxt)
    if n == "DOJI":
        return "FLAT"
    if signal == "UP":
        return "WIN" if n == "BULL" else "LOSS"
    if signal == "DOWN":
        return "WIN" if n == "BEAR" else "LOSS"
    return "UNKNOWN"


def ts_fmt(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def simulate_martingale(
    sample: list[dict],
    base_bet: float = 10.0,
    multiplier: float = 2.0,
    max_losses: int = 4,
    max_bet: float = 200.0,
) -> dict:
    """
    PRD martingale: lose -> double bet; win -> reset;
    after max_losses consecutive losses -> halt, skip next signal, reset.
    PnL model: win +stake, loss -stake (≈50c Polymarket entry, no fees).
    """
    consecutive_losses = 0
    current_bet = base_bet
    is_halted = False

    total_pnl = 0.0
    total_wagered = 0.0
    trades_taken = 0
    trades_skipped_halt = 0
    stop_triggers = 0
    wins = 0
    losses = 0
    ledger: list[dict] = []

    for t in sample:
        if is_halted:
            trades_skipped_halt += 1
            is_halted = False
            consecutive_losses = 0
            current_bet = base_bet
            ledger.append({**t, "action": "SKIP_HALT", "bet": 0, "pnl": 0})
            continue

        bet = min(current_bet, max_bet)
        trades_taken += 1
        total_wagered += bet

        if t["result"] == "WIN":
            pnl = bet
            total_pnl += pnl
            wins += 1
            consecutive_losses = 0
            current_bet = base_bet
            ledger.append({**t, "action": "WIN", "bet": bet, "pnl": pnl, "runLoss": 0})
        elif t["result"] == "LOSS":
            pnl = -bet
            total_pnl += pnl
            losses += 1
            consecutive_losses += 1
            ledger.append(
                {
                    **t,
                    "action": "LOSS",
                    "bet": bet,
                    "pnl": pnl,
                    "runLoss": consecutive_losses,
                }
            )
            if consecutive_losses >= max_losses:
                stop_triggers += 1
                is_halted = True
                consecutive_losses = 0
                current_bet = base_bet
            else:
                current_bet = bet * multiplier
        else:  # FLAT
            ledger.append({**t, "action": "FLAT", "bet": bet, "pnl": 0})

    peak_eq = 0.0
    equity = 0.0
    max_drawdown = 0.0
    for row in ledger:
        if row["action"] in ("WIN", "LOSS"):
            equity += row["pnl"]
            peak_eq = max(peak_eq, equity)
            max_drawdown = max(max_drawdown, peak_eq - equity)

    return {
        "total_pnl": total_pnl,
        "total_wagered": total_wagered,
        "trades_taken": trades_taken,
        "trades_skipped_halt": trades_skipped_halt,
        "stop_triggers": stop_triggers,
        "wins": wins,
        "losses": losses,
        "peak_equity": peak_eq,
        "max_drawdown": max_drawdown,
        "final_equity": total_pnl,
        "ledger": ledger,
    }


def cycle_max_loss(base: float, multiplier: float, max_losses: int) -> float:
    """Theoretical loss if all bets in one martingale cycle lose."""
    total = 0.0
    bet = base
    for _ in range(max_losses):
        total += bet
        bet *= multiplier
    return total


def compare_martingale_stops(
    sample: list[dict],
    stops: list[int] | None = None,
    base_bet: float = 10.0,
    multiplier: float = 2.0,
) -> list[dict]:
    if stops is None:
        stops = [2, 3, 4, 5, 6, 7, 8]
    rows = []
    for n in stops:
        mg = simulate_martingale(
            sample, base_bet=base_bet, multiplier=multiplier, max_losses=n
        )
        roi = (mg["total_pnl"] / mg["total_wagered"] * 100) if mg["total_wagered"] else 0
        rows.append(
            {
                "max_losses": n,
                "cycle_risk": cycle_max_loss(base_bet, multiplier, n),
                "net_pnl": mg["total_pnl"],
                "total_wagered": mg["total_wagered"],
                "roi_pct": roi,
                "trades": mg["trades_taken"],
                "skipped": mg["trades_skipped_halt"],
                "stops": mg["stop_triggers"],
                "wins": mg["wins"],
                "losses": mg["losses"],
                "max_dd": mg["max_drawdown"],
                "peak": mg["peak_equity"],
            }
        )
    return rows


def print_martingale_grid(rows: list[dict], sample_size: int) -> None:
    print("=" * 88)
    print(
        f"Martingale stop comparison — $10 base, x2, last {sample_size} signals "
        "(win +bet / loss -bet, no fees)"
    )
    print("=" * 88)
    hdr = (
        f"{'Stop@':>6}  {'CycleRisk':>10}  {'NetPnL':>10}  {'Wagered':>10}  "
        f"{'ROI%':>7}  {'Stops':>6}  {'Skip':>5}  {'W/L':>9}  {'MaxDD':>8}"
    )
    print(hdr)
    print("-" * 88)
    best = max(rows, key=lambda r: r["net_pnl"])
    for r in rows:
        mark = " *" if r["max_losses"] == best["max_losses"] else ""
        print(
            f"{r['max_losses']:>5}亏  "
            f"${r['cycle_risk']:>8,.0f}  "
            f"${r['net_pnl']:>+9,.0f}  "
            f"${r['total_wagered']:>9,.0f}  "
            f"{r['roi_pct']:>+6.2f}%  "
            f"{r['stops']:>6}  "
            f"{r['skipped']:>5}  "
            f"{r['wins']:>4}/{r['losses']:<4}  "
            f"${r['max_dd']:>7,.0f}"
            f"{mark}"
        )
    print("-" * 88)
    print(f"* Highest net PnL at stop-after-{best['max_losses']}-losses (${best['net_pnl']:+,.0f})")
    print()
    print("CycleRisk = max loss if one full stop cycle loses (10+20+... before reset)")
    print("Stop@N = after Nth consecutive loss, skip next signal and reset to $10")


def analyze_losing_streaks(sample: list[dict]) -> dict:
    """Extract maximal consecutive LOSS runs (WIN resets; FLAT breaks streak)."""
    streaks: list[dict] = []
    current_len = 0
    start_idx = 0

    for i, t in enumerate(sample):
        r = t["result"]
        if r == "LOSS":
            if current_len == 0:
                start_idx = i
            current_len += 1
        else:
            if current_len >= 2:
                streaks.append(
                    {
                        "length": current_len,
                        "startIdx": start_idx,
                        "endIdx": i - 1,
                        "from": sample[start_idx]["signalAt"],
                        "to": sample[i - 1]["signalAt"],
                    }
                )
            current_len = 0

    if current_len >= 2:
        streaks.append(
            {
                "length": current_len,
                "startIdx": start_idx,
                "endIdx": len(sample) - 1,
                "from": sample[start_idx]["signalAt"],
                "to": sample[-1]["signalAt"],
            }
        )

    length_hist = Counter(s["length"] for s in streaks)
    max_streak = max((s["length"] for s in streaks), default=0)

    # Per-trade: current consecutive loss count at each LOSS (for martingale view)
    at_each_loss: Counter[int] = Counter()
    run = 0
    for t in sample:
        if t["result"] == "LOSS":
            run += 1
            at_each_loss[run] += 1
        elif t["result"] == "WIN":
            run = 0

    return {
        "streaks": streaks,
        "streak_count_2plus": len(streaks),
        "length_histogram": dict(sorted(length_hist.items())),
        "max_streak": max_streak,
        "at_each_loss": dict(sorted(at_each_loss.items())),
    }


def main():
    # ~51% signal rate → need ~1000 bars per 500 trades; fetch 2500 for margin
    candles = fetch_klines_pages(FETCH_BARS)
    if len(candles) < 4:
        raise SystemExit("Not enough candle data")

    closed = candles[:-1]
    trades: list[dict] = []

    for i in range(2, len(closed)):
        prev, curr, nxt = closed[i - 2], closed[i - 1], closed[i]
        signal, signal_id = evaluate_signal(prev, curr)
        if signal is None:
            continue
        trades.append(
            {
                "signalAt": ts_fmt(curr["t"]),
                "predictWindow": ts_fmt(nxt["t"]),
                "signalId": signal_id,
                "signal": signal,
                "result": outcome(signal, nxt),
            }
        )

    if len(trades) < TARGET_TRADES:
        print(f"WARNING: only {len(trades)} signals; using all available.")
        sample = trades
    else:
        sample = trades[-TARGET_TRADES:]

    wins = sum(1 for t in sample if t["result"] == "WIN")
    losses = sum(1 for t in sample if t["result"] == "LOSS")
    flats = sum(1 for t in sample if t["result"] == "FLAT")
    decided = wins + losses
    win_rate = (wins / decided * 100) if decided else 0.0

    streak = analyze_losing_streaks(sample)

    print("=" * 64)
    print(f"Reversal Continuation Backtest — BTC/USDT {INTERVAL} (Binance)")
    print("=" * 64)
    print(f"Bars fetched (closed):       {len(closed)}")
    print(f"Total signals (full history): {len(trades)}")
    print(f"Sample size:                 {len(sample)}")
    print(f"Wins / Losses / Flat:        {wins} / {losses} / {flats}")
    print(f"Win rate:                    {win_rate:.2f}%  ({wins}/{decided})")
    print(f"Period:                      {sample[0]['signalAt']}")
    print(f"                          ->  {sample[-1]['signalAt']}")
    print()

    print("=" * 64)
    print("Consecutive LOSS streaks (length >= 2)")
    print("=" * 64)
    print(f"Occurrences (2+ losses in a row):  {streak['streak_count_2plus']}")
    print(f"Longest losing streak:             {streak['max_streak']}")
    print()

    print("By streak length — how many times each length occurred:")
    print("-" * 64)
    print(f"  {'Length':>8}  {'Count':>8}  {'Note'}")
    print("-" * 64)
    for length, count in streak["length_histogram"].items():
        note = ""
        if length >= 4:
            note = "<- Martingale stop (MAX_LOSSES=4) would trigger"
        print(f"  {length:>8}  {count:>8}  {note}")
    if not streak["length_histogram"]:
        print("  (none)")
    print()

    print("At each LOSS — distribution of 'which loss in current run':")
    print("(1st loss after win, 2nd consecutive, 3rd, ...)")
    print("-" * 64)
    for n, count in streak["at_each_loss"].items():
        bar = "#" * min(count, 40)
        print(f"  Loss #{n:<2}  {count:>4}x  {bar}")
    print()

    print("Detail: every consecutive-loss episode (length >= 2):")
    print("-" * 64)
    for j, s in enumerate(streak["streaks"], 1):
        print(
            f"  #{j:>3}  len={s['length']}  "
            f"{s['from']}  ->  {s['to']}"
        )
    print()

    stops = sum(1 for s in streak["streaks"] if s["length"] >= 4)
    print(f"Episodes with 4+ consecutive losses (direction only): {stops}")
    print()

    mg = simulate_martingale(sample, max_losses=MARTINGALE_MAX_LOSSES)
    print("=" * 64)
    print(
        f"Martingale PnL — $10 base, x2, stop after {MARTINGALE_MAX_LOSSES} losses (PRD v2.2)"
    )
    print("=" * 64)
    print("Assumption: win +bet / loss -bet (even-money ~50c entry, no fees)")
    print("After 4th loss: skip the NEXT signal, then resume at $10")
    print("-" * 64)
    print(f"  Trades executed:           {mg['trades_taken']}")
    print(f"  Signals skipped (halt):  {mg['trades_skipped_halt']}")
    print(f"  Stop-loss triggers:      {mg['stop_triggers']}")
    print(f"  Record (W/L):            {mg['wins']} / {mg['losses']}")
    print(f"  Total wagered:           ${mg['total_wagered']:,.2f}")
    print(f"  Net PnL:                 ${mg['total_pnl']:+,.2f}")
    print(f"  ROI (on wagered):        {mg['total_pnl']/mg['total_wagered']*100:+.2f}%")
    print(f"  Peak running profit:     ${mg['peak_equity']:+,.2f}")
    print(f"  Max drawdown from peak:  ${mg['max_drawdown']:,.2f}")
    print()

    # Flat bet comparison
    flat_pnl = sum(
        (10 if t["result"] == "WIN" else -10 if t["result"] == "LOSS" else 0)
        for t in sample
    )
    print("Comparison — flat $10 every signal (no martingale):")
    print(f"  Net PnL: ${flat_pnl:+,.2f}  ({wins - losses} net wins at $10)")
    print()

    worst = sorted(
        [r for r in mg["ledger"] if r["action"] == "LOSS"],
        key=lambda r: r["pnl"],
    )[:5]
    print("Worst 5 single trades (martingale bet size):")
    for r in worst:
        print(
            f"  ${r['pnl']:+.0f}  bet=${r['bet']:.0f}  "
            f"loss#{r['runLoss']}  {r['signalAt']}  {r['signalId']}"
        )


if __name__ == "__main__":
    main()
