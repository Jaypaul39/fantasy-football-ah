import { PocketIc, createIdentity } from "@dfinity/pic";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { idlFactory } from "../../src/frontend/src/declarations/backend.did.js";
import type {
  AuctionSettings,
  Player,
  _SERVICE,
} from "../../src/frontend/src/declarations/backend.did";

const PIC_URL = process.env.POCKET_IC_URL ?? "";
const BACKEND_WASM = process.env.BACKEND_WASM ?? "";

let pic: PocketIc | undefined;
let actor: _SERVICE;

// Deterministic identities so each caller is a distinct, stable principal.
const adminIdentity = createIdentity("admin-seed");
const bobIdentity = createIdentity("bob-seed");
const carolIdentity = createIdentity("carol-seed");

const admin = adminIdentity.getPrincipal();
const bob = bobIdentity.getPrincipal();
const carol = carolIdentity.getPrincipal();

const settings: AuctionSettings = {
  minBidIncrement: 1n,
  maxActivePicks: 3n,
  adpDataset: "all",
  nomTimerSecs: 30n,
  maxParticipants: 12n,
  bidTimerSecs: 30n,
  maxRosterSize: [10n],
};

function player(id: string, name: string, position: string): Player {
  return {
    id,
    adp: 100,
    yearsExp: 2n,
    name,
    team: "TST",
    byeWeek: [],
    position,
    headshotUrl: [],
  };
}

/**
 * Create a fresh 3-participant room (admin, bob, carol in that order), import
 * two players, and start the auction. Admin is the first nominator (index 0).
 */
async function setupRoom(): Promise<string> {
  actor.setIdentity(adminIdentity);
  const created = await actor.createRoom(
    `Room ${Date.now()}`,
    200n,
    settings,
    true,
    [],
    [],
    [],
    [],
    [],
    [],
    [],
  );
  if (!("ok" in created)) {
    throw new Error(`createRoom failed: ${JSON.stringify(created)}`);
  }
  const roomId = created.ok;

  actor.setIdentity(bobIdentity);
  await actor.joinRoom(roomId, []);
  actor.setIdentity(carolIdentity);
  await actor.joinRoom(roomId, []);

  actor.setIdentity(adminIdentity);
  await actor.importPlayers([player("P1", "Player One", "QB"), player("P2", "Player Two", "RB")]);

  const started = await actor.startAuction(roomId);
  if (!("ok" in started)) {
    throw new Error(`startAuction failed: ${JSON.stringify(started)}`);
  }
  return roomId;
}

beforeAll(async () => {
  pic = await PocketIc.create(PIC_URL);
  ({ actor } = await pic.setupCanister<_SERVICE>({
    idlFactory,
    wasm: BACKEND_WASM,
    sender: admin,
  }));
  // Bootstrap the global admin: the first user to set a display name becomes
  // the registered admin (see setDisplayName's admin-bootstrap). Without this,
  // importPlayers rejects the admin identity ("Only the admin can import
  // players") and no players are ever imported, so every later nomination
  // fails with "Player not found".
  actor.setIdentity(adminIdentity);
  await actor.setDisplayName("Admin");
});

afterAll(async () => {
  // `?.` because `beforeAll` may not have got that far.
  await pic?.tearDown();
});

describe("auto-nomination turn-handoff", () => {
  it("answers an empty-state read instead of trapping", async () => {
    actor.setIdentity(adminIdentity);
    const state = await actor.getRoomState("999");
    expect("err" in state).toBe(true);
  });

  it("auto-nominates the next queued participant immediately after a manual nomination", async () => {
    const roomId = await setupRoom();

    // Bob queues a player for auto-nomination.
    actor.setIdentity(bobIdentity);
    await actor.setNominationQueue(roomId, "P2");

    // Admin (current nominator) nominates P1 manually. The turn-handoff fix
    // must advance to Bob and fire his queued auto-nomination immediately,
    // without waiting for the nomination timer to expire.
    actor.setIdentity(adminIdentity);
    const res = await actor.nominatePlayer(roomId, "P1");
    expect("ok" in res).toBe(true);

    // Bob should now have an active nomination for P2.
    actor.setIdentity(adminIdentity);
    const noms = await actor.getNominations(roomId);
    const bobNom = noms.find(
      (n) => n.nominatedBy.toText() === bob.toText() && n.state.Active !== undefined,
    );
    expect(bobNom).toBeDefined();
    expect(bobNom!.playerId).toBe("P2");

    // The turn should have advanced past Bob to Carol.
    const state = await actor.getRoomState(roomId);
    if (!("ok" in state)) {
      throw new Error(`getRoomState failed: ${JSON.stringify(state)}`);
    }
    expect(state.ok.currentNominatorId).toEqual([carol]);
  });

  it("clears the queue and advances the turn when the queued player is already nominated", async () => {
    const roomId = await setupRoom();

    // Bob queues P1, but admin nominates P1 first so it is already nominated.
    actor.setIdentity(bobIdentity);
    await actor.setNominationQueue(roomId, "P1");

    actor.setIdentity(adminIdentity);
    const res = await actor.nominatePlayer(roomId, "P1");
    expect("ok" in res).toBe(true);

    // advanceNominatorIndex moves to Bob and fires his auto-nomination. His
    // queued P1 is already nominated, so tryAutoNominate's "player unavailable"
    // branch clears the queue and the turn advances past Bob to Carol.
    actor.setIdentity(bobIdentity);
    const queued = await actor.getNominationQueue(roomId);
    expect(queued).toEqual([]);

    actor.setIdentity(adminIdentity);
    const state = await actor.getRoomState(roomId);
    if (!("ok" in state)) {
      throw new Error(`getRoomState failed: ${JSON.stringify(state)}`);
    }
    expect(state.ok.currentNominatorId).toEqual([carol]);
  });
});

describe("nomination queue management and manual nomination", () => {
  it("round-trips a queued player through set/get/clearNominationQueue", async () => {
    const roomId = await setupRoom();

    // Bob queues P2, then reads it back as the caller.
    actor.setIdentity(bobIdentity);
    const setRes = await actor.setNominationQueue(roomId, "P2");
    expect("ok" in setRes).toBe(true);
    expect(await actor.getNominationQueue(roomId)).toEqual(["P2"]);

    // Clearing removes the entry for the caller.
    await actor.clearNominationQueue(roomId);
    expect(await actor.getNominationQueue(roomId)).toEqual([]);
  });

  it("creates an active nomination for the nominator on manual nomination", async () => {
    const roomId = await setupRoom();

    actor.setIdentity(adminIdentity);
    const nomRes = await actor.nominatePlayer(roomId, "P1");
    expect("ok" in nomRes).toBe(true);

    const noms = await actor.getNominations(roomId);
    const adminNom = noms.find(
      (n) => n.nominatedBy.toText() === admin.toText() && n.state.Active !== undefined,
    );
    expect(adminNom).toBeDefined();
    expect(adminNom!.playerId).toBe("P1");
  });
});
