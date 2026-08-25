import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { backendInterface } from "../backend.d.ts";
import AdminPanel from "../components/AdminPanel";

// ── Mock the useBackend hook ────────────────────────────────────────────────
// AdminPanel consumes the actor through useBackend(). We stub the hook with a
// typed actor mock so the component can be rendered in isolation without a
// live canister or the @caffeineai/core-infrastructure actor provider.
const actorMock = {
  getCycleBalance: vi.fn(async () => BigInt(1_500_000_000_000)),
  getRooms: vi.fn(async () => []),
  getGiphyApiKey: vi.fn(async () => null),
  getOneSignalApiKey: vi.fn(async () => null),
  getOneSignalPlayerIds: vi.fn(async () => []),
  getRssFeedUrls: vi.fn(async () => []),
  getLastRssFetchStatus: vi.fn(async () => []),
  getRssRefreshIntervalSecs: vi.fn(async () => BigInt(900)),
  getByeWeeks: vi.fn(async () => []),
  getADPDatasetByType: vi.fn(async () => null),
  getNotificationCounters: vi.fn(async () => ({
    queued: BigInt(0),
    processed: BigInt(0),
    sent: BigInt(0),
    expired: BigInt(0),
    retried: BigInt(0),
    failed: BigInt(0),
  })),
  getNotificationQueueSnapshot: vi.fn(async () => []),
  getHeartbeatDiagnostics: vi.fn(async () => ({
    lastNotificationWorkerStartedAt: BigInt(0),
    lastNotificationWorkerCompletedAt: BigInt(0),
    notificationWorkerEntryCount: BigInt(0),
  })),
  setRecoveryPassword: vi.fn(async () => ({ __kind__: "ok", ok: null })),
} as unknown as backendInterface;

vi.mock("../hooks/useBackend", () => ({
  useBackend: () => ({ actor: actorMock, isFetching: false }),
}));

describe("AdminPanel", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the admin panel header", () => {
    render(<AdminPanel />);
    expect(
      screen.getByRole("heading", { name: "Admin Panel" }),
    ).toBeInTheDocument();
  });

  it("renders the existing administration cards", () => {
    render(<AdminPanel />);
    expect(
      screen.getByRole("heading", { name: "Canister Health" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Import Players from Sleeper API",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Clear All Players" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Delete Room" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Giphy API Key" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "OneSignal REST API Key" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "News Feed Sources" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "ADP Datasets" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Bye Weeks" }),
    ).toBeInTheDocument();
  });

  it("fetches and displays the canister cycle balance on mount", async () => {
    render(<AdminPanel />);
    expect(actorMock.getCycleBalance).toHaveBeenCalled();
    expect(await screen.findByText("1.50 TC")).toBeInTheDocument();
  });

  it("renders the clear-players confirmation flow", async () => {
    const user = (await import("@testing-library/user-event")).default;
    render(<AdminPanel />);
    await user.click(screen.getByRole("button", { name: "Clear Players" }));
    expect(
      screen.getByText(
        "Are you sure? This will delete all players permanently.",
      ),
    ).toBeInTheDocument();
  });

  it("renders the recovery password set/update controls", () => {
    render(<AdminPanel />);
    expect(
      screen.getByRole("heading", { name: "Recovery Password" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("New Recovery Password")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Confirm Recovery Password"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save Recovery Password" }),
    ).toBeInTheDocument();
  });

  it("disables saving until both recovery password fields are filled", () => {
    render(<AdminPanel />);
    const saveButton = screen.getByRole("button", {
      name: "Save Recovery Password",
    });
    expect(saveButton).toBeDisabled();
    expect(actorMock.setRecoveryPassword).not.toHaveBeenCalled();
  });

  it("shows an error when the recovery password and confirmation do not match", async () => {
    const user = (await import("@testing-library/user-event")).default;
    render(<AdminPanel />);
    await user.type(
      screen.getByLabelText("New Recovery Password"),
      "secret-pass",
    );
    await user.type(
      screen.getByLabelText("Confirm Recovery Password"),
      "different-pass",
    );
    await user.click(
      screen.getByRole("button", { name: "Save Recovery Password" }),
    );
    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();
    expect(actorMock.setRecoveryPassword).not.toHaveBeenCalled();
  });

  it("saves a matching recovery password via setRecoveryPassword", async () => {
    const user = (await import("@testing-library/user-event")).default;
    render(<AdminPanel />);
    await user.type(
      screen.getByLabelText("New Recovery Password"),
      "secret-pass",
    );
    await user.type(
      screen.getByLabelText("Confirm Recovery Password"),
      "secret-pass",
    );
    await user.click(
      screen.getByRole("button", { name: "Save Recovery Password" }),
    );
    expect(actorMock.setRecoveryPassword).toHaveBeenCalledWith("secret-pass");
    expect(
      await screen.findByText("Recovery password saved successfully."),
    ).toBeInTheDocument();
  });
});
