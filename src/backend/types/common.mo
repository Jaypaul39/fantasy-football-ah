// Common cross-cutting types shared across all domains
module {
  public type RoomId = Text;
  public type UserId = Principal;
  public type NominationId = Nat;
  public type Timestamp = Int; // nanoseconds from Time.now()
};
