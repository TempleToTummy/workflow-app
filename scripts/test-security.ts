// Two-factor authentication, secret encryption and session device labels.
// No framework, no database:
//
//   ./node_modules/.bin/tsx scripts/test-security.ts
import {
  base32Encode,
  base32Decode,
  hotp,
  totpCode,
  verifyTotp,
  timeStep,
  normalizeTotpInput,
  otpauthUri,
  generateTotpSecret,
  formatSecretForDisplay,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  hashRecoveryCode,
  consumeRecoveryCode,
  recoveryCodesRemaining,
} from "../src/lib/totp";
import { seal, unseal, sealingKey, isEncryptionConfigured } from "../src/lib/secret-box";
import { describeUserAgent, displayIp } from "../src/lib/user-agent";
import { check, checkThrows, section, finish } from "./harness";

section("base32");
check("RFC 4648 vector: 'foobar'", base32Encode(Buffer.from("foobar")), "MZXW6YTBOI");
check("round trip", base32Decode(base32Encode(Buffer.from("hello world"))).toString(), "hello world");
check("decoding ignores case, spaces and padding", base32Decode("mzxw 6ytb oi==").toString(), "foobar");
checkThrows("non-base32 characters are refused", () => base32Decode("MZXW1"), "That secret contains characters that aren't base32.");

// RFC 6238 Appendix B, SHA-1, secret = ASCII "12345678901234567890". The RFC
// prints 8-digit codes; a 6-digit code is the last six digits.
section("TOTP — RFC 6238 test vectors");
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
check("the secret in base32", RFC_SECRET, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
const vectors: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];
for (const [seconds, eight] of vectors) {
  check(`T=${seconds} (8 digits)`, hotp(Buffer.from("12345678901234567890"), timeStep(seconds * 1000), 8), eight);
  check(`T=${seconds} (6 digits)`, totpCode(RFC_SECRET, seconds * 1000), eight.slice(2));
}

section("verifyTotp");
{
  const now = 1_700_000_000_000;
  const code = totpCode(RFC_SECRET, now);
  const step = timeStep(now);
  check("the current code passes", verifyTotp(RFC_SECRET, code, { now }), { ok: true, step });
  check("spaces and dashes are fine", verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, { now }).ok, true);
  check("the previous step still passes (clock drift)", verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 30_000), { now }).ok, true);
  check("the next step passes", verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now + 30_000), { now }).ok, true);
  check("two steps back fails", verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 60_000), { now }).ok, false);
  check("a used code can't be replayed", verifyTotp(RFC_SECRET, code, { now, lastUsedStep: step }).ok, false);
  check(
    "…but the next code works after it",
    verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now + 30_000), { now, lastUsedStep: step }).ok,
    true
  );
  check("a wrong code fails", verifyTotp(RFC_SECRET, code === "000000" ? "111111" : "000000", { now }).ok, false);
  check("letters fail", verifyTotp(RFC_SECRET, "12a456", { now }).ok, false);
  check("five digits fail", verifyTotp(RFC_SECRET, code.slice(1), { now }).ok, false);
  check("normalizeTotpInput", [normalizeTotpInput(" 123-456 "), normalizeTotpInput("1234567")], ["123456", null]);
}

section("secrets and the QR code URI");
{
  const s = generateTotpSecret();
  check("a new secret is 160 bits (32 base32 chars)", s.length, 32);
  check("…and decodes to 20 bytes", base32Decode(s).length, 20);
  check("two secrets differ", generateTotpSecret() === generateTotpSecret(), false);
  check("display groups in fours", formatSecretForDisplay("ABCDEFGHIJ"), "ABCD EFGH IJ");
  const uri = otpauthUri({ secret: "ABC", account: "dana@firm.test", issuer: "Smith & Co" });
  check("otpauth URI", uri, "otpauth://totp/Smith%20%26%20Co%3Adana%40firm.test?secret=ABC&issuer=Smith+%26+Co&algorithm=SHA1&digits=6&period=30");
}

section("recovery codes");
{
  const codes = generateRecoveryCodes();
  check("ten codes", codes.length, 10);
  check("all distinct", new Set(codes).size, 10);
  check("XXXXX-XXXXX shape", codes.every((c) => /^[23456789A-HJKMNP-Z]{5}-[23456789A-HJKMNP-Z]{5}$/.test(c)), true);
  check("no look-alike characters", codes.some((c) => /[01ILO]/.test(c)), false);
  check("typing is forgiving", normalizeRecoveryCode(" abcde-fghjk "), "ABCDEFGHJK");
  check("wrong length refused", normalizeRecoveryCode("ABCD-EFGH"), null);
  check("look-alike characters refused", normalizeRecoveryCode("ABCDE-FGHI0"), null);
  check("hash ignores formatting", hashRecoveryCode("abcde fghjk"), hashRecoveryCode("ABCDE-FGHJK"));

  const stored = JSON.stringify(codes.map(hashRecoveryCode));
  const remaining = consumeRecoveryCode(stored, codes[3].toLowerCase());
  check("a valid code is consumed", remaining?.length, 9);
  check("…and can't be used twice", consumeRecoveryCode(JSON.stringify(remaining), codes[3]), null);
  check("an unknown code fails", consumeRecoveryCode(stored, "22222-22222"), null);
  check("no stored codes fails", consumeRecoveryCode(null, codes[0]), null);
  check("corrupt storage fails safe", consumeRecoveryCode("{not json", codes[0]), null);
  check("remaining count", recoveryCodesRemaining(JSON.stringify(remaining)), 9);
  check("remaining count on null", recoveryCodesRemaining(null), 0);
}

section("secret box");
{
  const key = sealingKey({ AUTH_SECRET: "test-secret" } as unknown as NodeJS.ProcessEnv);
  const sealed = seal("JBSWY3DPEHPK3PXP", key);
  check("sealed value is versioned, not plaintext", sealed.startsWith("v1:") && !sealed.includes("JBSWY3DP"), true);
  check("round trip", unseal(sealed, key), "JBSWY3DPEHPK3PXP");
  check("each seal is different (random IV)", seal("same", key) === seal("same", key), false);
  const other = sealingKey({ AUTH_SECRET: "a different secret" } as unknown as NodeJS.ProcessEnv);
  checkThrows("the wrong key is refused", () => unseal(sealed, other), "Couldn't decrypt a stored secret — has AUTH_SECRET changed?");
  checkThrows("no key for an encrypted value", () => unseal(sealed, null), "This value is encrypted, but AUTH_SECRET isn't set on the server.");
  const tampered = sealed.slice(0, -2) + (sealed.endsWith("A") ? "BB" : "AA");
  checkThrows("tampering is detected", () => unseal(tampered, key));
  check("without a key, values are marked plain", seal("abc", null), "plain:abc");
  check("plain values read with or without a key", [unseal("plain:abc", null), unseal("plain:abc", key)], ["abc", "abc"]);
  check("blank AUTH_SECRET counts as unset", isEncryptionConfigured({ AUTH_SECRET: "  " } as unknown as NodeJS.ProcessEnv), false);
}

section("device labels");
check(
  "Chrome on macOS",
  describeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"),
  "Chrome on macOS"
);
check(
  "Safari on iPhone",
  describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"),
  "Safari on iPhone"
);
check(
  "Edge on Windows",
  describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0"),
  "Edge on Windows"
);
check(
  "Firefox on Linux",
  describeUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"),
  "Firefox on Linux"
);
check(
  "Chrome on Android",
  describeUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"),
  "Chrome on Android"
);
check("missing header", describeUserAgent(null), "Unknown device");
check("unrecognisable header", describeUserAgent("SomeBot/1.0"), "Unknown device");
check("IPv6-mapped IPv4 is shortened", displayIp("::ffff:10.0.0.5"), "10.0.0.5");
check("no address", displayIp(null), "—");

finish();
