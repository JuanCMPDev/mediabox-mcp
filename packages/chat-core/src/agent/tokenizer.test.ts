import { describe, it, expect } from 'vitest';
import { TokenCounter } from './tokenizer.js';

describe('TokenCounter Calibration (§2.4 / AGT-12)', () => {
  it('estimates tokens with default factor of 3.5', () => {
    const counter = new TokenCounter(3.5);
    expect(counter.estimate('1234567')).toBe(2);
  });

  it('adjusts factor after two consecutive turns with deviation > 10%', () => {
    const counter = new TokenCounter(3.5);

    // Text: 700 chars. At 3.5 chars/token = 200 estimated tokens.
    // Turn 1: real = 250 tokens (|200 - 250| / 250 = 0.20 > 0.10)
    counter.calibrate(200, 250, 700);
    expect(counter.currentFactor).toBe(3.5); // only 1 turn, factor not adjusted yet

    // Turn 2: real = 260 tokens (consecutive deviation)
    counter.calibrate(200, 260, 700);
    expect(counter.currentFactor).not.toBe(3.5);
    expect(counter.currentFactor).toBeCloseTo(700 / 260, 2);
    expect(counter.logs.length).toBeGreaterThan(0);
  });

  it('applies 15% extra safety margin when deviation exceeds 25%', () => {
    const counter = new TokenCounter(3.5);

    // Text: 700 chars. At 3.5 = 200 tokens estimated.
    // Real: 300 tokens (|200 - 300| / 300 = 0.33 > 0.25)
    counter.calibrate(200, 300, 700);

    expect(counter.currentExtraMargin).toBe(0.15);
    // Next estimation applies 15% extra
    const rawExpected = Math.ceil(700 / 3.5); // 200
    expect(counter.estimate('A'.repeat(700))).toBe(Math.ceil(rawExpected * 1.15));
  });
});
