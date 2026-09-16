/* Settlement Prover tests — node --test, zero network. */
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../prover.js");

const DEMO = {
  chain: "base",
  hash: "0x0f7bc8d5adce70987d6f4cdee48421aefd69ddb18e2b52d6eaffb993f85b45df",
  expectedAmountWei: "173503114619109366",
  expectedTo: "0x7945dd00e71915eb4d8ae722418dcc8ff62509a3"
};
const DEMO_CHAIN = {
  found: true, status: 1,
  from: "0x04de5383cd4460330fa43c710ceee56340ee4554",
  to: "0x7945dd00e71915eb4d8ae722418dcc8ff62509a3",
  valueWei: "173503114619109366", input: "0x",
  blockNumber: 51387651, confirmations: 35
};

test("parseAmountToWei: decimal ETH string", () => {
  assert.equal(P.parseAmountToWei("0.5"), "500000000000000000");
});
test("parseAmountToWei: full-precision decimal", () => {
  assert.equal(P.parseAmountToWei("0.173503114619109366"), "173503114619109366");
});
test("parseAmountToWei: pure digits treated as wei", () => {
  assert.equal(P.parseAmountToWei("173503114619109366"), "173503114619109366");
});
test("parseAmountToWei: '1 ETH' suffix", () => {
  assert.equal(P.parseAmountToWei("1 ETH"), "1000000000000000000");
});
test("parseAmountToWei: rejects garbage", () => {
  assert.equal(P.parseAmountToWei("abc"), null);
  assert.equal(P.parseAmountToWei("0.1234567890123456789"), null); // 19 dp
  assert.equal(P.parseAmountToWei(""), null);
});
test("parseEthToWei: integer ETH", () => {
  assert.equal(P.parseEthToWei("2"), "2000000000000000000");
});
test("parseEthToWei: decimal ETH", () => {
  assert.equal(P.parseEthToWei("0.173503114619109366"), "173503114619109366");
});
test("parseEthToWei: rejects >18 decimals and garbage", () => {
  assert.equal(P.parseEthToWei("0.1234567890123456789"), null);
  assert.equal(P.parseEthToWei("xyz"), null);
});
test("weiToEth round-trips", () => {
  assert.equal(P.weiToEth("173503114619109366"), "0.173503114619109366");
  assert.equal(P.weiToEth("1000000000000000000"), "1");
});
test("address and hash validators", () => {
  assert.equal(P.isAddress("0x7945dd00e71915eb4d8ae722418dcc8ff62509a3"), true);
  assert.equal(P.isAddress("0x7945DD00E71915EB4D8AE722418DCC8FF62509A3"), true);
  assert.equal(P.isAddress("0x123"), false);
  assert.equal(P.isTxHash(DEMO.hash), true);
  assert.equal(P.isTxHash("0x123"), false);
});
test("parseProofParam: valid base:hash", () => {
  const p = P.parseProofParam("base:" + DEMO.hash);
  assert.equal(p.chain, "base");
  assert.equal(p.hash, DEMO.hash);
});
test("parseProofParam: rejects bad chain / bad hash", () => {
  assert.equal(P.parseProofParam("solana:" + DEMO.hash), null);
  assert.equal(P.parseProofParam("base:0x123"), null);
  assert.equal(P.parseProofParam("nocolon"), null);
});
test("serialize/parse round-trip", () => {
  const s = P.serializeProofParam({ chain: "ethereum", hash: DEMO.hash });
  assert.deepEqual(P.parseProofParam(s), { chain: "ethereum", hash: DEMO.hash });
});
test("evaluateClaim: full-match demo -> SETTLED", () => {
  const proof = P.evaluateClaim(DEMO, DEMO_CHAIN, { observedAt: "2026-09-16T13:30:00Z" });
  assert.equal(proof.verdict, "SETTLED");
  assert.equal(proof.schema, "cwi.settlement-proof/1.0");
  assert.ok(proof.checks.every(c => c.result === "pass"));
  assert.equal(proof.finality.confirmations, 35);
  assert.ok(proof.explorerUrl.includes("basescan.org/tx/" + DEMO.hash));
});
test("evaluateClaim: wrong amount -> MISMATCH with field diff", () => {
  const proof = P.evaluateClaim({ ...DEMO, expectedAmountWei: "1" }, DEMO_CHAIN);
  assert.equal(proof.verdict, "MISMATCH");
  assert.deepEqual(proof.mismatchedFields, ["amount"]);
  const c = proof.checks.find(x => x.id === "amount");
  assert.equal(c.result, "fail");
  assert.ok(c.note.includes("173503114619109366"));
});
test("evaluateClaim: wrong recipient -> MISMATCH (case-insensitive match ok)", () => {
  const ok = P.evaluateClaim({ ...DEMO, expectedTo: "0x7945DD00E71915EB4D8AE722418DCC8FF62509A3" }, DEMO_CHAIN);
  assert.equal(ok.verdict, "SETTLED");
  const bad = P.evaluateClaim({ ...DEMO, expectedTo: "0x0000000000000000000000000000000000000001" }, DEMO_CHAIN);
  assert.equal(bad.verdict, "MISMATCH");
  assert.deepEqual(bad.mismatchedFields, ["recipient"]);
});
test("evaluateClaim: reverted tx -> FAILED", () => {
  const proof = P.evaluateClaim(DEMO, { ...DEMO_CHAIN, status: 0 });
  assert.equal(proof.verdict, "FAILED");
  assert.equal(proof.checks.find(x => x.id === "status").result, "fail");
});
test("evaluateClaim: young tx -> PENDING", () => {
  const proof = P.evaluateClaim(DEMO, { ...DEMO_CHAIN, confirmations: 3 });
  assert.equal(proof.verdict, "PENDING");
  assert.equal(proof.finality.assessment, "low");
});
test("evaluateClaim: absent tx -> NOT_FOUND", () => {
  const proof = P.evaluateClaim(DEMO, { found: false });
  assert.equal(proof.verdict, "NOT_FOUND");
});
test("evaluateClaim: null chainData -> NOT_FOUND", () => {
  const proof = P.evaluateClaim(DEMO, null);
  assert.equal(proof.verdict, "NOT_FOUND");
});
test("evaluateClaim: contract call -> UNSUPPORTED (honest scope limit)", () => {
  const proof = P.evaluateClaim(DEMO, { ...DEMO_CHAIN, input: "0xa9059cbb000000000000000000000000", confirmations: 40 });
  assert.equal(proof.verdict, "UNSUPPORTED");
  assert.equal(proof.checks.find(x => x.id === "native_transfer").result, "unknown");
});
test("evaluateClaim: bad claim shape -> INVALID_CLAIM", () => {
  const p1 = P.evaluateClaim({ chain: "base", hash: "0x123" }, DEMO_CHAIN);
  assert.equal(p1.verdict, "INVALID_CLAIM");
  const p2 = P.evaluateClaim({ chain: "solana", hash: DEMO.hash }, DEMO_CHAIN);
  assert.equal(p2.verdict, "INVALID_CLAIM");
  const p3 = P.evaluateClaim({ ...DEMO, expectedTo: "notanaddress" }, DEMO_CHAIN);
  assert.equal(p3.verdict, "INVALID_CLAIM");
});
test("evaluateClaim: no expectations -> SETTLED with unknown checks", () => {
  const proof = P.evaluateClaim({ chain: "base", hash: DEMO.hash }, DEMO_CHAIN);
  assert.equal(proof.verdict, "SETTLED");
  assert.equal(proof.checks.find(x => x.id === "amount").result, "unknown");
  assert.equal(proof.checks.find(x => x.id === "recipient").result, "unknown");
});
test("finalityAssessment tiers", () => {
  assert.equal(P.finalityAssessment(0).level, "low");
  assert.equal(P.finalityAssessment(11).level, "low");
  assert.equal(P.finalityAssessment(12).level, "medium");
  assert.equal(P.finalityAssessment(63).level, "medium");
  assert.equal(P.finalityAssessment(64).level, "high");
});
test("rpcCall: fails over to second endpoint", async () => {
  let calls = 0;
  const fake = (url) => {
    calls++;
    if (calls === 1) return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('{"error":{"message":"boom"}}') });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"jsonrpc":"2.0","id":1,"result":"0x123"}') });
  };
  const r = await P.rpcCall("base", "eth_blockNumber", [], fake, { timeoutMs: 1000 });
  assert.equal(r, "0x123");
  assert.equal(calls, 2);
});
test("rpcCall: all endpoints down -> RPC_FAILED", async () => {
  const fake = () => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("{}") });
  await assert.rejects(P.rpcCall("base", "eth_blockNumber", [], fake, { timeoutMs: 500 }), (e) => e.code === "RPC_FAILED");
});
test("rpcCall: 429s everywhere -> RATE_LIMITED", async () => {
  const fake = () => Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve("rate limit exceeded") });
  await assert.rejects(P.rpcCall("base", "eth_blockNumber", [], fake, { timeoutMs: 500 }), (e) => e.code === "RATE_LIMITED");
});
test("proveSettlement: rate-limited network -> honest RATE_LIMITED proof", async () => {
  const fake = () => Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve("rate limit") });
  const proof = await P.proveSettlement({ chain: "base", hash: DEMO.hash }, fake, { timeoutMs: 500 });
  assert.equal(proof.verdict, "RATE_LIMITED");
  assert.ok(proof.checks[0].note.includes("Nothing was fabricated"));
});
test("proof object validates against schema shape", () => {
  const schema = require("../schema/proofs.schema.json");
  const proof = P.evaluateClaim(DEMO, DEMO_CHAIN);
  assert.ok(schema.required.every(k => k in proof));
  assert.ok(schema.properties.verdict.enum.includes(proof.verdict));
  assert.ok(Array.isArray(proof.checks));
  assert.ok(proof.checks.every(c => ["pass", "fail", "unknown"].includes(c.result)));
});
