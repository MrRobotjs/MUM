package main

import (
	"crypto/sha256"
	"fmt"
	"slices"
	"strings"
)

// A migration's fingerprint covers its SQL only. Line endings, blank lines
// and whole-line "--" comments are left out, so a comment can be corrected
// without a database reporting the migration as changed; any change to a
// statement still does. The "sql:" prefix tells it apart from the earlier
// whole-file fingerprint, which databases created before it still hold until
// their next start replaces it.
//
// This is for development only. Before release the migration history is
// reset to a fresh baseline and the fingerprint goes back to a SHA-256 of the
// whole file, comments included, so any change to a migration is detected.
const migrationChecksumPrefix = "sql:"

func migrationChecksum(body []byte) string {
	kept := []string{}
	for _, line := range strings.Split(strings.ReplaceAll(string(body), "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "--") {
			continue
		}
		kept = append(kept, strings.TrimRight(line, " \t"))
	}
	return fmt.Sprintf("%s%x", migrationChecksumPrefix, sha256.Sum256([]byte(strings.Join(kept, "\n"))))
}

// rewordedMigrations are the whole-file fingerprints, with Windows and Unix
// line endings, of migrations as they were before their comments were
// reworded. Their SQL is unchanged.
var rewordedMigrations = map[string][]string{
	"066_edit_operations.sql":          {"a7337a22afdd54879ef6cc83411e2ec9d3d0ee949288f2d971f0c533c85cfecb", "1d688d2cd9f88c697a47f10350f2fb3b4854ae76f1f8b15449bd2d17ac524db8"},
	"072_no_server_sync_notice.sql":    {"4b90f04853675b378d25192d759bcef3835fe8a66eae6fbbb8298cdda2480b48", "9ff10c4a934040da3138408eb837a2d9fe482af6c4462f363fbb405e23f077b1"},
	"073_transcode_policy.sql":         {"8524c89cc717119561fd2dfc98f3b6fc842b67c950cc3d4856b65d9bfdabdede", "5dab54ec342853227a981e17bb7479f8ba7079c079a91021c4fcbb63c3aff4ed"},
	"074_purge.sql":                    {"686113fc4d3426b0487e710b5e1c16bab8144c869c653184adabca5b61ab582e", "86778b1bc21a9b9066a11586fd254f7cff23af006c027ff21f6fd2c54e8d287a"},
	"075_plex_history_posters.sql":     {"9fb1194d681638b917fc066021d43786115c91cb6bb7f6485e0ca93c189e61ea", "5bd729f0ea0445a7bf339ff45b1517a3906440cb7362180f6d2d499ce14488a4"},
	"076_history_imports.sql":          {"bf4048bb8e94c8045e9eed163bf0a5b2f5735476033082f14c45628b62588943", "0943baba3681f78db288410f12d2f4bbdfaf02df073aa432145a9b5539701256"},
	"077_discord_sign_in.sql":          {"cd0ed68a9691a176aa91779467df5295c4929105c940a284210870e57e13b2f5", "1c9fb0c0fc31f8b9b2f681c7cfc3701eb2f76fa2990daf61d6ca2218ba11e2d3"},
	"078_activity_paused_time.sql":     {"d7bacd21f164e953188cfe4be51cc47ed18a329d410b97fd7f1cd8e41c0a8830", "35fbc6638412278440b418efa3a1c3b28097109744ac34b16c808a85042ea6bf"},
	"079_activity_platform.sql":        {"a36556c4f30968849f72536b509d7bfbe0808b6df2b9ff863601a56b05c0927e", "ad0dd151eb0551d49204ccf53b60da53c29a896faa7a9bc18dc479a3b652c43c"},
	"080_service_account_cloud_id.sql": {"871bec021b95e04188c8771ee7f1d8064797e4256366a3c14493977d93baacdf", "7eff6d7ebb5ab55e106e7a922f1089b38836fb0831a9fd79cf0e785943527958"},
	"081_activity_ip_address.sql":      {"0590f499fe97c81fb9fcf6cc25d4a7e2df8c3c34aad55e9d0afd43c4de8778ac", "ca00a76fa2750c7bfa6594c597eaa892cdc539c676468742fbd4e16ebe3a7714"},
	"082_activity_paused_since.sql":    {"45bcfb3ea454f17b9ed1a7532366d5686484297a7c226c1e79a15ea1e1b36084", "846c34a9aa1f102350bcba87a7537d8b4bf57c96dc4158cd1188566eaa8f0676"},
	"083_history_import_account.sql":   {"9fc1c536c688757fa8dbc918df63f065cb544975ff2940daa3106c56d8b09d21", "2427a0dfee489dfd5b77592d67b93ea969dca5a2f593ae255ca265963fd7a850"},
}

// migrationApplied reports whether a stored fingerprint is this migration:
// the current fingerprint, or an earlier whole-file one of the same file
// with either line ending, or of its wording before a comment change.
func migrationApplied(version, stored string, body []byte) bool {
	if stored == migrationChecksum(body) {
		return true
	}
	if strings.HasPrefix(stored, migrationChecksumPrefix) {
		return false
	}
	unix := strings.ReplaceAll(string(body), "\r\n", "\n")
	windows := strings.ReplaceAll(unix, "\n", "\r\n")
	for _, form := range []string{unix, windows} {
		if stored == fmt.Sprintf("%x", sha256.Sum256([]byte(form))) {
			return true
		}
	}
	return slices.Contains(rewordedMigrations[version], stored)
}
