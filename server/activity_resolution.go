package main

import (
	"strconv"
	"strings"
)

// activityResolution accepts only normalized video resolution labels.
func activityResolution(value string) string {
	switch value {
	case "SD", "2K", "4K":
		return value
	}
	if len(value) < 2 || len(value) > 6 || !strings.HasSuffix(value, "p") && !strings.HasSuffix(value, "i") {
		return ""
	}
	n, err := strconv.Atoi(value[:len(value)-1])
	if err != nil || n < 1 || n > 10000 || strconv.Itoa(n) != value[:len(value)-1] {
		return ""
	}
	return value
}
