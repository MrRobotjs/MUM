package main

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"io"
	"strings"
)

const plexRawPayloadLimit = 8192

// A structural projection of the actual session XML, not a synthesized card DTO.
// Never copy text, unknown elements/attributes, users, keys, paths or URLs.
type plexRawElement struct {
	Element    string            `json:"element"`
	Attributes map[string]string `json:"attributes,omitempty"`
	Children   []*plexRawElement `json:"children,omitempty"`
}

func plexRawChild(parent, child string) bool {
	switch parent {
	case "Video", "Track":
		return child == "Player" || child == "Session" || child == "Media" || child == "TranscodeSession"
	case "Media":
		return child == "Part"
	case "Part":
		return child == "Stream"
	}
	return false
}

func plexRawAttribute(element, name, value string) bool {
	// The numeric-only list excludes identifiers that may be opaque credentials.
	numeric := ""
	words := ""
	switch element {
	case "Video", "Track":
		numeric = "duration viewOffset year"
		words = "type"
	case "Player":
		numeric = "local relay"
		words = "state"
	case "Session":
		numeric = "bandwidth"
		words = "location"
	case "Media":
		numeric = "selected duration bitrate width height audioChannels hasVoiceActivity aspectRatio"
		words = "container videoCodec audioCodec videoResolution videoFrameRate videoProfile"
	case "Part":
		numeric = "selected duration size"
		words = "container decision"
	case "Stream":
		numeric = "streamType selected index bitrate width height channels samplingRate bitDepth frameRate aspectRatio"
		words = "codec profile decision scanType colorSpace colorRange colorTrc colorPrimaries"
	case "TranscodeSession":
		numeric = "audioChannels width height throttled speed progress remaining duration transcodeHwRequested transcodeHwFullPipeline"
		words = "videoDecision audioDecision subtitleDecision videoCodec audioCodec container transcodeHwDecoding transcodeHwEncoding"
	}
	if value == "" || len(value) > 64 {
		return false
	}
	if strings.Contains(" "+numeric+" ", " "+name+" ") {
		for _, r := range value {
			if (r < '0' || r > '9') && r != '.' {
				return false
			}
		}
		return true
	}
	if strings.Contains(" "+words+" ", " "+name+" ") {
		for _, r := range value {
			if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '_' && r != '-' && r != '.' && r != ' ' {
				return false
			}
		}
		return true
	}
	return false
}

func parsePlexRawPayloads(body []byte) []string {
	decoder := xml.NewDecoder(bytes.NewReader(body))
	var result []string
	var root *plexRawElement
	var stack []*plexRawElement
	depth, nodes, budget := 0, 0, 0
	overflow := false
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return result
		}
		if err != nil {
			return nil
		}
		switch v := token.(type) {
		case xml.StartElement:
			depth++
			if depth < 2 {
				continue
			}
			if depth == 2 {
				root = nil
				stack = nil
				nodes = 0
				budget = 0
				overflow = false
			}
			var node *plexRawElement
			allowed := depth == 2 && (v.Name.Local == "Video" || v.Name.Local == "Track")
			if depth > 2 && len(stack) > 0 && stack[len(stack)-1] != nil {
				allowed = plexRawChild(stack[len(stack)-1].Element, v.Name.Local)
			}
			if allowed && !overflow && v.Name.Space == "" {
				nodes++
				budget += 64
				if nodes > 128 || budget > plexRawPayloadLimit {
					overflow = true
				} else {
					node = &plexRawElement{Element: v.Name.Local, Attributes: map[string]string{}}
					for _, attr := range v.Attr {
						if attr.Name.Space == "" && plexRawAttribute(v.Name.Local, attr.Name.Local, attr.Value) {
							node.Attributes[attr.Name.Local] = attr.Value
							budget += len(attr.Name.Local) + len(attr.Value) + 8
						}
					}
					if depth == 2 {
						root = node
					} else {
						parent := stack[len(stack)-1]
						parent.Children = append(parent.Children, node)
					}
				}
			}
			stack = append(stack, node)
		case xml.EndElement:
			if depth == 2 {
				raw := ""
				if !overflow && root != nil {
					encoded, err := json.Marshal(root)
					if err == nil && len(encoded) <= plexRawPayloadLimit {
						raw = string(encoded)
					}
				}
				result = append(result, raw)
			}
			if depth >= 2 {
				stack = stack[:len(stack)-1]
			}
			depth--
		}
	}
}

// JSON escaping the diagnostic string adds overhead. Omit optional diagnostics
// before the store's existing total limit can reject authoritative playback.
func boundPlexRawDisplay(d *activityDisplay) {
	if d.RawDataJSON == "" {
		return
	}
	encoded, err := json.Marshal(d)
	if err != nil || len(encoded) > 16384 {
		d.RawDataJSON = ""
	}
}
