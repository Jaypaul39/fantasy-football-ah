import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// backend.ts (which re-exports GameType/CompetitionMode) imports ExternalBlob
// from @caffeineai/object-storage, whose dist/blob subpath does not resolve in
// the jsdom test environment. Mock it so the enum values can be loaded.
vi.mock("@caffeineai/object-storage", () => ({
  ExternalBlob: class ExternalBlob {},
}));

import { CompetitionMode, GameType } from "../backend";
import type { backendInterface } from "../backend.d.ts";
import { CreateRoomDialog } from "../components/CreateRoomDialog";

// ── Actor mock ─────────────────────────────────────────────────────────────
const getRoomsMock = vi.fn();
const createRoomMock = vi.fn();
const actorMock = {
  getRooms: getRoomsMock,
  createRoom: createRoomMock,
} as unknown as backendInterface;

vi.mock("../hooks/useBackend", () => ({
  useBackend: () => ({ actor: actorMock, isFetching: false }),
}));

// Force the desktop (Dialog) branch so the form is rendered in a portal.
vi.mock("../hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: navigateMock }),
}));

const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

function renderDialog() {
  const onOpenChange = vi.fn();
  const utils = render(<CreateRoomDialog open onOpenChange={onOpenChange} />);
  return { ...utils, onOpenChange };
}

/** Queries an element by its data-ocid deterministic marker. */
function byOcid(ocid: string): HTMLElement {
  const el = document.querySelector(`[data-ocid="${ocid}"]`);
  if (!el) throw new Error(`No element with data-ocid="${ocid}"`);
  return el as HTMLElement;
}

async function fillRoomName(name = "Test Room") {
  await userEvent.type(byOcid("create-room-name-input"), name);
}

async function selectGameType(value: GameType) {
  await userEvent.selectOptions(
    byOcid("create-room-game-type-select"),
    String(value),
  );
}

async function selectCompetitionMode(value: CompetitionMode) {
  await userEvent.selectOptions(
    byOcid("create-room-competition-mode-select"),
    String(value),
  );
}

async function selectPlayoffTeams(value: number) {
  await userEvent.selectOptions(
    byOcid("create-room-playoff-teams-select"),
    String(value),
  );
}

describe("CreateRoomDialog competition mode + playoff teams selectors", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getRoomsMock.mockResolvedValue([]);
    createRoomMock.mockResolvedValue({ __kind__: "ok", ok: "room-001" });
  });

  it("hides the competition-mode selector for Auction rooms (accept-and-ignore)", async () => {
    renderDialog();
    // Default game type is Auction Only.
    expect(
      document.querySelector(
        '[data-ocid="create-room-competition-mode-select"]',
      ),
    ).toBeNull();
    expect(
      document.querySelector('[data-ocid="create-room-playoff-teams-select"]'),
    ).toBeNull();
  });

  it("shows the competition-mode selector only when Best Ball is selected", async () => {
    renderDialog();
    expect(
      document.querySelector(
        '[data-ocid="create-room-competition-mode-select"]',
      ),
    ).toBeNull();

    await selectGameType(GameType.BestBall);
    expect(
      document.querySelector(
        '[data-ocid="create-room-competition-mode-select"]',
      ),
    ).not.toBeNull();
    // Playoff selector still hidden until Head-to-Head is chosen.
    expect(
      document.querySelector('[data-ocid="create-room-playoff-teams-select"]'),
    ).toBeNull();
  });

  it("shows the playoff-teams selector only when Head-to-Head is selected", async () => {
    renderDialog();
    await selectGameType(GameType.BestBall);
    // Cumulative is the default competition mode → no playoff selector.
    expect(
      document.querySelector('[data-ocid="create-room-playoff-teams-select"]'),
    ).toBeNull();

    await selectCompetitionMode(CompetitionMode.HeadToHead);
    expect(
      document.querySelector('[data-ocid="create-room-playoff-teams-select"]'),
    ).not.toBeNull();

    // Switching back to Cumulative hides it again.
    await selectCompetitionMode(CompetitionMode.Cumulative);
    expect(
      document.querySelector('[data-ocid="create-room-playoff-teams-select"]'),
    ).toBeNull();
  });

  it("hides both selectors again when switching back to Auction", async () => {
    renderDialog();
    await selectGameType(GameType.BestBall);
    await selectCompetitionMode(CompetitionMode.HeadToHead);
    expect(
      document.querySelector('[data-ocid="create-room-playoff-teams-select"]'),
    ).not.toBeNull();

    await selectGameType(GameType.Auction);
    expect(
      document.querySelector(
        '[data-ocid="create-room-competition-mode-select"]',
      ),
    ).toBeNull();
    expect(
      document.querySelector('[data-ocid="create-room-playoff-teams-select"]'),
    ).toBeNull();
  });

  it("rejects Best Ball / Cumulative with playoff teams set (must be 0)", async () => {
    renderDialog();
    await selectGameType(GameType.BestBall);
    // Set a playoff field via Head-to-Head, then switch back to Cumulative.
    await selectCompetitionMode(CompetitionMode.HeadToHead);
    await selectPlayoffTeams(4);
    await selectCompetitionMode(CompetitionMode.Cumulative);

    await fillRoomName();
    await userEvent.click(byOcid("create-room-submit-btn"));

    await waitFor(() => {
      expect(byOcid("create-room-competition-error")).toHaveTextContent(
        "Cumulative Best Ball rooms cannot have playoffs. Set playoff teams to 0.",
      );
    });
    expect(createRoomMock).not.toHaveBeenCalled();
  });

  it("accepts Best Ball / Head-to-Head without playoffs (playoffTeams = 0)", async () => {
    renderDialog();
    await selectGameType(GameType.BestBall);
    await selectCompetitionMode(CompetitionMode.HeadToHead);
    // Default playoffTeams is 0 (No playoffs).
    await fillRoomName();
    await userEvent.click(byOcid("create-room-submit-btn"));

    await waitFor(() => {
      expect(createRoomMock).toHaveBeenCalled();
    });
    expect(
      document.querySelector('[data-ocid="create-room-competition-error"]'),
    ).toBeNull();
    const args = createRoomMock.mock.calls[0];
    expect(args[1]).toBe(CompetitionMode.HeadToHead);
    expect(args[2]).toBe(BigInt(0));
  });

  it("accepts Best Ball / Head-to-Head with exactly 4, 6, or 8 playoff teams", async () => {
    for (const teams of [4, 6, 8]) {
      cleanup();
      vi.clearAllMocks();
      getRoomsMock.mockResolvedValue([]);
      createRoomMock.mockResolvedValue({ __kind__: "ok", ok: "room-001" });

      renderDialog();
      await selectGameType(GameType.BestBall);
      await selectCompetitionMode(CompetitionMode.HeadToHead);
      await selectPlayoffTeams(teams);
      await fillRoomName(`Room ${teams}`);
      await userEvent.click(byOcid("create-room-submit-btn"));

      await waitFor(() => {
        expect(createRoomMock).toHaveBeenCalled();
      });
      expect(
        document.querySelector('[data-ocid="create-room-competition-error"]'),
      ).toBeNull();
      const args = createRoomMock.mock.calls[0];
      expect(args[1]).toBe(CompetitionMode.HeadToHead);
      expect(args[2]).toBe(BigInt(teams));
    }
  });

  it("Auction rooms accept-and-ignore competition mode and playoff teams", async () => {
    renderDialog();
    // Auction is the default; competition/playoff selectors are hidden, so the
    // component's internal state stays at the defaults (Cumulative, 0) and no
    // competition validation runs.
    await fillRoomName();
    await userEvent.click(byOcid("create-room-submit-btn"));

    await waitFor(() => {
      expect(createRoomMock).toHaveBeenCalled();
    });
    expect(
      document.querySelector('[data-ocid="create-room-competition-error"]'),
    ).toBeNull();
    const args = createRoomMock.mock.calls[0];
    expect(args[0]).toBe(GameType.Auction);
    expect(args[1]).toBe(CompetitionMode.Cumulative);
    expect(args[2]).toBe(BigInt(0));
  });
});
