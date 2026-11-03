import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCredentials } from "../src/credentials.ts";

const groq = "gsk_SYNTHETIC_TEST_ONLY";
const deepgram = "synthetic-deepgram-test-only";

test("labelled Desktop file imports both providers without mixing credentials", () => {
  assert.deepEqual(parseCredentials(`Groq: ${groq}\r\nDeepgram: ${deepgram}\r\n`), { groq, deepgram });
  assert.deepEqual(parseCredentials(`# private\nexport GROQ_API_KEY='${groq}'\nDEEPGRAM_API_KEY=\"${deepgram}\"`), { groq, deepgram });
  assert.deepEqual(parseCredentials(groq, true), { groq });
});

test("ambiguous or malformed key files fail without echoing secret contents", () => {
  for (const input of ["", `Groq: ${groq}\nGroq: ${groq}`, `Deepgram: ${deepgram}\nunknown: ${groq}`, `Groq: ${groq}\nDeepgram: contains spaces`]) {
    assert.throws(() => parseCredentials(input), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(groq), false);
      assert.equal(error.message.includes(deepgram), false);
      return true;
    });
  }
});
