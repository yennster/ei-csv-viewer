import { describe, it, expect, afterEach } from "vitest";
import {
  parseParams,
  parseBool,
  parseIntStrict,
  parseEnum,
  clamp,
  getIframeQueryParams,
} from "@/lib/url-params";

describe("primitive coercion", () => {
  it("parses booleans across accepted tokens", () => {
    for (const t of ["1", "true", "TRUE", "yes", "on"]) {
      expect(parseBool(t)).toBe(true);
    }
    for (const f of ["0", "false", "No", "off"]) {
      expect(parseBool(f)).toBe(false);
    }
    expect(parseBool("maybe")).toBeUndefined();
    expect(parseBool(null)).toBeUndefined();
  });

  it("parses strict integers only", () => {
    expect(parseIntStrict("42")).toBe(42);
    expect(parseIntStrict("-3")).toBe(-3);
    expect(parseIntStrict("3.5")).toBeUndefined();
    expect(parseIntStrict("abc")).toBeUndefined();
    expect(parseIntStrict(null)).toBeUndefined();
  });

  it("parses enums case-insensitively", () => {
    expect(parseEnum("Training", ["training", "testing"])).toBe("training");
    expect(parseEnum("nope", ["training", "testing"])).toBeUndefined();
  });

  it("clamps", () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(-1, 1, 10)).toBe(1);
    expect(clamp(99, 1, 10)).toBe(10);
  });
});

describe("parseParams", () => {
  it("returns sensible defaults for an empty query", () => {
    const p = parseParams("");
    expect(p.limit).toBe(200);
    expect(p.offset).toBe(0);
    expect(p.embed).toBe(false);
    expect(p.mode).toBe("editor");
    expect(p.apiKey).toBeUndefined();
  });

  it("parses mode (viewer|editor), case-insensitively, default editor", () => {
    expect(parseParams("mode=viewer").mode).toBe("viewer");
    expect(parseParams("mode=VIEWER").mode).toBe("viewer");
    expect(parseParams("mode=Editor").mode).toBe("editor");
    // invalid values are dropped -> default editor
    expect(parseParams("mode=readonly").mode).toBe("editor");
    expect(parseParams("mode=").mode).toBe("editor");
    expect(parseParams("").mode).toBe("editor");
  });

  it("accepts only ei_ prefixed api keys and clamps limit/offset", () => {
    const ok = parseParams("apiKey=ei_abc123&limit=5000&offset=-4");
    expect(ok.apiKey).toBe("ei_abc123");
    expect(ok.limit).toBe(1000);
    expect(ok.offset).toBe(0);

    const bad = parseParams("apiKey=not_a_key");
    expect(bad.apiKey).toBeUndefined();
  });

  it("reads project via alias and validates >= 1", () => {
    expect(parseParams("eiProject=7").project).toBe(7);
    expect(parseParams("project=0").project).toBeUndefined();
  });

  it("reads sample via alias", () => {
    expect(parseParams("sampleId=12").sample).toBe(12);
    expect(parseParams("sample=3").sample).toBe(3);
  });

  it("parses labels, category, theme and embed", () => {
    const p = parseParams(
      "labels=walk, run ,,jump&category=TESTING&theme=Dark&embed=1",
    );
    expect(p.labels).toEqual(["walk", "run", "jump"]);
    expect(p.category).toBe("testing");
    expect(p.theme).toBe("dark");
    expect(p.embed).toBe(true);
  });

  it("never throws on garbage input", () => {
    expect(() => parseParams("limit=&offset=&theme=&category=")).not.toThrow();
    const p = parseParams("limit=&category=banana");
    expect(p.limit).toBe(200);
    expect(p.category).toBeUndefined();
  });
});

describe("getIframeQueryParams (secret-param isolation)", () => {
  const realParent = Object.getOwnPropertyDescriptor(window, "parent");

  afterEach(() => {
    // Restore window.parent / location.search between cases.
    if (realParent) Object.defineProperty(window, "parent", realParent);
    window.history.replaceState(null, "", "/");
  });

  function setParent(search: string) {
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: { location: { search } } as unknown as Window,
    });
  }

  it("does NOT inherit apiKey from a parent frame, but inherits other params", () => {
    setParent("?apiKey=ei_secretkey&project=99&category=testing");
    window.history.replaceState(null, "", "/?embed=1");
    const merged = getIframeQueryParams();
    // apiKey from the parent is dropped...
    expect(merged.get("apiKey")).toBeNull();
    // ...but non-secret params are inherited, and own-window params win.
    expect(merged.get("project")).toBe("99");
    expect(merged.get("category")).toBe("testing");
    expect(merged.get("embed")).toBe("1");
  });

  it("still accepts apiKey supplied to the app's OWN url", () => {
    setParent("?project=7");
    window.history.replaceState(null, "", "/?apiKey=ei_ownkey");
    const merged = getIframeQueryParams();
    expect(merged.get("apiKey")).toBe("ei_ownkey");
    expect(parseParams(merged).apiKey).toBe("ei_ownkey");
  });
});
