package main

// Request bodies for Plex invitation redemption tests.

func plexReservationBody(proof, name, request string) map[string]any {
	body := redeemBody(name, request)
	body["plex_authorization_id"] = proof
	body["invitation_revision"] = 1
	return body
}
