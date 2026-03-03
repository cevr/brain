import { describe, it, expect } from "bun:test";
import { resolveJob } from "../../../src/commands/daemon/schedule.js";

describe("resolveJob", () => {
  describe("Sunday (0)", () => {
    it("9am -> meditate", () => expect(resolveJob({ day: 0, hour: 9 })).toBe("meditate"));
    it("1pm -> reflect", () => expect(resolveJob({ day: 0, hour: 13 })).toBe("reflect"));
    it("5pm -> reflect", () => expect(resolveJob({ day: 0, hour: 17 })).toBe("reflect"));
    it("9pm -> reflect", () => expect(resolveJob({ day: 0, hour: 21 })).toBe("reflect"));
  });

  describe("Mon-Thu (1-4)", () => {
    for (const day of [1, 2, 3, 4] as const) {
      it(`day ${day} 9am -> ruminate`, () => expect(resolveJob({ day, hour: 9 })).toBe("ruminate"));
      it(`day ${day} 1pm -> reflect`, () => expect(resolveJob({ day, hour: 13 })).toBe("reflect"));
      it(`day ${day} 5pm -> reflect`, () => expect(resolveJob({ day, hour: 17 })).toBe("reflect"));
      it(`day ${day} 9pm -> reflect`, () => expect(resolveJob({ day, hour: 21 })).toBe("reflect"));
    }
  });

  describe("Fri/Sat (5-6) skip all", () => {
    for (const day of [5, 6] as const) {
      for (const hour of [9, 13, 17, 21]) {
        it(`day ${day} hour ${hour} -> null`, () => expect(resolveJob({ day, hour })).toBeNull());
      }
    }
  });

  describe("unexpected hours -> null", () => {
    it("3am -> null", () => expect(resolveJob({ day: 1, hour: 3 })).toBeNull());
    it("midnight -> null", () => expect(resolveJob({ day: 0, hour: 0 })).toBeNull());
    it("10am -> null", () => expect(resolveJob({ day: 2, hour: 10 })).toBeNull());
  });
});
