import { pickLsofBin } from "../src/platform";

describe("pickLsofBin", () => {
  it("prefers /usr/sbin/lsof, which launchd's PATH does not reach", () => {
    expect(pickLsofBin((p) => p === "/usr/sbin/lsof")).toBe("/usr/sbin/lsof");
  });

  it("falls back to a PATH lookup where lsof lives elsewhere", () => {
    expect(pickLsofBin(() => false)).toBe("lsof");
  });
});
