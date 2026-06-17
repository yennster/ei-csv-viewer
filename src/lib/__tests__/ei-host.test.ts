import { describe, it, expect } from "vitest";
import {
  normalizeAllowedHost,
  isPrivateHostname,
  isAllowedHostname,
} from "@/lib/ei-host";

describe("normalizeAllowedHost (SSRF / key-exfiltration guard)", () => {
  it("accepts the Edge Impulse cloud hosts and preserves the API base path", () => {
    expect(normalizeAllowedHost("https://studio.edgeimpulse.com/v1/api")).toBe(
      "https://studio.edgeimpulse.com/v1/api",
    );
    expect(normalizeAllowedHost("https://ingestion.edgeimpulse.com/api")).toBe(
      "https://ingestion.edgeimpulse.com/api",
    );
    expect(normalizeAllowedHost("https://edgeimpulse.com")).toBe(
      "https://edgeimpulse.com",
    );
  });

  it("strips a trailing slash and drops query/hash but keeps the path", () => {
    expect(
      normalizeAllowedHost("https://studio.edgeimpulse.com/v1/api/?x=1#h"),
    ).toBe("https://studio.edgeimpulse.com/v1/api");
  });

  it("keeps an explicit port", () => {
    expect(normalizeAllowedHost("https://studio.edgeimpulse.com:8443/v1/api")).toBe(
      "https://studio.edgeimpulse.com:8443/v1/api",
    );
  });

  it("REJECTS a non-allowlisted host (the key-theft vector)", () => {
    expect(normalizeAllowedHost("https://attacker.example")).toBeUndefined();
    expect(
      normalizeAllowedHost("https://evil.com/?ei=studio.edgeimpulse.com"),
    ).toBeUndefined();
    // suffix-spoofing: not a real subdomain of edgeimpulse.com
    expect(
      normalizeAllowedHost("https://edgeimpulse.com.attacker.example"),
    ).toBeUndefined();
  });

  it("REJECTS non-https schemes", () => {
    expect(normalizeAllowedHost("http://studio.edgeimpulse.com")).toBeUndefined();
    expect(
      normalizeAllowedHost("ftp://studio.edgeimpulse.com"),
    ).toBeUndefined();
  });

  it("REJECTS SSRF targets even if allowlisting were bypassed", () => {
    expect(normalizeAllowedHost("https://localhost/v1/api")).toBeUndefined();
    expect(
      normalizeAllowedHost("https://127.0.0.1:8080/v1/api"),
    ).toBeUndefined();
    expect(
      normalizeAllowedHost("https://169.254.169.254/latest/meta-data/"),
    ).toBeUndefined();
    expect(normalizeAllowedHost("https://10.0.0.5")).toBeUndefined();
    expect(normalizeAllowedHost("https://192.168.1.1")).toBeUndefined();
    expect(normalizeAllowedHost("https://172.16.0.1")).toBeUndefined();
  });

  it("returns undefined for empty / unparseable input", () => {
    expect(normalizeAllowedHost("")).toBeUndefined();
    expect(normalizeAllowedHost(null)).toBeUndefined();
    expect(normalizeAllowedHost(undefined)).toBeUndefined();
    expect(normalizeAllowedHost("not a url")).toBeUndefined();
  });

  it("honors extra allowed hosts (self-hosted EI) including subdomains", () => {
    expect(
      normalizeAllowedHost("https://studio.acme.internal/v1/api", [
        "acme.internal",
      ]),
    ).toBe("https://studio.acme.internal/v1/api");
    // private ranges are still rejected even when their hostname is allowlisted
    expect(
      normalizeAllowedHost("https://10.1.2.3", ["10.1.2.3"]),
    ).toBeUndefined();
  });
});

describe("isPrivateHostname", () => {
  it("flags loopback / private / link-local literals", () => {
    expect(isPrivateHostname("localhost")).toBe(true);
    expect(isPrivateHostname("127.0.0.1")).toBe(true);
    expect(isPrivateHostname("0.0.0.0")).toBe(true);
    expect(isPrivateHostname("169.254.169.254")).toBe(true);
    expect(isPrivateHostname("10.0.0.1")).toBe(true);
    expect(isPrivateHostname("192.168.0.1")).toBe(true);
    expect(isPrivateHostname("172.16.0.1")).toBe(true);
    expect(isPrivateHostname("172.31.255.255")).toBe(true);
  });

  it("does not flag public hosts", () => {
    expect(isPrivateHostname("studio.edgeimpulse.com")).toBe(false);
    expect(isPrivateHostname("8.8.8.8")).toBe(false);
    expect(isPrivateHostname("172.32.0.1")).toBe(false); // just outside private
  });
});

describe("isAllowedHostname", () => {
  it("matches the base host and its subdomains, not look-alikes", () => {
    expect(isAllowedHostname("edgeimpulse.com")).toBe(true);
    expect(isAllowedHostname("studio.edgeimpulse.com")).toBe(true);
    expect(isAllowedHostname("a.b.edgeimpulse.com")).toBe(true);
    expect(isAllowedHostname("edgeimpulse.com.evil.com")).toBe(false);
    expect(isAllowedHostname("notedgeimpulse.com")).toBe(false);
  });
});
