// Chama community relay — a khatru relay tuned for the Chama P2P marketplace.
//
// WHY THIS EXISTS
//   Public relays propagate Chama's vote/chat events unreliably (the "vote2
//   didn't arrive" glitch = several public defaults down at once, below fetch
//   quorum). This is one always-up home every client publishes to AND reads
//   back from, so escrow events + chat land and rehydrate instantly.
//
// TWO PROPERTIES THAT MATTER
//   1. STORE-ALL, COLLAPSE-NOTHING. Chama's escrow/chat events are addressable
//      (kind 38xxx) and every event in a trade shares d=<escrowId>. A stock
//      relay would treat them as parameterized-replaceable and keep only the
//      LATEST per (kind, pubkey, d) — which would gut chat history (every CHAT
//      is kind 38108). We wire the replaceable/addressable path to a plain
//      SaveEvent so nothing is ever replaced or deleted. (khatru only runs its
//      delete-old collapse when ReplaceEvent is empty — see khatru adding.go
//      handleNormal; by registering ReplaceEvent we take that branch away.)
//      Kind-5 deletes are not in the allowlist, so nothing can erase an event.
//   2. CHAMA-ONLY WRITES. Only the kinds the app actually publishes are
//      accepted for storage; reads stay open. This keeps it the chamacitos'
//      relay, not a public spam magnet.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/fiatjaf/eventstore/badger"
	"github.com/fiatjaf/khatru"
	"github.com/fiatjaf/khatru/policies"
	"github.com/nbd-wtf/go-nostr"
)

// allowedKind is the Chama WRITE allowlist. Derived from the live client code:
//
//	0            profile metadata — kind:0 display names (src/ui/nostr-profiles.ts)
//	4            NIP-04 encrypted DM — trade notifier (src/escrow-engine/notifier.ts)
//	24133        NIP-46 Nostr Connect — remote-signing rendezvous (Amber/nsecBunker;
//	             src/escrow-engine/nip46-signer.ts). Ephemeral (20000–29999): khatru
//	             broadcasts it to live subscribers and stores NOTHING. Lets this relay
//	             take over the NIP-46 role from the old box's throwaway in-memory relay
//	             (relay.satoshimarket.app) so that box can be decommissioned.
//	30078        NIP-78 app-specific data
//	38100–38112  escrow wire (EscrowEventKind in src/escrow-engine/types.ts):
//	             CREATE 38100, JOIN 38101, LOCK 38102, VOTE 38103, RESOLVE 38104,
//	             CLAIM 38105, COMPLETE 38106, CANCEL 38107, CHAT 38108,
//	             SUBSCRIBE 38111, PERIOD_RELEASE 38112 (38109/38110 retired-reserved)
//	38120–38134  governance/bond band: arbiter roster 38120, applications 38121,
//	             ratings 38123, bond declaration 38130, victim attestation 38131,
//	             bond-key attestation 38132, descriptor 38133, return PSBT 38134
//
// 38100–38134 is allowed as one contiguous block (a small margin over the two
// documented bands) so a newly-added Chama kind in this space is never silently
// rejected — this app grows kinds here (38133/38134 landed 2026-07-01).
//
// Everything else is refused: kind-1 notes, kind-1059 gift wrap, zaps
// (9734/9735), NWC (13194/23194/23195), kind-5 deletes — none are published by
// Chama, and kind 1 is the main relay spam vector.
func allowedKind(k int) bool {
	switch {
	case k == 0, k == 4, k == 30078:
		return true
	case k == 24133: // NIP-46 Nostr Connect (remote-signing rendezvous) — ephemeral, broadcast-only
		return true
	case k >= 38100 && k <= 38134:
		return true
	default:
		return false
	}
}

func main() {
	addr := envOr("RELAY_ADDR", "127.0.0.1:7777")
	dbPath := envOr("RELAY_DB", "./data")

	relay := khatru.NewRelay()
	relay.Info.Name = envOr("RELAY_NAME", "Chama community relay")
	relay.Info.Description = "Home relay for the Chama P2P marketplace. Writes restricted to Chama protocol events; reads open. Chama events are kept, never collapsed."
	relay.Info.Software = "https://github.com/fiatjaf/khatru"
	relay.Info.Version = "chama-1"
	relay.Info.Contact = envOr("RELAY_CONTACT", "")
	relay.Info.PostingPolicy = "Writes restricted to Chama protocol event kinds."
	relay.Info.SupportedNIPs = []any{1, 11}

	db := &badger.BadgerBackend{Path: dbPath, MaxLimit: 10000}
	if err := db.Init(); err != nil {
		log.Fatalf("badger init (%s): %v", dbPath, err)
	}
	defer db.Close()

	// STORE-ALL, COLLAPSE-NOTHING (see file header). Regular kinds (4) store
	// directly; replaceable (0) + addressable (30078, 38xxx) also route to a
	// plain SaveEvent, so no prior event is ever deleted.
	relay.StoreEvent = append(relay.StoreEvent, db.SaveEvent)
	relay.ReplaceEvent = append(relay.ReplaceEvent, db.SaveEvent)
	relay.QueryEvents = append(relay.QueryEvents, db.QueryEvents)
	relay.CountEvents = append(relay.CountEvents, db.CountEvents)
	relay.DeleteEvent = append(relay.DeleteEvent, db.DeleteEvent)

	// WRITE POLICY + hygiene. Cheapest / most-decisive check first.
	relay.RejectEvent = append(relay.RejectEvent,
		func(ctx context.Context, e *nostr.Event) (bool, string) {
			if !allowedKind(e.Kind) {
				return true, "blocked: this relay only stores Chama protocol events"
			}
			return false, ""
		},
		// Max event size. The app caps chat content at 128 KB; 256 KB gives
		// headroom for a legit max-size image chat while blocking abuse. (khatru's
		// own WebSocket read limit is 512 KB — this is the tighter event bound.)
		func(ctx context.Context, e *nostr.Event) (bool, string) {
			if len(e.Content) > 256*1024 {
				return true, "blocked: event content too large"
			}
			if len(e.Tags) > 200 {
				return true, "blocked: too many tags"
			}
			return false, ""
		},
		// Rate limit per client IP. Behind Caddy the real IP arrives via
		// X-Forwarded-For (khatru GetIPFromRequest honors it): 5 events/sec
		// sustained, burst 100 — generous for legit trade bursts and shared-NAT
		// users, a backstop against floods.
		policies.EventIPRateLimiter(5, time.Second, 100),
	)

	log.Printf("chama-relay: listening on %s  db=%s  (store-all; Chama-kinds-only writes)", addr, dbPath)
	if err := http.ListenAndServe(addr, relay); err != nil {
		log.Fatal(err)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
