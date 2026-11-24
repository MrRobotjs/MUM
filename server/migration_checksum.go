package main

import (
	"crypto/sha256"
	"fmt"
)

// migrationChecksum fingerprints every byte of the embedded migration.
func migrationChecksum(body []byte) string {
	return fmt.Sprintf("%x", sha256.Sum256(body))
}
