package main

import (
	"slices"

	"app/server/providers/provider"
)

// The features a media service's card lists on the Media Servers page: what
// MUM can do with that service, derived from what its module implements, so
// a card never claims more than MUM supports. Every service lists every key,
// unsupported ones with supported false, so services can be compared.

type mediaServiceFeature struct {
	Key       string `json:"key"`
	Supported bool   `json:"supported"`
}

// mediaServiceFeatureKeys is the order the cards show them in.
var mediaServiceFeatureKeys = []string{
	"users.sync", "users.invites", "users.library_access",
	"libraries.sync", "libraries.titles", "libraries.collections",
	"activity.live", "activity.stop", "activity.history_import",
	"extras.overseerr", "extras.download_labels", "extras.resources",
}

// moduleFeatures lists a module's features in mediaServiceFeatureKeys order.
func moduleFeatures(m mediaModule) []mediaServiceFeature {
	instance := m.New(provider.Config{})
	capabilities := moduleCapabilities(m)
	has := func(capability string) bool { return slices.Contains(capabilities, capability) }
	_, collections := instance.(collectionReader)
	_, live := instance.(activityReader)
	_, stops := instance.(sessionTerminator)
	_, resources := instance.(statisticsReader)
	supported := map[string]bool{
		"users.sync":              has("users.sync"),
		"users.invites":           has("invitations.redeem"),
		"users.library_access":    has("users.libraries.update"),
		"libraries.sync":          has("libraries.sync"),
		"libraries.titles":        has("libraries.items.sync"),
		"libraries.collections":   collections,
		"activity.live":           live,
		"activity.stop":           stops,
		"activity.history_import": slices.Contains(importableHistory, m.Definition.ID),
		"extras.overseerr":        has("integrations.overseerr"),
		"extras.download_labels":  has("labels.downloads.sync"),
		"extras.resources":        resources,
	}
	features := make([]mediaServiceFeature, 0, len(mediaServiceFeatureKeys))
	for _, key := range mediaServiceFeatureKeys {
		features = append(features, mediaServiceFeature{Key: key, Supported: supported[key]})
	}
	return features
}
