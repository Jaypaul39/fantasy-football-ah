import { PocketIc, createIdentity } from "@dfinity/pic";
import { afterAll, beforeAll, expect, it } from "vitest";

import { idlFactory } from "../../src/frontend/src/declarations/backend.did.js";
import type { _SERVICE } from "../../src/frontend/src/declarations/backend.did";

const PIC_URL = process.env.POCKET_IC_URL ?? "";
const BACKEND_WASM = process.env.BACKEND_WASM ?? "";

let pic: PocketIc | undefined;
let actor: _SERVICE;

const adminIdentity = createIdentity("fresh-install-admin-seed");
const admin = adminIdentity.getPrincipal();

beforeAll(async () => {
  pic = await PocketIc.create(PIC_URL);
  ({ actor } = await pic.setupCanister<_SERVICE>({
    idlFactory,
    wasm: BACKEND_WASM,
    sender: admin,
  }));
});

afterAll(async () => {
  await pic?.tearDown();
});

/**
 * The migration chain must install cleanly on a fresh canister. The previous
 * revision's migration declared `activeRoomIds` in its OldActor, which traps on
 * a fresh install because the empty state does not carry that field. This test
 * asserts the current wasm installs and answers an empty-state read instead of
 * trapping during the migration chain.
 */
it("installs fresh and answers an empty-state read instead of trapping", async () => {
  actor.setIdentity(adminIdentity);
  const state = await actor.getRoomState("999");
  expect("err" in state).toBe(true);
});
