/* CWI Settlement Prover — proof engine (UMD, zero dependencies)
 * Verifies on-chain settlement claims against public RPCs.
 * Pure verdict logic (evaluateClaim) is network-free and fully unit-tested;
 * only proveSettlement touches the network, with endpoint failover.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CWISettlementProver = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SCHEMA_ID = "cwi.settlement-proof/1.0";

  var CHAINS = {
    base: {
      id: "base",
      name: "Base",
      chainId: 8453,
      native: "ETH",
      explorer: "https://basescan.org/tx/",
      finalityNote: "Base posts batches to Ethereum L1; 12+ L2 confirmations is the common exchange heuristic.",
      rpcs: [
        "https://base-rpc.publicnode.com",
        "https://developer-access-mainnet.base.org",
        "https://1rpc.io/base",
        "https://mainnet.base.org"
      ]
    },
    ethereum: {
      id: "ethereum",
      name: "Ethereum",
      chainId: 1,
      native: "ETH",
      explorer: "https://etherscan.io/tx/",
      finalityNote: "Ethereum probabilistic finality; 12+ confirmations is the common heuristic, ~2 epochs for stronger assurance.",
      rpcs: [
        "https://cloudflare-eth.com",
        "https://ethereum.publicnode.com",
        "https://eth.meowrpc.com",
        "https://rpc.ankr.com/eth"
      ]
    }
  };

  var VERDICTS = ["SETTLED", "PENDING", "FAILED", "NOT_FOUND", "MISMATCH", "RATE_LIMITED", "INVALID_CLAIM", "UNSUPPORTED"];

  var ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
  var HASH_RE = /^0x[0-9a-fA-F]{64}$/;

  function isAddress(a) { return typeof a === "string" && ADDRESS_RE.test(a.trim()); }
  function isTxHash(h) { return typeof h === "string" && HASH_RE.test(h.trim()); }

  // Parse "0.1735", "0.1735 ETH", "173503114619109366" (wei) -> wei string. Returns null on invalid.
  function parseAmountToWei(s) {
    if (s === undefined || s === null) return null;
    s = String(s).trim();
    if (s === "") return null;
    var hadEth = /\s*eth\s*$/i.test(s);
    s = s.replace(/\s*eth\s*$/i, "").trim();
    if (hadEth) return parseEthToWei(s); // explicit unit wins: "1 ETH" = 1e18 wei, never 1 wei
    if (/^\d+$/.test(s)) {
      try { return BigInt(s).toString(); } catch (e) { return null; }
    }
    var m = s.match(/^(\d+)\.(\d{1,18})$/);
    if (!m) return null;
    var frac = (m[2] + "000000000000000000").slice(0, 18);
    try { return (BigInt(m[1]) * BigInt("1000000000000000000") + BigInt(frac)).toString(); }
    catch (e) { return null; }
  }

  function weiToEth(weiStr) {
    try {
      var w = BigInt(weiStr);
      var whole = w / BigInt("1000000000000000000");
      var frac = (w % BigInt("1000000000000000000")).toString().padStart(18, "0").replace(/0+$/, "");
      return frac ? whole.toString() + "." + frac : whole.toString();
    } catch (e) { return null; }
  }

  // Parse an ETH-denominated decimal ("1", "0.5", "0.173503114619109366") -> wei string. Null on invalid.
  function parseEthToWei(s) {
    if (s === undefined || s === null) return null;
    s = String(s).trim().replace(/\s*eth\s*$/i, "").trim();
    if (s === "") return null;
    var m = s.match(/^(\d+)(?:\.(\d{1,18}))?$/);
    if (!m) return null;
    var frac = ((m[2] || "") + "000000000000000000").slice(0, 18);
    try { return (BigInt(m[1]) * BigInt("1000000000000000000") + BigInt(frac)).toString(); }
    catch (e) { return null; }
  }

  // ?proof=<chain>:<txhash> with optional &amount= &to= &memo=
  function parseProofParam(s) {
    if (!s || typeof s !== "string") return null;
    s = s.trim();
    var parts = s.split(":");
    if (parts.length < 2) return null;
    var chain = parts[0].toLowerCase();
    var hash = parts.slice(1).join(":");
    if (!CHAINS[chain] || !isTxHash(hash)) return null;
    return { chain: chain, hash: hash.toLowerCase() };
  }

  function serializeProofParam(claim) {
    return claim.chain + ":" + claim.hash;
  }

  function finalityAssessment(confirmations) {
    if (typeof confirmations !== "number" || confirmations < 0) return { level: "unknown", label: "unknown" };
    if (confirmations < 12) return { level: "low", label: "low — under 12 confirmations" };
    if (confirmations < 64) return { level: "medium", label: "medium — 12+ confirmations" };
    return { level: "high", label: "high — 64+ confirmations" };
  }

  function check(id, label, result, expected, actual, note) {
    var c = { id: id, label: label, result: result };
    if (expected !== undefined) c.expected = expected;
    if (actual !== undefined) c.actual = actual;
    if (note) c.note = note;
    return c;
  }

  // Pure verdict logic. claim: {chain, hash, expectedAmountWei?, expectedTo?, memo?}
  // chainData: null | {found, status, from, to, valueWei, input, blockNumber, confirmations}
  function evaluateClaim(claim, chainData, opts) {
    opts = opts || {};
    var observedAt = opts.observedAt || new Date().toISOString();
    var proof = {
      schema: SCHEMA_ID,
      claim: { chain: claim.chain, hash: claim.hash.toLowerCase() },
      observedAt: observedAt,
      verdict: "INVALID_CLAIM",
      checks: [],
      finality: null,
      explorerUrl: (CHAINS[claim.chain] || {}).explorer ? CHAINS[claim.chain].explorer + claim.hash.toLowerCase() : null
    };
    if (claim.memo) proof.claim.memo = claim.memo;

    if (!CHAINS[claim.chain] || !isTxHash(claim.hash)) {
      proof.checks.push(check("claim_valid", "Claim is well-formed", "fail", "chain in {base, ethereum} + 0x tx hash", claim.chain + ":" + claim.hash));
      return proof;
    }
    if (claim.expectedTo && !isAddress(claim.expectedTo)) {
      proof.checks.push(check("claim_valid", "Claim is well-formed", "fail", "valid 0x recipient address", claim.expectedTo));
      return proof;
    }
    if (claim.expectedAmountWei !== undefined && claim.expectedAmountWei !== null && claim.expectedAmountWei !== "") {
      try { BigInt(claim.expectedAmountWei); }
      catch (e) {
        proof.checks.push(check("claim_valid", "Claim is well-formed", "fail", "parseable amount", String(claim.expectedAmountWei)));
        return proof;
      }
    }

    if (!chainData || chainData.found === false) {
      proof.verdict = "NOT_FOUND";
      proof.checks.push(check("exists", "Transaction exists on " + CHAINS[claim.chain].name, "fail", "transaction present", "absent",
        "No transaction with this hash on " + CHAINS[claim.chain].name + ". Wrong chain, typo, or not yet propagated."));
      return proof;
    }

    proof.checks.push(check("exists", "Transaction exists on " + CHAINS[claim.chain].name, "pass", "transaction present", "present",
      "Block " + chainData.blockNumber + (chainData.blockNumber != null ? "" : "")));

    if (chainData.status === 0) {
      proof.verdict = "FAILED";
      proof.checks.push(check("status", "Transaction succeeded", "fail", "status = success (1)", "reverted (0)",
        "The transaction was mined but reverted — no value moved as intended."));
      return proof;
    }
    proof.checks.push(check("status", "Transaction succeeded", "pass", "status = success (1)", "success (1)"));

    var isContractCall = chainData.input && chainData.input !== "0x" && chainData.input !== "";
    if (isContractCall) {
      proof.checks.push(check("native_transfer", "Native transfer (v1 scope)", "unknown", "simple value transfer", "contract interaction",
        "v1 proves native transfers. Token/contract amounts are not decoded — amount and recipient checks are skipped for contract calls."));
      if (typeof chainData.confirmations === "number") {
        proof.finality = {
          confirmations: chainData.confirmations,
          assessment: finalityAssessment(chainData.confirmations).level,
          note: "Probabilistic only — reorg risk never reaches zero."
        };
        if (chainData.confirmations < 12) {
          proof.verdict = "PENDING";
          proof.checks.push(check("confirmations", "Sufficient confirmations", "fail", ">= 12", String(chainData.confirmations)));
          return proof;
        }
      }
      proof.verdict = "UNSUPPORTED";
      return proof;
    }
    proof.checks.push(check("native_transfer", "Native transfer (v1 scope)", "pass", "simple value transfer", "simple value transfer"));

    var mismatches = [];
    if (claim.expectedAmountWei !== undefined && claim.expectedAmountWei !== null && claim.expectedAmountWei !== "") {
      var exp = BigInt(claim.expectedAmountWei).toString();
      var act = chainData.valueWei != null ? BigInt(chainData.valueWei).toString() : null;
      if (act === null) {
        proof.checks.push(check("amount", "Amount matches", "unknown", weiToEth(exp) + " " + CHAINS[claim.chain].native, "unavailable"));
      } else if (exp === act) {
        proof.checks.push(check("amount", "Amount matches", "pass", weiToEth(exp) + " " + CHAINS[claim.chain].native, weiToEth(act) + " " + CHAINS[claim.chain].native));
      } else {
        mismatches.push("amount");
        proof.checks.push(check("amount", "Amount matches", "fail", weiToEth(exp) + " " + CHAINS[claim.chain].native, weiToEth(act) + " " + CHAINS[claim.chain].native,
          "Expected " + exp + " wei, observed " + act + " wei."));
      }
    } else {
      proof.checks.push(check("amount", "Amount matches", "unknown", "not asserted", chainData.valueWei != null ? weiToEth(chainData.valueWei) + " " + CHAINS[claim.chain].native : "unavailable",
        "No expected amount given — observed value shown for reference."));
    }

    if (claim.expectedTo) {
      var expTo = claim.expectedTo.toLowerCase();
      var actTo = (chainData.to || "").toLowerCase();
      if (actTo === expTo) {
        proof.checks.push(check("recipient", "Recipient matches", "pass", expTo, actTo));
      } else {
        mismatches.push("recipient");
        proof.checks.push(check("recipient", "Recipient matches", "fail", expTo, actTo || "none (contract creation?)",
          "Funds went to a different address than claimed."));
      }
    } else {
      proof.checks.push(check("recipient", "Recipient matches", "unknown", "not asserted", chainData.to || "unavailable",
        "No expected recipient given — observed recipient shown for reference."));
    }

    if (typeof chainData.confirmations === "number") {
      proof.finality = {
        confirmations: chainData.confirmations,
        assessment: finalityAssessment(chainData.confirmations).level,
        note: "Probabilistic only — reorg risk never reaches zero."
      };
      if (chainData.confirmations < 12) {
        proof.checks.push(check("confirmations", "Sufficient confirmations", "fail", ">= 12", String(chainData.confirmations),
          "Mined but young — treat as pending until confirmations accumulate."));
        proof.verdict = "PENDING";
        return proof;
      }
      proof.checks.push(check("confirmations", "Sufficient confirmations", "pass", ">= 12", String(chainData.confirmations)));
    }

    if (mismatches.length) {
      proof.verdict = "MISMATCH";
      proof.mismatchedFields = mismatches;
      return proof;
    }
    proof.verdict = "SETTLED";
    return proof;
  }

  function isRateLimitSignal(status, bodyText) {
    if (status === 429) return true;
    if (bodyText && /rate limit|too many requests|throttl/i.test(bodyText)) return true;
    return false;
  }

  // Minimal JSON-RPC with endpoint failover. fetchImpl defaults to global fetch.
  // Failover is a loop (not recursion-into-catch): the terminal rejection from
  // the loop guard propagates to the caller and is never re-caught by a frame.
  function rpcCall(chainId, method, params, fetchImpl, opts) {
    opts = opts || {};
    var chain = CHAINS[chainId];
    if (!chain) return Promise.reject(new Error("unknown chain: " + chainId));
    var f = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!f) return Promise.reject(new Error("no fetch implementation available"));
    var rpcs = opts.rpcs || chain.rpcs;
    var timeoutMs = opts.timeoutMs == null ? 15000 : opts.timeoutMs;
    var errors = [];

    function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

    function tryOne(url) {
      return new Promise(function (resolve, reject) {
        var timer = null, settled = false;
        function settle(fn, val) { if (!settled) { settled = true; if (timer) clearTimeout(timer); fn(val); } }
        var fetchOpts = {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params })
        };
        if (typeof AbortController !== "undefined" && timeoutMs > 0) {
          var ctrl = new AbortController();
          fetchOpts.signal = ctrl.signal;
          timer = setTimeout(function () { settle(reject, { message: "timeout after " + timeoutMs + "ms", rateLimited: false }); }, timeoutMs);
        }
        f(url, fetchOpts).then(function (resp) {
          resp.text().then(function (text) {
            var body = null;
            try { body = JSON.parse(text); } catch (e) { /* non-JSON body */ }
            if (!resp.ok || (body && body.error)) {
              var msg = (body && body.error && body.error.message) || ("HTTP " + resp.status);
              var rl = isRateLimitSignal(resp.status, msg) || !!(body && body.error && body.error.code === -32005);
              settle(reject, { message: msg, rateLimited: rl });
            } else {
              settle(resolve, body ? body.result : null);
            }
          }, function (e) { settle(reject, { message: String((e && e.message) || e), rateLimited: false }); });
        }, function (e) {
          settle(reject, { message: String((e && e.message) || e), rateLimited: /rate limit|429/i.test(String((e && e.message) || "")) });
        });
      });
    }

    function loop(i) {
      if (i >= rpcs.length) {
        var rateLimited = errors.some(function (e) { return e.rateLimited; });
        var err = new Error(rateLimited ? "All RPC endpoints rate-limited or unreachable" : "All RPC endpoints failed");
        err.code = rateLimited ? "RATE_LIMITED" : "RPC_FAILED";
        err.errors = errors;
        return Promise.reject(err);
      }
      // Two-arg .then: onRejected handles only tryOne's rejection, never the
      // terminal rejection returned by the recursive loop call.
      return tryOne(rpcs[i]).then(
        function (result) { return result; },
        function (fail) {
          errors.push({ url: rpcs[i], message: fail.message, rateLimited: !!fail.rateLimited });
          return sleep(400 * (i + 1)).then(function () { return loop(i + 1); });
        }
      );
    }
    return loop(0);
  }

  // Full live proof: validates claim, fetches tx + receipt + head, evaluates.
  function proveSettlement(claim, fetchImpl, opts) {
    opts = opts || {};
    claim = {
      chain: (claim.chain || "").toLowerCase(),
      hash: (claim.hash || "").trim().toLowerCase(),
      expectedAmountWei: claim.expectedAmountWei,
      expectedTo: claim.expectedTo,
      memo: claim.memo
    };
    if (!CHAINS[claim.chain] || !isTxHash(claim.hash)) {
      return Promise.resolve(evaluateClaim(claim, null, opts));
    }
    return rpcCall(claim.chain, "eth_getTransactionByHash", [claim.hash], fetchImpl, opts).then(function (tx) {
      if (!tx) return evaluateClaim(claim, { found: false }, opts);
      return rpcCall(claim.chain, "eth_getTransactionReceipt", [claim.hash], fetchImpl, opts).then(function (rc) {
        return rpcCall(claim.chain, "eth_blockNumber", [], fetchImpl, opts).then(function (head) {
          var txBlock = tx.blockNumber ? parseInt(tx.blockNumber, 16) : (rc && rc.blockNumber ? parseInt(rc.blockNumber, 16) : null);
          var latest = head ? parseInt(head, 16) : null;
          var chainData = {
            found: true,
            status: rc && rc.status != null ? parseInt(rc.status, 16) : 1,
            from: tx.from, to: tx.to,
            valueWei: tx.value ? BigInt(tx.value).toString() : "0",
            input: tx.input,
            blockNumber: txBlock,
            confirmations: (txBlock != null && latest != null) ? Math.max(0, latest - txBlock) : null
          };
          return evaluateClaim(claim, chainData, opts);
        });
      });
    }).catch(function (e) {
      if (e && e.code === "RATE_LIMITED") {
        var p = evaluateClaim({ chain: claim.chain, hash: claim.hash }, { found: false }, opts);
        p.verdict = "RATE_LIMITED";
        p.checks = [check("rpc", "Public RPC reachable", "fail", "receipt data", "rate-limited",
          "All public endpoints rate-limited or unreachable right now. Nothing was fabricated — try again in a minute.")];
        p.errors = (e.errors || []).map(function (x) { return x.url + ": " + x.message; });
        return p;
      }
      throw e;
    });
  }

  return {
    SCHEMA_ID: SCHEMA_ID,
    CHAINS: CHAINS,
    VERDICTS: VERDICTS,
    isAddress: isAddress,
    isTxHash: isTxHash,
    parseAmountToWei: parseAmountToWei,
    parseEthToWei: parseEthToWei,
    weiToEth: weiToEth,
    parseProofParam: parseProofParam,
    serializeProofParam: serializeProofParam,
    finalityAssessment: finalityAssessment,
    evaluateClaim: evaluateClaim,
    rpcCall: rpcCall,
    proveSettlement: proveSettlement
  };
});
