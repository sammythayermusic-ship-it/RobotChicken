import { describe, expect, it } from "vitest";
import { idiv, mulDiv, setFixedChecks } from "../src/index";

describe("fixed", () => {
  it("truncates toward zero, mirror-symmetric", () => {
    for (const [a, b] of [[7, 2], [-7, 2], [7, -2], [1, 3], [-1, 3], [999999, 1000]]) {
      expect(idiv(a!, b!)).toBe(Math.trunc(a! / b!) || 0);
      expect(idiv(-a!, b!)).toBe(-idiv(a!, b!) || 0);
    }
  });
  it("never produces -0", () => {
    expect(Object.is(idiv(-1, 2), -0)).toBe(false);
    expect(Object.is(idiv(0, -5), -0)).toBe(false);
  });
  it("mulDiv computes chip exactly", () => {
    expect(mulDiv(600, 10, 100)).toBe(60);
    expect(mulDiv(3000, 10, 100)).toBe(300);
  });
  it("asserts on division by zero when checks are on", () => {
    setFixedChecks(true);
    expect(() => idiv(1, 0)).toThrow();
    setFixedChecks(false);
    expect(idiv(1, 0)).toBe(0);
  });
});
