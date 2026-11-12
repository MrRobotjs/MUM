//go:build migrationtool && legacyimport

package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

// This developer migration utility is intentionally build-tagged until the web
// runtime is ported. It is not a replacement entrypoint for the Flask app.
func main() {
	if err := runMigrationTool(); err != nil {
		fmt.Fprintln(os.Stderr, "migration:", err)
		os.Exit(1)
	}
}

func runMigrationTool() error {
	path := flag.String("db", "", "new destination SQLite path (required)")
	snapshot := flag.String("snapshot", "", "offline snapshot JSON to import into an empty destination")
	flag.Parse()
	if *path == "" {
		return fmt.Errorf("-db is required; never select a live source database")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	s, err := OpenStore(ctx, *path)
	if err != nil {
		return err
	}
	defer s.Close()
	if *snapshot != "" {
		file, err := os.Open(*snapshot)
		if err != nil {
			return err
		}
		report, err := s.ImportSnapshot(ctx, file)
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		if err := json.NewEncoder(os.Stdout).Encode(report); err != nil {
			return err
		}
	}
	if err := s.CheckIntegrity(ctx); err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, "Database schema and integrity verified.")
	return nil
}
