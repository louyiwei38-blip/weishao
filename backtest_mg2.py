#!/usr/bin/env python3
"""Martingale with MAX_LOSSES=2 on last 500 trades."""

from backtest_reversal import (
    fetch_klines_pages,
    evaluate_signal,
    outcome,
    ts_fmt,
    simulate_martingale,
)

TARGET = 500


def build_sample():
    candles = fetch_klines_pages(2500)
    closed = candles[:-1]
    trades = []
    for i in range(2, len(closed)):
        prev, curr, nxt = closed[i - 2], closed[i - 1], closed[i]
        sig, sid = evaluate_signal(prev, curr)
        if sig is None:
            continue
        trades.append(
            {
                "signalAt": ts_fmt(curr["t"]),
                "signalId": sid,
                "signal": sig,
                "result": outcome(sig, nxt),
            }
        )
    return trades[-TARGET:]


def main():
    sample = build_sample()
    mg2 = simulate_martingale(sample, max_losses=2)
    mg4 = simulate_martingale(sample, max_losses=4)
    flat = sum(
        10 if t["result"] == "WIN" else -10 if t["result"] == "LOSS" else 0
        for t in sample
    )
    wins = sum(1 for t in sample if t["result"] == "WIN")
    losses = sum(1 for t in sample if t["result"] == "LOSS")

    print("=" * 64)
    print("Martingale: $10 base, x2, STOP after 2 consecutive losses")
    print("=" * 64)
    print("Assumption: win +bet / loss -bet; skip next signal after 2nd loss")
    print(f"Period: {sample[0]['signalAt']} -> {sample[-1]['signalAt']}")
    print("-" * 64)
    print(f"  Sample:              {len(sample)} signals ({wins}W/{losses}L, {wins/len(sample)*100:.1f}% WR)")
    print(f"  Trades executed:     {mg2['trades_taken']}")
    print(f"  Skipped (halt):      {mg2['trades_skipped_halt']}")
    print(f"  Stop triggers:       {mg2['stop_triggers']}")
    print(f"  W/L (executed):      {mg2['wins']} / {mg2['losses']}")
    print(f"  Total wagered:       ${mg2['total_wagered']:,.2f}")
    print(f"  Net PnL:             ${mg2['total_pnl']:+,.2f}")
    print(f"  ROI on wagered:      {mg2['total_pnl']/mg2['total_wagered']*100:+.2f}%")
    print(f"  Peak profit:         ${mg2['peak_equity']:+,.2f}")
    print(f"  Max drawdown:        ${mg2['max_drawdown']:,.2f}")
    print(f"  Max single loss:     $20 (2nd bet in cycle)")
    print(f"  Loss per stop cycle: $30 ($10 + $20)")
    print()
    print("Comparison:")
    print(f"  Flat $10 every trade:     ${flat:+,.2f}")
    print(
        f"  4-loss stop (prev run):  ${mg4['total_pnl']:+,.2f}  "
        f"({mg4['trades_taken']} trades, {mg4['stop_triggers']} stops)"
    )


if __name__ == "__main__":
    main()
