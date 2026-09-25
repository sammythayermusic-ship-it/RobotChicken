import { describe, expect, it } from "vitest";
import { formatRaw, formatUsd, rawUsd } from "./data";

describe("money formatting", () => {
  it("prints raw units as whole tokens with up to two decimals", () => {
    expect(formatRaw("1450000000", 6)).toBe("1,450 PUMP");
    expect(formatRaw("1450500000", 6)).toBe("1,450.5 PUMP");
    expect(formatRaw("123", 6)).toBe("0 PUMP");
    expect(formatRaw("123456", 6)).toBe("0.12 PUMP");
    expect(formatRaw("0", 6)).toBe("0 PUMP");
    expect(formatRaw("5", 0, "X")).toBe("5 X");
    expect(formatRaw("99999999999999999999", 6)).toBe("99,999,999,999,999.99 PUMP");
  });
  it("values raw units at a price and prints dollars", () => {
    expect(rawUsd("1450000000", 6, 0.005)).toBeCloseTo(7.25, 6);
    expect(formatUsd(7.25)).toBe("$7.25");
    expect(formatUsd(0.749)).toBe("$0.75");
    expect(formatUsd(12345.6)).toBe("$12,346");
    expect(formatUsd(NaN)).toBe("$0.00");
  });
});
