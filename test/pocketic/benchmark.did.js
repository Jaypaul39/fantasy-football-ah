/* eslint-disable */

// @ts-nocheck

// idlFactory for the standalone benchmark canister
// (src/backend/test/benchmark-canister.mo). Exposes the methods the PocketIC
// benchmark test drives: runBenchmark() (update), getReport() (query),
// runControlled(poolSize, benchSize) (update), and
// runCachingBenchmark() (update). Generated from the canister's Candid
// interface:
//
//   service : {
//     getReport: () -> (text) query;
//     runBenchmark: () -> ();
//     runControlled: (nat, nat) -> (text);
//     runCachingBenchmark: () -> (text);
//   }

// `@icp-sdk/core/candid` is a bare specifier that only resolves from the
// frontend package (src/frontend/node_modules), not from this test directory.
// Import the ESM build via a relative path so Vitest can resolve it here.
import { IDL } from '../../src/frontend/node_modules/@icp-sdk/core/lib/esm/candid/index.js';

export const idlFactory = ({ IDL }) => {
  return IDL.Service({
    getReport: IDL.Func([], [IDL.Text], ['query']),
    runBenchmark: IDL.Func([], [], []),
    runControlled: IDL.Func([IDL.Nat, IDL.Nat], [IDL.Text], []),
    runCachingBenchmark: IDL.Func([], [IDL.Text], []),
  });
};

export const init = ({ IDL }) => {
  return [];
};
