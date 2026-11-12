//go:build !windows

package main

// launchedByDoubleClick is Windows-only; other systems keep the terminal open.
func launchedByDoubleClick() bool { return false }
