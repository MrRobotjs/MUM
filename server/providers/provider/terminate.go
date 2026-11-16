package provider

import "errors"

// Stopping a stream from the Streams page.
var (
	// ErrSessionGone: the server no longer lists the stream.
	ErrSessionGone = errors.New("the stream is no longer playing")
	// ErrTerminateRefused: the server would not stop the stream (Plex only
	// allows it with Plex Pass; a key without the right is refused too).
	ErrTerminateRefused = errors.New("the server refused to stop the stream")
)

// MaxTerminateMessage is the longest message shown to the viewer, in characters.
const MaxTerminateMessage = 500
