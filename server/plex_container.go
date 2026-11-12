package main

import "strings"

func plexContainerDetail(source, output string, transcoding bool) string {
	source = strings.ToUpper(displayText(source))
	output = strings.ToUpper(displayText(output))
	if transcoding {
		if source == "" {
			source = "N/A"
		}
		if output == "" {
			output = "N/A"
		}
		return "Converting (" + source + " → " + output + ")"
	}
	if source == "" {
		return "Unknown"
	}
	return source
}
