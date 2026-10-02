import assert from "node:assert/strict";
import test from "node:test";
import { rememberCredentialSecret, rememberRequestCredentials } from "../src/credential-material.js";
import { diagnosticError, diagnosticText } from "../src/diagnostic-safety.js";

test("diagnostic errors redact known opaque values and stacks without losing codes", () => {
  const secret = "fixture-opaque-diagnostic-value";
  rememberCredentialSecret(secret);
  const source = Object.assign(new Error(`Provider rejected ${secret}`), {
    code: "PROVIDER_REJECTED",
    details: { retryable: false, nested: { accessToken: secret } },
  });
  source.stack = `Error: ${secret}\n    at provider (${secret})`;

  const safe = diagnosticError(source);
  assert.equal(safe.code, "PROVIDER_REJECTED");
  assert.equal(safe.message.includes(secret), false);
  assert.equal(JSON.stringify(safe.details).includes(secret), false);
  assert.equal((safe.details as {retryable:boolean}).retryable, false);
  assert.equal(diagnosticText(source, true).includes(secret), false);
  const binary = diagnosticError({ code: "BINARY_FAILURE", message: "Failed", details: { body: Buffer.from(secret) } });
  assert.equal((binary.details as {body:string}).body, "[Binary omitted]");
  const keyed = diagnosticError({ code: "KEYED_FAILURE", message: "Failed", details: { [secret]: "retry later" } });
  assert.equal(JSON.stringify(keyed.details).includes(secret), false);
  const nested = diagnosticError({ code: "NESTED_FAILURE", message: "Failed", details: {
    token: ["opaque123"], authorization: { value: "opaque123" },
    headers: { "X-API-Key": "opaque123", "Proxy-Authorization": "Basic abc12345", Cookie: "sid=abc12345" },
  } });
  assert.equal(JSON.stringify(nested.details).includes("opaque123"), false);
  assert.equal(JSON.stringify(nested.details).includes("abc12345"), false);
  assert.equal(diagnosticText("Authorization: Basic dXNlcjpwYXNz").includes("dXNlcjpwYXNz"), false);
  assert.equal(diagnosticText("Cookie: sid=abc12345").includes("abc12345"), false);
  const url = diagnosticText("GET https://api.example.invalid/v1?token=opaque123&refresh_token=opaque456");
  assert.equal(url.includes("opaque123"), false);
  assert.equal(url.includes("opaque456"), false);
  assert.equal(url.includes("api.example.invalid/v1?token="), true);
  rememberRequestCredentials(new URL("https://api.example.invalid/v1?token=fixture-provider-opaque"));
  assert.equal(diagnosticText("Provider echoed fixture-provider-opaque").includes("fixture-provider-opaque"), false);
});
